//! **The most expensive single operation** (docs/PLAN.md §13, docs/METHODOLOGY.md §4
//! hurdle 13) — a clock-free view of what no per-op *average* can show.
//!
//! Every Compare curve is a mean over a batch. A structure whose guarantee is about the
//! *worst* operation — the red-black tree's ≤ 2 rotations per insert and ≤ 3 per delete,
//! against an AVL delete that may rebalance at every level — looks, on a mean, like a
//! structure with no such guarantee. And a structure whose mean hides a rare dear operation
//! — the array's or the hash set's grow-and-copy — looks like it never pays one. This
//! module replays one fixed workload one operation at a time and keeps the **maximum** of
//! each counter instead of the sum.
//!
//! **Why clock-free.** One operation takes nanoseconds — below the browser clock's
//! resolution (docs/METHODOLOGY.md §2.1), and the whole timing method exists because a single
//! op cannot be timed honestly. Every number here is a count from the twins' own counted
//! paths (`*_one_counted` / `*_one_detail`), the op-count signal of §1, per call.
//!
//! **The workload — the same for every structure.**
//! - **Build:** insert the first `n` keys of the dataset, one at a time, in the dataset's
//!   order, from empty. The build maximum is therefore a *running* maximum: the worst insert
//!   into a structure that grew from 0 to `n`, which can only rise as `n` grows.
//! - **Delete pass:** then delete the same `n` keys in the trees' teardown order — the
//!   current largest, then the current smallest, in turn (docs/METHODOLOGY.md §4.1) — computed
//!   once from the sorted prefix and handed to every structure, so every line deletes the
//!   identical sequence. On a de-duplicating structure (the two hash sets) the second delete
//!   of a repeated key finds nothing; it is still an operation of the run and is counted,
//!   and [`MaxOpProfile::delete_misses`] says how many there were.
//!
//! **The counters, each maximised on its own** (so two maxima may come from different
//! operations):
//! - `ops` — the structure's **own cost metric**, the unit of its op-count line on the
//!   charts (comparisons + rotations for the balanced trees, comparisons + shifts for the
//!   arrays, hashes + probes for the hash sets, …). Comparable across structures only as
//!   loosely as the op-count charts are.
//! - `rotations` — the AVL and the red-black tree only. This is where the red-black bound is
//!   visible. Both schemes rotate at most twice on an *insert*; they differ on *delete*.
//! - `recolours` — the red-black tree only, on its own counter and **never** in `ops`
//!   (docs/METHODOLOGY.md §2.9): the AVL has no colour to pay for.
//! - `moved` — keys re-placed by a **grow-and-copy**: the unsorted and sorted arrays (one
//!   contiguous block that reallocates when full) and the two hash sets (a table that
//!   doubles and re-places every key). This work is **outside** every structure's op-count
//!   metric — an array append counts 0 and a rehash is "amortised structural work" — which
//!   is exactly why a per-op average never shows it. It is observed from outside, by the
//!   capacity changing across the insert, and the count is the keys the copy re-placed
//!   (for an array, the keys held before the push; for a hash set, every key held after
//!   the insert, the new one included). "Re-placed" rather than "copied": the allocator may
//!   extend a block in place, and that is not visible here. The linked structures allocate
//!   a node per key; the ones that keep their nodes in a growing arena (the red-black tree,
//!   the skip list, the B-tree, the lists, the BST) move those nodes on a grow too, but that
//!   is a storage choice of this implementation, not a step of the structure — the AVL's
//!   `Box` nodes never move — so it is not reported.
//!
//! The min-heap (its op set is insert / extract-min, docs/PLAN.md §8, risk R6), the graph
//! (its own section) and the string twins (another key type) are not profiled here.

use super::avl::AvlF64;
use super::bst::BstF64;
use super::btree::{BTree, MIN_DEGREE};
use super::doubly_linked_list::DoublyLinkedListF64;
use super::dyn_array::ArrayF64;
use super::hash_set::HashSetF64;
use super::hash_set_bs::HashSetBsF64;
use super::hash_set_oa::HashSetOaF64;
use super::linked_list::LinkedListF64;
use super::rbt::RbtF64;
use super::skip_list::SkipListF64;
use super::sorted_array::SortedArrayF64;
use wasm_bindgen::prelude::*;

