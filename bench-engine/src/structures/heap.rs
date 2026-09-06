//! Binary **min-heap** (docs/PLAN.md §8, "Trees / heaps" family) — the production/bench
//! twin of the TypeScript teaching impl (`src/structures/heap.ts`).
//!
//! Semantics: the classic **array-backed complete tree** — position `i`'s children are
//! `2i+1` / `2i+2`, its parent `⌊(i-1)/2⌋` — holding a **multiset** (duplicates kept;
//! docs/PLAN.md "Keys are identity; never dedupe"). No arena and no recursion: every
//! sift is a loop over the one `Vec`, and a heap's height is `⌊log₂ n⌋` by construction,
//! so unlike the BST there is no degenerate-chain stack hazard to design around.
//!
//! **A different op set (docs/PLAN.md §4.1, §8): insert / peek / extract-min.** A heap is
//! ordered for *extract-min*, not for membership, so `search` exists only as the deliberate
//! **O(n) linear-scan contrast** — the demo that searching a heap is no better than
//! scanning an unsorted array. Because the op set differs, the heap is compared only
//! **within its own group** and never merged into the canonical insert/search/delete
//! charts (docs/PLAN.md §8, risk R6); that separation is enforced in the UI
//! (`src/ui/CompareSection.tsx`), while the measurement layer reuses the shared runners.
//!
//! **Cost metric — comparisons + swaps (docs/PLAN.md §8); the R1 conformance contract.**
//! The op-count is key comparisons **plus** swaps. Six counting rules must match
//! `heap.ts` exactly or the `conformance/corpus-heap.txt` corpus diverges:
//!   1. The comparison that **fails** and terminates a sift **is** counted.
//!   2. Sift-down's child-vs-child comparison happens **only when a right child exists**
//!      (`r < n`). A port that always compares both children over-counts on the last parent.
//!   3. The child tie-break is `heap[r] < heap[l]`, so **equal children pick the left**.
//!      A `<=` port picks the right and builds a different array layout on duplicate keys.
//!   4. Insert's sift-up test is the strict `heap[i] < heap[p]`, so **equal keys don't swap**.
//!   5. Extract-min on a heap that the pop **empties** returns **0 ops** — the sift loop is
//!      never entered.
//!   6. The structural `heap[0] = last` refill is **not** a compare-driven swap and is
//!      **not** counted (nor is the tail `push` of an insert).
//! The `duplicates` corpus case is what discriminates rules 3 and 4: extracted *values*
//! come out sorted whatever the tie-break does, so only the pinned **array layout** catches
//! a divergence there.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly as
//! the other structures: one algorithm, the `*ops` increments compiled away on the timed hot
//! path, alive on the op-count signal.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3).** Mirroring `ArrayF64`, the
//! `#[wasm_bindgen]` impl exposes the batched primitives `measure.ts` times:
//! `search_n`/`search_counted` (size-preserving), the `churn_n`/`churn_counted` primary, and
//! the `build_insert_*`/`teardown_*` cumulative cross-check. **Two heap specifics:**
//!
//!   1. **Churn is `insert(min − 1)` + `extract_min()`, and the low key is not a
//!      preference — it is the only mechanically valid choice.** A heap has no
//!      delete-by-value in its op set, so a churn pair must be insert-then-extract-*min*.
//!      With a high key (`max + 1`) the insert lands at the tail and the extract then
//!      removes a **real** key: the heap drains, size is not preserved, and after n pairs
//!      there is nothing left to measure. With `min − 1` the inserted key is strictly below
//!      every stored key, so it sifts to the root and is exactly what the extract removes —
//!      the pair restores the **multiset** every time (usually the exact layout too; a tie
//!      among children can permute equal keys, which changes nothing observable). Two
//!      consequences worth stating: the stored minimum never moves, so **one**
//!      `set_churn_key` before the timed loop stays valid for every pair; and the probe
//!      rides the **full height** in both halves, so it reports the honest Θ(log n) class.
//!   2. **Churn's insert is the *worst-case* insert, so the constant runs high.** A random
//!      key sifts up O(1) levels in expectation (most of a heap is leaves), while a new
//!      global minimum always climbs the full `⌊log₂ n⌋`. Same class, biased constant —
//!      the mirror image of the trees' spine churn, which runs *low* (docs/METHODOLOGY.md
//!      §4.1, §4.2). Read the heap's churn curve for its **shape**, not its absolute ns.
//!
//! **The build is strongly input-order-sensitive** — more so than the trees, and in the
//! opposite direction to what the sorted-array module warns about. On **ascending** input
//! every insert is a new maximum: it stays at the tail after one failed comparison, so the
//! build is Θ(n) and `insert_fd` reads ≈ 1 (flat). On **descending** input every insert is a
//! new minimum and climbs to the root, so the build is Θ(n log n) and `insert_fd` reads
//! ≈ 2·log n. Churn itself is order-insensitive (always full-height), which is why the heap
//! is **not** `shapeSensitive` in the registry — only the finite-difference *insert* half
//! moves with input order, and both regimes are honest readings of the same structure.
//!
//! Teardown is repeated `extract_min` to empty — heapsort, Θ(n log n) — which keeps the
//! finite-difference delete on exactly the path churn's extract half probes.

