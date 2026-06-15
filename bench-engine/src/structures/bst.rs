//! Unbalanced binary search tree (docs/PLAN.md §8, "Trees / heaps" family) — the
//! production/bench twin of the TypeScript teaching impl (`src/structures/bst.ts`).
//!
//! Semantics: an **unbalanced multiset BST**. The ordering rule is `key < node` ⇒
//! left, otherwise (`≥`) ⇒ **right**, so equal keys accumulate to the right and the
//! in-order traversal is non-decreasing (the sorted multiset; duplicates are kept —
//! docs/PLAN.md "Keys are identity; never dedupe"). No balancing: sorted input
//! degenerates to an O(n) right-leaning chain (docs/PLAN.md §8, §4.3) — the headline
//! demo, and the reason the tree lives in an **index arena walked iteratively**: a
//! 10⁵–10⁶-deep chain would overflow the WASM stack under recursive
//! search/insert/traversal (or a recursive `Box<Node>` `Drop`). The `Vec` arena drops
//! flat and every walk is a loop.
//!
//! **Cost metric — comparisons (docs/PLAN.md §8); the R1 conformance contract.** The
//! op-count is **key comparisons** only: one per node examined on a search path
//! (search, insert, and delete's *find* phase). Delete is the textbook **value-copy
//! (Hibbard)** scheme — a two-child node takes its in-order successor's value, then the
//! successor (which has no left child) is unlinked. The successor min-walk follows
//! child links and performs **no key comparison**, so it does *not* contribute to the
//! count — matching `bst.ts` so the cross-language corpus (`conformance/corpus-bst.txt`)
//! agrees (risk R1). A bug that counted the successor walk would diverge there.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly
//! as the Phase 2 structures: one algorithm, the `*ops` increments compiled away on the
//! timed hot path, alive on the op-count signal.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3).** Mirroring `ArrayF64`, the
//! `#[wasm_bindgen]` impl exposes the batched primitives the TS `measure.ts` times:
//! `search_n`/`search_counted` (size-preserving), the `churn_n`/`churn_counted` primary
//! (insert+delete pairs at fixed n), and the `build_insert_*`/`teardown_*` cumulative
//! cross-check. **Teardown deletes the current maximum repeatedly** — the rightmost node,
//! always a leaf-or-one-child (never the two-child Hibbard path), reached down the right
//! spine exactly as the churn key (`max + 1`) is. Deleting the *root* instead would be
//! O(1)/op on a chain and break the cross-check. This makes churn's probe and the
//! finite-difference delete measure the *same* path, the precondition for
//! `churn ≈ insert_fd + delete_fd` — which (unlike the array) holds tightly only for the
//! degenerate **chain**; for a balanced tree the FD sum *overshoots* churn (the methods
//! agree in complexity class only). See the `methodology` self-test in `mod.rs`.
//!
//! One honest consequence: because churn (and the delete-max teardown) ride the *cheap*
//! right spine (≈ ln n) rather than a random key's average depth (≈ 2 ln n), the measured
//! BST mutation *magnitude* runs low — read the curve for its O(log n) **shape**, not its
//! absolute ns (docs/PLAN.md §2.3, §6.3).

use wasm_bindgen::prelude::*;

/// An arena node. Children are indices into [`BstF64::nodes`] (`None` = absent), not
/// pointers, so traversal is a flat loop and reclamation is the `Vec`'s.
struct Node {
    value: f64,
    left: Option<u32>,
    right: Option<u32>,
}

/// An unbalanced multiset BST over `f64` keys, stored in an index arena.
#[wasm_bindgen]
pub struct BstF64 {
    nodes: Vec<Node>,
    root: Option<u32>,
    /// Slots vacated by delete, reused by the next insert so the arena stays bounded
    /// by live size. Slot numbering is not observable — every traversal follows the
    /// root and child links — so reuse never changes iteration order or shape.
    free: Vec<u32>,
    count: usize,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2). Mirrors `ArrayF64`.
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). The caller sets it to
    /// a value absent from the tree (the engine uses `max + 1`, so it descends the right
    /// spine) — each insert is real and the matching delete restores size, holding n stable.
    churn_key: f64,
}

