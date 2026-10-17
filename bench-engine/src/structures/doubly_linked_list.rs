//! Doubly linked list (docs/PLAN.md §8, "Linear" family) — the bench twin of the
//! `DoublyLinkedListF64` teaching impl in `src/structures/linkedList.ts`, measured as a
//! structure of its own (StructureId `'dll'`) so the claim below is a *measurement*, not
//! an assertion in a comment.
//!
//! **The finding this structure exists to show: on the canonical op set the second pointer
//! buys nothing.** Same semantics as [`LinkedListF64`](super::linked_list::LinkedListF64) — a
//! multiset with O(1) head insert, O(n) linear search, O(n) delete-by-value, newest key at the
//! head, duplicates kept (docs/PLAN.md "Keys are identity; never dedupe"). Each node also
//! carries a `prev` link, and `prev` does exactly one thing: it lets you unlink a node **you
//! already hold** without walking to its predecessor. Delete-by-value never holds one — it
//! has to *find* the node first, and the find is the same head-first walk the singly list
//! does, visit for visit. The splice that `prev` makes cheaper was never counted on either
//! list (the R1 contract: the unlink carries no node-visit), so every op-count here equals
//! the singly list's on the same sequence **exactly** — not "within noise", equal — while
//! each node is 8 bytes larger (24 vs 16, pinned by `node_is_half_again_the_singly_node`).
//! Pinned clock-free by `structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`
//! and, per op over random streams, by `bench-engine/tests/proptest_doubly_linked_list.rs`.
//! The one operation where `prev` *does* pay — unlink-given-a-handle — is on the test
//! surface only ([`DoublyLinkedListF64::unlink_handle_counted`]), because the canonical op
//! set (docs/PLAN.md §4.1) never hands a caller a node.
//!
//! **Index arena, for the same reason as the singly list.** A list is the depth-n chain a
//! recursive `Box<Node>` drop would overflow the WASM stack on, so nodes live in a `Vec` with
//! `Option<u32>` links, every walk is a loop, freed slots are reused (so churn stays bounded by
//! live size), and nothing is allocated in a timed region once the arena has grown to n + 1.
//! `Option<u32>` rather than a `u32::MAX` sentinel deliberately mirrors the singly twin, so the
//! two node layouts differ by *exactly* the `prev` field — the size comparison is then a
//! statement about the pointer, not about two different encodings.
//!
//! **Cost metric — node-visits (docs/PLAN.md §8), identical to the singly list.** One visit per
//! node examined, short-circuiting on a match, for `search` and the `delete` *find* phase. Head
//! `insert` visits nothing; the unlink (now via `prev`) and the free-list bookkeeping visit
//! nothing. `COUNT` is the zero-overhead const flag (docs/PLAN.md §6.4).
//!
//! **Mutation methodology — regime 7 again, for the same reason (docs/METHODOLOGY.md §2.3).**
//!   - **Churn is honestly O(1), and no key choice changes that.** Head insert puts the churn
//!     key at the head *whatever its value*, so the paired delete finds it in one visit: above
//!     the max, below the min, or equal to a stored key (the newest copy is the head) — always
//!     exactly 1 (`no_churn_key_recovers_the_linear_delete`). The engine passes `max + 1`, the
//!     singly list's key, so the two curves are the same experiment.
//!   - **The canonical O(n) delete is surfaced by the finite-difference teardown**, which deletes
//!     the current tail's *value* — a full walk from the head each time, Σ = O(n²). It must
//!     **not** unlink the tail through the `tail` handle: that would be O(1) per delete, the class
//!     disagreement would vanish, and the chart would be timing unlink-given-a-handle, the one op
//!     this op set never offers. So the doubly list's teardown is the singly list's, pointer for
//!     pointer in the walk, and its op-count is equal to it.
//!   - The consequence is the singly list's: churn (O(1)) ≪ `insert_fd + delete_fd` (O(n)), a
//!     complexity-class disagreement, and every honesty rule that binds the singly list's flat
//!     curve binds this one (the caveat box, the O(n) delete-by-value beside it, the PNG legend
//!     row and caption line, the browser-gate pins).

use wasm_bindgen::prelude::*;

