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
//!
//! **Churn cycles a small block of keys, not one** (docs/METHODOLOGY.md §2.8, rule 4 — the
//! open-addressing set's recipe, adopted here for symmetry). A single churn key's cost is the
//! length of the one chain its bucket happens to hold, so a one-key curve jumps between
//! neighbouring sweep points with no trend behind the jumps (2.3× on the browser's mutation
//! ladder; `tests::a_single_churn_key_samples_one_bucket`). `set_churn_key` therefore expands
//! `max + 1` into the block `max + 1, max + 2, …` of `churn_block(len)` keys — the same
//! `clamp(⌊len/32⌋, 1, 16)` both open-addressing sets use — and the counted signal is the
//! mean per pair. No priming is needed: an insert appends to its chain and the delete removes
//! that last entry, so every pair restores the table exactly.

use super::mix_f64;
use wasm_bindgen::prelude::*;

const INITIAL_BUCKETS: usize = 4;
/// Grow when `len / buckets` would exceed this.
const MAX_LOAD: f64 = 0.75;

/// Most churn keys a block holds — the open-addressing sets' 16.
const CHURN_BLOCK_MAX: usize = 16;
/// At most one churn key per this many stored keys — the open-addressing sets' 32.
const KEYS_PER_CHURN_KEY: usize = 32;

/// How many churn keys a set of `len` stored keys churns: `clamp(len / 32, 1, 16)` — the
/// open-addressing sets' block rule, restated so all three hash lines sample the same keys.
pub fn churn_block(len: usize) -> usize {
    (len / KEYS_PER_CHURN_KEY).clamp(1, CHURN_BLOCK_MAX)
}

/// A set of distinct `f64` keys (duplicates collapse on insert — set semantics;
/// membership is what `search` answers).
#[wasm_bindgen]
pub struct HashSetF64 {
    buckets: Vec<Vec<f64>>,
    len: usize,
    probes: Vec<f64>,
    /// The block of spare keys cycled in/out by `churn_n` (docs/PLAN.md §6.3), all absent
    /// (module doc).
    churn_keys: Vec<f64>,
    /// Which key of the block the next timed churn pair uses.
    churn_cursor: usize,
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
            churn_keys: Vec::new(),
            churn_cursor: 0,
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