#[wasm_bindgen]
impl BstF64 {
    /// Build from the first `n` keys of `keys`, inserting in order — insertion order
    /// fixes the shape (docs/PLAN.md §4.3). Mirrors the Phase 2 constructors' `(keys, n)`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> BstF64 {
        let n = n.min(keys.len());
        let mut t = BstF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            t.insert::<false>(k, &mut ops);
        }
        t
    }

    /// Number of stored keys (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.count
    }

    // ── Search: size-preserving (docs/PLAN.md §6.3) ──

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` searches, cycling through the stored probes. Returns
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
            if self.find::<false>(self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`, returning
    /// total comparisons (the cost metric). `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the tree so each
    /// insert is real and the matching delete restores size. The engine passes `max + 1`,
    /// which descends the right spine. Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size stable at
    /// ≈ n (docs/PLAN.md §6.3). Isolates the per-op mutation cost at a fixed n — you cannot
    /// time a batch of plain inserts because each one changes n. The combined insert+delete
    /// of `max + 1` walks the right spine down and back up. Returns the delete-hit count to
    /// defeat dead-code elimination. No op-counting overhead (`COUNT=false`).
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

    /// Op-count signal (§6.4) for *one* churn pair: the comparisons of a counted
    /// insert+delete of the churn key. The pair nets zero size change, so state is
    /// unchanged afterwards. Cost = insert find-path + delete find-path comparisons
    /// (≈ 2 × right-spine depth) — the delete's successor walk carries none (risk R1).
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        let _ = self.delete::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh tree of size `n` from empty by inserting each key in turn.
    /// Differencing this across sweep points yields per-insert cost near n (finite
    /// differences, docs/PLAN.md §6.3). Returns the size to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        BstF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n`: total find-path comparisons to
    /// insert the first `n` keys (the tree's internal path length). For sorted input this
    /// is Σ i = O(n²); for random input ≈ O(n log n).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut t = BstF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            t.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key by repeatedly removing the current maximum, leaving
    /// the tree empty (docs/PLAN.md §6.3 teardown). The max is the rightmost node — reached
    /// down the right spine, the same path the churn key probes — and is always a
    /// leaf-or-one-child, so no two-child Hibbard copy occurs. Returns the delete count to
    /// defeat DCE. No op-counting overhead (`COUNT=false`).
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(max) = self.max_value() {
            self.delete::<false>(max, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons to delete every key by
    /// repeatedly removing the current maximum (Σ over the shrinking tree of each max's
    /// find-path depth). Built untimed via `new`, then counted.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut t = BstF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(max) = t.max_value() {
            t.delete::<true>(max, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` tree via inserts, then tear it all down by
    /// delete-max, in one self-contained call. Subtracting the `build_insert_n` time
    /// isolates the teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); the identical insert build path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        BstF64::new(keys, n).teardown_all()
    }
}

impl BstF64 {
    /// An empty tree.
    pub fn new_empty() -> BstF64 {
        BstF64 {
            nodes: Vec::new(),
            root: None,
            free: Vec::new(),
            count: 0,
            probes: Vec::new(),
            churn_key: 0.0,
        }
    }

    /// Whether the tree holds no keys.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Value of the current maximum — the rightmost node, found by following right links
    /// from the root (no key comparison, so it is not a cost event — the same pointer-walk
    /// rule as the in-order-successor walk, risk R1). `None` for an empty tree.
    fn max_value(&self) -> Option<f64> {
        let mut cur = self.root?;
        loop {
            match self.nodes[cur as usize].right {
                Some(r) => cur = r,
                None => return Some(self.nodes[cur as usize].value),
            }
        }
    }

    /// Allocate a fresh leaf, reusing a freed slot when one is available.
    fn alloc(&mut self, value: f64) -> u32 {
        let node = Node { value, left: None, right: None };
        match self.free.pop() {
            Some(i) => {
                self.nodes[i as usize] = node;
                i
            }
            None => {
                self.nodes.push(node);
                (self.nodes.len() - 1) as u32
            }
        }
    }

    /// Insert `key`, descending `key < node` ⇒ left else right (equal keys go right,
    /// keeping the multiset). Counts one comparison per node on the path to the new
    /// leaf's slot (0 for the first key).
    fn insert<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        let id = self.alloc(key);
        let mut cur = match self.root {
            None => {
                self.root = Some(id);
                self.count += 1;
                return;
            }
            Some(r) => r,
        };
        loop {
            if COUNT {
                *ops += 1;
            }
            let go_left = key < self.nodes[cur as usize].value;
            let child = if go_left {
                self.nodes[cur as usize].left
            } else {
                self.nodes[cur as usize].right
            };
            match child {
                None => {
                    if go_left {
                        self.nodes[cur as usize].left = Some(id);
                    } else {
                        self.nodes[cur as usize].right = Some(id);
                    }
                    self.count += 1;
                    return;
                }
                Some(c) => cur = c,
            }
        }
    }

    /// Search for `key`, comparing at each node until a match or a null child. Counts
    /// one comparison per node examined — the matching comparison included.
    fn find<const COUNT: bool>(&self, key: f64, ops: &mut u64) -> bool {
        let mut cur = self.root;
        while let Some(i) = cur {
            if COUNT {
                *ops += 1;
            }
            let v = self.nodes[i as usize].value;
            if key == v {
                return true;
            }
            cur = if key < v {
                self.nodes[i as usize].left
            } else {
                self.nodes[i as usize].right
            };
        }
        false
    }

    /// Delete the first matching key (value-copy / Hibbard). Counts only the find-path
    /// comparisons; the successor walk and link surgery carry no comparisons (the R1
    /// contract above). Returns whether a key was removed.
    fn delete<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) -> bool {
        // ── Find the target and the parent link that points at it. ──
        let mut parent: Option<u32> = None;
        let mut parent_left = false; // direction parent → target
        let mut cur = self.root;
        while let Some(i) = cur {
            if COUNT {
                *ops += 1;
            }
            let v = self.nodes[i as usize].value;
            if key == v {
                self.remove_node(i, parent, parent_left);
                self.count -= 1;
                return true;
            }
            parent = Some(i);
            parent_left = key < v;
            cur = if parent_left {
                self.nodes[i as usize].left
            } else {
                self.nodes[i as usize].right
            };
        }
        false
    }

    /// Structural removal of the node at arena index `target` — **no comparisons**.
    /// Two children ⇒ copy the in-order successor's value up and unlink the successor;
    /// otherwise splice the single child (or nothing) into target's parent link.
    /// `parent`/`parent_left` locate the link pointing at `target` (`parent == None` ⇒
    /// `target` is the root).
    fn remove_node(&mut self, target: u32, parent: Option<u32>, parent_left: bool) {
        let left = self.nodes[target as usize].left;
        let right = self.nodes[target as usize].right;

        if let (Some(_), Some(r)) = (left, right) {
            // ── Two children: descend to the in-order successor (min of the right
            // subtree), copy its value up, then unlink it (it has no left child). ──
            let mut succ_parent = target;
            let mut succ_parent_left = false; // first step target → right
            let mut succ = r;
            while let Some(l) = self.nodes[succ as usize].left {
                succ_parent = succ;
                succ_parent_left = true;
                succ = l;
            }
            self.nodes[target as usize].value = self.nodes[succ as usize].value;
            let succ_right = self.nodes[succ as usize].right;
            if succ_parent_left {
                self.nodes[succ_parent as usize].left = succ_right;
            } else {
                self.nodes[succ_parent as usize].right = succ_right;
            }
            self.free.push(succ);
        } else {
            // ── Leaf or one child: splice the present child (or None) into the link. ──
            let child = left.or(right);
            match parent {
                None => self.root = child,
                Some(p) => {
                    if parent_left {
                        self.nodes[p as usize].left = child;
                    } else {
                        self.nodes[p as usize].right = child;
                    }
                }
            }
            self.free.push(target);
        }
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the comparison count for one search (the cost metric).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.find::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key, returning the comparison count to reach its slot. Mutates.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        ops
    }

    /// Delete the first occurrence of `target`, returning `(removed, comparisons)`.
    /// Mutates.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys in ascending (in-order) order — the sorted multiset. Iterative (explicit
    /// stack) so a degenerate chain can't overflow the call stack.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut stack: Vec<u32> = Vec::new();
        let mut cur = self.root;
        loop {
            while let Some(i) = cur {
                stack.push(i);
                cur = self.nodes[i as usize].left;
            }
            match stack.pop() {
                Some(i) => {
                    out.push(self.nodes[i as usize].value);
                    cur = self.nodes[i as usize].right;
                }
                None => break,
            }
        }
        out
    }

    /// Pre-order traversal with explicit `None` null markers — an unambiguous,
    /// language-agnostic serialization of the *shape*. In-order alone can't tell a
    /// balanced tree from a degenerate chain (they share an in-order), so the corpus
    /// pins this to catch shape drift. Iterative.
    pub fn preorder(&self) -> Vec<Option<f64>> {
        let mut out: Vec<Option<f64>> = Vec::new();
        let mut stack: Vec<Option<u32>> = vec![self.root];
        while let Some(top) = stack.pop() {
            match top {
                None => out.push(None),
                Some(i) => {
                    out.push(Some(self.nodes[i as usize].value));
                    // Push right before left so left is visited first (pre-order).
                    stack.push(self.nodes[i as usize].right);
                    stack.push(self.nodes[i as usize].left);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bst(keys: &[f64]) -> BstF64 {
        BstF64::new(keys, keys.len())
    }

    /// Pre-order shape as a string, `.` for a null — the unit-test mirror of the
    /// corpus serialization, so hand-computed shapes pin the algorithm independent of
    /// the (regenerated) corpus.
    fn shape(t: &BstF64) -> String {
        t.preorder()
            .iter()
            .map(|n| match n {
                Some(v) => format!("{v}"),
                None => ".".to_string(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn in_order_is_the_sorted_multiset_duplicates_kept() {
        let t = bst(&[50.0, 30.0, 70.0, 30.0, 20.0, 60.0]);
        assert_eq!(t.keys_in_order(), vec![20.0, 30.0, 30.0, 50.0, 60.0, 70.0]);
        assert_eq!(t.len(), 6);
    }

    #[test]
    fn equal_key_goes_right_never_collapses() {
        let t = bst(&[50.0, 50.0]);
        assert_eq!(t.len(), 2);
        // root 50 with a right child 50, no left child.
        assert_eq!(shape(&t), "50 . 50 . .");
    }

    #[test]
    fn search_counts_comparisons_bounded_by_height() {
        // Balanced, height 3: 50 {30{20,40}, 70{60,80}}.
        let t = bst(&[50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0]);
        assert_eq!(t.search_one_counted(50.0), (true, 1)); // root hit
        assert_eq!(t.search_one_counted(20.0), (true, 3)); // 50→30→20
        assert_eq!(t.search_one_counted(35.0), (false, 3)); // 50→30→40(left null)
    }

    #[test]
    fn degenerates_to_a_chain_on_sorted_input() {
        let t = bst(&[10.0, 20.0, 30.0, 40.0, 50.0]); // each key a new right child
        assert_eq!(t.search_one_counted(50.0), (true, 5)); // O(n) — the demo
        assert_eq!(shape(&t), "10 . 20 . 30 . 40 . 50 . .");
    }

    #[test]
    fn insert_counts_comparisons_to_the_slot() {
        let mut t = BstF64::new_empty();
        assert_eq!(t.insert_one_counted(50.0), 0); // first key, no comparison
        assert_eq!(t.insert_one_counted(30.0), 1); // 30<50 → left slot
        assert_eq!(t.insert_one_counted(70.0), 1); // 70≥50 → right slot
        assert_eq!(t.insert_one_counted(20.0), 2); // 50→30→left slot
    }

    #[test]
    fn delete_leaf_counts_only_find_comparisons() {
        let mut t = bst(&[50.0, 30.0, 70.0, 20.0]);
        assert_eq!(t.delete_one_counted(20.0), (true, 3)); // 50→30→20
        assert_eq!(t.keys_in_order(), vec![30.0, 50.0, 70.0]);
    }

    #[test]
    fn delete_one_child_left_and_right() {
        let mut a = bst(&[50.0, 30.0, 20.0]); // 30 has only a left child (20)
        assert_eq!(a.delete_one_counted(30.0), (true, 2));
        assert_eq!(a.keys_in_order(), vec![20.0, 50.0]);
        assert_eq!(shape(&a), "50 20 . . ."); // 20 took 30's place on the left

        let mut b = bst(&[50.0, 30.0, 40.0]); // 30 has only a right child (40)
        assert_eq!(b.delete_one_counted(30.0), (true, 2));
        assert_eq!(b.keys_in_order(), vec![40.0, 50.0]);
        assert_eq!(shape(&b), "50 40 . . .");
    }

    /// The crown-jewel R1 contract (advisor's example): a two-child delete counts the
    /// **find-path comparisons only** — the in-order-successor walk is not counted.
    #[test]
    fn delete_two_child_counts_find_path_only() {
        // 50 {30, 70{60,80}} — delete 70: compare@50 (go right), compare@70 (match) = 2.
        let mut t = bst(&[50.0, 30.0, 70.0, 60.0, 80.0]);
        assert_eq!(t.delete_one_counted(70.0), (true, 2));
        assert_eq!(t.keys_in_order(), vec![30.0, 50.0, 60.0, 80.0]);
        // successor 80 copied up into 70's node; 60 stays as its left child.
        assert_eq!(shape(&t), "50 30 . . 80 60 . . .");
    }

    #[test]
    fn delete_two_child_root_takes_successor() {
        let mut t = bst(&[50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0]);
        assert_eq!(t.delete_one_counted(50.0), (true, 1)); // root hit
        assert_eq!(t.keys_in_order(), vec![20.0, 30.0, 40.0, 60.0, 70.0, 80.0]);
        // in-order successor of 50 is 60; it becomes the new root value.
        assert_eq!(t.preorder()[0], Some(60.0));
    }

    #[test]
    fn delete_down_to_empty_then_reinsert_reuses_arena() {
        let mut t = bst(&[42.0]);
        assert_eq!(t.delete_one_counted(42.0), (true, 1));
        assert!(t.is_empty());
        assert_eq!(t.preorder(), vec![None]); // empty tree → single null
        // Re-inserting after a delete-to-empty must rebuild cleanly (free-list reuse).
        assert_eq!(t.insert_one_counted(7.0), 0);
        assert_eq!(t.keys_in_order(), vec![7.0]);
    }

    #[test]
    fn delete_removes_only_one_duplicate() {
        let mut t = bst(&[50.0, 50.0, 50.0, 70.0]);
        assert_eq!(t.delete_one_counted(50.0).0, true);
        assert_eq!(t.keys_in_order(), vec![50.0, 50.0, 70.0]);
        assert_eq!(t.len(), 3);
        assert_eq!(t.delete_one_counted(99.0).0, false); // absent
    }

    #[test]
    fn empty_tree_search_and_delete() {
        let t = bst(&[]);
        assert_eq!(t.search_one_counted(1.0), (false, 0));
        let mut t = bst(&[]);
        assert_eq!(t.delete_one_counted(1.0), (false, 0));
        assert_eq!(shape(&t), "."); // root null
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn max_value_follows_the_right_spine() {
        assert_eq!(bst(&[50.0, 30.0, 70.0, 60.0, 80.0]).max_value(), Some(80.0));
        assert_eq!(bst(&[10.0, 20.0, 30.0]).max_value(), Some(30.0)); // chain
        assert_eq!(bst(&[]).max_value(), None);
    }

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut t = bst(&[50.0, 30.0, 70.0]);
        t.set_probes(&[30.0, 99.0]); // one present, one absent
        assert_eq!(t.search_n(4), 2); // [30,99,30,99] => 2 hits
    }

    #[test]
    fn search_counted_sums_comparisons_over_probes() {
        // Balanced: 50 {30, 70}. find(30)=2 (50→30), find(99)=2 (50→70, null right).
        let mut t = bst(&[50.0, 30.0, 70.0]);
        t.set_probes(&[30.0, 99.0]);
        assert_eq!(t.search_counted(), 4.0);
    }

    #[test]
    fn churn_holds_size_and_counts_the_right_spine_round_trip() {
        // Chain 10→20→30: max = 30 at depth 2. churn key 99 (> max) descends the right
        // spine: insert walks 10,20,30 (3 comparisons) → leaf at depth 3; delete finds it
        // in 4 comparisons. churn = 3 + 4 = 7. The pair nets zero, so size is restored.
        let mut t = bst(&[10.0, 20.0, 30.0]);
        t.set_churn_key(99.0);
        t.churn_n(5);
        assert_eq!(t.len(), 3);
        assert_eq!(t.keys_in_order(), vec![10.0, 20.0, 30.0]);
        assert_eq!(t.churn_counted(), 7.0);
        assert_eq!(t.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_insert_counted_is_the_internal_path_length() {
        // Chain 0→1→2→3: insertion depths 0,1,2,3 ⇒ Σ = 6.
        assert_eq!(BstF64::build_insert_n(&[0.0, 1.0, 2.0, 3.0], 4), 4);
        assert_eq!(BstF64::build_insert_counted(&[0.0, 1.0, 2.0, 3.0], 4), 6.0);
        // Balanced 50 {30,70}: depths 0,1,1 ⇒ Σ = 2.
        assert_eq!(BstF64::build_insert_counted(&[50.0, 30.0, 70.0], 3), 2.0);
    }

    #[test]
    fn teardown_empties_by_delete_max_and_counts_each_find_path() {
        let keys = [10.0, 20.0, 30.0]; // chain; max depths 2,1,0 ⇒ finds 3,2,1
        let mut t = BstF64::new(&keys, 3);
        assert_eq!(t.teardown_all(), 3);
        assert!(t.is_empty());
        assert_eq!(BstF64::teardown_counted(&keys, 3), 6.0); // 3 + 2 + 1
        // Balanced 50 {30,70}: delete 70 (find 2), then 50 (root, find 1), then 30 (find 1).
        assert_eq!(BstF64::teardown_counted(&[50.0, 30.0, 70.0], 3), 4.0);
    }

    #[test]
    fn build_then_teardown_empties_the_tree() {
        assert_eq!(BstF64::build_then_teardown_n(&[5.0, 3.0, 8.0, 1.0], 4), 4);
    }
}
