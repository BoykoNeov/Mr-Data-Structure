//! Unsorted dynamic array (docs/PLAN.md §8, "Linear" family).
//!
//! Search is a linear scan from the front; the cost metric is **comparisons**
//! (one per element examined). It is the deliberate O(n)-search foil to the hash
//! set in the Phase 2 thin slice (docs/PLAN.md §10): on a size sweep its search
//! cost must rise linearly while the hash set stays flat.

use wasm_bindgen::prelude::*;

/// An unsorted list of `f64` keys (a multiset — duplicates are kept, matching the
/// data layer's "never dedupe" rule; membership is unaffected by multiplicity).
#[wasm_bindgen]
pub struct ArrayF64 {
    data: Vec<f64>,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2).
    probes: Vec<f64>,
}

#[wasm_bindgen]
impl ArrayF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> ArrayF64 {
        let n = n.min(keys.len());
        ArrayF64 { data: keys[..n].to_vec(), probes: Vec::new() }
    }

    /// Number of stored keys (`n`).
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` searches, cycling through the stored probes.
    /// Returns the number of hits — consumed by the caller so the optimizer can't
    /// elide the work (docs/PLAN.md §6.2). No op-counting overhead (`COUNT=false`).
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

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`,
    /// returning total comparisons. `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }
}

impl ArrayF64 {
    /// The one search algorithm, generic over whether it counts. With
    /// `COUNT=false` the `*ops` increment is dead code and is removed entirely.
    #[inline]
    fn contains<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        for &k in &self.data {
            if COUNT {
                *ops += 1;
            }
            if k == target {
                return true;
            }
        }
        false
    }

    /// Test/conformance helper: membership plus the comparison count for one
    /// search (the cost metric for this structure).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Stored keys in insertion order — the array's iteration order. A
    /// conformance hook (docs/PLAN.md §12); not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        self.data.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arr(keys: &[f64]) -> ArrayF64 {
        ArrayF64::new(keys, keys.len())
    }

    #[test]
    fn comparisons_equal_position_when_found() {
        let a = arr(&[10.0, 20.0, 30.0]);
        assert_eq!(a.search_one_counted(10.0), (true, 1));
        assert_eq!(a.search_one_counted(20.0), (true, 2));
        assert_eq!(a.search_one_counted(30.0), (true, 3));
    }

    #[test]
    fn absent_key_scans_whole_array() {
        let a = arr(&[10.0, 20.0, 30.0]);
        assert_eq!(a.search_one_counted(99.0), (false, 3));
    }

    #[test]
    fn keeps_duplicates() {
        let a = arr(&[5.0, 5.0, 5.0]);
        assert_eq!(a.len(), 3);
        // First match short-circuits at position 1.
        assert_eq!(a.search_one_counted(5.0), (true, 1));
    }

    #[test]
    fn constructor_honors_n() {
        let a = ArrayF64::new(&[1.0, 2.0, 3.0, 4.0], 2);
        assert_eq!(a.len(), 2);
        assert_eq!(a.search_one_counted(3.0), (false, 2));
    }

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut a = arr(&[1.0, 2.0, 3.0]);
        a.set_probes(&[2.0, 99.0]); // one present, one absent
        // 4 searches over [2,99,2,99] => 2 hits.
        assert_eq!(a.search_n(4), 2);
    }

    #[test]
    fn search_counted_sums_over_probes() {
        let mut a = arr(&[1.0, 2.0, 3.0]);
        a.set_probes(&[1.0, 99.0]); // 1 comparison (hit pos 1) + 3 (full scan)
        assert_eq!(a.search_counted(), 4.0);
    }
}