/// An arena node: the singly list's node plus `prev`. Both links are indices into
/// [`DoublyLinkedListF64::nodes`] (`None` = end of list in that direction).
struct Node {
    value: f64,
    next: Option<u32>,
    prev: Option<u32>,
}

/// A doubly linked list (multiset) over `f64` keys, stored in an index arena.
#[wasm_bindgen]
pub struct DoublyLinkedListF64 {
    nodes: Vec<Node>,
    /// Newest node; `None` when empty. Head insert prepends here.
    head: Option<u32>,
    /// Oldest node; `None` when empty. With `prev` links this is a real handle (the tail can be
    /// unlinked in O(1)) — which is exactly why the teardown must *not* use it to delete (see
    /// the module doc): it only names the tail's **value**, then deletes by value from the head.
    tail: Option<u32>,
    /// Slots vacated by delete, reused by the next insert.
    free: Vec<u32>,
    count: usize,
    /// Query workload, stored once (untimed) — docs/PLAN.md §6.2.
    probes: Vec<f64>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3). The engine passes `max + 1`.
    churn_key: f64,
}

#[wasm_bindgen]
impl DoublyLinkedListF64 {
    /// Build from the first `n` keys of `keys` by head-inserting each in turn, so the head→tail
    /// order is the reverse of `keys[..n]` — identical to the singly list's constructor.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> DoublyLinkedListF64 {
        let n = n.min(keys.len());
        // No `reserve`: the singly constructor grows its arena by doubling, and the two
        // builds must do the same allocation work for the timed build to compare like with like.
        let mut l = DoublyLinkedListF64::new_empty();
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

    /// Timed hot path: `k` searches cycling through the stored probes; returns the hit count so
    /// the optimizer can't elide the work (docs/PLAN.md §6.2). `COUNT=false`.
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

    /// Op-count signal (§6.4): total node-visits over one pass of the probe set.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n`. Untimed. Any value gives the same O(1) pair (see
    /// the module doc); the engine passes `max + 1` so this is the singly list's experiment.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_key = key;
    }

    /// Timed hot path: `k` insert+delete pairs of the churn key at size ≈ n. Each pair head-
    /// inserts (0 visits) and deletes by value, finding the key at the head (1 visit). Returns
    /// the delete-hit count to defeat dead-code elimination. `COUNT=false`.
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

    /// Op-count signal (§6.4) for one churn pair: exactly `1` at every n (O(1)). Nets zero.
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key;
        let mut ops = 0u64;
        self.insert(key);
        let _ = self.delete::<true>(key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh size-`n` list by head inserts. Returns the size to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        DoublyLinkedListF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n`: always 0 — head insert visits no node
    /// (writing the old head's `prev` is a link update, not a visit, exactly as the singly
    /// list's `next` write is).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let l = DoublyLinkedListF64::new(keys, n);
        debug_assert_eq!(l.count, n.min(keys.len()));
        0.0
    }

    /// Timed: delete every key by repeatedly deleting the current tail's **value** — a
    /// delete-by-value that walks from the head, O(n) each, Σ O(n²). Deliberately not an O(1)
    /// unlink through the `tail` handle (module doc). Returns the delete count. `COUNT=false`.
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

    /// Op-count for a full size-`n` teardown (tail value by value, Σ of each walk's length). Like
    /// the singly list's, assumes the distinct keys the finite-difference path feeds; with
    /// duplicates an earlier copy can short-circuit the walk — identically on both lists.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut l = DoublyLinkedListF64::new(keys, n);
        let mut ops = 0u64;
        while let Some(t) = l.tail {
            let tail_value = l.nodes[t as usize].value;
            l.delete::<true>(tail_value, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` list then tear it down, in one call; subtracting the
    /// `build_insert_n` time isolates the teardown (docs/PLAN.md §6.3).
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        DoublyLinkedListF64::new(keys, n).teardown_all()
    }
}