    /// Set the spare churn keys: the block `key, key + 1, …` of `churn_block(len)` keys —
    /// the open-addressing sets' block (module doc). `key` must be absent (the sweep passes
    /// `max + 1`) so each insert is real and the matching delete restores size; a block key
    /// that turns out to be present is dropped, since its "delete" would remove a real key.
    /// Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_keys.clear();
        self.churn_cursor = 0;
        let mut ops = 0u64;
        for j in 0..churn_block(self.len) {
            let k = key + j as f64;
            if !self.contains::<false>(k, &mut ops) {
                self.churn_keys.push(k);
            }
        }
    }

    /// Timed hot path: `k` insert+delete *pairs*, each of the next key in the churn block,
    /// holding size stable at ≈ n (docs/PLAN.md §6.3). Returns the delete-hit count to
    /// defeat dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let block = self.churn_keys.len();
        if block == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            let key = self.churn_keys[self.churn_cursor];
            self.churn_cursor = (self.churn_cursor + 1) % block;
            self.insert_generic::<false>(key, &mut ops);
            if self.remove_key::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the **mean** hashes + chain-steps of one
    /// counted insert+delete per key in the block (the open-addressing sets' averaging). Every
    /// pair restores the table exactly, so this is exact whatever the cursor position.
    pub fn churn_counted(&mut self) -> f64 {
        let block = self.churn_keys.len();
        if block == 0 {
            return 0.0;
        }
        let mut ops = 0u64;
        for j in 0..block {
            let key = self.churn_keys[j];
            self.insert_generic::<true>(key, &mut ops);
            let _ = self.remove_key::<true>(key, &mut ops);
        }
        ops as f64 / block as f64
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
            churn_keys: Vec::new(),
            churn_cursor: 0,
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

    /// Test/max-op helper: insert `key`, returning `(newly stored, hashes + chain-steps)`.
    /// The rehash a growing insert triggers is not in that count (see `insert_generic`);
    /// [`Self::bucket_count`] lets the caller see it (`structures::maxop`, docs/PLAN.md
    /// §13). Mutates the set.
    pub fn insert_one_counted(&mut self, key: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let before = self.len;
        self.insert_generic::<true>(key, &mut ops);
        (self.len != before, ops)
    }

    /// The current churn block (a test hook; not on the wasm surface).
    pub fn churn_block_keys(&self) -> Vec<f64> {
        self.churn_keys.clone()
    }

    /// Number of buckets — a max-op hook for observing a rehash from outside
    /// (`structures::maxop`); not on the wasm surface.
    pub fn bucket_count(&self) -> usize {
        self.buckets.len()
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
        s.set_churn_key(99.0); // absent; three keys ⇒ a block of one
        assert_eq!(s.churn_block_keys(), vec![99.0]);
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
    fn churn_cycles_the_block_and_restores_the_table_exactly() {
        let keys: Vec<f64> = (0..200).map(|i| i as f64).collect();
        let mut s = set(&keys);
        let before = s.keys_in_order();
        s.set_churn_key(200.0);
        // 200 keys ⇒ a block of six (`clamp(200 / 32, 1, 16)`), all from `max + 1` on.
        assert_eq!(s.churn_block_keys(), vec![200.0, 201.0, 202.0, 203.0, 204.0, 205.0]);
        assert_eq!(s.churn_n(13), 13);
        assert_eq!(s.keys_in_order(), before, "every pair puts the chain back as it was");
        let counted = s.churn_counted();
        assert_eq!(s.keys_in_order(), before);
        assert_eq!(s.churn_counted(), counted, "the mean does not depend on the cursor");
    }

    #[test]
    fn a_present_churn_key_is_dropped_not_deleted() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_churn_key(2.0); // a caller error — the block must not delete a real key
        assert_eq!(s.len(), 3);
        assert!(s.search_one_counted(2.0).0);
        assert!(s.churn_block_keys().is_empty());
        assert_eq!(s.churn_n(5), 0);
        assert_eq!(s.churn_counted(), 0.0);
    }

    #[test]
    fn churn_block_is_the_open_addressing_sets() {
        for len in [0usize, 31, 32, 100, 511, 512, 10_000] {
            assert_eq!(churn_block(len), super::super::hash_set_oa::churn_block(len), "len={len}");
        }
    }

    /// A fixed-seed permutation of `0..n` (xorshift; no RNG dependency, no flake) — the
    /// open-addressing tests' key set, so the two hash sets' churn pins read the same keys.
    fn shuffled_keys(n: usize) -> Vec<f64> {
        let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        for i in (1..n).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let j = (state % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
        v
    }

    /// **Why churn cycles a block here too (module doc; docs/METHODOLOGY.md §2.8, rule 4).**
    /// One churn key's cost is 1 + its chain's length, twice — whatever chain its bucket holds,
    /// so a one-key curve steps between neighbouring sweep points with no trend behind it. The
    /// problem is milder than under linear probing (a chain is not a cluster, so it rarely runs
    /// past a few keys), but it is the same sampling problem, and the open-addressing sets'
    /// block cures it the same way. Measured over the mutation ladder 250 … 4000 on three key
    /// sets: one key 3, 3, 7, 3, 5 / 5, 3, 3, 7, 5 / 3, 3, 3, 3, 5 (swings 2.33×, 2.33×,
    /// 1.67×); the block 3.38 … 4.25 (1.26×), 3.75 … 5.25 (1.40×), 3.29 … 4.50 (1.37×); the
    /// 64-key mean within 1.10×, 1.13×, 1.08×.
    #[test]
    fn a_single_churn_key_samples_one_bucket() {
        let swing = |v: &[f64]| {
            v.iter().copied().fold(f64::MIN, f64::max) / v.iter().copied().fold(f64::MAX, f64::min)
        };
        let pair = |keys: &[f64], n: usize, key: f64| -> f64 {
            let mut s = HashSetF64::new(keys, n);
            let (_, ins) = s.insert_one_counted(key);
            let (_, del) = s.delete_one_counted(key);
            (ins + del) as f64
        };
        let ladder = [250usize, 500, 1000, 2000, 4000];
        let key_sets: [Vec<f64>; 3] = [
            shuffled_keys(4000),
            shuffled_keys(4000).iter().map(|k| k * 7.0 + 3.0).collect(),
            (0..4000).map(|i| i as f64).collect(),
        ];
        let mut worst_single: f64 = 0.0;
        for keys in &key_sets {
            let (mut single, mut block, mut mean) = (Vec::new(), Vec::new(), Vec::new());
            for &n in &ladder {
                let max = keys[..n].iter().copied().fold(f64::NEG_INFINITY, f64::max);
                single.push(pair(keys, n, max + 1.0));
                let mut s = HashSetF64::new(keys, n);
                s.set_churn_key(max + 1.0);
                block.push(s.churn_counted());
                let m: f64 = (0..64).map(|j| pair(keys, n, max + 1.0 + j as f64)).sum();
                mean.push(m / 64.0);
            }
            worst_single = worst_single.max(swing(&single));
            assert!(swing(&block) < 1.6, "the block recipe is steady: {block:?}");
            assert!(swing(&block) < swing(&single), "and steadier than one key: {block:?} vs {single:?}");
            assert!(swing(&mean) < 1.25, "the 64-key mean is smooth: {mean:?}");
        }
        assert!(worst_single > 2.0, "one key steps two-fold between sweep points");
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
