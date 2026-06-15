//! Hash set with **separate chaining** (docs/PLAN.md §8, "Hashing" family — the
//! canonical v1 hash structure).
//!
//! Search hashes the key once, then walks the chain in that bucket comparing
//! keys. The cost metric is **hashes + chain-steps**. Buckets are a power of two
//! (index by mask) and the table doubles when the load factor would exceed 0.75,
//! so chains stay short and search reads as O(1) — the flat foil to the array's
//! O(n) search in the Phase 2 thin slice (docs/PLAN.md §10).
//!
//! **Mutation (docs/PLAN.md §6.3, §8).** `insert` hashes, walks the chain to
//! dedupe, and appends; it doubles the table when the load factor is exceeded.
//! `delete` hashes, walks the chain to find the key, and removes it with
//! `Vec::remove` so the chain order is preserved (so the eventual TS teaching
//! twin + conformance corpus stay bit-exact, risk R1); the table never shrinks.
//! Both are O(1) amortized, so the churn / teardown mutation cost stays flat —
//! the O(1) foil to the array's O(n) delete.

use super::mix_f64;
use wasm_bindgen::prelude::*;

const INITIAL_BUCKETS: usize = 4;
/// Grow when `len / buckets` would exceed this.
const MAX_LOAD: f64 = 0.75;

/// A set of distinct `f64` keys (duplicates collapse on insert — set semantics;
/// membership is what `search` answers).
#[wasm_bindgen]
pub struct HashSetF64 {
    buckets: Vec<Vec<f64>>,
    len: usize,
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3) — set absent.
    churn_key: f64,
    /// Distinct keys captured at build time, in insertion order, so `teardown_all`
    /// can delete every key without an O(buckets) scan inside the timed region.
    teardown_keys: Vec<f64>,
}

#[wasm_bindgen]
impl HashSetF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`. Building
    /// (including any rehashes) is untimed; search timing starts from the built
    /// table (docs/PLAN.md §6.3, "search is size-preserving").
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> HashSetF64 {
        let n = n.min(keys.len());
        let mut set = HashSetF64 {
            buckets: vec![Vec::new(); INITIAL_BUCKETS],
            len: 0,
            probes: Vec::new(),
            churn_key: 0.0,
            teardown_keys: Vec::new(),
        };
        for &k in &keys[..n] {
            let before = set.len;
            set.insert(k);
            if set.len != before {
                set.teardown_keys.push(k); // distinct keys only
            }
        }
        set
    }

    /// Number of distinct stored keys.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: `k` searches over the stored probes, no op-counting
    /// (`COUNT=false`). Returns the hit count to defeat dead-code elimination.
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.contains::<false>(self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probes counting hashes +
    /// chain-steps, total returned as a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the set so each
    /// insert is real and the matching delete restores size. Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size
    /// stable at ≈ n (docs/PLAN.md §6.3). Returns the delete-hit count to defeat
    /// dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key;
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert_generic::<false>(key, &mut ops);
            if self.remove_key::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: hashes + chain-steps of a
    /// counted insert+delete. The pair nets zero size change.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert_generic::<true>(key, &mut ops);
        let _ = self.remove_key::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh set of size `n` from empty by inserting each key in
    /// turn (including any rehashes — amortized into the measured cost).
    /// Differencing this across sweep points yields per-insert cost near n
    /// (finite differences, docs/PLAN.md §6.3). Returns `len` to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        let s = HashSetF64::new(keys, n);
        s.len as u32
    }

    /// Op-count for the cumulative build to size `n`: total hashes + chain-steps
    /// of the per-insert dedupe walks (rehash redistribution is amortized
    /// structural work and deliberately not counted, keeping the signal O(1)).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut s = HashSetF64 {
            buckets: vec![Vec::new(); INITIAL_BUCKETS],
            len: 0,
            probes: Vec::new(),
            churn_key: 0.0,
            teardown_keys: Vec::new(),
        };
        let mut ops = 0u64;
        for &k in &keys[..n] {
            s.insert_generic::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key, leaving the set empty (docs/PLAN.md §6.3
    /// teardown). Built untimed by the caller via `new`; only this call is timed.
    /// Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        let n = self.teardown_keys.len();
        for i in 0..n {
            let k = self.teardown_keys[i];
            if self.remove_key::<false>(k, &mut ops) {
                count += 1;
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total hashes + chain-steps to
    /// delete every distinct key (O(n) — each delete is O(1)).
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut s = HashSetF64::new(keys, n);
        let mut ops = 0u64;
        let order = s.teardown_keys.clone();
        for k in order {
            let _ = s.remove_key::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` set, then tear it all down, in one
    /// self-contained call. Subtracting the `build_insert_n` time isolates the
    /// teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); the constructor's insert build cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        let mut s = HashSetF64::new(keys, n);
        s.teardown_all()
    }
}

impl HashSetF64 {
    #[inline]
    fn bucket_index(&self, key: f64) -> usize {
        // Power-of-two bucket count => mask instead of modulo.
        (mix_f64(key) as usize) & (self.buckets.len() - 1)
    }

    /// Insert with dedupe (untimed build path — no counters).
    fn insert(&mut self, key: f64) {
        let mut ops = 0u64;
        self.insert_generic::<false>(key, &mut ops);
    }

