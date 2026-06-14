//! Hash set with **separate chaining** (docs/PLAN.md §8, "Hashing" family — the
//! canonical v1 hash structure).
//!
//! Search hashes the key once, then walks the chain in that bucket comparing
//! keys. The cost metric is **hashes + chain-steps**. Buckets are a power of two
//! (index by mask) and the table doubles when the load factor would exceed 0.75,
//! so chains stay short and search reads as O(1) — the flat foil to the array's
//! O(n) search in the Phase 2 thin slice (docs/PLAN.md §10).

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
        };
        for &k in &keys[..n] {
            set.insert(k);
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
}

impl HashSetF64 {
    #[inline]
    fn bucket_index(&self, key: f64) -> usize {
        // Power-of-two bucket count => mask instead of modulo.
        (mix_f64(key) as usize) & (self.buckets.len() - 1)
    }

    /// Insert with dedupe (untimed build path — no counters).
    fn insert(&mut self, key: f64) {
        let idx = self.bucket_index(key);
        if self.buckets[idx].iter().any(|&k| k == key) {
            return;
        }
        self.buckets[idx].push(key);
        self.len += 1;
        if self.len as f64 > MAX_LOAD * self.buckets.len() as f64 {
            self.rehash();
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

    /// Longest chain — a test hook proving the load-factor policy keeps chains
    /// short (so search is genuinely O(1), not a disguised linear scan).
    pub fn max_chain(&self) -> usize {
        self.buckets.iter().map(|b| b.len()).max().unwrap_or(0)
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
}