impl DoublyLinkedListF64 {
    /// An empty list.
    pub fn new_empty() -> DoublyLinkedListF64 {
        DoublyLinkedListF64 {
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

    /// Allocate a node, reusing a freed slot when one is available. Both links are written in
    /// full, so a reused slot can never carry a stale `prev` from its previous life.
    fn alloc(&mut self, value: f64, next: Option<u32>, prev: Option<u32>) -> u32 {
        let node = Node { value, next, prev };
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

    /// Splice `key` in at the head (O(1), no node-visits): the new node points forward at the old
    /// head, and the old head points back at it.
    fn insert(&mut self, key: f64) {
        let old_head = self.head;
        let id = self.alloc(key, old_head, None);
        match old_head {
            Some(h) => self.nodes[h as usize].prev = Some(id),
            None => self.tail = Some(id),
        }
        self.head = Some(id);
        self.count += 1;
    }

    /// Walk from the head, one visit per node examined, matching visit included — the singly
    /// list's `find`, unchanged: `prev` has nothing to offer a search.
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

    /// Unlink node `i` through its own links — the one thing `prev` buys. O(1), no visits.
    fn unlink(&mut self, i: u32) {
        let (prev, next) = {
            let n = &self.nodes[i as usize];
            (n.prev, n.next)
        };
        match prev {
            None => self.head = next,
            Some(p) => self.nodes[p as usize].next = next,
        }
        match next {
            None => self.tail = prev,
            Some(nx) => self.nodes[nx as usize].prev = prev,
        }
        self.free.push(i);
        self.count -= 1;
    }

    /// Delete-by-value: walk from the head to the first match (counted), then unlink it via
    /// `prev` (uncounted). The walk does not need to carry a trailing predecessor the way the
    /// singly list's does — that is the whole of what the second pointer changes, and it is
    /// invisible to the op-count, because the visits are the walk.
    fn delete<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        let mut cur = self.head;
        while let Some(i) = cur {
            if COUNT {
                *ops += 1;
            }
            if self.nodes[i as usize].value == target {
                self.unlink(i);
                return true;
            }
            cur = self.nodes[i as usize].next;
        }
        false
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the node-visit count for one search.
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.find::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key at the head, returning the node-visit count (always 0).
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        self.insert(key);
        0
    }

    /// Delete the head-most occurrence of `target`, returning `(removed, visits)`.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys head → tail, following `next` — the reverse of insertion order.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut cur = self.head;
        while let Some(i) = cur {
            out.push(self.nodes[i as usize].value);
            cur = self.nodes[i as usize].next;
        }
        out
    }

    /// Keys tail → head, following `prev`. **The back-link integrity check.** No canonical op
    /// ever reads `prev` on the walk, so a list whose back-links are corrupt answers every
    /// search, every delete and every op-count correctly — `delete` would only misbehave on the
    /// *splice*, possibly long after. This walk is what catches it, which is why the unit tests,
    /// the proptest (after every op) and the corpus all pin it equal to the reversed forward
    /// order. Bounded by `count + 1` steps so a cyclic corruption fails the comparison instead
    /// of hanging the test.
    pub fn keys_in_reverse(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut cur = self.tail;
        while let Some(i) = cur {
            if out.len() > self.count {
                break;
            }
            out.push(self.nodes[i as usize].value);
            cur = self.nodes[i as usize].prev;
        }
        out
    }

    /// Node handles head → tail (arena indices). Test surface for
    /// [`unlink_handle_counted`](Self::unlink_handle_counted) — the canonical op set has no way
    /// to obtain one, which is the point.
    pub fn handles_in_order(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.count);
        let mut cur = self.head;
        while let Some(i) = cur {
            out.push(i);
            cur = self.nodes[i as usize].next;
        }
        out
    }

    /// **Unlink-given-a-handle** — the one operation the second pointer pays for, and the one the
    /// canonical op set (insert / search / delete *by key*, docs/PLAN.md §4.1) never offers. Visits
    /// no node, at any position: returns `(removed value, 0)`. The singly list has no equivalent
    /// short of a walk to the predecessor. Test surface only; not on the wasm surface and not
    /// measured, because no chart in this project asks a structure to delete a node it is handed.
    pub fn unlink_handle_counted(&mut self, handle: u32) -> (f64, u64) {
        let value = self.nodes[handle as usize].value;
        self.unlink(handle);
        (value, 0)
    }

    /// Bytes per arena node — the price of the second pointer, compared against the singly
    /// node's by `node_is_half_again_the_singly_node`.
    pub(crate) const NODE_BYTES: usize = std::mem::size_of::<Node>();
}

#[cfg(test)]
mod tests {
    use super::super::linked_list::LinkedListF64;
    use super::*;

