//! Height-balanced binary search tree — an **AVL tree** (docs/PLAN.md §8, "Trees /
//! heaps" family, balanced) — the production/bench twin of the TypeScript teaching
//! impl (`src/structures/avl.ts`).
//!
//! Semantics: a **height-balanced multiset BST**. It shares the unbalanced BST's
//! ordering rule — `key < node` ⇒ left, otherwise (`≥`) ⇒ **right**, so equal keys
//! accumulate to the right and the in-order traversal is non-decreasing (the sorted
//! multiset; duplicates kept — docs/PLAN.md "Keys are identity; never dedupe") — and
//! its **value-copy (Hibbard) delete**. The difference is the *self-balancing*: after
//! every insert/delete the path back to the root is retraced, each node's height
//! updated, and a **rotation** applied wherever the balance factor leaves {-1, 0, +1}.
//! So where the naive BST degenerates to an O(n) chain on sorted input (the headline
//! demo, docs/PLAN.md §4.3, `bst::BstF64`), the AVL stays O(log n) — the contrast the
//! two tree tabs make visible (proven as a deterministic op-count in
//! `structures::methodology`).
//!
//! **Recursive `Box<Node>`, *not* the BST's index arena — deliberately.** The BST is
//! arena-backed and walked iteratively because sorted input degenerates it to a
//! 10⁵–10⁶-deep right chain that would overflow the WASM stack under recursion (or a
//! recursive `Drop`). **The AVL invariant removes that hazard**: height is bounded by
//! ≤ 1.44·log₂(n+2) ≈ 29 for a million keys, so recursive insert/delete/traversal/drop
//! are categorically safe. With the stack risk gone, the recursive form is preferred:
//! it mirrors the recursive teaching twin (`avl.ts`) almost line-for-line, and that
//! 1:1 structure is the surest guard against op-count drift (risk R1) — the recursion
//! *is* the op-count spec. (A reviewer fresh off `bst.rs` will expect the arena; this
//! is why it is not here.)
//!
//! **Cost metric — comparisons + rotations (docs/PLAN.md §8); the R1 conformance
//! contract.** The op-count is **key comparisons** (one per node examined on a find
//! path — search, insert, and delete's *find* phase) **plus rotations** (one per single
//! rotation; a double rotation is two). The height/balance-factor arithmetic of the
//! retrace is *not* a comparison and is not counted; nor is the in-order-successor walk
//! of a two-child delete (it follows child links). A find path counts **one** op per
//! node even though delete's branch tests `key < v` then `key > v` — the teaching twin
//! increments once per node, so the bench twin must too, or the cross-language corpus
//! (`conformance/corpus-avl.txt`) mismatches.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly
//! as the other structures: one algorithm, the `*ops` increments compiled away on the
//! timed hot path, alive on the op-count signal.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3).** Mirroring `BstF64`/`ArrayF64`,
//! the `#[wasm_bindgen]` impl exposes the batched primitives the TS `measure.ts` times:
//! `search_n`/`search_counted` (size-preserving), the `churn_n`/`churn_counted` primary
//! (insert+delete pairs at fixed n), and the `build_insert_*`/`teardown_*` cumulative
//! cross-check. **Teardown deletes the current maximum repeatedly** — the rightmost node
//! (no right child), reached down the right spine exactly as the churn key (`max + 1`) is.
//! Unlike the BST, this teardown's op-count includes the **rotations** the retrace fires
//! while rebalancing the shrinking spine.

use wasm_bindgen::prelude::*;

/// A recursive tree node carrying its subtree `height` for O(1) balance checks. A
/// fresh leaf has height 1; an absent child has height 0.
struct Node {
    value: f64,
    left: Option<Box<Node>>,
    right: Option<Box<Node>>,
    height: i32,
}

impl Node {
    fn leaf(value: f64) -> Box<Node> {
        Box::new(Node { value, left: None, right: None, height: 1 })
    }
}

/// Height of a (possibly absent) subtree: 0 for `None`, else the stored height.
fn height(n: &Option<Box<Node>>) -> i32 {
    match n {
        Some(b) => b.height,
        None => 0,
    }
}

/// Recompute `n`'s height from its children (their heights must already be current).
fn update(n: &mut Node) {
    n.height = 1 + height(&n.left).max(height(&n.right));
}