/// The structure ids this module profiles — the registry's canonical numeric structures
/// (`src/registry.ts`), in the order the TS side lists them.
pub const MAX_OP_STRUCTURES: [&str; 12] =
    ["array", "ll", "sarr", "hashset", "skiplist", "dll", "rbt", "btree", "hashoa", "bst", "avl", "hashbs"];

/// What one profiled run returns: per counter, the largest single-operation value over the
/// build and over the delete pass (see the module doc for the workload). Fields that do not
/// apply to a structure are `NaN` (→ `null` on the TS side). `*_at` fields are the 1-based
/// position of the **first** operation that reached the maximum in its pass.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct MaxOpProfile {
    /// Input keys inserted (the prefix length).
    pub n: f64,
    /// Keys the structure held after the build (its `len()`): below `n` on a hash set fed
    /// repeated keys.
    pub stored: f64,
    /// Tree height after the build — AVL and red-black only.
    pub height: f64,
    pub insert_max_ops: f64,
    pub insert_max_ops_at: f64,
    pub insert_mean_ops: f64,
    pub delete_max_ops: f64,
    pub delete_max_ops_at: f64,
    pub delete_mean_ops: f64,
    /// Deletes in the pass (always `n`).
    pub deletes: f64,
    /// Deletes that found nothing — a de-duplicating structure's second copy of a key.
    pub delete_misses: f64,
    pub insert_max_rotations: f64,
    pub delete_max_rotations: f64,
    pub insert_max_recolours: f64,
    pub delete_max_recolours: f64,
    /// Keys re-placed by the largest single grow-and-copy, and the insert that triggered it.
    pub insert_max_moved: f64,
    pub insert_max_moved_at: f64,
    /// Grow-and-copy events during the build that re-placed at least one key.
    pub resizes: f64,
}

/// One counted operation's figures. `None` = the counter does not apply to the structure.
#[derive(Clone, Copy, Default)]
struct Step {
    ops: u64,
    rotations: Option<u64>,
    recolours: Option<u64>,
    moved: Option<u64>,
}

impl Step {
    fn ops(ops: u64) -> Step {
        Step { ops, ..Step::default() }
    }
}

/// A structure under profile: one counted insert, one counted delete, its size.
trait Subject {
    fn insert(&mut self, key: f64) -> Step;
    fn delete(&mut self, key: f64) -> (bool, Step);
    fn len(&self) -> usize;
    fn height(&self) -> Option<u32> {
        None
    }
}

/// Max (first occurrence) and sum of one counter over a pass.
#[derive(Default)]
struct Peak {
    seen: bool,
    max: u64,
    at: usize,
    sum: u64,
}

impl Peak {
    fn push(&mut self, v: Option<u64>, at: usize) {
        if let Some(v) = v {
            if !self.seen || v > self.max {
                self.max = v;
                self.at = at;
            }
            self.seen = true;
            self.sum += v;
        }
    }
    fn max(&self) -> f64 {
        if self.seen {
            self.max as f64
        } else {
            f64::NAN
        }
    }
    fn at(&self) -> f64 {
        if self.seen {
            self.at as f64
        } else {
            f64::NAN
        }
    }
}

/// The delete order: current maximum, current minimum, in turn, over the sorted multiset of
/// `keys` — the trees' teardown order (docs/METHODOLOGY.md §4.1). Computed from the keys, not
/// from any structure, so every structure deletes the identical sequence.
pub fn alternating_extremes(keys: &[f64]) -> Vec<f64> {
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let (mut lo, mut hi) = (0usize, sorted.len());
    let mut out = Vec::with_capacity(sorted.len());
    let mut take_hi = true;
    while lo < hi {
        if take_hi {
            hi -= 1;
            out.push(sorted[hi]);
        } else {
            out.push(sorted[lo]);
            lo += 1;
        }
        take_hi = !take_hi;
    }
    out
}

