//! **Red-black tree** (docs/PLAN.md §8 "Trees / heaps", §13 "Balanced tree: … offer
//! red-black as an alternative later for a balancing-scheme comparison?") — the
//! production/bench twin of the TypeScript teaching impl (`src/structures/rbt.ts`).
//!
//! Semantics: a **colour-balanced multiset BST**, the classic CLRS scheme (not the
//! left-leaning variant). It shares the BST's and the AVL's ordering rule — `key < node` ⇒
//! left, otherwise (`≥`) ⇒ **right**, so equal keys accumulate to the right and the
//! in-order traversal is the sorted multiset (duplicates kept — "keys are identity; never
//! dedupe") — and their **value-copy (Hibbard) delete**: the first matching node on the way
//! down is the one removed, and a two-child match takes its in-order successor's value
//! while the successor's node is the one unlinked.
//!
//! **Why it is on the chart next to the AVL — the trade the two schemes make.** Both keep
//! every operation O(log n) on any input order. They buy it differently:
//!
//! - The AVL keeps heights within ±1 at every node, so its height is ≤ ≈1.44·log₂ n — but
//!   a delete may have to rotate at *every* level on the way back up (O(log n) rotations).
//! - The red-black tree only promises that no path is more than twice as long as another
//!   (height ≤ 2·log₂(n+1)), and in exchange **never rotates more than twice on an insert
//!   or three times on a delete**. What it does instead of rotating is **recolour**, which
//!   can still walk O(log n) levels up.
//!
//! So the expected finding is *fewer rotations, slightly more comparisons*. That is pinned
//! clock-free, against the AVL on the same key sequences, in `structures::methodology`
//! (docs/METHODOLOGY.md §2.9) — and the rotation bounds themselves are asserted per
//! operation by the proptest (`tests/proptest_rbt.rs`).
//!
//! **Cost metric — comparisons + rotations, exactly the AVL's (docs/PLAN.md §8).** One
//! comparison per node examined on a find path (search, insert's descent, delete's find
//! phase, the match included), plus one per single rotation. The successor walk of a
//! two-child delete and the min/max walks of the teardown follow child links and are free.
//! The two trees' op-count curves are therefore comparable unit for unit.
//! **Recolourings are deliberately *not* in that metric**: the AVL has no colour, so
//! counting them would put a cost on the chart that only one of the two lines can pay.
//! They are counted on a separate counter ([`Cost::recolours`]) and reported beside the
//! rotation counts in the methodology tests, so "fewer rotations" is never read as "less
//! work". A **recolour** is defined as *a write that changes a node's colour*: colouring a
//! fresh node red at creation is not one; a node that goes red and then back to black in
//! one fix-up counts twice; a write that leaves the colour as it was counts zero.
//!
//! **Arena, iterative, with parent links.** Nodes live in a `Vec` and refer to each other
//! by index. Slot 0 is the **NIL sentinel**: always black, and **never written** — the
//! delete fix-up tracks the current node's parent in an explicit variable instead of the
//! CLRS trick of parking it in `nil.p`, which in an arena would alias every absent child
//! at once and would be hard to mirror exactly in TypeScript. Freed slots go on a free
//! list and the next insert reuses them, so a churn pair allocates nothing in steady state
//! (the AVL's timed path allocates one `Box` per insert). Every walk is a loop; the height
//! bound would make recursion safe, but nothing here needs it.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), as in every
//! other structure.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3)** — identical to `AvlF64`'s:
//! `search_n`/`search_counted`, the **two-key** churn (`min − 1` and `max + 1`, alternating,
//! the mean reported — docs/METHODOLOGY.md §4.1), and the `build_insert_*`/`teardown_*`
//! cumulative cross-check with an alternating delete-max / delete-min teardown.

use wasm_bindgen::prelude::*;

/// The NIL sentinel's slot. Always black, never written.
const NIL: u32 = 0;

/// An arena node. `left`/`right`/`parent` are slot indices; [`NIL`] means absent.
struct Node {
    value: f64,
    left: u32,
    right: u32,
    parent: u32,
    red: bool,
}

/// The three things a counted operation tallies. The shared op-count metric is
/// `comparisons + rotations` ([`Cost::ops`]); `recolours` is reported separately (see the
/// module doc for why, and for the exact definition of a recolour).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    /// Key comparisons on a find path, one per node examined.
    pub comparisons: u64,
    /// Single rotations (a double rotation is two).
    pub rotations: u64,
    /// Writes that changed a node's colour. **Not** part of [`Cost::ops`].
    pub recolours: u64,
}

impl Cost {
    /// The shared cost metric, unit-for-unit with the AVL: comparisons + rotations.
    pub fn ops(&self) -> u64 {
        self.comparisons + self.rotations
    }

    fn add(&mut self, o: Cost) {
        self.comparisons += o.comparisons;
        self.rotations += o.rotations;
        self.recolours += o.recolours;
    }
}

/// A CLRS red-black multiset tree over `f64` keys, stored in an index arena.
#[wasm_bindgen]
pub struct RbtF64 {
    /// Slot 0 is the NIL sentinel.
    nodes: Vec<Node>,
    root: u32,
    /// Slots vacated by delete, reused by the next insert. Slot numbering is never
    /// observable — every traversal follows the root and child links.
    free: Vec<u32>,
    count: usize,
    /// Query workload, stored once (untimed) — mirrors `AvlF64`.
    probes: Vec<f64>,
    /// The two spare churn keys (docs/PLAN.md §6.3, docs/METHODOLOGY.md §4.1); the engine
    /// sets `min − 1` and `max + 1`.
    churn_lo: f64,
    churn_hi: f64,
    /// Which end the next churn pair uses; persisted across `churn_n` calls.
    churn_hi_next: bool,
}