/// Balance factor = height(right) − height(left); the invariant keeps it in
/// {-1, 0, +1}, and a rotation fires the moment an insert/delete pushes it to ±2.
fn balance(n: &Node) -> i32 {
    height(&n.right) - height(&n.left)
}

/// Insert `key` into `node`'s subtree (`key < node` ⇒ left else right — equal keys go
/// right, keeping the multiset), then retrace and rebalance on the way back up.
/// Counts one comparison per existing node on the path, plus any rebalancing rotations.
fn insert_at<const COUNT: bool>(node: Option<Box<Node>>, key: f64, ops: &mut u64) -> Box<Node> {
    let mut node = match node {
        None => return Node::leaf(key),
        Some(n) => n,
    };
    if COUNT {
        *ops += 1;
    }
    if key < node.value {
        node.left = Some(insert_at::<COUNT>(node.left.take(), key, ops));
    } else {
        node.right = Some(insert_at::<COUNT>(node.right.take(), key, ops));
    }
    update(&mut node);
    rebalance::<COUNT>(node, ops)
}

/// Delete the first matching key from `node`'s subtree (value-copy / Hibbard), then
/// retrace and rebalance. Counts one comparison per node on the find path plus any
/// rotations; the successor walk carries none. Sets `removed` when a key is unlinked.
fn delete_at<const COUNT: bool>(
    node: Option<Box<Node>>,
    key: f64,
    ops: &mut u64,
    removed: &mut bool,
) -> Option<Box<Node>> {
    // `?` short-circuits to None when we run off the tree — the key is absent on this path.
    let mut node = node?;
    if COUNT {
        *ops += 1;
    }
    if key < node.value {
        node.left = delete_at::<COUNT>(node.left.take(), key, ops, removed);
    } else if key > node.value {
        node.right = delete_at::<COUNT>(node.right.take(), key, ops, removed);
    } else {
        // ── Match. Leaf or one child: splice the present child (or None) in; the node
        // is gone, so no retrace/rebalance applies to it. ──
        if node.left.is_none() || node.right.is_none() {
            *removed = true;
            return node.left.take().or_else(|| node.right.take());
        }
        // Two children: copy the in-order successor's value up (the min of the right
        // subtree) and unlink it. `remove_min` descends by child link (no comparison).
        let (new_right, succ_val) = remove_min::<COUNT>(node.right.take().expect("right child"), ops);
        node.right = new_right;
        node.value = succ_val;
        *removed = true;
    }
    update(&mut node);
    Some(rebalance::<COUNT>(node, ops))
}

/// Unlink the minimum (leftmost) node of `node`'s subtree, rebalancing on the way back
/// up, and return the new subtree root plus the removed value (the in-order successor of
/// a two-child delete). The leftward descent performs **no** comparison.
fn remove_min<const COUNT: bool>(mut node: Box<Node>, ops: &mut u64) -> (Option<Box<Node>>, f64) {
    if node.left.is_none() {
        return (node.right.take(), node.value); // the min has no left child
    }
    let (new_left, val) = remove_min::<COUNT>(node.left.take().expect("left child"), ops);
    node.left = new_left;
    update(&mut node);
    (Some(rebalance::<COUNT>(node, ops)), val)
}

/// Restore the AVL invariant at `node` (whose children's heights are current), counting
/// one op per single rotation. A left-/right-heavy node with an oppositely-leaning child
/// is the double-rotation case — the child is rotated first.
fn rebalance<const COUNT: bool>(mut node: Box<Node>, ops: &mut u64) -> Box<Node> {
    let bf = balance(&node);
    if bf < -1 {
        // Left-heavy. If the left child leans right, it's the LR case: rotate it left first.
        if balance(node.left.as_ref().expect("left child")) > 0 {
            let left = node.left.take().expect("left child");
            node.left = Some(rotate_left::<COUNT>(left, ops));
        }
        return rotate_right::<COUNT>(node, ops);
    }
    if bf > 1 {
        // Right-heavy. If the right child leans left, it's the RL case: rotate it right first.
        if balance(node.right.as_ref().expect("right child")) < 0 {
            let right = node.right.take().expect("right child");
            node.right = Some(rotate_right::<COUNT>(right, ops));
        }
        return rotate_left::<COUNT>(node, ops);
    }
    node
}

