//! Singly/doubly linked list (docs/PLAN.md §8, "Linear" family) — the production/bench
//! twin of the TypeScript teaching impls (`src/structures/linkedList.ts`).
//!
//! Semantics: a **multiset** with **O(1) head insert**, **O(n) linear search**, and
//! **O(n) delete-by-value** (walk to find, then unlink). Newest keys end up at the head,
//! so the head→tail iteration order is the reverse of insertion order (duplicates kept —
//! docs/PLAN.md "Keys are identity; never dedupe").
//!
//! **One impl for both list flavours.** The singly and doubly lists are
//! *observationally identical* under this module's cost metric: same iteration order, same
//! search op-count, same delete op-count. The doubly list's extra `prev` pointer only buys
//! an O(1) unlink-*with-a-handle*, but the unlink is uncounted in **both** and the
//! find-walk that dominates is identical — so a second struct, a second corpus, and a
//! second sweep wiring would be pure duplication. The back-pointers are a *visualization*
//! concern, already handled by the Phase 3 teaching twins; the bench has one
//! `LinkedListF64`, pinned to *both* TS twins by `conformance/corpus-ll.txt`.
//!
//! **Index arena, by the repo's own rule.** `Box<Node>`/recursion is used where height is
//! bounded (the AVL); an **index arena** where a deep chain would overflow the WASM stack
//! (the BST). A linked list *is* the depth-n chain that rule exists for — a 10⁵–10⁶-node
//! `Box<Node>` list would overflow on its recursive `Drop`. So nodes live in a `Vec` with
//! `Option<u32>` links: every walk is a loop, the arena drops flat, and freed slots are
//! reused so churn stays bounded by live size. One accepted consequence: head-insert lays
//! nodes out reverse-sequentially in the `Vec`, so traversal is cache-friendly and the
//! wall-clock won't show a dramatic cache penalty vs the contiguous array — fine, because
//! wall-clock is read for its *shape*, not its absolute magnitude (docs/PLAN.md §2.3).
//!
//! **Cost metric — node-visits (docs/PLAN.md §8); the R1 conformance contract.** The
//! op-count is **one visit per node examined**, short-circuiting on a match — for both
//! `search` and the `delete` *find* phase. Head `insert` visits **nothing** (O(1), 0
//! ops); the `delete` unlink and the free-list bookkeeping carry no visit either. This
//! mirrors `linkedList.ts` exactly (where `ll.visit` ticks once per node), so the
//! cross-language corpus agrees (risk R1). Counting is the zero-overhead `const COUNT:
//! bool` flag (docs/PLAN.md §6.4): the increments compile away on the timed hot path.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2–§6.3).** Mirroring `ArrayF64`, the
//! `#[wasm_bindgen]` impl exposes `search_n`/`search_counted` (size-preserving), the
//! `churn_n`/`churn_counted` primary, and the `build_insert_*`/`teardown_*` cross-check.
//! **The mutation methodology has a twist worth stating plainly:**
//!   - **Churn is honestly O(1), and that's the point.** Churn inserts the spare key at
//!     the head, then deletes it — and the delete finds it *immediately at the head* (1
//!     visit). There is **no** size-preserving same-key churn that yields O(n): head-insert
//!     structurally places the key where deletion is cheap. So churn measures the true cost
//!     of an insert + delete-of-the-newest (O(1)), which is *not* the canonical
//!     delete-by-value (O(n)). (Contrast the sorted array, where front-churn *recovers*
//!     O(n) because every position shifts the whole array.)
//!   - **The canonical O(n) delete is surfaced by the finite-difference teardown**, which
//!     deletes the current **tail** (the oldest key) repeatedly — each a full walk from the
//!     head, O(n), Σ = O(n²). Deleting head-first instead would be O(1)/op and understate it
//!     (the same mislabel trap as a sorted-array tail-churn).
//!   - The honest consequence — churn (O(1)) ≪ `insert_fd + delete_fd` (O(n)) — is a
//!     **complexity-class disagreement**, a *fifth* churn-vs-finite-difference regime after
//!     the array (tight), balanced BST (FD overshoots, same class), AVL (close), and sorted
//!     array (front churn overshoots, same class). It is proven clock-free in the
//!     `methodology` self-test (`mod.rs`), the home for deterministic op-count findings;
//!     a flat O(1) churn curve on the browser clock would look identical to the hash set
//!     (docs/PLAN.md §2.3, §6.3). Browser wiring for the mutation side is therefore deferred
//!     to Phase 5 (this slice wires only `search`), exactly as the sorted-array slice did.