use wasm_bindgen::prelude::*;

/// A binary min-heap over `f64` keys (a multiset — duplicates are kept, matching the data
/// layer's "never dedupe" rule).
#[wasm_bindgen]
pub struct MinHeapF64 {
    /// The complete tree, flattened; index 0 is the root (the minimum). This *is* the
    /// structure's observable shape — the multiset alone does not determine it.
    heap: Vec<f64>,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2). Mirrors `ArrayF64`.
    probes: Vec<f64>,
    /// The spare key inserted by each `churn_n` pair (docs/PLAN.md §6.3). The caller sets it
    /// to `min − 1` — strictly below every stored key, so it sifts to the root and is exactly
    /// what the pair's `extract_min` removes, holding size and contents stable (see the
    /// module doc: a high key would drain the heap instead).
    churn_key: f64,
}

#[wasm_bindgen]
impl MinHeapF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`, inserting each in turn
    /// so each sifts up into place. Mirrors the Phase 2 constructors' `(keys, n)` shape.
    /// Insertion order fixes the layout (though not the multiset) — see the module doc on
    /// the build's order-sensitivity.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> MinHeapF64 {
        let n = n.min(keys.len());
        let mut h = MinHeapF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            h.insert::<false>(k, &mut ops);
        }
        h
    }

    /// Number of stored keys (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.heap.len()
    }

    // ── Search: the O(n) contrast, size-preserving (docs/PLAN.md §6.3, §8) ──

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` linear scans, cycling through the stored probes. Returns
    /// the hit count so the optimizer can't elide the work (docs/PLAN.md §6.2). No
    /// op-counting overhead (`COUNT=false`).
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.scan::<false>(self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`, returning total
    /// comparisons (a scan performs no swaps). `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.scan::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key each churn pair inserts. Must be **strictly below every stored key**
    /// — the engine passes `min − 1` — so it sifts to the root and the pair's `extract_min`
    /// removes exactly it, restoring the multiset. A key above the minimum would make the
    /// extract remove a *real* key and drain the heap (module doc). Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert + extract-min *pairs* of the churn key, holding size stable
    /// at ≈ n (docs/PLAN.md §6.3). Isolates the per-op mutation cost at a fixed n — you cannot
    /// time a batch of plain inserts because each one changes n. Both halves ride the full
    /// height, so each pair costs ≈ 3·log n comparisons + swaps. Returns the extract-hit count
    /// to defeat dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key;
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert::<false>(key, &mut ops);
            if self.extract_min::<false>(&mut ops).is_some() {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the comparisons + swaps of a counted
    /// insert + extract-min of the churn key. The pair nets zero size change and restores the
    /// stored multiset, so the heap is measurement-equivalent afterwards.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        let _ = self.extract_min::<true>(&mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh heap of size `n` from empty by inserting each key in turn.
    /// Differencing this across sweep points yields the per-insert cost near n (finite
    /// differences, docs/PLAN.md §6.3). **Order-sensitive**: Θ(n) on ascending input (every
    /// key appends after one failed comparison), Θ(n log n) on descending (every key climbs
    /// to the root) — see the module doc. Returns the length to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        MinHeapF64::new(keys, n).len() as u32
    }

    /// Op-count for the cumulative build to size `n`: total comparisons + swaps to insert the
    /// first `n` keys. On shuffled input the expected per-insert sift is O(1), so this is
    /// ≈ Θ(n) and `insert_fd` reads flat — the heap's signature asymmetry against its
    /// Θ(log n) extract.
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut h = MinHeapF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            h.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: extract every stored key, leaving the heap empty (docs/PLAN.md §6.3 teardown).
    /// Repeated `extract_min` is heapsort, Θ(n log n), and rides exactly the path churn's
    /// extract half probes — the precondition for comparing the two methods. Returns the
    /// extract count to defeat DCE. No op-counting overhead (`COUNT=false`).
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while self.extract_min::<false>(&mut ops).is_some() {
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons + swaps to extract every key
    /// (Σ over the shrinking heap — Θ(n log n)). Built untimed via `new`, then counted.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut h = MinHeapF64::new(keys, n);
        let mut ops = 0u64;
        while h.extract_min::<true>(&mut ops).is_some() {}
        ops as f64
    }

    /// Timed: build a fresh size-`n` heap via inserts, then extract it empty, in one
    /// self-contained call. Subtracting the `build_insert_n` time isolates the teardown — the
    /// delete side of the finite-difference method (docs/PLAN.md §6.3); the identical insert
    /// build path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        let mut h = MinHeapF64::new(keys, n);
        h.teardown_all()
    }
}

