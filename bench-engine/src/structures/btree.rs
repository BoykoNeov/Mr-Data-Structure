//! **B-tree** of minimum degree `t` (docs/PLAN.md §8, "Trees / heaps", balanced; Phase 6)
//! — the production/bench twin of the TypeScript teaching impl (`src/structures/btree.ts`).
//!
//! Why it is in the catalogue: it is the balanced tree whose **op-count and real clock are
//! expected to tell different stories about the constant** (docs/METHODOLOGY.md §2.10). A
//! lookup makes about as many key *comparisons* as the AVL's — ≈ log₂ n, binary search is
//! binary search — but it makes them inside ≈ log_t n wide nodes rather than ≈ log₂ n
//! two-key ones, so it takes roughly a quarter of the AVL's dependent pointer hops. The
//! comparison count literally cannot see that; `node-visits` (reported clock-free in
//! `structures::methodology_btree`, not on the chart) can.
//!
//! # Semantics — a multiset, duplicates kept
//!
//! "Keys are identity; never dedupe" (CLAUDE.md). Every inserted key is stored, and a
//! delete removes **one** occurrence — the *first* one in sorted (in-order) order. The
//! ordering invariant is the non-strict one a multiset needs: every key in child `i` lies in
//! `[keys[i-1], keys[i]]` (inclusive), so equal keys may sit on both sides of an equal
//! separator. Duplicates spanning node boundaries are the classic B-tree bug; the proptests
//! (`tests/proptest_btree.rs`) run at `t = 2` with keys drawn from a handful of values so
//! that case is the common one, not the rare one.
//!
//! # The algorithm, and every choice the TS twin must share (risk R1)
//!
//! Changing any rule below changes the corpus (`conformance/corpus-btree.txt`); the teaching
//! twin mirrors each one line for line.
//!
//! - **Node capacity.** At most `2t − 1` keys and `2t` children; every node except the root
//!   holds at least `t − 1`. All leaves are at the same depth.
//! - **Search — lower bound, equality deferred to the end.** Each node is binary-searched for
//!   the first key `≥ k` (`keys[mid] < k` is the one comparison per probe). If there is one,
//!   it becomes the *candidate*; the descent continues into child `i` regardless, down to a
//!   leaf. One final comparison `candidate == k` decides membership (none at all when no key
//!   `≥ k` was ever seen — there is nothing to compare). The deepest candidate is the global
//!   lower bound of `k`, so this is exact, and it makes a lookup cost ≈ log₂ n comparisons
//!   whether the key sits in a leaf or a separator. It never stops early on an internal hit:
//!   with only `<` tests a node cannot know a key is present until the end, and stopping
//!   early would cost an extra equality comparison per node to save a level ~1 time in 20.
//! - **Insert — upper bound, proactive split on the way down (CLRS).** A full root is split
//!   first (the tree grows a level); then at each internal node the child to enter is found
//!   by the first key `> k` (`keys[mid] <= k`), so **equal keys go right**, as in the AVL. A
//!   full child is split *before* it is entered, and one more comparison (`median <= k`)
//!   picks the half. The new key lands at the leaf's upper bound.
//! - **Split.** A full node (`2t − 1` keys) keeps its first `t − 1` keys, sends key `t − 1`
//!   up as the separator, and moves the last `t − 1` keys (and last `t` children) into a new
//!   right sibling.
//! - **Delete — find like search, then repair underflow on the way back up.** The descent is
//!   the search's (same comparisons), recording the path. A candidate equal to `k` in a leaf
//!   is removed there. A candidate in an internal node is replaced by its **in-order
//!   predecessor** — the last key of the leaf the descent already reached, since below the
//!   candidate every key is `< k`, so the lower bound walked the rightmost path of the
//!   candidate's left child. No second search, no re-delete by value. Then, from that leaf
//!   upward, a node left with fewer than `t − 1` keys is repaired: **borrow from the left
//!   sibling** if it can spare a key, else **borrow from the right**, else **merge** (with the
//!   left sibling when there is one, else with the right) and continue at the parent. A root
//!   left with no keys is replaced by its only child (or the tree becomes empty).
//!
//! ## Why not CLRS's single-pass delete — the honesty trap this replaces
//!
//! CLRS's delete *pre-fills* every node it enters that holds exactly `t − 1` keys, by a
//! borrow or a merge. Together with the proactive split that is a **thrash at a node
//! boundary**: a split leaves both halves at exactly `t − 1` keys — exactly the size the
//! single-pass delete repairs — so a churn pair (insert then delete one absent key, the §6.3
//! primary probe) can split a node on the way down and merge it straight back on the way
//! down again, on *every* pair. A hand trace at `t = 2`: root `[20]`, left child `[5 10 15]`
//! (full, leaves `[1] [7] [12] [17]`), right child `[30]` (leaves `[25] [35]`). Insert `0`:
//! the full child splits into `[5]`, `[15]` with `10` lifted, giving root `[10 20]`; the leaf
//! becomes `[0 1]`. CLRS delete `0`: entering `[5]` (t − 1 keys) whose sibling `[15]` also
//! has t − 1, it merges them back into `[5 10 15]` and the root returns to `[20]` — the exact
//! start state, so the next pair splits and merges again. On sorted input a proactive-split
//! build leaves the whole left spine at `t − 1`, so it thrashes at *every* level. The churn
//! curve would then measure node allocation and O(t) key moves, not the descent.
//!
//! Repairing only on **underflow** (fewer than `t − 1`) has hysteresis: a split produces
//! `t − 1` (not underflow), a merge produces at most `2t − 2` (not full), so an insert+delete
//! pair of the same edge key settles after at most a few warm-up pairs and then performs no
//! structural change at all. That is also what production B-trees do. Pinned by
//! `tests::churn_settles_into_zero_restructures_and_zero_allocation` (ascending, descending
//! and shuffled builds, `t = 2` and `t = 16`). A second benefit: deleting an *absent* key
//! never touches the tree (pinned by `tests::deleting_an_absent_key_changes_nothing`).
//!
//! # Cost metric — comparisons + splits/merges/borrows (docs/PLAN.md §8)
//!
//! The op-count is **key comparisons** (each binary-search probe, the split-side test, the
//! final equality test) **plus one per structural event** — split, merge, borrow — the
//! B-tree's counterpart of the AVL's rotations. Key *moves* within or between nodes are not
//! counted: they are bounded block copies (≤ 2t − 1 keys), the B-tree's analogue of the AVL's
//! height arithmetic, and counting them would let a layout detail pose as complexity — the
//! same call the trie makes for its in-node child lookup. They are real on the clock, which
//! is exactly where §2.10 says to look for them. A root collapse after a merge is part of
//! that merge, not a second event. Steady-state churn has no structural events at all
//! (above), so its op-count is comparisons only; the finite-difference build includes the
//! amortised splits (≈ 1/(t − 1) per insert).
//!
//! # Layout — a flat index arena, keys inline per node
//!
//! Node `i`'s keys are `keys[i·(2t−1) ..]` and its children `kids[i·2t ..]`, in two flat
//! `Vec`s: a node's keys are one contiguous block (the point of a B-tree), every move between
//! two nodes is a `copy_within` on one buffer, and nothing recurses — the descent is a loop
//! and the delete's repair walks a fixed-size on-stack path array (no `Vec` in the timed
//! path). Freed nodes (merges, root collapse) go on a free list that splits reuse, so a
//! settled churn allocates nothing; a split with an empty free list grows the arena by one
//! node, which is the only allocation an insert can make (the AVL allocates a `Box` on
//! *every* insert). At `t = 16` a node is 31 keys = 248 bytes, about four 64-byte cache lines
//! (plus its child array, 128 bytes, in a separate buffer): wide enough that the tree is
//! ~4 levels deep at 100 000 keys, small enough that the in-node binary search stays inside
//! one short contiguous run the prefetcher handles. The claim is *fewer dependent pointer
//! hops*, not "one cache line per node" — it is not one line.
//!
//! **Counting is the usual zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4). One
//! set of diagnostic tallies (`event_counts`) is bumped unconditionally on a split/merge/borrow:
//! those are rare O(t) events already, and the steady-state timed path never reaches them.