use wasm_bindgen::prelude::*;

/// An arena node. `next` is an index into [`LinkedListF64::nodes`] (`None` = end of list),
/// not a pointer, so traversal is a flat loop and reclamation is the `Vec`'s free list.
struct Node {
    value: f64,
    next: Option<u32>,
}

/// A linked list (multiset) over `f64` keys, stored in an index arena. Represents both the
/// singly and doubly teaching twins, which are bench-identical under the node-visit metric.
#[wasm_bindgen]
pub struct LinkedListF64 {
    nodes: Vec<Node>,
    /// Newest node; `None` when empty. Head insert prepends here.
    head: Option<u32>,
    /// Oldest node (last in iteration order); `None` when empty. Tracked so the
    /// finite-difference teardown can delete the oldest repeatedly in O(1) lookup — its
    /// successor is recovered from the predecessor that `delete` already walks to.
    tail: Option<u32>,
    /// Slots vacated by delete, reused by the next insert so the arena stays bounded by
    /// live size under churn. Slot numbering is not observable — every walk follows links.
    free: Vec<u32>,
    count: usize,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2). Mirrors `ArrayF64`.
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). Inserted at the head and
    /// deleted from the head, so it must be absent (the engine uses `max + 1`) for the delete
    /// to remove exactly the just-inserted node and restore size.
    churn_key: f64,
}

#[wasm_bindgen]
impl LinkedListF64 {
    /// Build from the first `n` keys of `keys` by inserting each at the head in turn, so the
    /// iteration order is the reverse of `keys[..n]`. Mirrors the Phase 2 constructors' `(keys, n)`.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> LinkedListF64 {
        let n = n.min(keys.len());
        let mut l = LinkedListF64::new_empty();
        for &k in &keys[..n] {
            l.insert(k);
        }
        l
    }

    /// Number of stored nodes (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.count
    }

    // ── Search: size-preserving (docs/PLAN.md §6.3) ──

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` searches, cycling through the stored probes. Returns the
    /// hit count so the optimizer can't elide the work (docs/PLAN.md §6.2). No op-counting
    /// overhead (`COUNT=false`).
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

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`, returning total
    /// node-visits (the cost metric). `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent so each head insert is real and
    /// the matching head delete restores size. The engine passes `max + 1`. Untimed.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size stable at ≈ n
    /// (docs/PLAN.md §6.3). Each pair inserts at the head (0 visits) and deletes the same key,
    /// which is found immediately at the head (1 visit) — honestly O(1) (see the module doc:
    /// this is *not* the canonical O(n) delete-by-value). Returns the delete-hit count to
    /// defeat dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key;
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert(key);
            if self.delete::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the node-visits of a counted insert+delete
    /// of the churn key. Head insert visits nothing; the delete finds the key at the head in
    /// one visit — so this is exactly `1` regardless of n (O(1)). The pair nets zero size
    /// change, so state is unchanged afterwards.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert(key);
        let _ = self.delete::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh list of size `n` from empty by head-inserting each key. Returns
    /// the size to defeat DCE. Differencing this across sweep points yields per-insert cost —
    /// which is **zero** node-visits (head insert is O(1), like the array's append).
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        LinkedListF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n`: total node-visits to head-insert the
    /// first `n` keys. Head insert visits no nodes, so this is **always 0** — the insert side
    /// of the finite-difference method reads flat (O(1)), exactly like the unsorted array's
    /// append, and the *opposite* of the O(n) delete below.
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let mut l = LinkedListF64::new_empty();
        let n = n.min(keys.len());
        for &k in &keys[..n] {
            l.insert(k);
        }
        // Head insert never visits a node; assert the contract holds rather than recompute.
        debug_assert_eq!(l.count, n);
        0.0
    }

    /// Timed: delete every stored key by repeatedly removing the current **tail** (the oldest
    /// key), leaving the list empty (docs/PLAN.md §6.3 teardown). Each delete walks from the
    /// head to the receding tail — O(n) — so the cumulative teardown is O(n²), the canonical
    /// delete-by-value cost (contrast the O(1) churn). Returns the delete count to defeat DCE.
    /// No op-counting overhead (`COUNT=false`).
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(t) = self.tail {
            let tail_value = self.nodes[t as usize].value;
            self.delete::<false>(tail_value, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total node-visits to delete every key by
    /// repeatedly removing the current tail (Σ over the shrinking list of each walk's length —
    /// O(n²)). Built untimed via `new`, then counted. Assumes the distinct keys the
    /// finite-difference method feeds, so each tail value occurs once and is reached only by a
    /// full walk (with duplicates an earlier copy could short-circuit; the FD path never uses them).
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut l = LinkedListF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(t) = l.tail {
            let tail_value = l.nodes[t as usize].value;
            l.delete::<true>(tail_value, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` list via head inserts, then tear it all down by deleting
    /// the tail repeatedly, in one self-contained call. Subtracting the `build_insert_n` time
    /// isolates the teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); the identical (and near-free) insert build path cancels in the subtraction.
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        LinkedListF64::new(keys, n).teardown_all()
    }
}