/// Right rotation at pivot `y`: lift `y.left` (`x`) into y's place. Counts one rotation
/// and fixes the two affected heights.
fn rotate_right<const COUNT: bool>(mut y: Box<Node>, ops: &mut u64) -> Box<Node> {
    if COUNT {
        *ops += 1;
    }
    let mut x = y.left.take().expect("right rotation needs a left child");
    y.left = x.right.take();
    update(&mut y);
    x.right = Some(y);
    update(&mut x);
    x
}

/// Left rotation at pivot `x`: lift `x.right` (`y`) into x's place (mirror of
/// [`rotate_right`]).
fn rotate_left<const COUNT: bool>(mut x: Box<Node>, ops: &mut u64) -> Box<Node> {
    if COUNT {
        *ops += 1;
    }
    let mut y = x.right.take().expect("left rotation needs a right child");
    x.right = y.left.take();
    update(&mut x);
    y.left = Some(x);
    update(&mut y);
    y
}

/// A height-balanced multiset AVL tree over `f64` keys.
#[wasm_bindgen]
pub struct AvlF64 {
    root: Option<Box<Node>>,
    count: usize,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2). Mirrors `BstF64`.
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). The caller sets it to
    /// a value absent from the tree (the engine uses `max + 1`, so it descends the right
    /// spine) — each insert is real and the matching delete restores size, holding n stable.
    churn_key: f64,
}

#[wasm_bindgen]
impl AvlF64 {
    /// Build from the first `n` keys of `keys`, inserting in order; the tree self-balances
    /// as it grows, so insertion order does *not* fix the shape (unlike the BST). Mirrors
    /// the Phase 2 constructors' `(keys, n)`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> AvlF64 {
        let n = n.min(keys.len());
        let mut t = AvlF64::new_empty();
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
    /// total comparisons (search performs no rotations). `f64` keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the tree so each insert
    /// is real and the matching delete restores size. The engine passes `max + 1`, which
    /// descends the right spine. Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size stable at
    /// ≈ n (docs/PLAN.md §6.3). Isolates per-op mutation cost at a fixed n. Each pair walks
    /// the right spine and rebalances on the way back. Returns the delete-hit count to
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

