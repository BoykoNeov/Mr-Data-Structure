//! Sorted dynamic array (docs/PLAN.md §8, "Linear" family) — the production/bench
//! twin of the TypeScript teaching impl (`src/structures/sortedArray.ts`).
//!
//! Semantics: a **sorted multiset** — keys are kept ascending and duplicates are
//! retained (the data layer never dedupes, docs/PLAN.md "Keys are identity"). `search`
//! is a **binary search**, so it is the O(log n) "missing middle" between the unsorted
//! array's O(n) scan and the hash set's O(1) lookup (docs/PLAN.md §8). `insert`
//! binary-searches the slot then shifts the tail **right** to open a gap; `delete`
//! binary-searches the key then shifts the tail **left** to compact.
//!
//! **Cost metric — comparisons + shifts (docs/PLAN.md §8); the R1 conformance
//! contract.** The op-count is the binary-search comparisons (one per midpoint
//! examined) **plus** the elements moved by the shift. The comparison count is the
//! drift-prone half: it must match `sortedArray.ts`'s `locate` *exactly* —
//! `mid = (lo + hi) / 2` (a floored midpoint, == JS `>>> 1`), **one** comparison per
//! midpoint, the `==` match short-circuit checked **before** the `<` branch, a
//! half-open `lo < hi` window. A port that counted both `==` and `<` (2× drift), used
//! an inclusive `lo <= hi`, or a `match v.cmp(&target)` would diverge on per-probe
//! op-count, which the `conformance/corpus-sarr.txt` corpus catches.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly
//! as the other structures: one algorithm, the `*ops` increments compiled away on the
//! timed hot path, alive on the op-count signal.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3).** Mirroring `ArrayF64`, the
//! `#[wasm_bindgen]` impl exposes the batched primitives `measure.ts` times:
//! `search_n`/`search_counted` (size-preserving), the `churn_n`/`churn_counted` primary
//! (insert+delete pairs at fixed n), and the `build_insert_*`/`teardown_*` cumulative
//! cross-check. **Two mutation specifics differ from the trees and the unsorted array:**
//!   1. **Churn rides the *front*, not the tail.** The caller sets the churn key to
//!      `min − 1`, so each insert/delete lands at index 0 and shifts the **whole array**
//!      — O(n). A *tail* key (`max + 1`, what the unsorted array and trees use) would
//!      append/pop with **zero** shifts and read O(log n) — and unlike the BST's cheap
//!      right spine (same O(log n) *class* as the average path, only a constant cheaper),
//!      the tail of a sorted array is a different *class* than the average position. Tail
//!      churn would therefore mislabel the structure's mutation as O(log n); front churn
//!      reports the honest O(n) (docs/PLAN.md §2.3, §6.3).
//!   2. **The build must see shuffled input to read O(n).** `build_insert_counted` on
//!      *ascending* keys is all appends (0 shifts) → O(n log n), so `insert_fd` would read
//!      O(log n) and contradict the O(n) churn in the same proof. The engine and the
//!      self-test feed a shuffled dataset so build inserts land at average depth (≈ n/2
//!      shifts) and `insert_fd`, `delete_fd`, and churn all read O(n) coherently.
//! Teardown deletes the current **minimum** (the front) repeatedly — mirroring
//! `ArrayF64::teardown_all`'s front-first delete — so each delete shifts the whole tail
//! (O(n)) and the cumulative teardown is O(n²), the same shape the front churn probes.

use wasm_bindgen::prelude::*;

/// A sorted list of `f64` keys (a multiset — duplicates are kept, matching the data
/// layer's "never dedupe" rule; membership is unaffected by multiplicity).
#[wasm_bindgen]
pub struct SortedArrayF64 {
    /// Always kept in ascending order; this *is* the iteration order.
    data: Vec<f64>,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2). Mirrors `ArrayF64`.
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). The caller sets it to
    /// a value absent from `data` — the engine uses `min − 1`, so it lands at the front and
    /// each churn op shifts the whole array (the honest O(n), not the tail's O(log n)).
    churn_key: f64,
}