    /// The one insert algorithm, generic over whether it counts. Hash, walk the
    /// chain to dedupe (one chain-step per key compared), append on miss, then
    /// rehash if the load factor is exceeded. Counts hashes + chain-steps; rehash
    /// redistribution is amortized structural work and is not counted.
    #[inline]
    fn insert_generic<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(key);
        for &k in &self.buckets[idx] {
            if COUNT {
                *ops += 1; // chain-step (dedupe check)
            }
            if k == key {
                return; // already present
            }
        }
        self.buckets[idx].push(key);
        self.len += 1;
        if self.len as f64 > MAX_LOAD * self.buckets.len() as f64 {
            self.rehash();
        }
    }

    /// The one delete algorithm, generic over whether it counts. Hash, walk the
    /// chain to find the key (one chain-step per key compared), then `Vec::remove`
    /// it so chain order is preserved. The table never shrinks. Returns whether a
    /// key was removed. Cost metric = hashes + chain-steps (docs/PLAN.md §8).
    #[inline]
    fn remove_key<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(target);
        let bucket = &mut self.buckets[idx];
        let mut pos = None;
        for (i, &k) in bucket.iter().enumerate() {
            if COUNT {
                *ops += 1; // chain-step
            }
            if k == target {
                pos = Some(i);
                break;
            }
        }
        match pos {
            Some(i) => {
                bucket.remove(i); // preserve chain order (no swap-remove)
                self.len -= 1;
                true
            }
            None => false,
        }
    }

    fn rehash(&mut self) {
        let new_count = self.buckets.len() * 2;
        let mut next = vec![Vec::new(); new_count];
        for bucket in &self.buckets {
            for &k in bucket {
                let idx = (mix_f64(k) as usize) & (new_count - 1);
                next[idx].push(k);
            }
        }
        self.buckets = next;
    }

    /// The one search algorithm, generic over counting. Counts one hash plus one
    /// chain-step per key compared (docs/PLAN.md §8 cost metric).
    #[inline]
    fn contains<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(target);
        for &k in &self.buckets[idx] {
            if COUNT {
                *ops += 1; // chain-step
            }
            if k == target {
                return true;
            }
        }
        false
    }

    /// Test/conformance helper: membership + (hashes + chain-steps) for one search.
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, hashes +
    /// chain-steps)`. Mutates the set.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.remove_key::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Longest chain — a test hook proving the load-factor policy keeps chains
    /// short (so search is genuinely O(1), not a disguised linear scan).
    pub fn max_chain(&self) -> usize {
        self.buckets.iter().map(|b| b.len()).max().unwrap_or(0)
    }

    /// Keys in bucket-walk order (buckets by index, each chain front-to-back) —
    /// the hash set's iteration order. A conformance hook (docs/PLAN.md §12);
    /// not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.len);
        for bucket in &self.buckets {
            out.extend_from_slice(bucket);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[f64]) -> HashSetF64 {
        HashSetF64::new(keys, keys.len())
    }

    #[test]
    fn membership_is_correct() {
        let s = set(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert!(s.search_one_counted(3.0).0);
        assert!(!s.search_one_counted(99.0).0);
    }

    #[test]
    fn dedupes_on_insert() {
        let s = set(&[7.0, 7.0, 7.0, 8.0]);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn every_search_counts_at_least_the_hash() {
        let s = set(&[1.0, 2.0, 3.0]);
        // A hit costs the hash plus >= 1 chain-step.
        let (found, ops) = s.search_one_counted(2.0);
        assert!(found && ops >= 2);
        // A miss costs at least the hash (chain may be empty).
        let (found, ops) = s.search_one_counted(123456.0);
        assert!(!found && ops >= 1);
    }

    #[test]
    fn load_factor_keeps_chains_short() {
        // 1000 distinct keys: with load factor <= 0.75 the longest chain must be
        // tiny (a few), which is what makes search O(1) rather than O(n).
        let keys: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let s = set(&keys);
        assert_eq!(s.len(), 1000);
        assert!(s.buckets.len() >= 1024); // grew past 1000/0.75
        assert!(s.max_chain() <= 6, "max chain was {}", s.max_chain());
    }

    #[test]
    fn search_n_counts_hits() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_probes(&[2.0, 99.0]);
        assert_eq!(s.search_n(4), 2); // [2,99,2,99] -> 2 hits
    }

    #[test]
    fn delete_removes_and_counts_hash_plus_chain() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        let (removed, ops) = s.delete_one_counted(2.0);
        assert!(removed && ops >= 2); // hash + >= 1 chain-step
        assert_eq!(s.len(), 2);
        assert!(!s.search_one_counted(2.0).0); // gone
        // Deleting an absent key removes nothing but still costs the hash.
        let (removed, ops) = s.delete_one_counted(2.0);
        assert!(!removed && ops >= 1);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn churn_holds_size_and_restores_membership() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_churn_key(99.0); // absent
        s.churn_n(10);
        assert_eq!(s.len(), 3);
        assert!(!s.search_one_counted(99.0).0); // churn key not left behind
        assert!(s.churn_counted() >= 2.0); // >= insert hash + delete hash
        assert_eq!(s.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_and_teardown_round_trip() {
        let keys: Vec<f64> = (0..50).map(|i| i as f64).collect();
        assert_eq!(HashSetF64::build_insert_n(&keys, 50), 50);
        // Build op-count is O(n): ~one hash + a short dedupe walk per key.
        let build_ops = HashSetF64::build_insert_counted(&keys, 50);
        assert!(build_ops >= 50.0);

        let mut s = HashSetF64::new(&keys, 50);
        assert_eq!(s.teardown_all(), 50);
        assert_eq!(s.len(), 0);
        // Teardown op-count is O(n) too (each delete is O(1)).
        let teardown_ops = HashSetF64::teardown_counted(&keys, 50);
        assert!(teardown_ops >= 50.0 && teardown_ops < 50.0 * 8.0);
    }

    #[test]
    fn teardown_keys_are_distinct_despite_duplicates() {
        // Duplicates collapse on insert, so teardown must delete each key once.
        let s = set(&[5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(s.len(), 3);
        let mut s = s;
        assert_eq!(s.teardown_all(), 3); // not 5
        assert_eq!(s.len(), 0);
    }
}
