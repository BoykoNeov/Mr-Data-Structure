//! Hash set of **string** keys with separate chaining (docs/PLAN.md §8,
//! "Hashing" family) — the string twin of [`super::hash_set::HashSetF64`].
//!
//! Identical algorithm, different key type and hash: keys are hashed with
//! [`super::mix_str`] (FNV-1a over the UTF-8 bytes, then SplitMix64), the table
//! doubles past load factor 0.75, and `delete` removes from the chain in place
//! so chain order is preserved (the eventual conformance corpus pins it, risk
//! R1). The cost metric is **hashes + chain-steps**. It is built from the
//! offsets+UTF-8 marshal layout (docs/PLAN.md §4.2, risk R7) via
//! [`super::decode_keys`].

use super::{decode_keys, mix_str};
use wasm_bindgen::prelude::*;

const INITIAL_BUCKETS: usize = 4;
/// Grow when `len / buckets` would exceed this.
const MAX_LOAD: f64 = 0.75;

/// A set of distinct string keys (duplicates collapse on insert — set semantics;
/// membership is what `search` answers).
#[wasm_bindgen]
pub struct HashSetStr {
    buckets: Vec<Vec<String>>,
    len: usize,
    probes: Vec<String>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3) — set absent.
    churn_key: String,
    /// Distinct keys captured at build time, in insertion order, so `teardown_all`
    /// can delete every key without an O(buckets) scan inside the timed region.
    teardown_keys: Vec<String>,
}

#[wasm_bindgen]
impl HashSetStr {
    /// Build from the first `n` keys of an offsets+UTF-8-bytes marshal buffer
    /// (docs/PLAN.md §4.2). Building (including any rehashes) is untimed; search
    /// timing starts from the built table (docs/PLAN.md §6.3).
    #[wasm_bindgen(constructor)]
    pub fn new(offsets: &[u32], bytes: &[u8], n: usize) -> HashSetStr {
        let keys = decode_keys(offsets, bytes, n);
        let mut set = HashSetStr {
            buckets: vec![Vec::new(); INITIAL_BUCKETS],
            len: 0,
            probes: Vec::new(),
            churn_key: String::new(),
            teardown_keys: Vec::new(),
        };
        for k in &keys {
            let before = set.len;
            set.insert(k);
            if set.len != before {
                set.teardown_keys.push(k.clone()); // distinct keys only
            }
        }
        set
    }