fn run<S: Subject>(mut s: S, keys: &[f64]) -> MaxOpProfile {
    let (mut ins, mut ins_rot, mut ins_rec, mut ins_mov) =
        (Peak::default(), Peak::default(), Peak::default(), Peak::default());
    let mut resizes = 0u64;
    let mut moved_applies = false;
    for (i, &k) in keys.iter().enumerate() {
        let st = s.insert(k);
        ins.push(Some(st.ops), i + 1);
        ins_rot.push(st.rotations, i + 1);
        ins_rec.push(st.recolours, i + 1);
        if let Some(m) = st.moved {
            moved_applies = true;
            if m > 0 {
                resizes += 1;
                ins_mov.push(Some(m), i + 1);
            }
        }
    }
    let stored = s.len();
    let height = s.height();
    let (mut del, mut del_rot, mut del_rec) = (Peak::default(), Peak::default(), Peak::default());
    let mut misses = 0u64;
    let order = alternating_extremes(keys);
    for (i, &k) in order.iter().enumerate() {
        let (removed, st) = s.delete(k);
        if !removed {
            misses += 1;
        }
        del.push(Some(st.ops), i + 1);
        del_rot.push(st.rotations, i + 1);
        del_rec.push(st.recolours, i + 1);
    }
    let mean = |p: &Peak, count: usize| if count > 0 { p.sum as f64 / count as f64 } else { f64::NAN };
    // A structure that grows-and-copies but never had to in this build reports 0, not "n/a".
    let (max_moved, max_moved_at) = if ins_mov.seen {
        (ins_mov.max(), ins_mov.at())
    } else if moved_applies {
        (0.0, f64::NAN)
    } else {
        (f64::NAN, f64::NAN)
    };
    MaxOpProfile {
        n: keys.len() as f64,
        stored: stored as f64,
        height: height.map_or(f64::NAN, |h| h as f64),
        insert_max_ops: ins.max(),
        insert_max_ops_at: ins.at(),
        insert_mean_ops: mean(&ins, keys.len()),
        delete_max_ops: del.max(),
        delete_max_ops_at: del.at(),
        delete_mean_ops: mean(&del, order.len()),
        deletes: order.len() as f64,
        delete_misses: misses as f64,
        insert_max_rotations: ins_rot.max(),
        delete_max_rotations: del_rot.max(),
        insert_max_recolours: ins_rec.max(),
        delete_max_recolours: del_rec.max(),
        insert_max_moved: max_moved,
        insert_max_moved_at: if moved_applies { max_moved_at } else { f64::NAN },
        resizes: if moved_applies { resizes as f64 } else { f64::NAN },
    }
}

// ── Subjects: thin adapters over each twin's own counted single-op surface ──

