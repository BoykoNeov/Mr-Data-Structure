//! Unsorted dynamic array (docs/PLAN.md §8, "Linear" family).
//!
//! Search is a linear scan from the front; the cost metric is **comparisons**
//! (one per element examined). It is the deliberate O(n)-search foil to the hash
//! set in the Phase 2 thin slice (docs/PLAN.md §10): on a size sweep its search
//! cost must rise linearly while the hash set stays flat.
//!
//! **Mutation (docs/PLAN.md §6.3, §8).** `insert` is an append — O(1) amortized,
//! zero comparisons/shifts. `delete` is the **ordered shift-compact** algorithm:
//! linear-scan for the first occurrence (comparisons), then shift the tail left
//! to close the gap (shifts). Cost metric = comparisons + shifts. Swap-remove is
//! deliberately *not* used: it would reorder elements and break the iteration
//! order that the eventual TS teaching twin + conformance corpus pin (risk R1).

use wasm_bindgen::prelude::*;

/// An unsorted list of `f64` keys (a multiset — duplicates are kept, matching the
/// data layer's "never dedupe" rule; membership is unaffected by multiplicity).
#[wasm_bindgen]
pub struct ArrayF64 {
    data: Vec<f64>,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2).
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). The caller
    /// sets it to a value absent from `data` so each insert is real and the
    /// matching delete restores size — holding n stable across the batch.
    churn_key: f64,
}

#[wasm_bindgen]
impl ArrayF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> ArrayF64 {
        let n = n.min(keys.len());
        ArrayF64 { data: keys[..n].to_vec(), probes: Vec::new(), churn_key: 0.0 }
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

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the data so
    /// each insert is real and the matching delete restores size. Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size
    /// stable at ≈ n (docs/PLAN.md §6.3). This isolates the per-op mutation cost
    /// at a fixed n — you cannot time a batch of plain inserts because each one
    /// changes n. Returns the delete-hit count to defeat dead-code elimination.
    /// No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key;
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.data.push(key); // insert (append, O(1))
            if self.remove_first::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the comparisons + shifts of a
    /// counted insert+delete. The pair nets zero size change, so state is
    /// unchanged afterwards. The append contributes no comparisons/shifts, so the
    /// pair's cost is the delete's (a full scan to the tail-appended key).
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.data.push(key);
        let _ = self.remove_first::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh array of size `n` from empty by appending each key in
    /// turn (no pre-reserved capacity, so realloc growth is part of the measured
    /// cost). Differencing this across sweep points yields per-insert cost near n
    /// (finite differences, docs/PLAN.md §6.3). Returns the length to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        let n = n.min(keys.len());
        let mut data: Vec<f64> = Vec::new();
        for &k in &keys[..n] {
            data.push(k);
        }
        data.len() as u32
    }

    /// Op-count for the cumulative build to size `n`. An array append performs no
    /// comparisons and no shifts, so the build's op-count is identically zero —
    /// the deterministic counterpart of insert's O(1) wall-clock cost.
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let _ = (keys, n);
        0.0
    }

    /// Timed: delete every stored key, front-first, leaving the array empty
    /// (docs/PLAN.md §6.3 teardown). Built untimed by the caller via `new`; only
    /// this call is timed. Differencing total teardown time across sweep points
    /// yields per-delete cost near n. Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(&k) = self.data.first() {
            self.remove_first::<false>(k, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons + shifts to
    /// delete every key front-first (Σ over the shrinking array — O(n²)).
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut a = ArrayF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(&k) = a.data.first() {
            a.remove_first::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` array via inserts, then tear it all down,
    /// in one self-contained call. Subtracting the `build_insert_n` time isolates
    /// the teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); building via the same append path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        let n = n.min(keys.len());
        let mut a = ArrayF64 { data: Vec::new(), probes: Vec::new(), churn_key: 0.0 };
        for &k in &keys[..n] {
            a.data.push(k);
        }
        a.teardown_all()
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

    /// The one delete algorithm, generic over whether it counts. Linear-scan for
    /// the first occurrence (one comparison per element examined), then shift the
    /// tail left to close the gap (one shift per element moved). Returns whether a
    /// key was removed. Cost metric = comparisons + shifts (docs/PLAN.md §8).
    #[inline]
    fn remove_first<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        let mut found = None;
        for (i, &k) in self.data.iter().enumerate() {
            if COUNT {
                *ops += 1; // comparison
            }
            if k == target {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                if COUNT {
                    *ops += (self.data.len() - 1 - i) as u64; // shifts to compact
                }
                self.data.remove(i);
                true
            }
            None => false,
        }
    }

    /// Test/conformance helper: membership plus the comparison count for one
    /// search (the cost metric for this structure).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: delete the first occurrence of `target`,
    /// returning `(removed, comparisons + shifts)`. Mutates the array.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.remove_first::<true>(target, &mut ops);
        (removed, ops)
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

    #[test]
    fn delete_counts_comparisons_plus_shifts() {
        // Remove the front of [10,20,30]: 1 comparison + 2 shifts to compact.
        let mut a = arr(&[10.0, 20.0, 30.0]);
        assert_eq!(a.delete_one_counted(10.0), (true, 3));
        assert_eq!(a.keys_in_order(), vec![20.0, 30.0]);
        // Remove the tail of [20,30]: 2 comparisons (full scan) + 0 shifts.
        assert_eq!(a.delete_one_counted(30.0), (true, 2));
        assert_eq!(a.keys_in_order(), vec![20.0]);
        // Absent key: full scan, nothing removed.
        assert_eq!(a.delete_one_counted(99.0), (false, 1));
    }

    #[test]
    fn delete_removes_only_first_occurrence() {
        let mut a = arr(&[5.0, 5.0, 7.0]);
        assert_eq!(a.delete_one_counted(5.0).0, true);
        assert_eq!(a.keys_in_order(), vec![5.0, 7.0]); // one 5 remains
    }

    #[test]
    fn churn_holds_size_and_counts_the_delete_scan() {
        let mut a = arr(&[1.0, 2.0, 3.0]);
        a.set_churn_key(99.0); // absent
        a.churn_n(10); // 10 insert+delete pairs
        assert_eq!(a.len(), 3); // size restored
        assert_eq!(a.keys_in_order(), vec![1.0, 2.0, 3.0]);
        // One pair: append 99 at the tail (0 ops) then delete it — found at the
        // tail of the size-4 array => 4 comparisons + 0 shifts.
        assert_eq!(a.churn_counted(), 4.0);
        assert_eq!(a.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_insert_is_free_of_comparisons_and_shifts() {
        let keys = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(ArrayF64::build_insert_n(&keys, 3), 3);
        assert_eq!(ArrayF64::build_insert_counted(&keys, 3), 0.0); // append-only
    }

    #[test]
    fn teardown_empties_and_counts_quadratically() {
        let keys = [1.0, 2.0, 3.0];
        let mut a = ArrayF64::new(&keys, 3);
        assert_eq!(a.teardown_all(), 3);
        assert_eq!(a.len(), 0);
        // Front-first teardown of size 3: (1 cmp + 2 shifts) + (1 + 1) + (1 + 0)
        // = 3 + 2 + 1 = 6.
        assert_eq!(ArrayF64::teardown_counted(&keys, 3), 6.0);
    }
}