use wasm_bindgen::prelude::*;

/// The shipped minimum degree: up to `2·16 − 1 = 31` keys per node (see the module doc).
pub const MIN_DEGREE: usize = 16;

/// Child-slot sentinel for "no node".
const NONE: u32 = u32::MAX;

/// Upper bound on tree height for the delete's on-stack path. A B-tree of minimum degree
/// `t ≥ 2` holding `n` keys has height ≤ log_t((n + 1) / 2) + 1, i.e. ≤ 32 for n < 2³² even
/// at `t = 2` — so 64 is never reached.
const MAX_DEPTH: usize = 64;

/// The B-tree proper, generic over a runtime minimum degree so the tests can drive the
/// split/merge/borrow paths at `t = 2` with a handful of keys. The WASM type
/// [`BTreeF64`] wraps it at [`MIN_DEGREE`].
pub struct BTree {
    t: usize,
    /// `2t − 1`: the key stride, and the most keys a node may hold.
    kcap: usize,
    /// `2t`: the child stride.
    ccap: usize,
    keys: Vec<f64>,
    kids: Vec<u32>,
    lens: Vec<u32>,
    leaf: Vec<bool>,
    free: Vec<u32>,
    root: u32,
    count: usize,
    live: usize,
    /// Diagnostic tallies of structural events ever performed (counted or not), indexed
    /// by [`EV_SPLIT`], [`EV_BORROW_LEFT`], [`EV_BORROW_RIGHT`], [`EV_MERGE_LEFT`],
    /// [`EV_MERGE_RIGHT`].
    events: [u64; 5],
}

/// Indices into [`BTree::event_counts`].
pub const EV_SPLIT: usize = 0;
pub const EV_BORROW_LEFT: usize = 1;
pub const EV_BORROW_RIGHT: usize = 2;
pub const EV_MERGE_LEFT: usize = 3;
pub const EV_MERGE_RIGHT: usize = 4;

impl BTree {
    /// An empty tree of minimum degree `t` (≥ 2).
    pub fn new(t: usize) -> BTree {
        assert!(t >= 2, "a B-tree needs minimum degree t >= 2");
        BTree {
            t,
            kcap: 2 * t - 1,
            ccap: 2 * t,
            keys: Vec::new(),
            kids: Vec::new(),
            lens: Vec::new(),
            leaf: Vec::new(),
            free: Vec::new(),
            root: NONE,
            count: 0,
            live: 0,
            events: [0; 5],
        }
    }

    /// Build by inserting the first `n` keys in order.
    pub fn from_keys(t: usize, keys: &[f64], n: usize) -> BTree {
        let n = n.min(keys.len());
        let mut b = BTree::new(t);
        let mut ops = 0u64;
        for &k in &keys[..n] {
            b.insert::<false>(k, &mut ops);
        }
        b
    }

    // ── arena primitives ──

    #[inline]
    fn len(&self, x: u32) -> usize {
        self.lens[x as usize] as usize
    }
    #[inline]
    fn set_len(&mut self, x: u32, l: usize) {
        self.lens[x as usize] = l as u32;
    }
    #[inline]
    fn kb(&self, x: u32) -> usize {
        x as usize * self.kcap
    }
    #[inline]
    fn cb(&self, x: u32) -> usize {
        x as usize * self.ccap
    }
    #[inline]
    fn key(&self, x: u32, i: usize) -> f64 {
        self.keys[self.kb(x) + i]
    }
    #[inline]
    fn kid(&self, x: u32, i: usize) -> u32 {
        self.kids[self.cb(x) + i]
    }
    #[inline]
    fn is_leaf(&self, x: u32) -> bool {
        self.leaf[x as usize]
    }