struct Array(ArrayF64);
impl Subject for Array {
    fn insert(&mut self, key: f64) -> Step {
        let (cap, len) = (self.0.capacity(), self.0.len());
        let ops = self.0.insert_one_counted(key);
        let moved = if self.0.capacity() != cap { len as u64 } else { 0 };
        Step { moved: Some(moved), ..Step::ops(ops) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.0.delete_one_counted(key);
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

struct Sorted(SortedArrayF64);
impl Subject for Sorted {
    fn insert(&mut self, key: f64) -> Step {
        let (cap, len) = (self.0.capacity(), self.0.len());
        let ops = self.0.insert_one_counted(key);
        let moved = if self.0.capacity() != cap { len as u64 } else { 0 };
        Step { moved: Some(moved), ..Step::ops(ops) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.0.delete_one_counted(key);
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

struct Chaining(HashSetF64);
impl Subject for Chaining {
    fn insert(&mut self, key: f64) -> Step {
        let buckets = self.0.bucket_count();
        let (_, ops) = self.0.insert_one_counted(key);
        let moved = if self.0.bucket_count() != buckets { self.0.len() as u64 } else { 0 };
        Step { moved: Some(moved), ..Step::ops(ops) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.0.delete_one_counted(key);
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// The build pass has no deletes, so no tombstones and no purge-in-place: every rebuild an
/// insert triggers here changes the capacity, and the capacity is what this watches.
struct OpenAddressing(HashSetOaF64);
impl Subject for OpenAddressing {
    fn insert(&mut self, key: f64) -> Step {
        let cap = self.0.capacity();
        let (_, ops) = self.0.insert_one_counted(key);
        let moved = if self.0.capacity() != cap { self.0.len() as u64 } else { 0 };
        Step { moved: Some(moved), ..Step::ops(ops) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.0.delete_one_counted(key);
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// The backward-shift set: the same table as [`OpenAddressing`] on a delete-free build, so the
/// same rebuilds; its delete's shift scan is inside `delete_one_counted`'s ops, as on the chart.
struct BackwardShift(HashSetBsF64);
impl Subject for BackwardShift {
    fn insert(&mut self, key: f64) -> Step {
        let cap = self.0.capacity();
        let (_, ops) = self.0.insert_one_counted(key);
        let moved = if self.0.capacity() != cap { self.0.len() as u64 } else { 0 };
        Step { moved: Some(moved), ..Step::ops(ops) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.0.delete_one_counted(key);
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// The plain adapters: insert → `u64`, delete → `(bool, u64)`, no extra counters.
macro_rules! plain_subject {
    ($name:ident, $ty:ty) => {
        struct $name($ty);
        impl Subject for $name {
            fn insert(&mut self, key: f64) -> Step {
                Step::ops(self.0.insert_one_counted(key))
            }
            fn delete(&mut self, key: f64) -> (bool, Step) {
                let (r, ops) = self.0.delete_one_counted(key);
                (r, Step::ops(ops))
            }
            fn len(&self) -> usize {
                self.0.len()
            }
        }
    };
}
plain_subject!(Singly, LinkedListF64);
plain_subject!(Doubly, DoublyLinkedListF64);
plain_subject!(Skip, SkipListF64);
plain_subject!(Bst, BstF64);

struct BTreeSubject {
    tree: BTree,
    len: usize,
}
impl Subject for BTreeSubject {
    fn insert(&mut self, key: f64) -> Step {
        self.len += 1;
        Step::ops(self.tree.insert_one_counted(key))
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, ops) = self.tree.delete_one_counted(key);
        if r {
            self.len -= 1;
        }
        (r, Step::ops(ops))
    }
    fn len(&self) -> usize {
        self.len
    }
}

struct Avl(AvlF64);
impl Subject for Avl {
    fn insert(&mut self, key: f64) -> Step {
        let (cmp, rot) = self.0.insert_one_detail(key);
        Step { rotations: Some(rot), ..Step::ops(cmp + rot) }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, cmp, rot) = self.0.delete_one_detail(key);
        (r, Step { rotations: Some(rot), ..Step::ops(cmp + rot) })
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn height(&self) -> Option<u32> {
        Some(self.0.tree_height())
    }
}

struct Rbt(RbtF64);
impl Subject for Rbt {
    fn insert(&mut self, key: f64) -> Step {
        let c = self.0.insert_one_detail(key);
        Step { ops: c.ops(), rotations: Some(c.rotations), recolours: Some(c.recolours), moved: None }
    }
    fn delete(&mut self, key: f64) -> (bool, Step) {
        let (r, c) = self.0.delete_one_detail(key);
        (r, Step { ops: c.ops(), rotations: Some(c.rotations), recolours: Some(c.recolours), moved: None })
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn height(&self) -> Option<u32> {
        Some(self.0.tree_height())
    }
}

/// Profile `structure` (an id from [`MAX_OP_STRUCTURES`]) on the first `n` keys: the build,
/// then the delete pass. `None` for an id this module does not profile.
pub fn profile(structure: &str, keys: &[f64], n: usize) -> Option<MaxOpProfile> {
    let keys = &keys[..n.min(keys.len())];
    let empty: &[f64] = &[];
    Some(match structure {
        "array" => run(Array(ArrayF64::new(empty, 0)), keys),
        "sarr" => run(Sorted(SortedArrayF64::new_empty()), keys),
        "hashset" => run(Chaining(HashSetF64::new(empty, 0)), keys),
        "hashoa" => run(OpenAddressing(HashSetOaF64::new(empty, 0)), keys),
        "hashbs" => run(BackwardShift(HashSetBsF64::new(empty, 0)), keys),
        "ll" => run(Singly(LinkedListF64::new_empty()), keys),
        "dll" => run(Doubly(DoublyLinkedListF64::new_empty()), keys),
        "skiplist" => run(Skip(SkipListF64::new_empty()), keys),
        "bst" => run(Bst(BstF64::new_empty()), keys),
        "btree" => run(BTreeSubject { tree: BTree::new(MIN_DEGREE), len: 0 }, keys),
        "avl" => run(Avl(AvlF64::new_empty()), keys),
        "rbt" => run(Rbt(RbtF64::new_empty()), keys),
        _ => return None,
    })
}

/// WASM entry point for the worker (`src/bench/engine.worker.ts`): [`profile`], or
/// `undefined` for an unknown id. Clock-free and untimed — it runs no batch and reads no
/// clock — so it can be called after the timed sweeps without disturbing any of them.
#[wasm_bindgen]
pub fn max_op_profile(structure: &str, keys: &[f64], n: usize) -> Option<MaxOpProfile> {
    profile(structure, keys, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ascending(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64).collect()
    }

    /// A fixed-seed permutation of `0..n` (xorshift, as `structures::methodology`).
    fn shuffled(n: usize, seed: u64) -> Vec<f64> {
        let mut v = ascending(n);
        let mut state = seed;
        for i in (1..n).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            v.swap(i, (state % (i as u64 + 1)) as usize);
        }
        v
    }

    /// Keys drawn *with replacement* from a range a third the size — about two draws in three
    /// repeat a key already drawn, the duplicate-heavy case user data brings (and the hash
    /// sets drop).
    fn with_repeats(n: usize, seed: u64) -> Vec<f64> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state % (n as u64 / 3).max(1)) as f64
            })
            .collect()
    }

    fn orders(n: usize) -> Vec<(&'static str, Vec<f64>)> {
        vec![
            ("shuffled", shuffled(n, 0x9e37_79b9_7f4a_7c15)),
            ("ascending", ascending(n)),
            ("descending", ascending(n).into_iter().rev().collect()),
            ("repeats", with_repeats(n, 0x2545_f491_4f6c_dd1d)),
        ]
    }

    /// The Compare mutation ladder (`src/compare/runSweeps.ts` MUT_MIN..MUT_MAX).
    const LADDER: [usize; 5] = [250, 500, 1000, 2000, 4000];

    fn p(id: &str, keys: &[f64]) -> MaxOpProfile {
        profile(id, keys, keys.len()).expect("a profiled id")
    }

    #[test]
    fn every_listed_structure_profiles_and_an_unknown_id_does_not() {
        let ks = shuffled(300, 7);
        for id in MAX_OP_STRUCTURES {
            let r = p(id, &ks);
            assert_eq!(r.n, 300.0, "{id}");
            assert_eq!(r.deletes, 300.0, "{id}");
            assert_eq!(r.delete_misses, 0.0, "{id}: distinct keys, every delete hits");
            assert!(r.insert_max_ops >= r.insert_mean_ops, "{id}");
            assert!(r.delete_max_ops >= r.delete_mean_ops, "{id}");
        }
        assert!(profile("heap", &ks, 300).is_none(), "the heap's op set is not this one");
        assert!(profile("triestr", &ks, 300).is_none());
    }

    /// **The red-black bound, through the view's own path.** On every order — sorted both
    /// ways, shuffled, and a duplicate-heavy draw — and at every rung of the ladder, no single
    /// insert rotated more than twice and no single delete more than three times.
    #[test]
    fn rbt_rotates_at_most_twice_per_insert_and_three_times_per_delete() {
        for (name, ks) in orders(4000) {
            for n in LADDER {
                let r = p("rbt", &ks[..n]);
                assert!(r.insert_max_rotations <= 2.0, "{name} n={n}: insert rotated {}", r.insert_max_rotations);
                assert!(r.delete_max_rotations <= 3.0, "{name} n={n}: delete rotated {}", r.delete_max_rotations);
                assert!(r.insert_max_recolours.is_finite() && r.delete_max_recolours.is_finite());
            }
        }
    }

    /// **The AVL is held to ≤ 2 per insert as well** — the two schemes differ on delete, not
    /// on insert, so the view must not suggest otherwise (it would be an untrue reading of a
    /// red-black-only column). And this is also the check that the AVL's comparison/rotation
    /// split is right on duplicates: the search-subtraction shortcut of the methodology
    /// tests reports nonsense rotations once a key repeats, and an AVL insert can never
    /// rotate more than twice.
    #[test]
    fn avl_inserts_rotate_at_most_twice_too_even_with_repeated_keys() {
        for (name, ks) in orders(4000) {
            let r = p("avl", &ks);
            assert!(r.insert_max_rotations <= 2.0, "{name}: AVL insert rotated {}", r.insert_max_rotations);
        }
        let ks = with_repeats(2000, 99);
        let mut t = AvlF64::new_empty();
        let mut u = AvlF64::new_empty();
        for &k in &ks {
            let (cmp, rot) = t.insert_one_detail(k);
            assert_eq!(cmp + rot, u.insert_one_counted(k), "the split sums to the counted op-count");
            assert!(rot <= 2);
        }
        for &k in &alternating_extremes(&ks) {
            let (r1, cmp, rot) = t.delete_one_detail(k);
            let (r2, ops) = u.delete_one_counted(k);
            assert_eq!((r1, cmp + rot), (r2, ops));
        }
        assert!(t.is_empty());
    }

    /// **The AVL's worst delete is not bounded by a constant — on an uneven tree.** On shuffled
    /// keys and on the duplicate-heavy draw its worst single delete rotates past the red-black
    /// bound of three at the top of the ladder (measured 10 on both at n = 4000, from 4–5 at
    /// n = 250), within the theoretical ceiling (at most two rotations per level, so
    /// ≤ 2·height), and never below the bottom rung's. Asserted as bands, not as strict growth
    /// at every step: a maximum over one fixed sequence is a property of that sequence.
    ///
    /// **On sorted input it stays at 2, and that is the finding, not a gap.** Sorted keys build
    /// a near-perfect AVL (height 12 at n = 4000), and the deletes that cascade need subtrees
    /// already at the edge of the balance rule. The red-black tree is no better there (also
    /// ≤ 2) — so on sorted data the view shows the two schemes level on rotations, with the
    /// red-black tree's worst op-count *higher* (its tree is deeper: 21 against 12).
    #[test]
    fn avl_worst_delete_grows_with_height_past_the_red_black_bound_on_uneven_trees() {
        for (name, ks) in orders(4000) {
            let small = p("avl", &ks[..LADDER[0]]);
            let top = p("avl", &ks);
            let rb = p("rbt", &ks);
            assert!(
                top.delete_max_rotations <= 2.0 * top.height,
                "{name}: {} rotations exceeds 2·height {}",
                top.delete_max_rotations,
                top.height
            );
            if name == "ascending" || name == "descending" {
                assert!(top.delete_max_rotations <= 3.0, "{name}: AVL's worst delete rotated {}", top.delete_max_rotations);
                assert!(rb.delete_max_ops > top.delete_max_ops, "{name}: the deeper red-black tree's worst delete costs more");
                continue;
            }
            assert!(top.delete_max_rotations > 3.0, "{name}: AVL's worst delete rotated {}", top.delete_max_rotations);
            assert!(top.delete_max_rotations > rb.delete_max_rotations, "{name}: past the red-black tree's worst");
            assert!(top.delete_max_rotations >= small.delete_max_rotations, "{name}: worst delete fell with n");
            assert!(top.height > small.height, "{name}: the tree grew taller");
        }
    }

    /// **The amortised spike is real and lives outside the op-count.** The array's appends
    /// cost 0 on its metric at every one of them — the op-count maximum is 0 — while the
    /// largest grow-and-copy re-placed at least half the keys. Same for the chaining set: its
    /// worst insert on the metric is a short chain, its worst grow re-placed > 3/8 of n (the
    /// table doubles past 0.75 load). Linked structures report no grow-and-copy at all.
    #[test]
    fn a_resize_moves_a_large_fraction_of_n_that_the_op_count_never_sees() {
        let ks = shuffled(4000, 3);
        let a = p("array", &ks);
        assert_eq!(a.insert_max_ops, 0.0, "an append compares and shifts nothing");
        assert!(a.insert_max_moved >= 2000.0, "array's largest grow moved {}", a.insert_max_moved);
        assert!(a.resizes >= 8.0);
        let h = p("hashset", &ks);
        assert!(h.insert_max_ops <= 12.0, "chaining insert {}", h.insert_max_ops);
        assert!(h.insert_max_moved > 1500.0, "rehash moved {}", h.insert_max_moved);
        let o = p("hashoa", &ks);
        assert!(o.insert_max_moved > 1500.0, "OA rehash moved {}", o.insert_max_moved);
        assert_eq!(o.insert_max_moved, h.insert_max_moved, "same growth points, same keys moved");
        let b = p("hashbs", &ks);
        assert_eq!(b.insert_max_moved, o.insert_max_moved, "a delete-free build is the OA set's table");
        assert_eq!(b.insert_max_ops, o.insert_max_ops, "same table, same probes on every insert");
        let s = p("sarr", &ks);
        assert!(s.insert_max_moved >= 2000.0);
        for id in ["ll", "dll", "skiplist", "bst", "btree", "avl", "rbt"] {
            let r = p(id, &ks);
            assert!(r.insert_max_moved.is_nan() && r.resizes.is_nan(), "{id} has no grow-and-copy step");
        }
    }

    /// The hash sets drop repeats, so their delete pass misses on each repeat — counted, and
    /// reported. The multiset structures keep every copy and miss nothing.
    #[test]
    fn de_duplicating_structures_report_their_delete_misses() {
        let ks = with_repeats(1200, 5);
        let distinct = {
            let mut s = ks.clone();
            s.sort_by(|a, b| a.total_cmp(b));
            s.dedup();
            s.len()
        };
        for id in ["hashset", "hashoa", "hashbs"] {
            let r = p(id, &ks);
            assert_eq!(r.stored as usize, distinct, "{id}");
            assert_eq!(r.delete_misses as usize, ks.len() - distinct, "{id}");
        }
        for id in ["array", "sarr", "ll", "dll", "skiplist", "bst", "btree", "avl", "rbt"] {
            let r = p(id, &ks);
            assert_eq!(r.stored, 1200.0, "{id} keeps duplicates");
            assert_eq!(r.delete_misses, 0.0, "{id}");
        }
    }

    /// The build maximum is a running maximum over a growing structure, so a longer prefix of
    /// the same keys can never report a smaller one — what the view's caption says.
    #[test]
    fn the_insert_maximum_never_falls_along_the_ladder() {
        for (name, ks) in orders(4000) {
            for id in MAX_OP_STRUCTURES {
                let mut prev = -1.0;
                for n in LADDER {
                    let r = p(id, &ks[..n]);
                    assert!(r.insert_max_ops >= prev, "{name} {id} n={n}");
                    prev = r.insert_max_ops;
                }
            }
        }
    }

    #[test]
    fn the_delete_order_alternates_the_current_extremes() {
        assert_eq!(alternating_extremes(&[3.0, 1.0, 2.0, 5.0, 4.0]), vec![5.0, 1.0, 4.0, 2.0, 3.0]);
        assert_eq!(alternating_extremes(&[2.0, 2.0, 1.0]), vec![2.0, 1.0, 2.0]);
    }

    /// Print the numbers the assertions above are bands around. `cargo test -- --ignored
    /// --nocapture print_the_ladder`.
    #[test]
    #[ignore]
    fn print_the_ladder() {
        for (name, ks) in orders(4000) {
            for id in MAX_OP_STRUCTURES {
                for n in [250usize, 500, 1000, 2000, 4000] {
                    let r = p(id, &ks[..n]);
                    println!(
                        "{name:10} {id:8} n={n:5} h={:>3} ins max {:>6} mean {:>8.2} | del max {:>6} mean {:>8.2} | rot {:>3}/{:>3} | rec {:>3}/{:>3} | moved {:>5} resizes {:>3} miss {}",
                        r.height, r.insert_max_ops, r.insert_mean_ops, r.delete_max_ops, r.delete_mean_ops,
                        r.insert_max_rotations, r.delete_max_rotations, r.insert_max_recolours,
                        r.delete_max_recolours, r.insert_max_moved, r.resizes, r.delete_misses
                    );
                }
            }
        }
    }
}