    fn list(keys: &[f64]) -> DoublyLinkedListF64 {
        DoublyLinkedListF64::new(keys, keys.len())
    }

    fn reversed(v: Vec<f64>) -> Vec<f64> {
        v.into_iter().rev().collect()
    }

    /// Forward and backward walks agree — the back-links are a mirror of the forward ones.
    fn assert_links(l: &DoublyLinkedListF64) {
        assert_eq!(l.keys_in_reverse(), reversed(l.keys_in_order()), "prev links disagree with next");
        assert_eq!(l.keys_in_order().len(), l.len());
    }

    #[test]
    fn head_insert_reverses_iteration_order_both_ways() {
        let l = list(&[10.0, 20.0, 30.0]);
        assert_eq!(l.keys_in_order(), vec![30.0, 20.0, 10.0]);
        assert_eq!(l.keys_in_reverse(), vec![10.0, 20.0, 30.0]);
        assert_eq!(l.len(), 3);
    }

    #[test]
    fn keeps_duplicates_as_a_multiset() {
        let l = list(&[5.0, 5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(l.keys_in_order(), vec![9.0, 5.0, 7.0, 5.0, 5.0, 5.0]);
        assert_links(&l);
    }

    /// The R1 node-visit contract — the same hand-verified numbers as the singly list's test.
    #[test]
    fn search_counts_one_visit_per_node_short_circuiting() {
        let l = list(&[10.0, 20.0, 30.0]); // head→tail: 30, 20, 10
        assert_eq!(l.search_one_counted(30.0), (true, 1));
        assert_eq!(l.search_one_counted(20.0), (true, 2));
        assert_eq!(l.search_one_counted(10.0), (true, 3));
        assert_eq!(l.search_one_counted(99.0), (false, 3));
        let e = list(&[]);
        assert_eq!(e.search_one_counted(1.0), (false, 0));
    }

    #[test]
    fn delete_head_middle_tail_absent_keeps_both_directions_linked() {
        let mut l = list(&[10.0, 20.0, 30.0, 40.0]); // 40, 30, 20, 10
        assert_eq!(l.delete_one_counted(30.0), (true, 2)); // middle
        assert_eq!(l.keys_in_order(), vec![40.0, 20.0, 10.0]);
        assert_links(&l);
        assert_eq!(l.delete_one_counted(10.0), (true, 3)); // tail: the new tail is 20
        assert_eq!(l.keys_in_reverse(), vec![20.0, 40.0]);
        assert_eq!(l.delete_one_counted(40.0), (true, 1)); // head: 20 is now head *and* tail
        assert_links(&l);
        assert_eq!(l.delete_one_counted(99.0), (false, 1)); // absent
        assert_eq!(l.delete_one_counted(20.0), (true, 1)); // last node
        assert!(l.is_empty());
        assert_eq!(l.keys_in_reverse(), Vec::<f64>::new());
    }

    #[test]
    fn delete_removes_only_the_head_most_duplicate() {
        let mut l = list(&[5.0, 5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(l.delete_one_counted(5.0), (true, 2));
        assert_eq!(l.keys_in_order(), vec![9.0, 7.0, 5.0, 5.0, 5.0]);
        assert_links(&l);
    }

    /// A reused arena slot must not keep its old `prev`: delete to empty, re-insert, and walk
    /// both ways.
    #[test]
    fn free_list_reuse_rewrites_both_links() {
        let mut l = list(&[1.0, 2.0, 3.0]);
        assert!(l.delete_one_counted(2.0).0);
        assert!(l.delete_one_counted(3.0).0);
        assert!(l.delete_one_counted(1.0).0);
        assert!(l.is_empty());
        l.insert(7.0);
        l.insert(8.0);
        assert_eq!(l.keys_in_order(), vec![8.0, 7.0]);
        assert_links(&l);
        assert_eq!(l.nodes.len(), 3, "the arena reused freed slots instead of growing");
    }

    #[test]
    fn search_n_and_search_counted() {
        let mut l = list(&[1.0, 2.0, 3.0]);
        l.set_probes(&[2.0, 99.0]);
        assert_eq!(l.search_n(4), 2);
        l.set_probes(&[1.0, 99.0]);
        assert_eq!(l.search_counted(), 6.0);
    }

    #[test]
    fn churn_is_o1_holds_size_and_order() {
        let mut l = list(&[10.0, 20.0, 30.0]);
        l.set_churn_key(99.0);
        assert_eq!(l.churn_n(5), 5);
        assert_eq!(l.len(), 3);
        assert_eq!(l.keys_in_order(), vec![30.0, 20.0, 10.0]);
        assert_links(&l);
        assert_eq!(l.churn_counted(), 1.0);
        assert_eq!(l.len(), 3);
    }

    /// The doubly list's counterpart to the skip list's `neither_churn_end_changes_the_reported_class`
    /// — with the opposite conclusion. There, both ends were honest; here, *no* key is: head insert
    /// fixes the churn key's position at the head whatever its value, so every choice — above the
    /// max, below the min, a stored key (its newest copy is the head) — costs exactly one visit at
    /// every size. There is no churn key that recovers the O(n) delete-by-value, which is why the
    /// finite-difference delete has to be read beside the flat curve rather than a key being tuned.
    #[test]
    fn no_churn_key_recovers_the_linear_delete() {
        for n in [10usize, 100, 1000] {
            let ks: Vec<f64> = (0..n).map(|i| i as f64).collect();
            let mut l = DoublyLinkedListF64::new(&ks, n);
            for key in [n as f64 + 1.0, -1.0, 0.0, (n / 2) as f64, (n - 1) as f64] {
                l.set_churn_key(key);
                assert_eq!(l.churn_counted(), 1.0, "churn key {key} at n {n}");
                assert_eq!(l.len(), n);
            }
            assert_eq!(l.keys_in_order(), reversed(ks.clone()), "churn left the order intact");
            assert_links(&l);
        }
    }

    #[test]
    fn build_visits_nothing_and_teardown_is_quadratic() {
        let keys = [10.0, 20.0, 30.0];
        assert_eq!(DoublyLinkedListF64::build_insert_n(&keys, 3), 3);
        assert_eq!(DoublyLinkedListF64::build_insert_counted(&keys, 3), 0.0);
        let mut l = DoublyLinkedListF64::new(&keys, 3);
        assert_eq!(l.teardown_all(), 3);
        assert!(l.is_empty());
        // tail-by-value: 3 + 2 + 1 = 6 — NOT 0, which a tail-handle unlink would have reported.
        assert_eq!(DoublyLinkedListF64::teardown_counted(&keys, 3), 6.0);
        assert_eq!(DoublyLinkedListF64::build_then_teardown_n(&keys, 3), 3);
    }

    /// What `prev` buys, and the only thing: unlinking a node you already hold costs zero visits
    /// at *every* position, while deleting the same key by value costs its position from the head —
    /// on this list exactly as on the singly one.
    #[test]
    fn unlink_given_a_handle_is_free_but_delete_by_value_still_walks() {
        let ks: Vec<f64> = (0..50).map(|i| i as f64).collect();
        let base = DoublyLinkedListF64::new(&ks, ks.len());
        let handles = base.handles_in_order();
        for (pos, &h) in handles.iter().enumerate() {
            let mut by_handle = DoublyLinkedListF64::new(&ks, ks.len());
            let (value, visits) = by_handle.unlink_handle_counted(h);
            assert_eq!(visits, 0, "a handle unlink visits nothing (position {pos})");
            assert_links(&by_handle);

            let mut by_value = DoublyLinkedListF64::new(&ks, ks.len());
            let mut singly = LinkedListF64::new(&ks, ks.len());
            let d = by_value.delete_one_counted(value);
            assert_eq!(d, (true, pos as u64 + 1), "delete-by-value walks to position {pos}");
            assert_eq!(d, singly.delete_one_counted(value), "…and the singly list walks the same");
            assert_eq!(by_value.keys_in_order(), by_handle.keys_in_order());
        }
    }

    /// The price of the second pointer, measured rather than assumed. With the singly twin's
    /// `Option<u32>` encoding each link is 8 bytes (a 4-byte tag padded to the payload's
    /// alignment), so the node goes 16 → 24 bytes: half again the memory per key for zero change
    /// in any op-count. (With a `u32::MAX` sentinel instead, the singly node would pad 12 → 16
    /// and the doubly node fit exactly in 16 — the "extra pointer" would then cost no bytes at
    /// all. That is an encoding choice the two twins share, so the comparison here is about the
    /// pointer; METHODOLOGY §2.11 states the caveat.)
    #[test]
    fn node_is_half_again_the_singly_node() {
        assert_eq!(DoublyLinkedListF64::NODE_BYTES, 24);
        assert_eq!(LinkedListF64::NODE_BYTES, 16);
    }

    // ── Cross-language corpus (docs/PLAN.md §12, risk R1) ─────────────────────────────────
    //
    // Kept in this module rather than appended to `conformance.rs`, so the corpus that pins
    // this structure lives with it. Format: the singly corpus's lines under a `dll_` prefix,
    // plus two dimensions the singly corpus cannot have — the **backward** order (tail→head via
    // `prev`) before and after the delete sequence, and a **mixed** insert/delete stream whose
    // per-op `(flag:ops)` and final orders exercise free-list reuse, where a stale `prev` would
    // hide. Integer-valued keys round-trip through TS `Number()`.

    const CORPUS_DLL_PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-dll.txt");

    struct DllCase {
        name: &'static str,
        keys: Vec<f64>,
        probes: Vec<f64>,
        deletes: Vec<f64>,
        /// `(is_delete, key)`; inserts report `1:0` (always added, never visit).
        mixed: Vec<(bool, f64)>,
    }

    fn dll_cases() -> Vec<DllCase> {
        vec![
            DllCase {
                name: "empty",
                keys: vec![],
                probes: vec![1.0, 2.0],
                deletes: vec![1.0],
                mixed: vec![(false, 1.0), (true, 1.0), (true, 1.0)],
            },
            DllCase {
                name: "singleton", // delete-to-empty: head and tail are the same node
                keys: vec![42.0],
                probes: vec![42.0, 7.0],
                deletes: vec![42.0],
                mixed: vec![(true, 42.0), (false, 7.0), (false, 8.0), (true, 7.0)],
            },
            DllCase {
                name: "ordered", // middle / absent / head deletes
                keys: vec![10.0, 20.0, 30.0],
                probes: vec![10.0, 20.0, 30.0, 99.0],
                deletes: vec![20.0, 99.0, 30.0],
                mixed: vec![(true, 10.0), (false, 40.0), (true, 30.0), (false, 50.0), (true, 40.0)],
            },
            DllCase {
                name: "duplicates", // delete removes the head-most of a run
                keys: vec![5.0, 5.0, 5.0, 7.0, 5.0, 9.0],
                probes: vec![5.0, 7.0, 9.0, 99.0],
                deletes: vec![5.0, 5.0],
                mixed: vec![(false, 5.0), (true, 5.0), (true, 9.0), (true, 5.0), (false, 9.0)],
            },
            DllCase {
                name: "tail-first", // the teardown's order: each delete is a full walk
                keys: vec![1.0, 2.0, 3.0, 4.0, 5.0],
                probes: vec![1.0, 5.0, 0.0],
                deletes: vec![1.0, 2.0, 3.0],
                mixed: vec![(true, 1.0), (false, 6.0), (true, 2.0), (false, 7.0), (true, 6.0)],
            },
        ]
    }

    fn fmt_nums(xs: &[f64]) -> String {
        xs.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" ")
    }

    fn fmt_flags(rs: &[(bool, u64)]) -> String {
        rs.iter().map(|&(f, ops)| format!("{}:{ops}", f as u8)).collect::<Vec<_>>().join(" ")
    }

    fn fmt_mixed(ops: &[(bool, f64)]) -> String {
        ops.iter()
            .map(|&(d, k)| format!("{}{k}", if d { "-" } else { "+" }))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn serialize_dll(cases: &[DllCase]) -> String {
        let mut out = String::new();
        out.push_str("# Mr Data Structure — doubly-linked-list conformance corpus (docs/PLAN.md §8, §12).\n");
        out.push_str("# Generated from the Rust bench impl (doubly_linked_list.rs); the TS teaching twin must match.\n");
        out.push_str("# Op-count = node-visits. *_rev lines walk tail→head via prev (back-link integrity).\n");
        out.push_str("# mixed: +k inserts at the head (1:0), -k deletes by value.\n");
        out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_dll\n");
        for c in cases {
            let l = DoublyLinkedListF64::new(&c.keys, c.keys.len());
            let search: Vec<(bool, u64)> = c.probes.iter().map(|&p| l.search_one_counted(p)).collect();

            let mut td = DoublyLinkedListF64::new(&c.keys, c.keys.len());
            let del: Vec<(bool, u64)> = c.deletes.iter().map(|&d| td.delete_one_counted(d)).collect();

            let mut mx = DoublyLinkedListF64::new(&c.keys, c.keys.len());
            let mixed: Vec<(bool, u64)> = c
                .mixed
                .iter()
                .map(|&(is_delete, k)| {
                    if is_delete {
                        mx.delete_one_counted(k)
                    } else {
                        (true, mx.insert_one_counted(k))
                    }
                })
                .collect();

            out.push('\n');
            out.push_str(&format!("case {}\n", c.name));
            out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
            out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
            out.push_str(&format!("dll_order {}\n", fmt_nums(&l.keys_in_order())));
            out.push_str(&format!("dll_order_rev {}\n", fmt_nums(&l.keys_in_reverse())));
            out.push_str(&format!("dll_search {}\n", fmt_flags(&search)));
            out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
            out.push_str(&format!("dll_delete {}\n", fmt_flags(&del)));
            out.push_str(&format!("dll_order_after {}\n", fmt_nums(&td.keys_in_order())));
            out.push_str(&format!("dll_order_rev_after {}\n", fmt_nums(&td.keys_in_reverse())));
            out.push_str(&format!("mixed {}\n", fmt_mixed(&c.mixed)));
            out.push_str(&format!("dll_mixed {}\n", fmt_flags(&mixed)));
            out.push_str(&format!("dll_order_mixed {}\n", fmt_nums(&mx.keys_in_order())));
            out.push_str(&format!("dll_order_rev_mixed {}\n", fmt_nums(&mx.keys_in_reverse())));
        }
        out
    }

    #[test]
    #[ignore = "writes the committed doubly-linked-list corpus; run deliberately after a behavior change"]
    fn regen_corpus_dll() {
        std::fs::write(CORPUS_DLL_PATH, serialize_dll(&dll_cases())).expect("write dll corpus");
    }

    #[test]
    fn corpus_dll_matches_committed() {
        let committed = std::fs::read_to_string(CORPUS_DLL_PATH).expect(
            "doubly-linked-list corpus missing; generate it with: cargo test -- --ignored regen_corpus_dll",
        );
        assert_eq!(
            committed.replace('\r', ""),
            serialize_dll(&dll_cases()),
            "doubly-linked-list corpus is stale vs the Rust impl; \
             regenerate with: cargo test -- --ignored regen_corpus_dll",
        );
    }

    /// Every result the corpus records is the singly list's result on the same input — the
    /// corpus-level form of "the second pointer buys nothing". (The `*_rev` lines have no singly
    /// counterpart; that dimension is what the doubly list *adds*, and it is pinned above.)
    #[test]
    fn every_corpus_result_equals_the_singly_lists() {
        for c in dll_cases() {
            let d = DoublyLinkedListF64::new(&c.keys, c.keys.len());
            let s = LinkedListF64::new(&c.keys, c.keys.len());
            assert_eq!(d.keys_in_order(), s.keys_in_order(), "{}", c.name);
            for &p in &c.probes {
                assert_eq!(d.search_one_counted(p), s.search_one_counted(p), "{} probe {p}", c.name);
            }
            let (mut d, mut s) = (
                DoublyLinkedListF64::new(&c.keys, c.keys.len()),
                LinkedListF64::new(&c.keys, c.keys.len()),
            );
            for &k in &c.deletes {
                assert_eq!(d.delete_one_counted(k), s.delete_one_counted(k), "{} delete {k}", c.name);
            }
            for &(is_delete, k) in &c.mixed {
                if is_delete {
                    assert_eq!(d.delete_one_counted(k), s.delete_one_counted(k), "{} mixed -{k}", c.name);
                } else {
                    assert_eq!(d.insert_one_counted(k), s.insert_one_counted(k), "{} mixed +{k}", c.name);
                }
            }
            assert_eq!(d.keys_in_order(), s.keys_in_order(), "{}", c.name);
        }
    }
}