    /// A fresh empty node, reusing a freed slot when there is one.
    fn alloc(&mut self, leaf: bool) -> u32 {
        self.live += 1;
        if let Some(x) = self.free.pop() {
            self.lens[x as usize] = 0;
            self.leaf[x as usize] = leaf;
            return x;
        }
        let x = self.lens.len() as u32;
        self.keys.resize(self.keys.len() + self.kcap, 0.0);
        self.kids.resize(self.kids.len() + self.ccap, NONE);
        self.lens.push(0);
        self.leaf.push(leaf);
        x
    }

    fn release(&mut self, x: u32) {
        self.live -= 1;
        self.lens[x as usize] = 0;
        self.free.push(x);
    }

    /// First index `i` with `keys[i] >= k` — one counted comparison per probe.
    #[inline]
    fn lower_bound<const COUNT: bool>(&self, x: u32, k: f64, ops: &mut u64) -> usize {
        let base = self.kb(x);
        let (mut lo, mut hi) = (0usize, self.len(x));
        while lo < hi {
            let mid = (lo + hi) / 2;
            if COUNT {
                *ops += 1;
            }
            if self.keys[base + mid] < k {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// First index `i` with `keys[i] > k` (equal keys go right) — one comparison per probe.
    #[inline]
    fn upper_bound<const COUNT: bool>(&self, x: u32, k: f64, ops: &mut u64) -> usize {
        let base = self.kb(x);
        let (mut lo, mut hi) = (0usize, self.len(x));
        while lo < hi {
            let mid = (lo + hi) / 2;
            if COUNT {
                *ops += 1;
            }
            if self.keys[base + mid] <= k {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    // ── search ──

    /// Lower-bound descent to a leaf, then one deferred equality test. Returns membership;
    /// adds comparisons to `ops` and node-visits to `visits`.
    fn find<const COUNT: bool>(&self, k: f64, ops: &mut u64, visits: &mut u64) -> bool {
        if self.root == NONE {
            return false;
        }
        let mut cand: Option<f64> = None;
        let mut x = self.root;
        loop {
            if COUNT {
                *visits += 1;
            }
            let i = self.lower_bound::<COUNT>(x, k, ops);
            if i < self.len(x) {
                cand = Some(self.key(x, i));
            }
            if self.is_leaf(x) {
                break;
            }
            x = self.kid(x, i);
        }
        match cand {
            Some(c) => {
                if COUNT {
                    *ops += 1;
                }
                c == k
            }
            None => false,
        }
    }

    // ── insert ──

    /// Split the full child `i` of non-full node `x` (the CLRS split): the child keeps its
    /// first `t − 1` keys, key `t − 1` moves up into `x` at `i`, the last `t − 1` keys (and
    /// last `t` children) move to a new right sibling at child slot `i + 1`.
    fn split_child(&mut self, x: u32, i: usize) {
        let t = self.t;
        let y = self.kid(x, i);
        let y_leaf = self.is_leaf(y);
        let z = self.alloc(y_leaf);
        let (yk, zk) = (self.kb(y), self.kb(z));
        // keys[t..2t-1] of y → z[0..t-1]
        for j in 0..t - 1 {
            self.keys[zk + j] = self.keys[yk + t + j];
        }
        if !y_leaf {
            let (yc, zc) = (self.cb(y), self.cb(z));
            for j in 0..t {
                self.kids[zc + j] = self.kids[yc + t + j];
            }
        }
        let median = self.keys[yk + t - 1];
        self.set_len(y, t - 1);
        self.set_len(z, t - 1);
        // open slot i in x's keys and slot i+1 in its children
        let xl = self.len(x);
        let (xk, xc) = (self.kb(x), self.cb(x));
        self.keys.copy_within(xk + i..xk + xl, xk + i + 1);
        self.keys[xk + i] = median;
        self.kids.copy_within(xc + i + 1..xc + xl + 1, xc + i + 2);
        self.kids[xc + i + 1] = z;
        self.set_len(x, xl + 1);
        self.events[EV_SPLIT] += 1;
    }

    fn insert<const COUNT: bool>(&mut self, k: f64, ops: &mut u64) {
        if self.root == NONE {
            self.root = self.alloc(true);
        }
        if self.len(self.root) == self.kcap {
            let s = self.alloc(false);
            let sc = self.cb(s);
            self.kids[sc] = self.root;
            self.root = s;
            self.split_child(s, 0);
            if COUNT {
                *ops += 1; // the split
            }
        }
        let mut x = self.root;
        loop {
            let mut i = self.upper_bound::<COUNT>(x, k, ops);
            if self.is_leaf(x) {
                let l = self.len(x);
                let b = self.kb(x);
                self.keys.copy_within(b + i..b + l, b + i + 1);
                self.keys[b + i] = k;
                self.set_len(x, l + 1);
                break;
            }
            let c = self.kid(x, i);
            if self.len(c) == self.kcap {
                self.split_child(x, i);
                if COUNT {
                    *ops += 2; // the split, and the comparison against the lifted median
                }
                if self.key(x, i) <= k {
                    i += 1;
                }
            }
            x = self.kid(x, i);
        }
        self.count += 1;
    }

    // ── delete ──

    /// Rotate one key from the left sibling of child `c` of `p` through the separator.
    fn borrow_from_left(&mut self, p: u32, c: usize) {
        let n = self.kid(p, c);
        let l = self.kid(p, c - 1);
        let (nl, ll) = (self.len(n), self.len(l));
        let (nk, lk, pk) = (self.kb(n), self.kb(l), self.kb(p));
        self.keys.copy_within(nk..nk + nl, nk + 1);
        self.keys[nk] = self.keys[pk + c - 1];
        self.keys[pk + c - 1] = self.keys[lk + ll - 1];
        if !self.is_leaf(n) {
            let (nc, lc) = (self.cb(n), self.cb(l));
            self.kids.copy_within(nc..nc + nl + 1, nc + 1);
            self.kids[nc] = self.kids[lc + ll];
        }
        self.set_len(l, ll - 1);
        self.set_len(n, nl + 1);
        self.events[EV_BORROW_LEFT] += 1;
    }

    /// Rotate one key from the right sibling of child `c` of `p` through the separator.
    fn borrow_from_right(&mut self, p: u32, c: usize) {
        let n = self.kid(p, c);
        let r = self.kid(p, c + 1);
        let (nl, rl) = (self.len(n), self.len(r));
        let (nk, rk, pk) = (self.kb(n), self.kb(r), self.kb(p));
        self.keys[nk + nl] = self.keys[pk + c];
        self.keys[pk + c] = self.keys[rk];
        self.keys.copy_within(rk + 1..rk + rl, rk);
        if !self.is_leaf(n) {
            let (nc, rc) = (self.cb(n), self.cb(r));
            self.kids[nc + nl + 1] = self.kids[rc];
            self.kids.copy_within(rc + 1..rc + rl + 1, rc);
        }
        self.set_len(n, nl + 1);
        self.set_len(r, rl - 1);
        self.events[EV_BORROW_RIGHT] += 1;
    }

    /// Merge child `i + 1` of `p` into child `i`, pulling separator `i` down between them.
    fn merge(&mut self, p: u32, i: usize) {
        let a = self.kid(p, i);
        let b = self.kid(p, i + 1);
        let (al, bl, pl) = (self.len(a), self.len(b), self.len(p));
        let (ak, bk, pk) = (self.kb(a), self.kb(b), self.kb(p));
        self.keys[ak + al] = self.keys[pk + i];
        self.keys.copy_within(bk..bk + bl, ak + al + 1);
        if !self.is_leaf(a) {
            let (ac, bc) = (self.cb(a), self.cb(b));
            self.kids.copy_within(bc..bc + bl + 1, ac + al + 1);
        }
        self.set_len(a, al + 1 + bl);
        let pc = self.cb(p);
        self.keys.copy_within(pk + i + 1..pk + pl, pk + i);
        self.kids.copy_within(pc + i + 2..pc + pl + 1, pc + i + 1);
        self.set_len(p, pl - 1);
        self.release(b);
    }

    fn delete<const COUNT: bool>(&mut self, k: f64, ops: &mut u64) -> bool {
        if self.root == NONE {
            return false;
        }
        let mut path = [(NONE, 0usize); MAX_DEPTH];
        let mut depth = 0usize;
        let mut cand: Option<(usize, usize)> = None;
        let mut x = self.root;
        loop {
            let i = self.lower_bound::<COUNT>(x, k, ops);
            path[depth] = (x, i);
            if i < self.len(x) {
                cand = Some((depth, i));
            }
            depth += 1;
            if self.is_leaf(x) {
                break;
            }
            x = self.kid(x, i);
        }
        let (cl, ci) = match cand {
            Some(c) => c,
            None => return false,
        };
        let cn = path[cl].0;
        if COUNT {
            *ops += 1; // the deferred equality test
        }
        if self.key(cn, ci) != k {
            return false;
        }
        let leaf = path[depth - 1].0;
        let ll = self.len(leaf);
        let lb = self.kb(leaf);
        if cl == depth - 1 {
            self.keys.copy_within(lb + ci + 1..lb + ll, lb + ci);
        } else {
            // Below the candidate every key is < k, so the descent took the rightmost path
            // of its left child: the leaf's last key is the in-order predecessor.
            let pred = self.keys[lb + ll - 1];
            let ck = self.kb(cn);
            self.keys[ck + ci] = pred;
        }
        self.set_len(leaf, ll - 1);
        self.count -= 1;
        self.repair::<COUNT>(&path, depth - 1, ops);
        true
    }

    /// Walk the recorded path upward from `lvl`, repairing underflow (fewer than `t − 1`
    /// keys): borrow left, else borrow right, else merge and continue at the parent.
    fn repair<const COUNT: bool>(&mut self, path: &[(u32, usize)], lvl: usize, ops: &mut u64) {
        let mut lvl = lvl;
        loop {
            let n = path[lvl].0;
            if lvl == 0 {
                if self.len(n) == 0 {
                    if self.is_leaf(n) {
                        self.root = NONE;
                    } else {
                        self.root = self.kid(n, 0);
                    }
                    self.release(n);
                }
                return;
            }
            if self.len(n) >= self.t - 1 {
                return;
            }
            let (p, c) = path[lvl - 1];
            if COUNT {
                *ops += 1; // exactly one structural event repairs this level
            }
            if c > 0 && self.len(self.kid(p, c - 1)) > self.t - 1 {
                self.borrow_from_left(p, c);
                return;
            }
            if c < self.len(p) && self.len(self.kid(p, c + 1)) > self.t - 1 {
                self.borrow_from_right(p, c);
                return;
            }
            if c > 0 {
                self.merge(p, c - 1);
                self.events[EV_MERGE_LEFT] += 1;
            } else {
                self.merge(p, c);
                self.events[EV_MERGE_RIGHT] += 1;
            }
            lvl -= 1;
        }
    }

    // ── read-only helpers ──

    /// Number of stored keys; duplicates each count.
    pub fn len_keys(&self) -> usize {
        self.count
    }

    /// Levels from the root to the leaves (0 when empty) — the node-visits of every search.
    pub fn height(&self) -> usize {
        if self.root == NONE {
            return 0;
        }
        let (mut h, mut x) = (1, self.root);
        while !self.is_leaf(x) {
            x = self.kid(x, 0);
            h += 1;
        }
        h
    }

    /// Live nodes (reachable, not on the free list).
    pub fn node_count(&self) -> usize {
        self.live
    }

    /// Arena slots ever allocated (live + free). Constant ⇔ no allocation happened.
    pub fn arena_slots(&self) -> usize {
        self.lens.len()
    }

    /// Total splits + merges + borrows performed so far.
    pub fn restructures(&self) -> u64 {
        self.events.iter().sum()
    }

    /// Per-kind structural event tallies (see [`EV_SPLIT`] and friends).
    pub fn event_counts(&self) -> [u64; 5] {
        self.events
    }

    /// The current maximum — the last key of the rightmost leaf (pointer walk, no compare).
    pub fn max_value(&self) -> Option<f64> {
        if self.root == NONE {
            return None;
        }
        let mut x = self.root;
        while !self.is_leaf(x) {
            x = self.kid(x, self.len(x));
        }
        Some(self.key(x, self.len(x) - 1))
    }

    /// The current minimum — the first key of the leftmost leaf (pointer walk, no compare).
    pub fn min_value(&self) -> Option<f64> {
        if self.root == NONE {
            return None;
        }
        let mut x = self.root;
        while !self.is_leaf(x) {
            x = self.kid(x, 0);
        }
        Some(self.key(x, 0))
    }

    /// In-order keys — the sorted multiset. Recursion depth is the height (≤ ~32).
    pub fn keys_in_order(&self) -> Vec<f64> {
        fn walk(b: &BTree, x: u32, out: &mut Vec<f64>) {
            let l = b.len(x);
            for i in 0..l {
                if !b.is_leaf(x) {
                    walk(b, b.kid(x, i), out);
                }
                out.push(b.key(x, i));
            }
            if !b.is_leaf(x) {
                walk(b, b.kid(x, l), out);
            }
        }
        let mut out = Vec::with_capacity(self.count);
        if self.root != NONE {
            walk(self, self.root, &mut out);
        }
        out
    }

    /// The shape, level by level (root first): each level is its nodes left to right, each
    /// node its keys. Given a valid B-tree this determines the structure exactly — node `j`
    /// of a level is the parent of the next `len + 1` nodes of the level below.
    pub fn levels(&self) -> Vec<Vec<Vec<f64>>> {
        let mut out = Vec::new();
        if self.root == NONE {
            return out;
        }
        let mut cur = vec![self.root];
        loop {
            out.push(
                cur.iter()
                    .map(|&x| (0..self.len(x)).map(|i| self.key(x, i)).collect())
                    .collect(),
            );
            if self.is_leaf(cur[0]) {
                break;
            }
            let mut next = Vec::new();
            for &x in &cur {
                for i in 0..=self.len(x) {
                    next.push(self.kid(x, i));
                }
            }
            cur = next;
        }
        out
    }

    /// Every B-tree invariant, or a description of the first one broken: occupancy
    /// (`t − 1 ..= 2t − 1` keys off the root, ≥ 1 at the root), all leaves at one depth,
    /// in-order sorted, every child's keys inside its separators (inclusive — a multiset),
    /// `len` equal to the stored keys, and the reachable node count equal to the live count
    /// (no leak, no node reachable twice).
    pub fn check(&self) -> Result<(), String> {
        if self.root == NONE {
            return if self.count == 0 && self.live == 0 {
                Ok(())
            } else {
                Err(format!("empty root but count {} live {}", self.count, self.live))
            };
        }
        struct St {
            keys: usize,
            nodes: usize,
            leaf_depth: Option<usize>,
        }
        fn walk(
            b: &BTree,
            x: u32,
            depth: usize,
            lo: f64,
            hi: f64,
            st: &mut St,
        ) -> Result<(), String> {
            let l = b.len(x);
            st.nodes += 1;
            st.keys += l;
            if x != b.root && (l < b.t - 1 || l > b.kcap) {
                return Err(format!("node {x} holds {l} keys, outside {}..={}", b.t - 1, b.kcap));
            }
            if x == b.root && (l == 0 || l > b.kcap) {
                return Err(format!("root holds {l} keys"));
            }
            for i in 0..l {
                let k = b.key(x, i);
                if k < lo || k > hi {
                    return Err(format!("key {k} in node {x} outside [{lo}, {hi}]"));
                }
                if i > 0 && b.key(x, i - 1) > k {
                    return Err(format!("node {x} keys out of order"));
                }
            }
            if b.is_leaf(x) {
                match st.leaf_depth {
                    None => st.leaf_depth = Some(depth),
                    Some(d) if d != depth => {
                        return Err(format!("leaf at depth {depth}, another at {d}"))
                    }
                    _ => {}
                }
                return Ok(());
            }
            for i in 0..=l {
                let clo = if i == 0 { lo } else { b.key(x, i - 1) };
                let chi = if i == l { hi } else { b.key(x, i) };
                let c = b.kid(x, i);
                if c == NONE {
                    return Err(format!("node {x} missing child {i}"));
                }
                walk(b, c, depth + 1, clo, chi, st)?;
            }
            Ok(())
        }
        let mut st = St { keys: 0, nodes: 0, leaf_depth: None };
        walk(self, self.root, 0, f64::NEG_INFINITY, f64::INFINITY, &mut st)?;
        if st.keys != self.count {
            return Err(format!("stored {} keys, count says {}", st.keys, self.count));
        }
        if st.nodes != self.live {
            return Err(format!("reachable {} nodes, live says {}", st.nodes, self.live));
        }
        let ord = self.keys_in_order();
        if ord.windows(2).any(|w| w[0] > w[1]) {
            return Err("in-order not sorted".into());
        }
        Ok(())
    }

    // ── counted single-op surface (tests, corpus) ──

    /// `(found, comparisons)` for one search.
    pub fn search_one_counted(&self, k: f64) -> (bool, u64) {
        let (mut ops, mut visits) = (0u64, 0u64);
        let f = self.find::<true>(k, &mut ops, &mut visits);
        (f, ops)
    }

    /// `(found, comparisons, node-visits)` for one search — the second clock-free figure
    /// (docs/METHODOLOGY.md §2.10), never charted.
    pub fn search_one_profiled(&self, k: f64) -> (bool, u64, u64) {
        let (mut ops, mut visits) = (0u64, 0u64);
        let f = self.find::<true>(k, &mut ops, &mut visits);
        (f, ops, visits)
    }

    /// Insert one key, returning comparisons + splits.
    pub fn insert_one_counted(&mut self, k: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(k, &mut ops);
        ops
    }

    /// Delete one occurrence, returning `(removed, comparisons + merges/borrows)`.
    pub fn delete_one_counted(&mut self, k: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let r = self.delete::<true>(k, &mut ops);
        (r, ops)
    }

    /// Uncounted insert / delete for builders and the timed paths.
    pub fn insert_fast(&mut self, k: f64) {
        let mut ops = 0u64;
        self.insert::<false>(k, &mut ops);
    }
    pub fn delete_fast(&mut self, k: f64) -> bool {
        let mut ops = 0u64;
        self.delete::<false>(k, &mut ops)
    }
    pub fn contains_fast(&self, k: f64) -> bool {
        let (mut ops, mut visits) = (0u64, 0u64);
        self.find::<false>(k, &mut ops, &mut visits)
    }

    fn teardown_alternating<const COUNT: bool>(&mut self, ops: &mut u64) -> u32 {
        let mut take_hi = true;
        let mut n = 0u32;
        loop {
            let end = if take_hi { self.max_value() } else { self.min_value() };
            match end {
                Some(v) => {
                    take_hi = !take_hi;
                    self.delete::<COUNT>(v, ops);
                    n += 1;
                }
                None => return n,
            }
        }
    }
}

/// The WASM bench twin: a [`BTree`] at [`MIN_DEGREE`] plus the batched harness surface
/// `measure.ts` times (docs/PLAN.md §6.2–§6.3), mirroring `AvlF64` method for method.
/// Churn and teardown are **two-keyed** like the other trees' (docs/METHODOLOGY.md §4.1):
/// pairs alternate `min − 1` and `max + 1`, `churn_counted` reports the mean, teardown
/// alternates delete-max / delete-min. Here neither end is special — every leaf of a B-tree
/// is at the same depth, so both churn keys walk the full height, the same distance as any
/// stored key.
#[wasm_bindgen]
pub struct BTreeF64 {
    tree: BTree,
    probes: Vec<f64>,
    churn_lo: f64,
    churn_hi: f64,
    churn_hi_next: bool,
}

#[wasm_bindgen]
impl BTreeF64 {
    /// Build from the first `n` keys of `keys`, inserting in order.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> BTreeF64 {
        BTreeF64::wrap(BTree::from_keys(MIN_DEGREE, keys, n))
    }

    /// Number of stored keys (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.tree.count
    }

    /// Set the query workload (present + absent probes). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed: `k` searches cycling the probes; returns the hit count (defeats DCE).
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.tree.contains_fast(self.probes[i % len]) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal: total comparisons over one pass of the probe set.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        let mut visits = 0u64;
        for &p in &self.probes {
            let _ = self.tree.find::<true>(p, &mut ops, &mut visits);
        }
        ops as f64
    }

    /// Set the two spare churn keys (both absent): the engine passes `min − 1`, `max + 1`.
    pub fn set_churn_keys(&mut self, lo: f64, hi: f64) {
        self.churn_lo = lo;
        self.churn_hi = hi;
    }

    /// Timed: `k` insert+delete pairs alternating the two churn keys; size stays n.
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            let key = if self.churn_hi_next { self.churn_hi } else { self.churn_lo };
            self.churn_hi_next = !self.churn_hi_next;
            self.tree.insert::<false>(key, &mut ops);
            if self.tree.delete::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count for *one* churn pair: the mean of the low and the high pair.
    pub fn churn_counted(&mut self) -> f64 {
        let (lo, hi) = (self.churn_lo, self.churn_hi);
        let mut lo_ops = 0u64;
        self.tree.insert::<true>(lo, &mut lo_ops);
        let _ = self.tree.delete::<true>(lo, &mut lo_ops);
        let mut hi_ops = 0u64;
        self.tree.insert::<true>(hi, &mut hi_ops);
        let _ = self.tree.delete::<true>(hi, &mut hi_ops);
        (lo_ops + hi_ops) as f64 / 2.0
    }

    /// Timed: build a fresh size-`n` tree from empty. Returns the size (defeats DCE).
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        BTree::from_keys(MIN_DEGREE, keys, n).count as u32
    }

    /// Op-count for the cumulative build to `n`: comparisons + splits.
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut b = BTree::new(MIN_DEGREE);
        let mut ops = 0u64;
        for &k in &keys[..n] {
            b.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every key, alternating the current maximum and minimum.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        self.tree.teardown_alternating::<false>(&mut ops)
    }

    /// Op-count for a full alternating teardown of a size-`n` build.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut b = BTree::from_keys(MIN_DEGREE, keys, n);
        let mut ops = 0u64;
        b.teardown_alternating::<true>(&mut ops);
        ops as f64
    }

    /// Timed: build then tear down in one call (the build cancels on subtraction).
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        BTreeF64::new(keys, n).teardown_all()
    }
}