impl LinkedListF64 {
    /// An empty list.
    pub fn new_empty() -> LinkedListF64 {
        LinkedListF64 {
            nodes: Vec::new(),
            head: None,
            tail: None,
            free: Vec::new(),
            count: 0,
            probes: Vec::new(),
            churn_key: 0.0,
        }
    }

    /// Whether the list holds no nodes.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Allocate a node, reusing a freed slot when one is available.
    fn alloc(&mut self, value: f64, next: Option<u32>) -> u32 {
        let node = Node { value, next };
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

    /// Splice `key` in at the head (O(1), **no node-visits**). The newest key becomes the new
    /// head; the first key ever inserted becomes (and stays) the tail until deleted.
    fn insert(&mut self, key: f64) {
        let id = self.alloc(key, self.head);
        self.head = Some(id);
        if self.tail.is_none() {
            self.tail = Some(id);
        }
        self.count += 1;
    }

    /// Walk from the head, visiting each node until a match or the end. Counts one visit per
    /// node examined — the matching visit included (the R1 contract). Returns membership.
    fn find<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        let mut cur = self.head;
        while let Some(i) = cur {
            if COUNT {
                *ops += 1;
            }
            if self.nodes[i as usize].value == target {
                return true;
            }
            cur = self.nodes[i as usize].next;
        }
        false
    }

    /// Walk from the head to the first matching node, then unlink it (the predecessor — or the
    /// head — reconnects to its successor, and `tail` is fixed up if the tail was removed).
    /// Counts only the find-path visits; the unlink and free-list bookkeeping carry none
    /// (the R1 contract). Returns whether a key was removed.
    fn delete<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        let mut prev: Option<u32> = None;
        let mut cur = self.head;
        while let Some(i) = cur {
            if COUNT {
                *ops += 1;
            }
            if self.nodes[i as usize].value == target {
                let next = self.nodes[i as usize].next;
                match prev {
                    None => self.head = next,
                    Some(p) => self.nodes[p as usize].next = next,
                }
                // If the tail was removed, its predecessor becomes the new tail (None when
                // the list is now empty — `prev` is then also None).
                if self.tail == Some(i) {
                    self.tail = prev;
                }
                self.free.push(i);
                self.count -= 1;
                return true;
            }
            prev = Some(i);
            cur = self.nodes[i as usize].next;
        }
        false
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the node-visit count for one search (the cost metric).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.find::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key at the head, returning the node-visit count (always 0 — head insert is
    /// O(1)). Mutates. Present for symmetry with the other twins' test surface.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        self.insert(key);
        0
    }