impl MinHeapF64 {
    /// An empty heap.
    pub fn new_empty() -> MinHeapF64 {
        MinHeapF64 { heap: Vec::new(), probes: Vec::new(), churn_key: 0.0 }
    }

    /// Whether the heap holds no keys.
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }

    #[inline]
    fn swap(&mut self, i: usize, j: usize) {
        self.heap.swap(i, j);
    }

    /// Insert `key`: append at the tail, then **sift up** while it is strictly smaller than
    /// its parent. Counts one comparison per level examined — **including the failing one
    /// that ends the climb** (rule 1) — plus one per swap. The tail `push` is structural and
    /// is not counted (rule 6); the strict `<` means equal keys don't swap (rule 4).
    #[inline]
    fn insert<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        self.heap.push(key);
        let mut i = self.heap.len() - 1;
        while i > 0 {
            let p = (i - 1) >> 1;
            if COUNT {
                *ops += 1;
            }
            if !(self.heap[i] < self.heap[p]) {
                break;
            }
            self.swap(i, p);
            if COUNT {
                *ops += 1;
            }
            i = p;
        }
    }

    /// Extract the minimum: take the root, move the last element into the root slot, then
    /// **sift down** while a child is strictly smaller. Returns the removed minimum, or
    /// `None` when empty. Counts the child-vs-child comparison **only when a right child
    /// exists** (rule 2), tie-breaking to the **left** on equal children (rule 3); the
    /// parent-vs-child comparison including the failing one (rule 1); and one per swap. A pop
    /// that empties the heap returns **0 ops** without entering the loop (rule 5), and the
    /// `heap[0] = last` refill is not counted (rule 6).
    #[inline]
    fn extract_min<const COUNT: bool>(&mut self, ops: &mut u64) -> Option<f64> {
        if self.heap.is_empty() {
            return None;
        }
        let min = self.heap[0];
        let last = self.heap.pop().expect("non-empty");
        if self.heap.is_empty() {
            // The heap held a single element — popping the root emptied it; nothing sifts.
            return Some(min);
        }
        self.heap[0] = last;
        let n = self.heap.len();
        let mut i = 0usize;
        loop {
            let l = 2 * i + 1;
            let r = 2 * i + 2;
            if l >= n {
                break;
            }
            let mut smaller = l;
            if r < n {
                if COUNT {
                    *ops += 1;
                }
                if self.heap[r] < self.heap[l] {
                    smaller = r;
                }
            }
            if COUNT {
                *ops += 1;
            }
            if !(self.heap[smaller] < self.heap[i]) {
                break;
            }
            self.swap(i, smaller);
            if COUNT {
                *ops += 1;
            }
            i = smaller;
        }
        Some(min)
    }

    /// The O(n) contrast op: walk every slot until a match. One comparison per slot examined.
    #[inline]
    fn scan<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        for i in 0..self.heap.len() {
            if COUNT {
                *ops += 1;
            }
            if self.heap[i] == target {
                return true;
            }
        }
        false
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Read the minimum without removing it (O(1), no cost metric).
    pub fn peek(&self) -> Option<f64> {
        self.heap.first().copied()
    }

    /// Membership plus the comparison count for one scan (a scan performs no swaps).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.scan::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key, returning the comparisons + swaps of the sift-up. Mutates.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        ops
    }

    /// Extract the minimum, returning `(min, comparisons + swaps)`; `min` is `None` when the
    /// heap is empty (in which case the count is 0). Mutates.
    pub fn extract_min_counted(&mut self) -> (Option<f64>, u64) {
        let mut ops = 0u64;
        let min = self.extract_min::<true>(&mut ops);
        (min, ops)
    }

    /// The backing array in **heap order** (not sorted) — the structure's observable shape,
    /// which the multiset alone does not determine. A conformance hook (docs/PLAN.md §12);
    /// not on the wasm surface. Named `keys_in_order` to match the sibling structures'
    /// corpus hook even though a heap's "order" is a layout, not a sort.
    pub fn keys_in_order(&self) -> Vec<f64> {
        self.heap.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heap(keys: &[f64]) -> MinHeapF64 {
        MinHeapF64::new(keys, keys.len())
    }

    /// Every parent is ≤ its children — the heap property, checked over the whole array.
    fn assert_heap_property(h: &MinHeapF64) {
        let a = h.keys_in_order();
        for i in 1..a.len() {
            let p = (i - 1) >> 1;
            assert!(a[p] <= a[i], "heap property broken at {i}: parent {} > child {}", a[p], a[i]);
        }
    }

    #[test]
    fn builds_a_valid_heap_from_any_input_order() {
        let h = heap(&[50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0]);
        assert_eq!(h.len(), 7);
        assert_eq!(h.peek(), Some(20.0));
        assert_heap_property(&h);
    }

    #[test]
    fn keeps_duplicates() {
        let h = heap(&[5.0, 9.0, 5.0, 7.0, 5.0]);
        assert_eq!(h.len(), 5);
        assert_eq!(h.peek(), Some(5.0));
        assert_heap_property(&h);
    }

    #[test]
    fn extracts_in_ascending_order() {
        let mut h = heap(&[50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0, 20.0]);
        let mut out = Vec::new();
        while let (Some(v), _) = h.extract_min_counted() {
            out.push(v);
        }
        assert_eq!(out, vec![20.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0]);
        assert!(h.is_empty());
    }

    #[test]
    fn empty_and_singleton_edges() {
        let mut h = heap(&[]);
        assert_eq!(h.peek(), None);
        assert_eq!(h.search_one_counted(1.0), (false, 0));
        assert_eq!(h.extract_min_counted(), (None, 0));

        let mut h = heap(&[42.0]);
        assert_eq!(h.peek(), Some(42.0));
        assert_eq!(h.search_one_counted(42.0), (true, 1));
        assert_eq!(h.search_one_counted(7.0), (false, 1));
        // Rule 5: the pop empties the heap, so the sift loop is never entered — 0 ops.
        assert_eq!(h.extract_min_counted(), (Some(42.0), 0));
        assert!(h.is_empty());
    }

    /// Rule 1 (the failing comparison counts) and rule 4 (equal keys don't swap), pinned by
    /// hand against `heap.ts`'s `insert`.
    #[test]
    fn insert_counts_the_failing_comparison_and_does_not_swap_equals() {
        // Ascending input: each key is a new maximum, so it stays at the tail after ONE
        // failed comparison and never swaps. Key 0 has no parent ⇒ 0 ops.
        let mut h = MinHeapF64::new_empty();
        assert_eq!(h.insert_one_counted(10.0), 0); // root: loop never runs
        assert_eq!(h.insert_one_counted(20.0), 1); // 1 failed comparison, no swap
        assert_eq!(h.insert_one_counted(30.0), 1);
        assert_eq!(h.keys_in_order(), vec![10.0, 20.0, 30.0]);

        // Insert 10 at index 3, whose parent is index **1** (= 20), not the root: 10 < 20 is
        // a real swap (1 cmp + 1 swap). It then meets the equal root and rule 4 bites — the
        // strict `<` makes 10 < 10 false, so it stops after ONE more comparison and does not
        // swap. 3 ops, and the duplicate stays below the root rather than displacing it.
        assert_eq!(h.insert_one_counted(10.0), 3);
        assert_eq!(h.keys_in_order(), vec![10.0, 10.0, 30.0, 20.0]);

        // A new global minimum climbs the full height: from index 4 the path is 4→1→0, so
        // 2 successful comparisons + 2 swaps, then the loop ends at the root (no comparison).
        assert_eq!(h.insert_one_counted(1.0), 4);
        assert_eq!(h.keys_in_order(), vec![1.0, 10.0, 30.0, 20.0, 10.0]);
    }

    /// Rule 2 (child-vs-child only when a right child exists) and rule 3 (equal children
    /// break left), pinned by hand against `heap.ts`'s `extractMin`.
    #[test]
    fn extract_counts_the_child_comparison_only_when_a_right_child_exists() {
        // [1, 2, 3]: extract 1 ⇒ pop 3 to the root, array [3, 2].
        // Sift: l=1 exists, r=2 does NOT (n=2) ⇒ NO child-vs-child comparison.
        // Then parent-vs-child 2 < 3 ⇒ 1 comparison + 1 swap. Total 2.
        let mut h = MinHeapF64::new_empty();
        for k in [1.0, 2.0, 3.0] {
            h.insert_one_counted(k);
        }
        assert_eq!(h.keys_in_order(), vec![1.0, 2.0, 3.0]);
        assert_eq!(h.extract_min_counted(), (Some(1.0), 2));
        assert_eq!(h.keys_in_order(), vec![2.0, 3.0]);

        // Equal children break LEFT (rule 3): build [1, 5, 5, 9] then extract.
        // Extract 1 ⇒ pop 9 to root, array [9, 5, 5]. l=1, r=2 both exist ⇒ 1 comparison,
        // heap[2] < heap[1] is 5 < 5 = false ⇒ smaller stays LEFT (index 1). Then 5 < 9 ⇒
        // 1 comparison + 1 swap ⇒ [5, 9, 5]. Next level: l=3 ≥ n=3 ⇒ stop. Total 3 ops.
        let mut h = MinHeapF64::new_empty();
        for k in [1.0, 5.0, 5.0, 9.0] {
            h.insert_one_counted(k);
        }
        assert_eq!(h.keys_in_order(), vec![1.0, 5.0, 5.0, 9.0]);
        assert_eq!(h.extract_min_counted(), (Some(1.0), 3));
        assert_eq!(h.keys_in_order(), vec![5.0, 9.0, 5.0]);
    }

    #[test]
    fn search_is_a_linear_scan_over_the_layout() {
        // The scan walks the *array layout*, so its cost depends on where the key sits —
        // the root is found in 1, an absent key costs the full n.
        let h = heap(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert_eq!(h.keys_in_order(), vec![10.0, 20.0, 30.0, 40.0, 50.0]);
        assert_eq!(h.search_one_counted(10.0), (true, 1));
        assert_eq!(h.search_one_counted(50.0), (true, 5));
        assert_eq!(h.search_one_counted(99.0), (false, 5));
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut h = heap(&[1.0, 2.0, 3.0]);
        h.set_probes(&[2.0, 99.0]); // one present, one absent
        assert_eq!(h.search_n(4), 2); // [2, 99, 2, 99] => 2 hits
    }

    #[test]
    fn search_counted_sums_comparisons_over_probes() {
        // Layout [1, 2, 3]: scan(1) = 1, scan(99) = 3 (the full array). Total 4.
        let mut h = heap(&[1.0, 2.0, 3.0]);
        h.set_probes(&[1.0, 99.0]);
        assert_eq!(h.search_counted(), 4.0);
    }

    /// The churn contract (module doc): a `min − 1` key holds size **and** the multiset
    /// stable, because the insert sifts it to the root and the extract takes exactly it back.
    #[test]
    fn low_key_churn_holds_size_and_restores_the_multiset() {
        let keys = [50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0];
        let mut h = heap(&keys);
        let before = h.keys_in_order();
        h.set_churn_key(19.0); // min(20) − 1
        h.churn_n(25);
        assert_eq!(h.len(), keys.len());
        assert_eq!(h.keys_in_order(), before, "each pair restores the layout exactly");
        assert_heap_property(&h);
        // And the stored minimum never moves, so one `set_churn_key` stays valid throughout.
        assert_eq!(h.peek(), Some(20.0));
        let one_pair = h.churn_counted();
        assert_eq!(h.len(), keys.len()); // churn_counted nets zero
        // Layout is [20, 30, 60, 50, 40, 70, 80]. The pair rides the full height both ways:
        // the insert enters at index 7 (depth 3) and climbs 7→3→1→0, three comparisons and
        // three swaps = 6; the extract pops the tail back to the root and sifts it down two
        // levels, each costing a child-vs-child comparison, a parent comparison and a swap
        // = 6. 12 total — and the layout comes back exactly.
        assert_eq!(one_pair, 12.0);
    }

    /// The counter-example the module doc names: a **high** churn key drains the heap,
    /// because the extract then removes a real key instead of the one just inserted. Pinned
    /// so nobody "simplifies" the engine to the `max + 1` key the other structures use.
    #[test]
    fn a_high_churn_key_would_drain_the_heap() {
        let keys = [10.0, 20.0, 30.0, 40.0];
        let mut h = heap(&keys);
        h.set_churn_key(99.0); // max + 1 — the WRONG recipe for a heap
        h.churn_n(4);
        // Size looks stable...
        assert_eq!(h.len(), keys.len());
        // ...but every real key has been extracted and replaced by copies of the spare.
        assert_eq!(h.peek(), Some(99.0));
        assert_eq!(h.keys_in_order(), vec![99.0, 99.0, 99.0, 99.0]);
    }

    #[test]
    fn build_is_linear_on_ascending_input_and_log_linear_on_descending() {
        // Ascending: every key is a new maximum ⇒ 1 failed comparison each, no swaps.
        // Key 0 costs 0 (no parent), so n = 4 costs 3.
        assert_eq!(MinHeapF64::build_insert_n(&[0.0, 1.0, 2.0, 3.0], 4), 4);
        assert_eq!(MinHeapF64::build_insert_counted(&[0.0, 1.0, 2.0, 3.0], 4), 3.0);
        // Descending: every key is a new minimum and climbs to the root.
        // insert 3 ⇒ 0; insert 2 at idx1 ⇒ 1 cmp + 1 swap = 2; insert 1 at idx2 ⇒ parent
        // idx0 ⇒ 1 cmp + 1 swap = 2; insert 0 at idx3 ⇒ 3→1 (1 cmp + 1 swap), 1→0 (1 cmp +
        // 1 swap) = 4. Total 0 + 2 + 2 + 4 = 8, well above the ascending 3.
        assert_eq!(MinHeapF64::build_insert_counted(&[3.0, 2.0, 1.0, 0.0], 4), 8.0);
    }

    #[test]
    fn teardown_empties_the_heap() {
        let keys = [10.0, 20.0, 30.0, 40.0, 50.0];
        let mut h = MinHeapF64::new(&keys, 5);
        assert_eq!(h.teardown_all(), 5);
        assert!(h.is_empty());
        assert!(MinHeapF64::teardown_counted(&keys, 5) > 0.0);
        assert_eq!(MinHeapF64::build_then_teardown_n(&[5.0, 3.0, 8.0, 1.0], 4), 4);
    }
}