impl BTreeF64 {
    /// Wrap a tree (any minimum degree — tests use small ones) with an empty harness state.
    pub fn wrap(tree: BTree) -> BTreeF64 {
        BTreeF64 { tree, probes: Vec::new(), churn_lo: 0.0, churn_hi: 0.0, churn_hi_next: true }
    }

    /// The underlying tree (read-only), for tests and the corpus.
    pub fn tree(&self) -> &BTree {
        &self.tree
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bt(t: usize, keys: &[f64]) -> BTree {
        let b = BTree::from_keys(t, keys, keys.len());
        b.check().unwrap();
        b
    }

    fn fmt_levels(b: &BTree) -> String {
        b.levels()
            .iter()
            .map(|lvl| {
                lvl.iter()
                    .map(|n| n.iter().map(|k| format!("{k}")).collect::<Vec<_>>().join(","))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join(" | ")
    }

    fn shuffled(n: usize, seed: u64) -> Vec<f64> {
        let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let mut s = seed;
        for i in (1..n).rev() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            v.swap(i, (s % (i as u64 + 1)) as usize);
        }
        v
    }

    #[test]
    fn in_order_is_the_sorted_multiset_duplicates_kept() {
        let b = bt(2, &[5.0, 3.0, 5.0, 1.0, 5.0, 3.0, 9.0, 5.0]);
        assert_eq!(b.keys_in_order(), vec![1.0, 3.0, 3.0, 5.0, 5.0, 5.0, 5.0, 9.0]);
        assert_eq!(b.len_keys(), 8);
    }

    /// The CLRS split at t = 2: inserting 1..=4 splits the full root `[1 2 3]` before the 4
    /// goes in — 2 lifted, `[1]` and `[3 4]` below.
    #[test]
    fn proactive_split_of_a_full_root() {
        let mut b = bt(2, &[1.0, 2.0, 3.0]);
        assert_eq!(fmt_levels(&b), "1,2,3");
        // split (1) + upper bound in the new root [2] (1 probe) + upper bound in [3] (1)
        assert_eq!(b.insert_one_counted(4.0), 3);
        assert_eq!(fmt_levels(&b), "2 | 1 3,4");
        b.check().unwrap();
    }

    #[test]
    fn a_split_on_the_way_down_costs_the_split_and_one_side_test() {
        // t = 2: root [2], children [1] [3 4 5] (full). Insert 6: upper bound in [2] = 1
        // probe; child full → split (1) + median test (1); then upper bound in [5] = 1.
        let mut b = bt(2, &[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(fmt_levels(&b), "2 | 1 3,4,5");
        assert_eq!(b.insert_one_counted(6.0), 4);
        assert_eq!(fmt_levels(&b), "2,4 | 1 3 5,6");
        b.check().unwrap();
    }

    #[test]
    fn search_is_a_lower_bound_descent_with_one_deferred_equality() {
        let b = bt(2, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]); // 2,4 | 1 3 5,6
        // 4 is a separator: lower bound in [2 4] = 2 probes (idx 1, candidate 4), then [3]
        // = 1 probe (idx 1 = len), leaf. Deferred equality = 1. Total 4, still found.
        assert_eq!(b.search_one_profiled(4.0), (true, 4, 2));
        // Above the max there is never a candidate, so no equality test at all: one probe in
        // [2 4] (mid = 4 < 99 ⇒ lo = 2 = len) and one in [5 6].
        assert_eq!(b.search_one_profiled(99.0), (false, 2, 2));
        // Absent mid-range: candidate 3 ≠ 2.5.
        assert_eq!(b.search_one_counted(2.5).0, false);
        // Node visits are exactly the height for every probe.
        for p in [0.0, 1.0, 2.0, 3.5, 6.0, 7.0] {
            assert_eq!(b.search_one_profiled(p).2, b.height() as u64);
        }
    }

    #[test]
    fn empty_tree_search_and_delete() {
        let mut b = BTree::new(16);
        assert_eq!(b.search_one_counted(1.0), (false, 0));
        assert_eq!(b.delete_one_counted(1.0), (false, 0));
        assert_eq!(b.height(), 0);
        b.check().unwrap();
    }

    #[test]
    fn delete_removes_one_occurrence_the_first_in_order() {
        let mut b = bt(2, &[5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0]);
        assert!(b.delete_one_counted(5.0).0);
        assert_eq!(b.len_keys(), 6);
        assert_eq!(b.keys_in_order(), vec![5.0; 6]);
        b.check().unwrap();
        assert!(!b.delete_one_counted(4.0).0);
    }

    #[test]
    fn delete_of_an_internal_key_uses_the_leaf_predecessor() {
        let mut b = bt(2, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]); // 2,4 | 1 3 5,6,7
        let before = fmt_levels(&b);
        assert_eq!(before, "2,4 | 1 3 5,6,7");
        // delete 4 (separator): predecessor 3 moves up; leaf [3] underflows to [] →
        // borrow from the left? left sibling [1] has t−1 = 1 → no; right [5 6 7] has 3 → yes.
        let (r, _) = b.delete_one_counted(4.0);
        assert!(r);
        b.check().unwrap();
        assert_eq!(fmt_levels(&b), "2,5 | 1 3 6,7");
    }

    /// Every repair path at t = 2: borrow left, borrow right, merge left, merge right, a
    /// merge cascading to a root collapse, and deleting back to empty — invariants checked
    /// after every step.
    #[test]
    fn every_repair_path_keeps_the_invariants() {
        let keys: Vec<f64> = (1..=40).map(|i| i as f64).collect();
        let mut b = bt(2, &keys);
        let h0 = b.height();
        let mut order: Vec<f64> = shuffled(40, 7).into_iter().map(|k| k + 1.0).collect();
        order.extend([0.0, 41.0]); // absent at the end — must be no-ops
        let mut model = keys.clone();
        let mut shrank = false;
        for k in order {
            let present = model.contains(&k);
            let (r, _) = b.delete_one_counted(k);
            assert_eq!(r, present);
            if present {
                model.retain(|&m| m != k);
            }
            b.check().unwrap();
            assert_eq!(b.keys_in_order(), model);
            if b.height() < h0 {
                shrank = true;
            }
        }
        assert!(shrank, "the tree must lose levels as it empties");
        assert_eq!(b.height(), 0);
        assert_eq!(b.node_count(), 0);
        let ev = b.event_counts();
        for (name, i) in [
            ("borrow-left", EV_BORROW_LEFT),
            ("borrow-right", EV_BORROW_RIGHT),
            ("merge-left", EV_MERGE_LEFT),
            ("merge-right", EV_MERGE_RIGHT),
        ] {
            assert!(ev[i] > 0, "the delete sequence never exercised {name}: {ev:?}");
        }
    }

    /// The hysteresis that replaced CLRS's single-pass delete (module doc): deleting an
    /// absent key — anywhere — leaves the tree bit-for-bit as it was.
    #[test]
    fn deleting_an_absent_key_changes_nothing() {
        for t in [2usize, 3, 16] {
            let ks: Vec<f64> = (0..300).map(|i| (i * 2) as f64).collect();
            let mut b = bt(t, &ks);
            let shape = b.levels();
            let r0 = b.restructures();
            for probe in [-1.0, 1.0, 299.0, 301.0, 1000.0] {
                assert!(!b.delete_one_counted(probe).0);
            }
            assert_eq!(b.levels(), shape);
            assert_eq!(b.restructures(), r0);
        }
    }

    /// **The churn honesty pin** — the B-tree's counterpart to the heap's drain test and the
    /// trie's prefix-free test. After a short warm-up, an insert+delete pair of either churn
    /// key performs *no* split, merge or borrow and allocates nothing, on ascending,
    /// descending and shuffled builds, at t = 2 and t = 16; and the counted pair is the same
    /// number every time. CLRS's single-pass delete fails this (it would split and re-merge
    /// a node on every pair — see the module doc for the hand trace).
    #[test]
    fn churn_settles_into_zero_restructures_and_zero_allocation() {
        for t in [2usize, 16] {
            for n in [31usize, 32, 100, 497, 1000, 4000] {
                let asc: Vec<f64> = (0..n).map(|i| i as f64).collect();
                let desc: Vec<f64> = asc.iter().rev().copied().collect();
                for ks in [asc.clone(), desc, shuffled(n, 0x9e37_79b9_7f4a_7c15)] {
                    let mut w = BTreeF64::wrap(BTree::from_keys(t, &ks, n));
                    w.set_churn_keys(-1.0, n as f64);
                    w.churn_n(64); // warm-up: at most a few one-time fixes per end
                    let counted = w.churn_counted();
                    let (slots, nodes, r0) =
                        (w.tree.arena_slots(), w.tree.node_count(), w.tree.restructures());
                    w.churn_n(1000);
                    assert_eq!(w.tree.restructures(), r0, "t={t} n={n}: churn restructured");
                    assert_eq!(w.tree.arena_slots(), slots, "t={t} n={n}: churn allocated");
                    assert_eq!(w.tree.node_count(), nodes);
                    assert_eq!(w.churn_counted(), counted, "t={t} n={n}: churn count moved");
                    assert_eq!(w.len(), n);
                    w.tree.check().unwrap();
                }
            }
        }
    }

    /// Both churn keys walk the full height — a B-tree's leaves are all at one depth — so
    /// neither end is a cheap spine (contrast the BST/AVL, METHODOLOGY §4.1).
    #[test]
    fn both_churn_ends_walk_the_full_height() {
        let n = 4000usize;
        let ks = shuffled(n, 3);
        let b = BTree::from_keys(16, &ks, n);
        let h = b.height() as u64;
        assert!(h >= 3);
        assert_eq!(b.search_one_profiled(-1.0).2, h);
        assert_eq!(b.search_one_profiled(n as f64).2, h);
        assert_eq!(b.search_one_profiled(1234.0).2, h);
    }

    // ── harness surface ──

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut w = BTreeF64::new(&[50.0, 30.0, 70.0], 3);
        w.set_probes(&[30.0, 99.0]);
        assert_eq!(w.search_n(4), 2);
        assert!(w.search_counted() > 0.0);
    }

    #[test]
    fn churn_holds_size_and_contents() {
        let ks: Vec<f64> = (0..200).map(|i| i as f64).collect();
        let mut w = BTreeF64::new(&ks, 200);
        w.set_churn_keys(-1.0, 200.0);
        let before = w.tree.keys_in_order();
        assert_eq!(w.churn_n(5), 5);
        assert_eq!(w.tree.keys_in_order(), before);
        assert!(w.churn_counted() > 0.0);
        assert_eq!(w.len(), 200);
        w.tree.check().unwrap();
    }

    #[test]
    fn build_and_teardown_round_trip_to_empty() {
        let ks: Vec<f64> = (0..500).map(|i| i as f64).collect();
        assert_eq!(BTreeF64::build_insert_n(&ks, 500), 500);
        assert_eq!(BTreeF64::build_then_teardown_n(&ks, 500), 500);
        assert!(BTreeF64::build_insert_counted(&ks, 500) > 0.0);
        assert!(BTreeF64::teardown_counted(&ks, 500) > 0.0);
        let mut b = BTree::from_keys(2, &ks, 500);
        let mut ops = 0;
        assert_eq!(b.teardown_alternating::<true>(&mut ops), 500);
        b.check().unwrap();
    }

    #[test]
    fn max_and_min_follow_the_outer_paths() {
        let b = bt(2, &[5.0, 1.0, 9.0, 3.0, 7.0, 2.0, 8.0]);
        assert_eq!(b.max_value(), Some(9.0));
        assert_eq!(b.min_value(), Some(1.0));
        assert_eq!(BTree::new(2).max_value(), None);
    }
}