    /// Delete the first occurrence of `target` (from the head), returning `(removed, visits)`.
    /// Mutates.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys head → tail — the reverse of insertion order (head insert). A conformance hook
    /// (docs/PLAN.md §12); not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut cur = self.head;
        while let Some(i) = cur {
            out.push(self.nodes[i as usize].value);
            cur = self.nodes[i as usize].next;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(keys: &[f64]) -> LinkedListF64 {
        LinkedListF64::new(keys, keys.len())
    }

    #[test]
    fn head_insert_reverses_iteration_order() {
        let l = list(&[10.0, 20.0, 30.0]);
        assert_eq!(l.keys_in_order(), vec![30.0, 20.0, 10.0]);
        assert_eq!(l.len(), 3);
    }

    #[test]
    fn keeps_duplicates_as_a_multiset() {
        // insert 5,5,5,7,5,9 at the head ⇒ [9,5,7,5,5,5].
        let l = list(&[5.0, 5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(l.keys_in_order(), vec![9.0, 5.0, 7.0, 5.0, 5.0, 5.0]);
    }

    /// The R1 node-visit contract, hand-verified against `linkedList.ts`'s `search`: one
    /// visit per node from the head, short-circuiting on a match.
    #[test]
    fn search_counts_one_visit_per_node_short_circuiting() {
        let l = list(&[10.0, 20.0, 30.0]); // head→tail: 30, 20, 10
        assert_eq!(l.search_one_counted(30.0), (true, 1)); // head hit
        assert_eq!(l.search_one_counted(20.0), (true, 2)); // 30 → 20
        assert_eq!(l.search_one_counted(10.0), (true, 3)); // 30 → 20 → 10 (tail)
        assert_eq!(l.search_one_counted(99.0), (false, 3)); // full walk, miss
    }

    #[test]
    fn empty_and_singleton_search() {
        let l = list(&[]);
        assert_eq!(l.search_one_counted(1.0), (false, 0));
        let l = list(&[42.0]);
        assert_eq!(l.search_one_counted(42.0), (true, 1));
        assert_eq!(l.search_one_counted(7.0), (false, 1));
    }

    #[test]
    fn insert_visits_nothing() {
        let mut l = LinkedListF64::new_empty();
        assert_eq!(l.insert_one_counted(10.0), 0);
        assert_eq!(l.insert_one_counted(20.0), 0);
        assert_eq!(l.keys_in_order(), vec![20.0, 10.0]);
    }

    #[test]
    fn delete_counts_visits_to_find_then_unlinks() {
        // head→tail: 30, 20, 10.
        let mut l = list(&[10.0, 20.0, 30.0]);
        assert_eq!(l.delete_one_counted(30.0), (true, 1)); // head delete
        assert_eq!(l.keys_in_order(), vec![20.0, 10.0]);
        assert_eq!(l.delete_one_counted(10.0), (true, 2)); // tail delete (full walk)
        assert_eq!(l.keys_in_order(), vec![20.0]);
        assert_eq!(l.delete_one_counted(99.0), (false, 1)); // absent: visits the lone node, no removal
        assert_eq!(l.delete_one_counted(20.0), (true, 1)); // last node
        assert!(l.is_empty());
    }

    #[test]
    fn delete_removes_only_the_head_most_duplicate() {
        // [9,5,7,5,5,5]: delete 5 removes the first 5 from the head (index after 9).
        let mut l = list(&[5.0, 5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(l.delete_one_counted(5.0), (true, 2)); // 9 → 5(match)
        assert_eq!(l.keys_in_order(), vec![9.0, 7.0, 5.0, 5.0, 5.0]);
        assert_eq!(l.len(), 5);
    }

    #[test]
    fn delete_tail_updates_tail_pointer() {
        let mut l = list(&[10.0, 20.0, 30.0]); // head 30 … tail 10
        assert_eq!(l.delete_one_counted(10.0), (true, 3)); // remove tail
        // The new tail is 20; deleting it now should be a 2-visit walk (30 → 20).
        assert_eq!(l.delete_one_counted(20.0), (true, 2));
        assert_eq!(l.keys_in_order(), vec![30.0]);
    }

    #[test]
    fn delete_to_empty_then_reinsert_reuses_arena() {
        let mut l = list(&[42.0]);
        assert_eq!(l.delete_one_counted(42.0), (true, 1));
        assert!(l.is_empty());
        // Re-inserting after a delete-to-empty must rebuild head/tail cleanly (free-list reuse).
        l.insert(7.0);
        assert_eq!(l.keys_in_order(), vec![7.0]);
        assert_eq!(l.delete_one_counted(7.0), (true, 1));
        assert!(l.is_empty());
    }

    // ── Timed harness surface (docs/PLAN.md §6.2–§6.3) ──

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut l = list(&[1.0, 2.0, 3.0]);
        l.set_probes(&[2.0, 99.0]); // one present, one absent
        assert_eq!(l.search_n(4), 2); // [2,99,2,99] => 2 hits
    }

    #[test]
    fn search_counted_sums_visits_over_probes() {
        // head→tail: 3, 2, 1. search(1)=3 (full walk), search(99)=3 (miss). Total 6.
        let mut l = list(&[1.0, 2.0, 3.0]);
        l.set_probes(&[1.0, 99.0]);
        assert_eq!(l.search_counted(), 6.0);
    }

    /// Churn is honestly O(1): head insert (0 visits) + delete-of-the-newest (1 visit) = 1,
    /// regardless of n. The pair nets zero, so size and order are restored.
    #[test]
    fn churn_is_o1_and_holds_size() {
        let mut l = list(&[10.0, 20.0, 30.0]);
        l.set_churn_key(99.0); // absent
        l.churn_n(5);
        assert_eq!(l.len(), 3);
        assert_eq!(l.keys_in_order(), vec![30.0, 20.0, 10.0]);
        assert_eq!(l.churn_counted(), 1.0); // exactly one visit, the just-inserted head
        assert_eq!(l.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_insert_visits_nothing_cumulatively() {
        assert_eq!(LinkedListF64::build_insert_n(&[5.0, 3.0, 8.0, 1.0], 4), 4);
        // Head insert is O(1): the cumulative insert op-count is flat zero.
        assert_eq!(LinkedListF64::build_insert_counted(&[5.0, 3.0, 8.0, 1.0], 4), 0.0);
    }

    /// Teardown deletes the tail (oldest) repeatedly — each a full walk — so the cumulative
    /// op-count is Σ i = O(n²), the canonical delete-by-value cost.
    #[test]
    fn teardown_deletes_tail_first_and_counts_quadratically() {
        let keys = [10.0, 20.0, 30.0]; // head→tail: 30, 20, 10; tail value 10
        let mut l = LinkedListF64::new(&keys, 3);
        assert_eq!(l.teardown_all(), 3);
        assert!(l.is_empty());
        // delete 10 (walk 30,20,10 = 3), delete 20 (walk 30,20 = 2), delete 30 (1). Σ = 6.
        assert_eq!(LinkedListF64::teardown_counted(&keys, 3), 6.0);
    }

    #[test]
    fn build_then_teardown_empties_the_list() {
        assert_eq!(LinkedListF64::build_then_teardown_n(&[5.0, 3.0, 8.0, 1.0], 4), 4);
    }
}