    /// Number of distinct stored keys.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Set the query workload (present + absent probe keys) from a marshal buffer.
    /// Untimed.
    pub fn set_probes(&mut self, offsets: &[u32], bytes: &[u8]) {
        self.probes = decode_keys(offsets, bytes, offsets.len().saturating_sub(1));
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
            if self.contains::<false>(&self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probes counting hashes +
    /// chain-steps, total returned as a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the set so each
    /// insert is real and the matching delete restores size. Untimed.
    pub fn set_churn_key(&mut self, key: &str) {
        self.churn_key = key.to_owned();
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size
    /// stable at ≈ n (docs/PLAN.md §6.3). Returns the delete-hit count to defeat
    /// dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key.clone();
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert_generic::<false>(&key, &mut ops);
            if self.remove_key::<false>(&key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: hashes + chain-steps of a
    /// counted insert+delete. The pair nets zero size change.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key.clone();
        let mut ops = 0u64;
        self.insert_generic::<true>(&key, &mut ops);
        let _ = self.remove_key::<true>(&key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh set of size `n` from empty by inserting each key in
    /// turn (including any rehashes — amortized into the measured cost).
    /// Differencing this across sweep points yields per-insert cost near n
    /// (finite differences, docs/PLAN.md §6.3). Returns `len` to defeat DCE.
    pub fn build_insert_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let s = HashSetStr::new(offsets, bytes, n);
        s.len as u32
    }

    /// Op-count for the cumulative build to size `n`: total hashes + chain-steps
    /// of the per-insert dedupe walks (rehash redistribution is amortized
    /// structural work and deliberately not counted, keeping the signal O(1)).
    pub fn build_insert_counted(offsets: &[u32], bytes: &[u8], n: usize) -> f64 {
        let keys = decode_keys(offsets, bytes, n);
        let mut s = HashSetStr {
            buckets: vec![Vec::new(); INITIAL_BUCKETS],
            len: 0,
            probes: Vec::new(),
            churn_key: String::new(),
            teardown_keys: Vec::new(),
        };
        let mut ops = 0u64;
        for k in &keys {
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
        let order = std::mem::take(&mut self.teardown_keys);
        for k in &order {
            if self.remove_key::<false>(k, &mut ops) {
                count += 1;
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total hashes + chain-steps to
    /// delete every distinct key (O(n) — each delete is O(1)).
    pub fn teardown_counted(offsets: &[u32], bytes: &[u8], n: usize) -> f64 {
        let mut s = HashSetStr::new(offsets, bytes, n);
        let order = s.teardown_keys.clone();
        let mut ops = 0u64;
        for k in &order {
            let _ = s.remove_key::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` set, then tear it all down, in one
    /// self-contained call. Subtracting the `build_insert_n` time isolates the
    /// teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); the constructor's insert build cancels in the subtraction.
    pub fn build_then_teardown_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let mut s = HashSetStr::new(offsets, bytes, n);
        s.teardown_all()
    }
}

impl HashSetStr {
    #[inline]
    fn bucket_index(&self, key: &str) -> usize {
        // Power-of-two bucket count => mask instead of modulo.
        (mix_str(key) as usize) & (self.buckets.len() - 1)
    }

    /// Insert with dedupe (untimed build path — no counters).
    fn insert(&mut self, key: &str) {
        let mut ops = 0u64;
        self.insert_generic::<false>(key, &mut ops);
    }

    /// The one insert algorithm, generic over whether it counts. Hash, walk the
    /// chain to dedupe (one chain-step per key compared), append on miss, then
    /// rehash if the load factor is exceeded. Counts hashes + chain-steps; rehash
    /// redistribution is amortized structural work and is not counted.
    #[inline]
    fn insert_generic<const COUNT: bool>(&mut self, key: &str, ops: &mut u64) {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(key);
        for k in &self.buckets[idx] {
            if COUNT {
                *ops += 1; // chain-step (dedupe check)
            }
            if k.as_str() == key {
                return; // already present
            }
        }
        self.buckets[idx].push(key.to_owned());
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
    fn remove_key<const COUNT: bool>(&mut self, target: &str, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(target);
        let bucket = &mut self.buckets[idx];
        let mut pos = None;
        for (i, k) in bucket.iter().enumerate() {
            if COUNT {
                *ops += 1; // chain-step
            }
            if k.as_str() == target {
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
        let mut next: Vec<Vec<String>> = vec![Vec::new(); new_count];
        for bucket in self.buckets.drain(..) {
            for k in bucket {
                let idx = (mix_str(&k) as usize) & (new_count - 1);
                next[idx].push(k);
            }
        }
        self.buckets = next;
    }

    /// The one search algorithm, generic over counting. Counts one hash plus one
    /// chain-step per key compared (docs/PLAN.md §8 cost metric).
    #[inline]
    fn contains<const COUNT: bool>(&self, target: &str, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let idx = self.bucket_index(target);
        for k in &self.buckets[idx] {
            if COUNT {
                *ops += 1; // chain-step
            }
            if k.as_str() == target {
                return true;
            }
        }
        false
    }

    /// Test/conformance helper: membership + (hashes + chain-steps) for one search.
    pub fn search_one_counted(&self, target: &str) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, hashes +
    /// chain-steps)`. Mutates the set.
    pub fn delete_one_counted(&mut self, target: &str) -> (bool, u64) {
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
    pub fn keys_in_order(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.len);
        for bucket in &self.buckets {
            out.extend(bucket.iter().cloned());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Marshal `keys` into the offsets+UTF-8 layout the constructor consumes —
    /// the test-side mirror of `src/data/marshal.ts`.
    fn marshal(keys: &[&str]) -> (Vec<u32>, Vec<u8>) {
        let mut offsets = vec![0u32];
        let mut bytes = Vec::new();
        for k in keys {
            bytes.extend_from_slice(k.as_bytes());
            offsets.push(bytes.len() as u32);
        }
        (offsets, bytes)
    }

    fn set(keys: &[&str]) -> HashSetStr {
        let (offsets, bytes) = marshal(keys);
        HashSetStr::new(&offsets, &bytes, keys.len())
    }

    #[test]
    fn membership_is_correct() {
        let s = set(&["one", "two", "three", "four", "five"]);
        assert!(s.search_one_counted("three").0);
        assert!(!s.search_one_counted("ninety-nine").0);
    }

    #[test]
    fn dedupes_on_insert() {
        let s = set(&["seven", "seven", "seven", "eight"]);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn builds_from_marshalled_offsets_including_empty_and_multibyte() {
        // Empty string, accented + CJK keys (byte-length ≠ char-length), and a
        // duplicate the set must collapse.
        let keys = ["", "a", "café", "日本", "a"];
        let s = set(&keys);
        assert_eq!(s.len(), 4); // the duplicate "a" collapsed
        assert!(s.search_one_counted("").0);
        assert!(s.search_one_counted("café").0);
        assert!(s.search_one_counted("日本").0);
        assert!(!s.search_one_counted("cafe").0); // byte-exact: "cafe" ≠ "café"
    }

    #[test]
    fn every_search_counts_at_least_the_hash() {
        let s = set(&["one", "two", "three"]);
        let (found, ops) = s.search_one_counted("two");
        assert!(found && ops >= 2); // hash + >= 1 chain-step
        let (found, ops) = s.search_one_counted("absent-key");
        assert!(!found && ops >= 1); // at least the hash
    }

    #[test]
    fn load_factor_keeps_chains_short() {
        // 1000 distinct keys: with load factor <= 0.75 the longest chain stays
        // tiny — what makes search O(1) rather than O(n).
        let keys: Vec<String> = (0..1000).map(|i| format!("key-{i}")).collect();
        let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        let s = set(&refs);
        assert_eq!(s.len(), 1000);
        assert!(s.buckets.len() >= 1024); // grew past 1000/0.75
        assert!(s.max_chain() <= 8, "max chain was {}", s.max_chain());
    }

    #[test]
    fn search_n_counts_hits() {
        let mut s = set(&["one", "two", "three"]);
        let (po, pb) = marshal(&["two", "zz"]);
        s.set_probes(&po, &pb);
        assert_eq!(s.search_n(4), 2); // [two,zz,two,zz] -> 2 hits
    }

    #[test]
    fn delete_removes_and_counts_hash_plus_chain() {
        let mut s = set(&["one", "two", "three"]);
        let (removed, ops) = s.delete_one_counted("two");
        assert!(removed && ops >= 2);
        assert_eq!(s.len(), 2);
        assert!(!s.search_one_counted("two").0); // gone
        let (removed, ops) = s.delete_one_counted("two");
        assert!(!removed && ops >= 1); // absent key still costs the hash
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn churn_holds_size_and_restores_membership() {
        let mut s = set(&["one", "two", "three"]);
        s.set_churn_key("zz"); // absent
        s.churn_n(10);
        assert_eq!(s.len(), 3);
        assert!(!s.search_one_counted("zz").0); // churn key not left behind
        assert!(s.churn_counted() >= 2.0); // >= insert hash + delete hash
        assert_eq!(s.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_and_teardown_round_trip() {
        let keys: Vec<String> = (0..50).map(|i| format!("k{i}")).collect();
        let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        let (offsets, bytes) = marshal(&refs);
        assert_eq!(HashSetStr::build_insert_n(&offsets, &bytes, 50), 50);
        let build_ops = HashSetStr::build_insert_counted(&offsets, &bytes, 50);
        assert!(build_ops >= 50.0); // ~one hash + a short dedupe walk per key

        let mut s = HashSetStr::new(&offsets, &bytes, 50);
        assert_eq!(s.teardown_all(), 50);
        assert_eq!(s.len(), 0);
        let teardown_ops = HashSetStr::teardown_counted(&offsets, &bytes, 50);
        assert!(teardown_ops >= 50.0 && teardown_ops < 50.0 * 8.0);
    }

    #[test]
    fn teardown_keys_are_distinct_despite_duplicates() {
        let mut s = set(&["x", "x", "y", "x", "z"]);
        assert_eq!(s.len(), 3);
        assert_eq!(s.teardown_all(), 3); // not 5
        assert_eq!(s.len(), 0);
    }
}