    /// Op-count signal (§6.4) for *one* churn pair: comparisons + rotations of a counted
    /// insert+delete of the churn key. The pair nets zero size change, so `len` and the
    /// in-order traversal are unchanged afterwards (the *shape* may differ — rotations can
    /// leave a differently-shaped but still-valid tree).
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        let _ = self.delete::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh tree of size `n` from empty by inserting each key in turn.
    /// Differencing this across sweep points yields per-insert cost (finite differences,
    /// docs/PLAN.md §6.3). Returns the size to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        AvlF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n`: total comparisons + rotations to
    /// insert the first `n` keys. Balanced throughout, so this is ≈ O(n log n) regardless
    /// of input order (the AVL's defining contrast with the BST's O(n²) on sorted input).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut t = AvlF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            t.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key by repeatedly removing the current maximum, leaving
    /// the tree empty (docs/PLAN.md §6.3 teardown). The max is the rightmost node — reached
    /// down the right spine, the same path the churn key probes — always a leaf-or-one-child
    /// (no two-child Hibbard copy). Returns the delete count to defeat DCE. No op-counting
    /// overhead (`COUNT=false`).
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(max) = self.max_value() {
            self.delete::<false>(max, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons **plus rotations** to delete
    /// every key by repeatedly removing the current maximum (each delete-max retraces and may
    /// rebalance the shrinking right spine). Built untimed via `new`, then counted.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut t = AvlF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(max) = t.max_value() {
            t.delete::<true>(max, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` tree via inserts, then tear it all down by delete-max,
    /// in one self-contained call. Subtracting the `build_insert_n` time isolates the
    /// teardown — the delete side of the finite-difference method (docs/PLAN.md §6.3); the
    /// identical insert build path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        AvlF64::new(keys, n).teardown_all()
    }
}

impl AvlF64 {
    /// An empty tree.
    pub fn new_empty() -> AvlF64 {
        AvlF64 { root: None, count: 0, probes: Vec::new(), churn_key: 0.0 }
    }

    /// Whether the tree holds no keys.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Tree height (0 when empty); a balanced n-node AVL is ≤ ~1.44·log₂(n+2).
    pub fn tree_height(&self) -> u32 {
        height(&self.root) as u32
    }

    /// Value of the current maximum — the rightmost node, found by following right links
    /// from the root (no comparison, so not a cost event). `None` for an empty tree.
    fn max_value(&self) -> Option<f64> {
        let mut cur = self.root.as_ref()?;
        loop {
            match &cur.right {
                Some(r) => cur = r,
                None => return Some(cur.value),
            }
        }
    }

    /// Insert `key`, retracing and rebalancing. Counts comparisons + rotations.
    fn insert<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        self.root = Some(insert_at::<COUNT>(self.root.take(), key, ops));
        self.count += 1;
    }

    /// Delete the first matching `key` (value-copy / Hibbard), retracing and rebalancing.
    /// Returns whether a key was removed; counts comparisons + rotations.
    fn delete<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) -> bool {
        let mut removed = false;
        self.root = delete_at::<COUNT>(self.root.take(), key, ops, &mut removed);
        if removed {
            self.count -= 1;
        }
        removed
    }

    /// Search for `key`, comparing at each node until a match or a null child. Iterative
    /// (read-only — no rebalancing). Counts one comparison per node, the match included.
    fn find<const COUNT: bool>(&self, key: f64, ops: &mut u64) -> bool {
        let mut cur = self.root.as_ref();
        while let Some(n) = cur {
            if COUNT {
                *ops += 1;
            }
            if key == n.value {
                return true;
            }
            cur = if key < n.value { n.left.as_ref() } else { n.right.as_ref() };
        }
        false
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the comparison count for one search (the cost metric; no rotations).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.find::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key, returning the op-count (comparisons + rotations) to place and
    /// rebalance it. Mutates.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        ops
    }

    /// Delete the first occurrence of `target`, returning `(removed, ops)` where ops is
    /// comparisons + rotations. Mutates.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys in ascending (in-order) order — the sorted multiset. Recursive; AVL height is
    /// bounded (≈ 29 for a million keys), so the call stack is safe.
    pub fn keys_in_order(&self) -> Vec<f64> {
        fn walk(n: &Option<Box<Node>>, out: &mut Vec<f64>) {
            if let Some(b) = n {
                walk(&b.left, out);
                out.push(b.value);
                walk(&b.right, out);
            }
        }
        let mut out = Vec::with_capacity(self.count);
        walk(&self.root, &mut out);
        out
    }

    /// Pre-order traversal with explicit `None` null markers — an unambiguous,
    /// language-agnostic serialization of the *shape*, the cross-language guard that the
    /// same rotations fired on both sides (in-order alone can't see shape). Recursive.
    pub fn preorder(&self) -> Vec<Option<f64>> {
        fn walk(n: &Option<Box<Node>>, out: &mut Vec<Option<f64>>) {
            match n {
                None => out.push(None),
                Some(b) => {
                    out.push(Some(b.value));
                    walk(&b.left, out);
                    walk(&b.right, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }

    /// Whether the AVL invariant holds everywhere: every node's balance factor ∈ {-1,0,+1}
    /// **and** its stored height equals `1 + max(child heights)` (a stale height would let a
    /// real imbalance hide). The AVL-specific correctness property the proptest asserts after
    /// every op.
    pub fn check_balanced(&self) -> bool {
        // Returns the verified height, or None if any subtree violates the invariant.
        fn check(n: &Option<Box<Node>>) -> Option<i32> {
            match n {
                None => Some(0),
                Some(b) => {
                    let lh = check(&b.left)?;
                    let rh = check(&b.right)?;
                    if (rh - lh).abs() > 1 {
                        return None;
                    }
                    let h = 1 + lh.max(rh);
                    if h != b.height {
                        return None;
                    }
                    Some(h)
                }
            }
        }
        check(&self.root).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn avl(keys: &[f64]) -> AvlF64 {
        AvlF64::new(keys, keys.len())
    }

    /// Pre-order shape as a string, `.` for a null — the unit-test mirror of the corpus
    /// serialization, pinning shapes independent of the (regenerated) corpus.
    fn shape(t: &AvlF64) -> String {
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
        let t = avl(&[50.0, 30.0, 70.0, 30.0, 20.0, 60.0]);
        assert_eq!(t.keys_in_order(), vec![20.0, 30.0, 30.0, 50.0, 60.0, 70.0]);
        assert_eq!(t.len(), 6);
        assert!(t.check_balanced());
    }

    /// The four rotation patterns, each reached from a different insertion order, all
    /// converge to the *same* balanced tree `20{10,30}` — the heart of the AVL contract.
    /// Each counts its 2 find comparisons plus rotations (single = 1, double = 2).
    #[test]
    fn ll_single_right_rotation() {
        let mut t = avl(&[30.0, 20.0]); // left-leaning so far
        assert_eq!(t.insert_one_counted(10.0), 3); // 2 compares + 1 right rotation
        assert_eq!(shape(&t), "20 10 . . 30 . .");
        assert!(t.check_balanced());
    }

    #[test]
    fn rr_single_left_rotation_on_sorted_input() {
        // Sorted input — the exact sequence that degenerates the BST to a chain. The AVL
        // rotates and stays balanced (the headline contrast).
        let mut t = avl(&[10.0, 20.0]);
        assert_eq!(t.insert_one_counted(30.0), 3); // 2 compares + 1 left rotation
        assert_eq!(shape(&t), "20 10 . . 30 . .");
        assert!(t.check_balanced());
    }

    #[test]
    fn lr_double_rotation() {
        let mut t = avl(&[30.0, 10.0]);
        assert_eq!(t.insert_one_counted(20.0), 4); // 2 compares + 2 rotations (left then right)
        assert_eq!(shape(&t), "20 10 . . 30 . .");
        assert!(t.check_balanced());
    }

    #[test]
    fn rl_double_rotation() {
        let mut t = avl(&[10.0, 30.0]);
        assert_eq!(t.insert_one_counted(20.0), 4); // 2 compares + 2 rotations (right then left)
        assert_eq!(shape(&t), "20 10 . . 30 . .");
        assert!(t.check_balanced());
    }

    #[test]
    fn search_counts_comparisons_no_rotations() {
        let t = avl(&[20.0, 10.0, 30.0]); // balanced 20{10,30}
        assert_eq!(t.search_one_counted(20.0), (true, 1)); // root hit
        assert_eq!(t.search_one_counted(10.0), (true, 2)); // 20→10
        assert_eq!(t.search_one_counted(99.0), (false, 2)); // 20→30, null right
    }

    /// Sorted input that would make the BST an O(n) chain stays O(log n) here: 15 ascending
    /// keys yield a balanced tree whose deepest search costs far fewer than 15 comparisons.
    #[test]
    fn sorted_input_stays_balanced() {
        let keys: Vec<f64> = (0..15).map(|i| i as f64).collect();
        let t = avl(&keys);
        assert!(t.check_balanced());
        assert!(t.tree_height() <= 5, "height {} should be O(log n)", t.tree_height());
        // The BST chain would cost 15 comparisons to find the max; the AVL costs ≤ height.
        let (found, ops) = t.search_one_counted(14.0);
        assert!(found && ops <= 5, "max search cost {ops} should be O(log n) ≪ 15");
    }

    #[test]
    fn delete_leaf_no_rebalance() {
        let mut t = avl(&[20.0, 10.0, 30.0]);
        assert_eq!(t.delete_one_counted(30.0), (true, 2)); // 20→30 match, no rotation
        assert_eq!(t.keys_in_order(), vec![10.0, 20.0]);
        assert!(t.check_balanced());
    }

    /// A *delete* that triggers a rotation (a distinct path from insert-triggered ones):
    /// removing 30 leaves 20 left-heavy, firing a right rotation up to `10{5,20}`.
    #[test]
    fn delete_triggers_rebalance() {
        let mut t = avl(&[20.0, 10.0, 30.0, 5.0]); // 20{10{5,_},30}
        assert_eq!(t.delete_one_counted(30.0), (true, 3)); // 2 compares + 1 rotation
        assert_eq!(t.keys_in_order(), vec![5.0, 10.0, 20.0]);
        assert_eq!(shape(&t), "10 5 . . 20 . .");
        assert!(t.check_balanced());
    }

    /// Two-child (Hibbard) delete counts the find path only — the successor walk is free.
    #[test]
    fn delete_two_child_counts_find_path_only() {
        // Balanced 50{30,70}; delete 50 (root, two children): compare@50 (match) = 1, no
        // rotation. Successor 70 copied up; 30 stays left.
        let mut t = avl(&[50.0, 30.0, 70.0]);
        assert_eq!(t.delete_one_counted(50.0), (true, 1));
        assert_eq!(t.keys_in_order(), vec![30.0, 70.0]);
        assert_eq!(shape(&t), "70 30 . . ."); // successor 70 became the root value
        assert!(t.check_balanced());
    }

    #[test]
    fn equal_keys_go_right_and_rebalance() {
        let t = avl(&[50.0, 50.0, 50.0, 70.0]);
        assert_eq!(t.keys_in_order(), vec![50.0, 50.0, 50.0, 70.0]);
        assert_eq!(shape(&t), "50 50 . . 50 . 70 . ."); // middle 50 lifted to root by RR
        assert!(t.check_balanced());
    }

    #[test]
    fn delete_removes_only_one_duplicate() {
        let mut t = avl(&[50.0, 50.0, 50.0, 70.0]);
        assert_eq!(t.delete_one_counted(50.0).0, true);
        assert_eq!(t.keys_in_order(), vec![50.0, 50.0, 70.0]);
        assert_eq!(t.len(), 3);
        assert!(t.check_balanced());
        assert_eq!(t.delete_one_counted(99.0).0, false); // absent
    }

    #[test]
    fn empty_tree_search_and_delete() {
        let t = avl(&[]);
        assert_eq!(t.search_one_counted(1.0), (false, 0));
        assert_eq!(shape(&t), "."); // root null
        let mut t = avl(&[]);
        assert_eq!(t.delete_one_counted(1.0), (false, 0));
        assert!(t.is_empty());
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn max_value_follows_the_right_spine() {
        assert_eq!(avl(&[50.0, 30.0, 70.0, 60.0, 80.0]).max_value(), Some(80.0));
        assert_eq!(avl(&[10.0, 20.0, 30.0]).max_value(), Some(30.0));
        assert_eq!(avl(&[]).max_value(), None);
    }

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut t = avl(&[50.0, 30.0, 70.0]);
        t.set_probes(&[30.0, 99.0]); // one present, one absent
        assert_eq!(t.search_n(4), 2); // [30,99,30,99] => 2 hits
    }

    #[test]
    fn search_counted_sums_comparisons_over_probes() {
        // Balanced 50{30,70}: find(30)=2 (50→30), find(99)=2 (50→70, null right).
        let mut t = avl(&[50.0, 30.0, 70.0]);
        t.set_probes(&[30.0, 99.0]);
        assert_eq!(t.search_counted(), 4.0);
    }

    #[test]
    fn churn_holds_size_and_in_order_but_not_necessarily_shape() {
        let mut t = avl(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        t.set_churn_key(99.0); // > max ⇒ descends the right spine
        let before = t.keys_in_order();
        t.churn_n(5);
        assert_eq!(t.len(), 5);
        assert_eq!(t.keys_in_order(), before); // size + in-order restored
        assert!(t.check_balanced());
        // churn_counted nets zero size change and is a positive op-count (compares + rotations).
        assert!(t.churn_counted() > 0.0);
        assert_eq!(t.len(), 5);
        assert!(t.check_balanced());
    }

    #[test]
    fn build_and_teardown_round_trip_to_empty() {
        let keys: Vec<f64> = (0..64).map(|i| i as f64).collect();
        assert_eq!(AvlF64::build_insert_n(&keys, 64), 64);
        // Balanced build is sub-quadratic — far below the BST chain's Σ i = 2016 for sorted input.
        assert!(AvlF64::build_insert_counted(&keys, 64) < 1000.0);
        assert_eq!(AvlF64::build_then_teardown_n(&keys, 64), 64);
        // Teardown op-count is positive and includes rotations (not comparisons-only).
        assert!(AvlF64::teardown_counted(&keys, 64) > 0.0);
    }
}