#[wasm_bindgen]
impl RbtF64 {
    /// Build from the first `n` keys of `keys`, inserting in order; the tree rebalances as
    /// it grows, so insertion order does not fix the class. Mirrors `AvlF64::new`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> RbtF64 {
        let n = n.min(keys.len());
        let mut t = RbtF64::with_capacity(n);
        let mut c = Cost::default();
        for &k in &keys[..n] {
            t.insert::<false>(k, &mut c);
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

    /// Timed hot path: `k` searches cycling through the stored probes; returns the hit
    /// count so the optimizer can't elide the work. No counting overhead.
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut c = Cost::default();
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.find::<false>(self.probes[i % len], &mut c) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probe set, total comparisons (a search
    /// never rotates).
    pub fn search_counted(&self) -> f64 {
        let mut c = Cost::default();
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut c);
        }
        c.ops() as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the two spare keys cycled by `churn_n`; both must be absent from the tree. The
    /// engine passes `lo = min − 1` and `hi = max + 1` (docs/METHODOLOGY.md §4.1). Untimed.
    pub fn set_churn_keys(&mut self, lo: f64, hi: f64) {
        self.churn_lo = lo;
        self.churn_hi = hi;
    }

    /// Timed hot path: `k` insert+delete pairs holding size at n, alternating the two churn
    /// keys. Returns the delete-hit count to defeat DCE. No counting overhead.
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let mut c = Cost::default();
        let mut hits = 0u32;
        for _ in 0..k {
            let key = if self.churn_hi_next { self.churn_hi } else { self.churn_lo };
            self.churn_hi_next = !self.churn_hi_next;
            self.insert::<false>(key, &mut c);
            if self.delete::<false>(key, &mut c) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal for *one* churn pair — the **mean** of the two alternating pairs'
    /// comparisons + rotations, exactly as `AvlF64::churn_counted`. Each pair nets zero
    /// size change; the in-order traversal is unchanged afterwards, the shape and colours
    /// need not be.
    pub fn churn_counted(&mut self) -> f64 {
        let (lo, hi) = (self.churn_lo, self.churn_hi);
        let mut a = Cost::default();
        self.insert::<true>(lo, &mut a);
        let _ = self.delete::<true>(lo, &mut a);
        let mut b = Cost::default();
        self.insert::<true>(hi, &mut b);
        let _ = self.delete::<true>(hi, &mut b);
        (a.ops() + b.ops()) as f64 / 2.0
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh size-`n` tree. Returns the size to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        RbtF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n` (comparisons + rotations).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        RbtF64::build_cost(keys, n).ops() as f64
    }

    /// Timed: delete every key by removing the current maximum and minimum in turn — the
    /// two spines the churn keys probe (docs/METHODOLOGY.md §4.1). Returns the delete count.
    pub fn teardown_all(&mut self) -> u32 {
        let mut c = Cost::default();
        let mut count = 0u32;
        let mut take_hi = true;
        loop {
            let end = if take_hi { self.max_value() } else { self.min_value() };
            match end {
                Some(v) => {
                    take_hi = !take_hi;
                    self.delete::<false>(v, &mut c);
                    count += 1;
                }
                None => break,
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown (comparisons + rotations), built untimed.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        RbtF64::teardown_cost(keys, n).ops() as f64
    }

    /// Timed: build then tear down in one call; subtracting `build_insert_n` isolates the
    /// teardown (docs/PLAN.md §6.3).
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        RbtF64::new(keys, n).teardown_all()
    }
}

impl RbtF64 {
    /// An empty tree.
    pub fn new_empty() -> RbtF64 {
        RbtF64::with_capacity(0)
    }

    /// An empty tree whose arena is pre-sized for `n` keys (plus the sentinel), so a build
    /// is one allocation rather than a doubling ladder.
    fn with_capacity(n: usize) -> RbtF64 {
        let mut nodes = Vec::with_capacity(n + 1);
        nodes.push(Node { value: 0.0, left: NIL, right: NIL, parent: NIL, red: false });
        RbtF64 {
            nodes,
            root: NIL,
            free: Vec::new(),
            count: 0,
            probes: Vec::new(),
            churn_lo: 0.0,
            churn_hi: 0.0,
            churn_hi_next: true,
        }
    }

    /// Whether the tree holds no keys.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    // ── Arena accessors ──

    #[inline]
    fn n(&self, i: u32) -> &Node {
        &self.nodes[i as usize]
    }

    #[inline]
    fn nm(&mut self, i: u32) -> &mut Node {
        debug_assert!(i != NIL, "the NIL sentinel is never written");
        &mut self.nodes[i as usize]
    }

    /// NIL is black; so is every absent child.
    #[inline]
    fn is_red(&self, i: u32) -> bool {
        self.nodes[i as usize].red
    }

    /// Set `i`'s colour, counting a recolour only when the colour actually changes.
    #[inline]
    fn paint<const COUNT: bool>(&mut self, i: u32, red: bool, c: &mut Cost) {
        if i == NIL {
            debug_assert!(!red, "NIL can only ever be black");
            return;
        }
        let node = &mut self.nodes[i as usize];
        if COUNT && node.red != red {
            c.recolours += 1;
        }
        node.red = red;
    }

    fn alloc(&mut self, value: f64, parent: u32) -> u32 {
        let node = Node { value, left: NIL, right: NIL, parent, red: true };
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

    /// Value of the current maximum (right links from the root; free). `None` when empty.
    fn max_value(&self) -> Option<f64> {
        if self.root == NIL {
            return None;
        }
        let mut cur = self.root;
        while self.n(cur).right != NIL {
            cur = self.n(cur).right;
        }
        Some(self.n(cur).value)
    }

    /// Value of the current minimum (left links from the root; free). `None` when empty.
    fn min_value(&self) -> Option<f64> {
        if self.root == NIL {
            return None;
        }
        let mut cur = self.root;
        while self.n(cur).left != NIL {
            cur = self.n(cur).left;
        }
        Some(self.n(cur).value)
    }

    // ── Rotations (CLRS LEFT-ROTATE / RIGHT-ROTATE), one op each ──

    /// Lift `x.right` (`y`) into `x`'s place.
    fn rotate_left<const COUNT: bool>(&mut self, x: u32, c: &mut Cost) {
        if COUNT {
            c.rotations += 1;
        }
        let y = self.n(x).right;
        debug_assert!(y != NIL, "left rotation needs a right child");
        let b = self.n(y).left;
        self.nm(x).right = b;
        if b != NIL {
            self.nm(b).parent = x;
        }
        let p = self.n(x).parent;
        self.nm(y).parent = p;
        if p == NIL {
            self.root = y;
        } else if self.n(p).left == x {
            self.nm(p).left = y;
        } else {
            self.nm(p).right = y;
        }
        self.nm(y).left = x;
        self.nm(x).parent = y;
    }

    /// Lift `y.left` (`x`) into `y`'s place (mirror of [`RbtF64::rotate_left`]).
    fn rotate_right<const COUNT: bool>(&mut self, y: u32, c: &mut Cost) {
        if COUNT {
            c.rotations += 1;
        }
        let x = self.n(y).left;
        debug_assert!(x != NIL, "right rotation needs a left child");
        let b = self.n(x).right;
        self.nm(y).left = b;
        if b != NIL {
            self.nm(b).parent = y;
        }
        let p = self.n(y).parent;
        self.nm(x).parent = p;
        if p == NIL {
            self.root = x;
        } else if self.n(p).left == y {
            self.nm(p).left = x;
        } else {
            self.nm(p).right = x;
        }
        self.nm(x).right = y;
        self.nm(y).parent = x;
    }

    // ── Insert (CLRS RB-INSERT + RB-INSERT-FIXUP) ──

    /// Insert `key` (`key < node` ⇒ left, else right — equal keys go right), then restore
    /// the colour invariants. Counts one comparison per existing node on the descent, plus
    /// the fix-up's rotations (at most two) and recolours.
    fn insert<const COUNT: bool>(&mut self, key: f64, c: &mut Cost) {
        let mut parent = NIL;
        let mut cur = self.root;
        let mut go_left = false;
        while cur != NIL {
            if COUNT {
                c.comparisons += 1;
            }
            parent = cur;
            go_left = key < self.n(cur).value;
            cur = if go_left { self.n(cur).left } else { self.n(cur).right };
        }
        let z = self.alloc(key, parent);
        if parent == NIL {
            self.root = z;
        } else if go_left {
            self.nm(parent).left = z;
        } else {
            self.nm(parent).right = z;
        }
        self.count += 1;
        self.insert_fixup::<COUNT>(z, c);
    }

    fn insert_fixup<const COUNT: bool>(&mut self, mut z: u32, c: &mut Cost) {
        // A red parent is never the root (the root is black), so the grandparent exists.
        while self.is_red(self.n(z).parent) {
            let p = self.n(z).parent;
            let g = self.n(p).parent;
            if p == self.n(g).left {
                let u = self.n(g).right;
                if self.is_red(u) {
                    // Case 1 — red uncle: push the blackness down from g, move up two levels.
                    self.paint::<COUNT>(p, false, c);
                    self.paint::<COUNT>(u, false, c);
                    self.paint::<COUNT>(g, true, c);
                    z = g;
                } else {
                    if z == self.n(p).right {
                        // Case 2 — black uncle, zig-zag: straighten it into case 3.
                        z = p;
                        self.rotate_left::<COUNT>(z, c);
                    }
                    // Case 3 — black uncle, straight line: one rotation at g ends it.
                    let p = self.n(z).parent;
                    let g = self.n(p).parent;
                    self.paint::<COUNT>(p, false, c);
                    self.paint::<COUNT>(g, true, c);
                    self.rotate_right::<COUNT>(g, c);
                }
            } else {
                let u = self.n(g).left;
                if self.is_red(u) {
                    self.paint::<COUNT>(p, false, c);
                    self.paint::<COUNT>(u, false, c);
                    self.paint::<COUNT>(g, true, c);
                    z = g;
                } else {
                    if z == self.n(p).left {
                        z = p;
                        self.rotate_right::<COUNT>(z, c);
                    }
                    let p = self.n(z).parent;
                    let g = self.n(p).parent;
                    self.paint::<COUNT>(p, false, c);
                    self.paint::<COUNT>(g, true, c);
                    self.rotate_left::<COUNT>(g, c);
                }
            }
        }
        let root = self.root;
        self.paint::<COUNT>(root, false, c);
    }

    // ── Delete (value-copy over CLRS RB-DELETE-FIXUP) ──

    /// Delete the first matching key on the way down (one comparison per node examined,
    /// the match included). A two-child match takes its in-order successor's value and the
    /// successor's node is unlinked instead (the walk to it is free). If the unlinked node
    /// was black the fix-up runs: at most three rotations. Returns whether a key was
    /// removed.
    ///
    /// This value-copy form leaves exactly the values and colours in exactly the places
    /// CLRS's node-moving `RB-TRANSPLANT` form does — pinned by
    /// `tests::value_copy_delete_matches_the_clrs_transplant_delete`.
    fn delete<const COUNT: bool>(&mut self, key: f64, c: &mut Cost) -> bool {
        let mut z = self.root;
        while z != NIL {
            if COUNT {
                c.comparisons += 1;
            }
            let v = self.n(z).value;
            if key < v {
                z = self.n(z).left;
            } else if key > v {
                z = self.n(z).right;
            } else {
                break;
            }
        }
        if z == NIL {
            return false;
        }
        // The node physically removed: z itself, or (two children) its successor.
        let y = if self.n(z).left != NIL && self.n(z).right != NIL {
            let mut s = self.n(z).right;
            while self.n(s).left != NIL {
                s = self.n(s).left;
            }
            let sv = self.n(s).value;
            self.nm(z).value = sv;
            s
        } else {
            z
        };
        self.unlink::<COUNT>(y, c);
        true
    }

    /// Splice out `y` (which has at most one child), free its slot, and run the fix-up if
    /// a black node left the tree.
    fn unlink<const COUNT: bool>(&mut self, y: u32, c: &mut Cost) {
        let x = if self.n(y).left != NIL { self.n(y).left } else { self.n(y).right };
        let xp = self.n(y).parent;
        if x != NIL {
            self.nm(x).parent = xp;
        }
        let x_is_left = xp != NIL && self.n(xp).left == y;
        if xp == NIL {
            self.root = x;
        } else if x_is_left {
            self.nm(xp).left = x;
        } else {
            self.nm(xp).right = x;
        }
        let y_was_red = self.n(y).red;
        self.free.push(y);
        self.count -= 1;
        if !y_was_red {
            self.delete_fixup::<COUNT>(x, xp, x_is_left, c);
        }
    }

    /// CLRS RB-DELETE-FIXUP with the parent carried explicitly (`xp`) and the side of `x`
    /// carried as `x_is_left` for the first step — `x` may be NIL, whose own parent link is
    /// never written.
    fn delete_fixup<const COUNT: bool>(&mut self, mut x: u32, mut xp: u32, mut x_is_left: bool, c: &mut Cost) {
        while x != self.root && !self.is_red(x) {
            if x_is_left {
                let mut w = self.n(xp).right;
                if self.is_red(w) {
                    // Case 1 — red sibling: rotate it above xp to get a black sibling.
                    self.paint::<COUNT>(w, false, c);
                    self.paint::<COUNT>(xp, true, c);
                    self.rotate_left::<COUNT>(xp, c);
                    w = self.n(xp).right;
                }
                if !self.is_red(self.n(w).left) && !self.is_red(self.n(w).right) {
                    // Case 2 — black sibling, two black nephews: recolour, move up.
                    self.paint::<COUNT>(w, true, c);
                    x = xp;
                    xp = self.n(x).parent;
                    x_is_left = xp != NIL && self.n(xp).left == x;
                } else {
                    if !self.is_red(self.n(w).right) {
                        // Case 3 — near nephew red, far black: rotate it into case 4.
                        let wl = self.n(w).left;
                        self.paint::<COUNT>(wl, false, c);
                        self.paint::<COUNT>(w, true, c);
                        self.rotate_right::<COUNT>(w, c);
                        w = self.n(xp).right;
                    }
                    // Case 4 — far nephew red: one rotation at xp ends it.
                    let xp_red = self.is_red(xp);
                    self.paint::<COUNT>(w, xp_red, c);
                    self.paint::<COUNT>(xp, false, c);
                    let wr = self.n(w).right;
                    self.paint::<COUNT>(wr, false, c);
                    self.rotate_left::<COUNT>(xp, c);
                    x = self.root;
                    xp = NIL;
                }
            } else {
                let mut w = self.n(xp).left;
                if self.is_red(w) {
                    self.paint::<COUNT>(w, false, c);
                    self.paint::<COUNT>(xp, true, c);
                    self.rotate_right::<COUNT>(xp, c);
                    w = self.n(xp).left;
                }
                if !self.is_red(self.n(w).right) && !self.is_red(self.n(w).left) {
                    self.paint::<COUNT>(w, true, c);
                    x = xp;
                    xp = self.n(x).parent;
                    x_is_left = xp != NIL && self.n(xp).left == x;
                } else {
                    if !self.is_red(self.n(w).left) {
                        let wr = self.n(w).right;
                        self.paint::<COUNT>(wr, false, c);
                        self.paint::<COUNT>(w, true, c);
                        self.rotate_left::<COUNT>(w, c);
                        w = self.n(xp).left;
                    }
                    let xp_red = self.is_red(xp);
                    self.paint::<COUNT>(w, xp_red, c);
                    self.paint::<COUNT>(xp, false, c);
                    let wl = self.n(w).left;
                    self.paint::<COUNT>(wl, false, c);
                    self.rotate_right::<COUNT>(xp, c);
                    x = self.root;
                    xp = NIL;
                }
            }
        }
        self.paint::<COUNT>(x, false, c);
    }

    /// Search: compare at each node until a match or NIL; one comparison per node.
    fn find<const COUNT: bool>(&self, key: f64, c: &mut Cost) -> bool {
        let mut cur = self.root;
        while cur != NIL {
            if COUNT {
                c.comparisons += 1;
            }
            let v = self.n(cur).value;
            if key == v {
                return true;
            }
            cur = if key < v { self.n(cur).left } else { self.n(cur).right };
        }
        false
    }

    // ── Conformance / methodology test surface (docs/PLAN.md §12) ──

    /// Membership plus the comparison count for one search.
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut c = Cost::default();
        let found = self.find::<true>(target, &mut c);
        (found, c.ops())
    }

    /// Insert one key, returning the shared op-count (comparisons + rotations).
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        self.insert_one_detail(key).ops()
    }

    /// Delete one occurrence, returning `(removed, comparisons + rotations)`.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let (removed, c) = self.delete_one_detail(target);
        (removed, c.ops())
    }

    /// Insert one key, returning the full breakdown — comparisons, rotations, recolours.
    pub fn insert_one_detail(&mut self, key: f64) -> Cost {
        let mut c = Cost::default();
        self.insert::<true>(key, &mut c);
        c
    }

    /// Delete one occurrence, returning whether it was removed and the full breakdown.
    pub fn delete_one_detail(&mut self, target: f64) -> (bool, Cost) {
        let mut c = Cost::default();
        let removed = self.delete::<true>(target, &mut c);
        (removed, c)
    }

    /// The full breakdown of a cumulative build of the first `n` keys.
    pub fn build_cost(keys: &[f64], n: usize) -> Cost {
        let n = n.min(keys.len());
        let mut t = RbtF64::with_capacity(n);
        let mut c = Cost::default();
        for &k in &keys[..n] {
            t.insert::<true>(k, &mut c);
        }
        c
    }

    /// The full breakdown of a size-`n` alternating delete-max / delete-min teardown.
    pub fn teardown_cost(keys: &[f64], n: usize) -> Cost {
        let mut t = RbtF64::new(keys, n);
        let mut total = Cost::default();
        let mut take_hi = true;
        loop {
            let end = if take_hi { t.max_value() } else { t.min_value() };
            match end {
                Some(v) => {
                    take_hi = !take_hi;
                    let (_, c) = t.delete_one_detail(v);
                    total.add(c);
                }
                None => break,
            }
        }
        total
    }

    /// The current maximum and minimum (test surface for the teardown sequences).
    pub fn extremes(&self) -> Option<(f64, f64)> {
        Some((self.min_value()?, self.max_value()?))
    }

    /// Tree height in nodes (0 when empty). Iterative.
    pub fn tree_height(&self) -> u32 {
        let mut best = 0u32;
        let mut stack: Vec<(u32, u32)> = Vec::new();
        if self.root != NIL {
            stack.push((self.root, 1));
        }
        while let Some((i, d)) = stack.pop() {
            best = best.max(d);
            let (l, r) = (self.n(i).left, self.n(i).right);
            if l != NIL {
                stack.push((l, d + 1));
            }
            if r != NIL {
                stack.push((r, d + 1));
            }
        }
        best
    }

    /// Sum over every node of its depth (root = 1) — the total comparisons to find every
    /// stored key once, the tree's *average search cost* times n. Iterative.
    pub fn internal_path_length(&self) -> u64 {
        let mut total = 0u64;
        let mut stack: Vec<(u32, u64)> = Vec::new();
        if self.root != NIL {
            stack.push((self.root, 1));
        }
        while let Some((i, d)) = stack.pop() {
            total += d;
            let (l, r) = (self.n(i).left, self.n(i).right);
            if l != NIL {
                stack.push((l, d + 1));
            }
            if r != NIL {
                stack.push((r, d + 1));
            }
        }
        total
    }

    /// Keys in ascending (in-order) order — the sorted multiset. Iterative.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut stack: Vec<u32> = Vec::new();
        let mut cur = self.root;
        while cur != NIL || !stack.is_empty() {
            while cur != NIL {
                stack.push(cur);
                cur = self.n(cur).left;
            }
            let i = stack.pop().expect("non-empty");
            out.push(self.n(i).value);
            cur = self.n(i).right;
        }
        out
    }

    /// Pre-order with explicit `None` null markers and each node's colour (`true` = red) —
    /// the cross-language shape **and colour** pin. Two trees of the same shape but
    /// different colours behave differently on the next operation, so shape alone is not
    /// enough. Iterative.
    pub fn preorder(&self) -> Vec<Option<(f64, bool)>> {
        let mut out = Vec::new();
        let mut stack: Vec<u32> = vec![self.root];
        while let Some(i) = stack.pop() {
            if i == NIL {
                out.push(None);
            } else {
                out.push(Some((self.n(i).value, self.n(i).red)));
                stack.push(self.n(i).right);
                stack.push(self.n(i).left);
            }
        }
        out
    }

    /// Whether every red-black invariant holds, plus the arena's own bookkeeping:
    /// the root is black; no red node has a red child; every root-to-NIL path has the same
    /// number of black nodes; in-order is non-decreasing; every child's parent link points
    /// back at its parent; the reachable node count equals `len`; the sentinel is still
    /// black; and the height is ≤ 2·log₂(n+1). The proptest asserts it after every op.
    pub fn check_rb(&self) -> bool {
        if self.n(NIL).red || self.is_red(self.root) {
            return false;
        }
        if self.root != NIL && self.n(self.root).parent != NIL {
            return false;
        }
        // Iterative post-order-free check: walk with the black depth carried down.
        let mut leaf_black: Option<u32> = None;
        let mut reached = 0usize;
        let mut stack: Vec<(u32, u32)> = Vec::new(); // (node, black count above incl. node)
        if self.root != NIL {
            stack.push((self.root, 1));
        } else {
            leaf_black = Some(0);
        }
        while let Some((i, bd)) = stack.pop() {
            reached += 1;
            let node = self.n(i);
            for child in [node.left, node.right] {
                if child == NIL {
                    match leaf_black {
                        None => leaf_black = Some(bd),
                        Some(b) if b != bd => return false,
                        _ => {}
                    }
                } else {
                    let ch = self.n(child);
                    if ch.parent != i {
                        return false;
                    }
                    if node.red && ch.red {
                        return false;
                    }
                    stack.push((child, bd + u32::from(!ch.red)));
                }
            }
        }
        if reached != self.count {
            return false;
        }
        let keys = self.keys_in_order();
        if keys.windows(2).any(|w| w[0] > w[1]) {
            return false;
        }
        let bound = 2.0 * ((self.count + 1) as f64).log2();
        (self.tree_height() as f64) <= bound + 1e-9
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rbt(keys: &[f64]) -> RbtF64 {
        RbtF64::new(keys, keys.len())
    }

    /// Pre-order shape with colours, `.` for NIL — the unit-test mirror of the corpus form.
    fn shape(t: &RbtF64) -> String {
        t.preorder()
            .iter()
            .map(|n| match n {
                Some((v, red)) => format!("{v}{}", if *red { 'r' } else { 'b' }),
                None => ".".to_string(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn cost(comparisons: u64, rotations: u64, recolours: u64) -> Cost {
        Cost { comparisons, rotations, recolours }
    }

    /// The slot holding `v` (test-only; distinct keys).
    fn slot_of(t: &RbtF64, v: f64) -> usize {
        (1..t.nodes.len()).find(|&i| t.nodes[i].value == v).expect("stored")
    }

    /// `check_rb` is the proptest's oracle, so each invariant it claims to check is broken
    /// here once and must be caught.
    #[test]
    fn check_rb_rejects_each_broken_invariant() {
        let fresh = || rbt(&[20.0, 10.0, 30.0, 5.0]); // 20b{10b{5r,.},30b}
        assert!(fresh().check_rb());
        let mut t = fresh();
        let r = t.root as usize;
        t.nodes[r].red = true;
        assert!(!t.check_rb(), "red root");
        let mut t = fresh();
        let i = slot_of(&t, 10.0);
        t.nodes[i].red = true;
        assert!(!t.check_rb(), "red node with a red child");
        let mut t = fresh();
        let i = slot_of(&t, 30.0);
        t.nodes[i].red = true;
        assert!(!t.check_rb(), "unequal black heights");
        let mut t = fresh();
        let i = slot_of(&t, 5.0);
        t.nodes[i].parent = slot_of(&t, 20.0) as u32;
        assert!(!t.check_rb(), "parent link disagrees with child link");
        let mut t = fresh();
        t.count += 1;
        assert!(!t.check_rb(), "reachable nodes ≠ len");
        let mut t = fresh();
        let i = slot_of(&t, 5.0);
        t.nodes[i].value = 99.0;
        assert!(!t.check_rb(), "in-order not sorted");
    }

    #[test]
    fn in_order_is_the_sorted_multiset_duplicates_kept() {
        let t = rbt(&[50.0, 30.0, 70.0, 30.0, 20.0, 60.0]);
        assert_eq!(t.keys_in_order(), vec![20.0, 30.0, 30.0, 50.0, 60.0, 70.0]);
        assert_eq!(t.len(), 6);
        assert!(t.check_rb());
    }

    /// The first key is painted red at birth and then blackened as the root — the one
    /// recolour an empty-tree insert pays, by the module doc's definition.
    #[test]
    fn first_insert_blackens_the_root() {
        let mut t = RbtF64::new_empty();
        assert_eq!(t.insert_one_detail(10.0), cost(0, 0, 1));
        assert_eq!(shape(&t), "10b . .");
    }

    /// Insert case 3 (black uncle, straight line) on sorted input — the BST's chain
    /// sequence. One rotation, two recolours.
    #[test]
    fn straight_line_black_uncle_is_one_rotation() {
        let mut t = rbt(&[10.0, 20.0]);
        assert_eq!(t.insert_one_detail(30.0), cost(2, 1, 2));
        assert_eq!(shape(&t), "20b 10r . . 30r . .");
        assert!(t.check_rb());
    }

    /// Insert case 2 → 3 (black uncle, zig-zag): the double rotation, two ops.
    #[test]
    fn zig_zag_black_uncle_is_a_double_rotation() {
        let mut t = rbt(&[30.0, 10.0]);
        assert_eq!(t.insert_one_detail(20.0), cost(2, 2, 2));
        assert_eq!(shape(&t), "20b 10r . . 30r . .");
        let mut t = rbt(&[10.0, 30.0]);
        assert_eq!(t.insert_one_detail(20.0), cost(2, 2, 2));
        assert_eq!(shape(&t), "20b 10r . . 30r . .");
        assert!(t.check_rb());
    }

    /// Insert case 1 (red uncle): no rotation at all — the blackness is pushed down and the
    /// root goes red then back to black (two recolours on one node, by definition).
    #[test]
    fn red_uncle_recolours_without_rotating() {
        let mut t = rbt(&[20.0, 10.0, 30.0]);
        assert_eq!(shape(&t), "20b 10r . . 30r . .");
        assert_eq!(t.insert_one_detail(5.0), cost(2, 0, 4));
        assert_eq!(shape(&t), "20b 10b 5r . . . 30b . .");
        assert!(t.check_rb());
    }

    #[test]
    fn search_counts_comparisons_only() {
        let t = rbt(&[20.0, 10.0, 30.0]);
        assert_eq!(t.search_one_counted(20.0), (true, 1));
        assert_eq!(t.search_one_counted(10.0), (true, 2));
        assert_eq!(t.search_one_counted(99.0), (false, 2));
    }

    /// Deleting a red leaf needs no fix-up: comparisons only.
    #[test]
    fn delete_red_leaf_is_free_of_fixup() {
        let mut t = rbt(&[20.0, 10.0, 30.0]);
        assert_eq!(t.delete_one_detail(30.0), (true, cost(2, 0, 0)));
        assert_eq!(shape(&t), "20b 10r . . .");
        assert!(t.check_rb());
    }

    /// Delete case 2 (black sibling, black nephews): recolour only, the doubly-black moves
    /// up to a red parent which absorbs it.
    #[test]
    fn delete_black_leaf_with_black_sibling_recolours() {
        // 20b{10b{5r},30b}: delete 30 (black leaf). Sibling 10 is black with a red near...
        // use a tree whose sibling has *no* red children instead.
        let mut t = rbt(&[20.0, 10.0, 30.0, 5.0]);
        assert!(t.delete_one_detail(5.0).0); // 20b{10b,30b}
        assert_eq!(shape(&t), "20b 10b . . 30b . .");
        assert_eq!(t.delete_one_detail(30.0), (true, cost(2, 0, 1)));
        assert_eq!(shape(&t), "20b 10r . . .");
        assert!(t.check_rb());
    }

    /// Delete case 4 (far nephew red) after case 3 (near nephew red): the rotation path.
    #[test]
    fn delete_with_red_near_nephew_rotates_twice() {
        // 20b{10b{_,15r},30b}: deleting 30 leaves x on the right; sibling 10's near nephew
        // (15, the right child) is red and the far one (left) black ⇒ case 3 then case 4.
        let mut t = rbt(&[20.0, 10.0, 30.0, 15.0]);
        assert_eq!(shape(&t), "20b 10b . 15r . . 30b . .");
        let (removed, c) = t.delete_one_detail(30.0);
        assert!(removed);
        assert_eq!(c.comparisons, 2);
        assert_eq!(c.rotations, 2);
        assert_eq!(shape(&t), "15b 10b . . 20b . .");
        assert!(t.check_rb());
    }

    /// Delete case 1 (red sibling): rotate the sibling up first.
    #[test]
    fn delete_with_red_sibling_rotates_it_up() {
        // Build a tree whose root's right child is red with two black children, then delete
        // a black leaf on the left.
        let mut t = rbt(&[10.0, 5.0, 20.0, 15.0, 25.0, 30.0]);
        assert!(t.check_rb());
        assert_eq!(shape(&t), "10b 5b . . 20r 15b . . 25b . 30r . .");
        let (removed, c) = t.delete_one_detail(5.0);
        assert!(removed);
        assert_eq!(c.comparisons, 2);
        assert!(c.rotations >= 1 && c.rotations <= 3);
        assert_eq!(t.keys_in_order(), vec![10.0, 15.0, 20.0, 25.0, 30.0]);
        assert!(t.check_rb());
    }

    /// Two-child delete counts the find path only — the successor walk is free — and the
    /// successor's *value* moves up while its node is the one unlinked.
    #[test]
    fn two_child_delete_counts_find_path_only() {
        let mut t = rbt(&[20.0, 10.0, 30.0]);
        assert_eq!(t.delete_one_detail(20.0), (true, cost(1, 0, 0)));
        assert_eq!(shape(&t), "30b 10r . . .");
        assert!(t.check_rb());
    }

    #[test]
    fn equal_keys_go_right_and_delete_removes_one() {
        let mut t = rbt(&[50.0, 50.0, 50.0, 70.0]);
        assert_eq!(t.keys_in_order(), vec![50.0, 50.0, 50.0, 70.0]);
        assert!(t.check_rb());
        assert!(t.delete_one_counted(50.0).0);
        assert_eq!(t.keys_in_order(), vec![50.0, 50.0, 70.0]);
        assert_eq!(t.len(), 3);
        assert!(t.check_rb());
        assert_eq!(t.delete_one_counted(99.0).0, false);
    }

    #[test]
    fn empty_tree_search_and_delete() {
        let t = rbt(&[]);
        assert_eq!(t.search_one_counted(1.0), (false, 0));
        assert_eq!(shape(&t), ".");
        let mut t = rbt(&[]);
        assert_eq!(t.delete_one_counted(1.0), (false, 0));
        assert!(t.is_empty());
        assert!(t.check_rb());
    }

    /// Sorted input — the BST's O(n) chain — stays within the red-black bound.
    #[test]
    fn sorted_input_stays_within_the_height_bound() {
        let keys: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let t = rbt(&keys);
        assert!(t.check_rb());
        assert!(t.tree_height() <= 2 * 10, "height {} > 2·log₂(1001)", t.tree_height());
        let (found, ops) = t.search_one_counted(999.0);
        assert!(found && ops <= 20, "max search {ops} must be O(log n) ≪ 1000");
    }

    /// The textbook bound the comparison with the AVL turns on: **at most two rotations per
    /// insert and three per delete**, on every single operation of a long mixed sequence
    /// (sorted build, shuffled build, alternating teardown, random deletes).
    #[test]
    fn rotations_per_op_never_exceed_two_on_insert_or_three_on_delete() {
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut t = RbtF64::new_empty();
        for i in 0..2000 {
            assert!(t.insert_one_detail(i as f64).rotations <= 2);
        }
        for _ in 0..2000 {
            let k = (next() % 4000) as f64;
            assert!(t.insert_one_detail(k).rotations <= 2);
        }
        for _ in 0..3000 {
            let k = (next() % 4000) as f64;
            let (_, c) = t.delete_one_detail(k);
            assert!(c.rotations <= 3, "delete rotated {} times", c.rotations);
        }
        let mut take_hi = true;
        while let Some((lo, hi)) = t.extremes() {
            let k = if take_hi { hi } else { lo };
            take_hi = !take_hi;
            assert!(t.delete_one_detail(k).1.rotations <= 3);
        }
        assert!(t.is_empty());
        assert!(t.check_rb());
    }

    // ── Value-copy delete ≡ CLRS RB-TRANSPLANT delete ──
    //
    // The module claims the value-copy form leaves the same values and colours in the same
    // places as the textbook's node-moving form. This is the textbook form, written against
    // the same arena, for that comparison only.

    impl RbtF64 {
        fn transplant(&mut self, u: u32, v: u32) {
            let up = self.n(u).parent;
            if up == NIL {
                self.root = v;
            } else if self.n(up).left == u {
                self.nm(up).left = v;
            } else {
                self.nm(up).right = v;
            }
            if v != NIL {
                self.nm(v).parent = up;
            }
        }

        /// CLRS RB-DELETE, moving the successor's *node* into z's place and giving it z's
        /// colour. Same find path; the fix-up is shared.
        fn delete_clrs(&mut self, key: f64) -> bool {
            let mut z = self.root;
            while z != NIL {
                let v = self.n(z).value;
                if key < v {
                    z = self.n(z).left;
                } else if key > v {
                    z = self.n(z).right;
                } else {
                    break;
                }
            }
            if z == NIL {
                return false;
            }
            let mut c = Cost::default();
            let (zl, zr) = (self.n(z).left, self.n(z).right);
            let (x, xp, x_is_left, removed_red);
            if zl == NIL || zr == NIL {
                x = if zl != NIL { zl } else { zr };
                xp = self.n(z).parent;
                x_is_left = xp != NIL && self.n(xp).left == z;
                removed_red = self.n(z).red;
                self.transplant(z, x);
            } else {
                let mut y = zr;
                while self.n(y).left != NIL {
                    y = self.n(y).left;
                }
                removed_red = self.n(y).red;
                x = self.n(y).right;
                if self.n(y).parent == z {
                    xp = y;
                    x_is_left = false;
                } else {
                    xp = self.n(y).parent;
                    x_is_left = true;
                    self.transplant(y, x);
                    self.nm(y).right = zr;
                    self.nm(zr).parent = y;
                }
                self.transplant(z, y);
                let zl = self.n(z).left;
                self.nm(y).left = zl;
                self.nm(zl).parent = y;
                let zred = self.n(z).red;
                self.nm(y).red = zred;
            }
            self.free.push(z);
            self.count -= 1;
            if !removed_red {
                self.delete_fixup::<false>(x, xp, x_is_left, &mut c);
            }
            true
        }
    }

    #[test]
    fn value_copy_delete_matches_the_clrs_transplant_delete() {
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..40 {
            let n = 1 + (next() % 200) as usize;
            // Distinct keys: with duplicates the two forms may unlink different (equal-
            // valued) nodes, which is the same multiset but not the same node identity.
            let mut keys: Vec<f64> = (0..n).map(|i| i as f64).collect();
            for i in (1..n).rev() {
                let j = (next() % (i as u64 + 1)) as usize;
                keys.swap(i, j);
            }
            let mut a = rbt(&keys);
            let mut b = rbt(&keys);
            for _ in 0..n {
                let k = (next() % (n as u64 + 5)) as f64;
                assert_eq!(a.delete_one_counted(k).0, b.delete_clrs(k), "round {round}");
                assert_eq!(shape(&a), shape(&b), "round {round}: delete {k} diverged");
                assert!(a.check_rb() && b.check_rb());
            }
        }
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut t = rbt(&[50.0, 30.0, 70.0]);
        t.set_probes(&[30.0, 99.0]);
        assert_eq!(t.search_n(4), 2);
        assert_eq!(t.search_counted(), 4.0); // 50→30, 50→70→NIL
    }

    #[test]
    fn churn_holds_size_and_contents_and_reuses_the_arena() {
        let keys: Vec<f64> = (10..60).map(|i| i as f64).collect();
        let mut t = rbt(&keys);
        t.set_churn_keys(9.0, 99.0);
        let before = t.keys_in_order();
        let slots = t.nodes.len();
        t.churn_n(101); // odd ⇒ both keys
        assert_eq!(t.len(), keys.len());
        assert_eq!(t.keys_in_order(), before);
        assert_eq!(t.nodes.len(), slots + 1, "a churn pair reuses its slot, never grows the arena");
        assert!(t.check_rb());
        assert!(t.churn_counted() > 0.0);
        assert_eq!(t.len(), keys.len());
        assert!(t.check_rb());
    }

    #[test]
    fn extremes_follow_the_spines() {
        let t = rbt(&[50.0, 30.0, 70.0, 60.0, 80.0]);
        assert_eq!(t.extremes(), Some((30.0, 80.0)));
        assert_eq!(rbt(&[]).extremes(), None);
    }

    #[test]
    fn build_and_teardown_round_trip_to_empty() {
        let keys: Vec<f64> = (0..64).map(|i| i as f64).collect();
        assert_eq!(RbtF64::build_insert_n(&keys, 64), 64);
        assert!(RbtF64::build_insert_counted(&keys, 64) < 1000.0);
        assert_eq!(RbtF64::build_then_teardown_n(&keys, 64), 64);
        let td = RbtF64::teardown_cost(&keys, 64);
        assert!(td.ops() > 0);
        assert_eq!(RbtF64::teardown_counted(&keys, 64), td.ops() as f64);
    }
}