#[wasm_bindgen]
impl SortedArrayF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`, inserting each in
    /// turn so the array sorts itself (insertion order is irrelevant to the result).
    /// Mirrors the Phase 2 constructors' `(keys, n)` shape.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> SortedArrayF64 {
        let n = n.min(keys.len());
        let mut a = SortedArrayF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            a.insert::<false>(k, &mut ops);
        }
        a
    }

    /// Number of stored keys (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    // ── Search: size-preserving (docs/PLAN.md §6.3) ──

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` binary searches, cycling through the stored probes.
    /// Returns the hit count so the optimizer can't elide the work (docs/PLAN.md §6.2).
    /// No op-counting overhead (`COUNT=false`).
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.locate::<false>(self.probes[i % len], &mut ops).1 {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`, returning
    /// total comparisons (binary search is shift-free, so search cost is comparisons only).
    /// `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.locate::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent so each insert is real and
    /// the matching delete restores size. The engine passes `min − 1`, which lands at the
    /// front so each op shifts the whole array (the honest O(n)). Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size stable at
    /// ≈ n (docs/PLAN.md §6.3). Isolates the per-op mutation cost at a fixed n — you cannot
    /// time a batch of plain inserts because each one changes n. With the front key each
    /// pair shifts the whole array twice (≈ 2n). Returns the delete-hit count to defeat
    /// dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key;
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert::<false>(key, &mut ops);
            if self.delete::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the comparisons + shifts of a counted
    /// insert+delete of the churn key. The pair nets zero size change, so state is unchanged
    /// afterwards. With the front key this is ≈ 2n shifts + 2·⌈log n⌉ comparisons.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        let _ = self.delete::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh array of size `n` from empty by inserting each key in turn.
    /// Differencing this across sweep points yields per-insert cost near n (finite
    /// differences, docs/PLAN.md §6.3). On shuffled input each insert shifts ≈ half the
    /// array, so this is O(n²). Returns the length to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        SortedArrayF64::new(keys, n).len() as u32
    }

    /// Op-count for the cumulative build to size `n`: total comparisons + shifts to insert
    /// the first `n` keys. Unlike the unsorted array's zero-op append, a sorted insert
    /// shifts to keep order — on shuffled input Σ ≈ n²/4 (O(n²)); on ascending input it is
    /// all appends (0 shifts), so the caller must feed shuffled keys (see the module doc).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut a = SortedArrayF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            a.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key by repeatedly removing the current minimum (the
    /// front), leaving the array empty (docs/PLAN.md §6.3 teardown). Front-first like
    /// `ArrayF64::teardown_all`, so each delete shifts the whole tail left (O(n)) and the
    /// total is O(n²) — the same shift-dominated shape the front churn probes. Returns the
    /// delete count to defeat DCE. No op-counting overhead (`COUNT=false`).
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(&k) = self.data.first() {
            self.delete::<false>(k, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons + shifts to delete every key
    /// front-first (Σ over the shrinking array — O(n²)). Built untimed via `new`, then counted.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut a = SortedArrayF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(&k) = a.data.first() {
            a.delete::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` array via inserts, then tear it all down front-first,
    /// in one self-contained call. Subtracting the `build_insert_n` time isolates the
    /// teardown — the delete side of the finite-difference method (docs/PLAN.md §6.3); the
    /// identical insert build path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        let mut a = SortedArrayF64::new(keys, n);
        a.teardown_all()
    }
}

impl SortedArrayF64 {
    /// An empty array.
    pub fn new_empty() -> SortedArrayF64 {
        SortedArrayF64 { data: Vec::new(), probes: Vec::new(), churn_key: 0.0 }
    }

    /// Whether the array holds no keys.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Binary search over the half-open window `[lo, hi)`, returning `(index, found)`.
    /// On a hit `index` is the matching slot; on a miss it is the insertion point that keeps
    /// the array sorted. Counts **one** comparison per midpoint (the `==` match included),
    /// short-circuiting on a hit — the exact shape of `sortedArray.ts`'s `locate`, the R1
    /// contract (see the module doc). `mid = lo + (hi - lo) / 2` floors identically to JS
    /// `(lo + hi) >>> 1` while never overflowing.
    #[inline]
    fn locate<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> (usize, bool) {
        let mut lo = 0usize;
        let mut hi = self.data.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if COUNT {
                *ops += 1;
            }
            let v = self.data[mid];
            if v == target {
                return (mid, true);
            }
            if v < target {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        (lo, false)
    }

    /// Insert `key`, keeping the array sorted (multiset — duplicates retained). Binary-search
    /// the slot (comparisons), then shift the tail right to open the gap (one shift per
    /// survivor moved = `len − index`) and drop `key` in. With duplicates the insertion point
    /// is *some* valid slot — order is unaffected, since the moved keys are identical values.
    #[inline]
    fn insert<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        let (i, _found) = self.locate::<COUNT>(key, ops);
        if COUNT {
            *ops += (self.data.len() - i) as u64; // shifts to open the gap
        }
        self.data.insert(i, key);
    }

    /// Delete the first occurrence found by binary search: shift the tail left to close the
    /// gap (one shift per survivor moved = `len − 1 − index`), then drop the duplicated tail
    /// slot. Returns whether a key was removed. Cost = comparisons + shifts (docs/PLAN.md §8).
    #[inline]
    fn delete<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        let (i, found) = self.locate::<COUNT>(target, ops);
        if !found {
            return false;
        }
        if COUNT {
            *ops += (self.data.len() - 1 - i) as u64; // shifts to compact
        }
        self.data.remove(i);
        true
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the comparison count for one search (binary search is shift-free).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.locate::<true>(target, &mut ops).1;
        (found, ops)
    }

    /// Insert one key, returning the comparisons + shifts. Mutates.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        ops
    }

    /// Delete the first occurrence of `target`, returning `(removed, comparisons + shifts)`.
    /// Mutates.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Stored keys in ascending (= iteration) order. A conformance hook (docs/PLAN.md §12);
    /// not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        self.data.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sarr(keys: &[f64]) -> SortedArrayF64 {
        SortedArrayF64::new(keys, keys.len())
    }

    #[test]
    fn sorts_itself_regardless_of_input_order() {
        let a = sarr(&[50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0]);
        assert_eq!(a.keys_in_order(), vec![20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0]);
        assert_eq!(a.len(), 7);
    }

    #[test]
    fn keeps_duplicates_in_a_run() {
        let a = sarr(&[5.0, 9.0, 5.0, 7.0, 5.0]);
        assert_eq!(a.keys_in_order(), vec![5.0, 5.0, 5.0, 7.0, 9.0]);
    }

    /// The R1 comparison-count contract, hand-verified against `sortedArray.ts`'s `locate`
    /// on `[10,20,30,40,50]`: `search(50)` = (true, 2) via 30→50, `search(35)` = (false, 3)
    /// via 30→50→40. A 2× drift (counting both `==` and `<`) would read 4 and 6.
    #[test]
    fn binary_search_counts_one_comparison_per_midpoint() {
        let a = sarr(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert_eq!(a.search_one_counted(30.0), (true, 1)); // mid hits immediately
        assert_eq!(a.search_one_counted(50.0), (true, 2)); // 30(<) → 50(=)
        assert_eq!(a.search_one_counted(10.0), (true, 3)); // 30(>) → 20(>) → 10(=)
        assert_eq!(a.search_one_counted(35.0), (false, 3)); // 30(<) → 50(>) → 40(>), lands at 3
        assert_eq!(a.search_one_counted(99.0), (false, 2)); // 30(<) → 50(<), lo runs off the end
    }

    #[test]
    fn empty_and_singleton_search() {
        let a = sarr(&[]);
        assert_eq!(a.search_one_counted(1.0), (false, 0));
        let a = sarr(&[42.0]);
        assert_eq!(a.search_one_counted(42.0), (true, 1));
        assert_eq!(a.search_one_counted(7.0), (false, 1));
    }

    #[test]
    fn insert_counts_comparisons_plus_shifts_to_open_the_gap() {
        // Insert 25 into [10,20,30,40,50]: binary search lands the slot, then the tail
        // [30,40,50] (3 elements) shifts right.
        let mut a = sarr(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        let ops = a.insert_one_counted(25.0);
        assert_eq!(a.keys_in_order(), vec![10.0, 20.0, 25.0, 30.0, 40.0, 50.0]);
        // locate(25): 30(>)→20(<)→ slot at index 2; 2 comparisons + 3 shifts = 5.
        assert_eq!(ops, 5);
        // Append at the end shifts nothing.
        let mut b = sarr(&[10.0, 20.0, 30.0]);
        let ops = b.insert_one_counted(99.0); // locate → index 3, 0 shifts
        assert_eq!(b.keys_in_order(), vec![10.0, 20.0, 30.0, 99.0]);
        assert_eq!(ops, 2); // 20(≠,<)→30(≠,<)→ end; 2 comparisons, 0 shifts
    }

    #[test]
    fn delete_counts_comparisons_plus_shifts_to_compact() {
        // Delete the front of [10,20,30,40,50]: the tail of 4 shifts left.
        let mut a = sarr(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        let (removed, ops) = a.delete_one_counted(10.0);
        assert!(removed);
        assert_eq!(a.keys_in_order(), vec![20.0, 30.0, 40.0, 50.0]);
        // locate(10): 30(>)→20(>)→10(=) at index 0; 3 comparisons + 4 shifts = 7.
        assert_eq!(ops, 7);
        // Delete the tail: 0 shifts.
        let mut b = sarr(&[10.0, 20.0, 30.0]);
        let (removed, ops) = b.delete_one_counted(30.0);
        assert!(removed);
        assert_eq!(b.keys_in_order(), vec![10.0, 20.0]);
        assert_eq!(ops, 2); // locate(30): 20(<)→30(=) index 2; 2 comparisons, 0 shifts
        // Absent key: comparisons only, nothing removed.
        assert_eq!(b.delete_one_counted(99.0), (false, 1));
    }

    #[test]
    fn delete_removes_only_one_duplicate() {
        let mut a = sarr(&[5.0, 5.0, 5.0, 7.0]);
        assert_eq!(a.delete_one_counted(5.0).0, true);
        assert_eq!(a.keys_in_order(), vec![5.0, 5.0, 7.0]); // one 5 remains
        assert_eq!(a.len(), 3);
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut a = sarr(&[1.0, 2.0, 3.0]);
        a.set_probes(&[2.0, 99.0]); // one present, one absent
        assert_eq!(a.search_n(4), 2); // [2,99,2,99] => 2 hits
    }

    #[test]
    fn search_counted_sums_comparisons_over_probes() {
        // [1,2,3]: search(1)=2 (2→1), search(99)=2 (2→3, then miss). Total 4.
        let mut a = sarr(&[1.0, 2.0, 3.0]);
        a.set_probes(&[1.0, 99.0]);
        assert_eq!(a.search_counted(), 4.0);
    }

    #[test]
    fn front_churn_holds_size_and_shifts_the_whole_array() {
        // [10,20,30]: front key 9 (< min) lands at index 0. insert(9): locate 20(>)→10(>)
        // → index 0 (2 comparisons) + 3 shifts = 5; the array is now [9,10,20,30].
        // delete(9): locate 20(>)→10(>)→9(=) index 0 (3 comparisons) + 3 shifts = 6.
        // churn = 5 + 6 = 11. The pair nets zero, so size and order are restored.
        let mut a = sarr(&[10.0, 20.0, 30.0]);
        a.set_churn_key(9.0);
        a.churn_n(5);
        assert_eq!(a.len(), 3);
        assert_eq!(a.keys_in_order(), vec![10.0, 20.0, 30.0]);
        assert_eq!(a.churn_counted(), 11.0);
        assert_eq!(a.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_insert_counted_shifts_on_shuffled_but_appends_on_ascending() {
        // Ascending input: every insert appends, 0 shifts — only comparisons.
        // [0,1,2,3]: per-insert comparisons 0,1,1,2 ⇒ 4; never any shift.
        assert_eq!(SortedArrayF64::build_insert_n(&[0.0, 1.0, 2.0, 3.0], 4), 4);
        assert_eq!(SortedArrayF64::build_insert_counted(&[0.0, 1.0, 2.0, 3.0], 4), 4.0);
        // Reverse input forces a shift on every insert (each new key is the new minimum):
        // [3,2,1,0]: insert 3 (0), 2 (1 cmp + 1 shift = 2), 1 (2 cmp + 2 shifts = 4),
        // 0 (2 cmp + 3 shifts = 5) = 0 + 2 + 4 + 5 = 11.
        assert_eq!(SortedArrayF64::build_insert_counted(&[3.0, 2.0, 1.0, 0.0], 4), 11.0);
    }

    #[test]
    fn teardown_empties_front_first_and_counts_quadratically() {
        let keys = [10.0, 20.0, 30.0];
        let mut a = SortedArrayF64::new(&keys, 3);
        assert_eq!(a.teardown_all(), 3);
        assert!(a.is_empty());
        // Front-first teardown of [10,20,30]: delete 10 (locate 20→10: 2 cmp + 2 shifts = 4),
        // delete 20 from [20,30] (locate 30→20: 2 cmp + 1 shift = 3), delete 30 (1 cmp + 0 = 1).
        // Total 4 + 3 + 1 = 8.
        assert_eq!(SortedArrayF64::teardown_counted(&keys, 3), 8.0);
    }

    #[test]
    fn build_then_teardown_empties_the_array() {
        assert_eq!(SortedArrayF64::build_then_teardown_n(&[5.0, 3.0, 8.0, 1.0], 4), 4);
    }
}
