/**
 * Step-event model (docs/PLAN.md §5) — the contract between the teaching impls
 * and the visualization renderers. Each canonical op (insert / search / delete)
 * a teaching impl performs can be replayed as a stream of these events; a
 * renderer folds the stream into a per-frame display state, and the
 * {@link ./player Player} lets the user step through it.
 *
 * Two design rules pinned in Phase 3 (see the advisor review in the Phase 3
 * kickoff):
 *
 *  1. **Cost events are the op-count, by construction.** The events tagged in
 *     {@link COST_EVENT_KINDS} are emitted *exactly* where the Rust/TS impls
 *     increment their cost counter (one comparison, one hash, one chain-step).
 *     So for any op the number of cost events in its stream equals the
 *     structure's op-count — asserted against the cross-language corpus in
 *     `src/viz/trace.test.ts`. This is what keeps the animation honest: the user
 *     watches the same comparisons that the benchmark counts (docs/PLAN.md §2.1,
 *     risk R1).
 *  2. **The taxonomy grows additively.** Only the array + hash-set events exist
 *     now; trees/heap (rotations, sift, probing variants) extend the union in
 *     later Phase 3 batches without touching what's here.
 */

// ── Dynamic array (docs/PLAN.md §8, "Linear") ──────────────────────────────

/** Compare the scanned cell at `index` against `target` (one comparison — a
 * cost event). `matched` short-circuits the scan. */
export interface ArrCompare {
  readonly kind: 'arr.compare';
  readonly index: number;
  readonly target: number;
  readonly matched: boolean;
}

/** Append `value` at the tail (insert — O(1), no comparisons). */
export interface ArrAppend {
  readonly kind: 'arr.append';
  readonly value: number;
}

/** Mark the cell at `index` as the delete target (highlight only — the shifts
 * that follow overwrite it). Emitted by `delete` after the scan finds a key. */
export interface ArrRemoveTarget {
  readonly kind: 'arr.removeTarget';
  readonly index: number;
}

/** Shift the cell at `from` one slot left to `to` (= `from - 1`) — one shift of
 * the ordered shift-compact (docs/PLAN.md §8). The hole bubbles toward the tail. */
export interface ArrShift {
  readonly kind: 'arr.shift';
  readonly from: number;
  readonly to: number;
}

/** Drop the now-duplicated tail slot, completing a delete. */
export interface ArrPop {
  readonly kind: 'arr.pop';
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost
 * event — it carries no comparison. */
export interface ArrResult {
  readonly kind: 'arr.result';
  readonly found: boolean;
}

export type ArrayEvent =
  | ArrCompare
  | ArrAppend
  | ArrRemoveTarget
  | ArrShift
  | ArrPop
  | ArrResult;

// ── Hash set (docs/PLAN.md §8, "Hashing", separate chaining) ────────────────

/** Hash `key` to `bucket` (one hash — a cost event; the search/insert/delete
 * op-count starts here). */
export interface HsHash {
  readonly kind: 'hs.hash';
  readonly key: number;
  readonly bucket: number;
}

/** Walk one step along `bucket`'s chain, comparing the chain entry at `pos`
 * against `target` (one chain-step — a cost event). */
export interface HsProbe {
  readonly kind: 'hs.probe';
  readonly bucket: number;
  readonly pos: number;
  readonly target: number;
  readonly matched: boolean;
}

/** Append `value` to the chain at `bucket` (insert miss → new entry). */
export interface HsInsert {
  readonly kind: 'hs.insert';
  readonly bucket: number;
  readonly value: number;
}

/** Insert found the key already present at `bucket`/`pos` — nothing stored (set
 * semantics: duplicates collapse). */
export interface HsDuplicate {
  readonly kind: 'hs.duplicate';
  readonly bucket: number;
  readonly pos: number;
}

/** Remove the chain entry at `bucket`/`pos`, preserving chain order (delete). */
export interface HsChainRemove {
  readonly kind: 'hs.chainRemove';
  readonly bucket: number;
  readonly pos: number;
}

/** One key's relocation during a rehash, in old-iteration order (buckets by
 * index, each chain front-to-back). The renderer zips these with its current
 * chips so each keeps its identity as it flies to the new bucket. */
export interface RehashMove {
  readonly value: number;
  readonly toBucket: number;
}

/** Double the table and redistribute (docs/PLAN.md §8, load-factor rehash). The
 * `moves` carry the full per-key redistribution so the relocation can animate. */
export interface HsRehash {
  readonly kind: 'hs.rehash';
  readonly oldCap: number;
  readonly newCap: number;
  readonly moves: readonly RehashMove[];
}

/** Terminal marker: whether the key was present (search/delete). Not a cost event. */
export interface HsResult {
  readonly kind: 'hs.result';
  readonly found: boolean;
}

export type HashSetEvent =
  | HsHash
  | HsProbe
  | HsInsert
  | HsDuplicate
  | HsChainRemove
  | HsRehash
  | HsResult;

// ── Open-addressing hash set (docs/PLAN.md §8 "Hashing", linear probing) ────
//
// One flat array of slots, each **empty**, a **tombstone** (a deleted key's marker)
// or **live**. Slots are addressed by index; a walk starts at the key's `home` slot
// and steps `+1`, wrapping from the last slot to slot 0. `home` rides on every walk
// event so the renderer can shade the stretch walked so far from the active event
// alone (the walk is contiguous, mod the capacity).
//
// **Cost metric — hashes + slot probes (docs/METHODOLOGY.md §2.8):** one for the hash
// and one per *occupied* slot examined — a live key compared, or a tombstone stepped
// over. So the cost events are `hoa.hash` and `hoa.probe`, and `countCostEvents(stream)
// === op-count` holds for **search, insert, AND delete**, pinned against the Rust corpus
// (`conformance/corpus-hoa.txt`, which has an insert column) in `src/viz/trace.hoa.test.ts`.
// Two steps are drawn but deliberately free, exactly as both twins count them:
//  - `hoa.stop`, the **empty slot that ends a walk** — the chaining set's "end of the
//    chain", a header read that says stop. Counting it would put the two hash sets'
//    op-counts one unit apart (Knuth's probe counts include it; this metric does not);
//  - the **rehash's re-placement walks** — `insert` has finished counting before the
//    rebuild runs, so a key's walk to its new slot is never an op.

/** Hash `key` to its `home` slot (one hash — a cost event; every op's count starts here). */
export interface HoaHash {
  readonly kind: 'hoa.hash';
  readonly key: number;
  readonly home: number;
}

/** Examine the occupied slot `slot` on the walk from `home` — one slot probe, a cost
 * event. `state: 'live'` compares the stored `value` against `target` (`matched` ends a
 * search/delete, or flags an insert's duplicate); `state: 'tomb'` steps over a deleted
 * key's marker, which can never match but must not stop the walk.
 *
 * `reuse` is an insert's remembered slot as of this step: the **first** tombstone on the
 * path so far, which the key will take once the walk reaches an empty slot and so proves
 * it absent (`reuse === slot` on the probe that first finds it). Always `null` on a
 * search or delete, and on an insert that has passed no tombstone yet. Carrying it on
 * every later step lets the view keep that slot marked from the active event alone. */
export interface HoaProbe {
  readonly kind: 'hoa.probe';
  readonly home: number;
  readonly slot: number;
  readonly state: 'live' | 'tomb';
  readonly value: number | null;
  readonly target: number;
  readonly matched: boolean;
  readonly reuse: number | null;
}

/** The walk reached the empty slot `slot` and stops: the key is absent. **Free** — not a
 * cost event (see the section note). On an insert this is the proof of absence that lets
 * the key be stored — in `reuse` if the walk passed a tombstone, else here. */
export interface HoaStop {
  readonly kind: 'hoa.stop';
  readonly home: number;
  readonly slot: number;
  readonly reuse: number | null;
}

/** Store `value` in `slot` (insert). `reused` is true when `slot` is the first tombstone
 * the walk passed — the reuse rule that keeps churn from stranding tombstones
 * (docs/METHODOLOGY.md §2.8 rule 1) — and false when it is the empty slot that ended the
 * walk. No probe: the walk that chose the slot was already counted. */
export interface HoaPlace {
  readonly kind: 'hoa.place';
  readonly slot: number;
  readonly value: number;
  readonly reused: boolean;
}

/** Insert found the key already live at `slot` — nothing stored (set semantics). */
export interface HoaDuplicate {
  readonly kind: 'hoa.duplicate';
  readonly slot: number;
}

/** Turn the live slot `slot` into a tombstone (delete). Emptying it instead would cut
 * the walk of every key stored past it in the same run. */
export interface HoaTombstone {
  readonly kind: 'hoa.tombstone';
  readonly slot: number;
}

/** One live key's new slot during a rebuild, in **old-slot order** (the order Rust
 * re-places them, which fixes the layout). The renderer zips these with its live cells
 * so each keeps its identity as it moves. */
export interface HoaMove {
  readonly value: number;
  readonly toSlot: number;
}

/** Rebuild the table without tombstones, because live + tombstones passed 0.75 of the
 * slots (docs/METHODOLOGY.md §2.8 rule 2): **purge** in place (`newCap === oldCap`) when
 * the live keys are at most half that threshold, otherwise **double**. `live` and
 * `tombs` are the counts that tripped it. Not a cost event — the re-placement walks
 * are uncounted (see the section note). */
export interface HoaRehash {
  readonly kind: 'hoa.rehash';
  readonly oldCap: number;
  readonly newCap: number;
  readonly live: number;
  readonly tombs: number;
  readonly moves: readonly HoaMove[];
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface HoaResult {
  readonly kind: 'hoa.result';
  readonly found: boolean;
}

export type HashSetOaEvent =
  | HoaHash
  | HoaProbe
  | HoaStop
  | HoaPlace
  | HoaDuplicate
  | HoaTombstone
  | HoaRehash
  | HoaResult;

// ── Sorted array (docs/PLAN.md §8, "Linear", binary search) ─────────────────

/** Compare the midpoint cell at `index` against `target` within the live binary-
 * search window `[lo, hi)` (one comparison — a cost event). The renderer shades
 * the eliminated halves; `matched` ends the search. */
export interface SArrCompare {
  readonly kind: 'sarr.compare';
  readonly index: number;
  readonly lo: number;
  readonly hi: number;
  readonly target: number;
  readonly matched: boolean;
}

/** Open a fresh empty slot at the tail to make room for an insert. The hole then
 * bubbles left (via `sarr.shift`) to the sorted insertion point. */
export interface SArrAppendHole {
  readonly kind: 'sarr.appendHole';
}

/** Shift the cell at `from` one slot to `to` (`to = from ± 1`) — a rightward
 * shift opens the insert gap; a leftward shift compacts after a delete. The hole
 * swaps the other way, keeping every slot id unique per frame. Not a cost event
 * on its own; the `+ shifts` term of the cost metric is counted in `ops`. */
export interface SArrShift {
  readonly kind: 'sarr.shift';
  readonly from: number;
  readonly to: number;
}

/** Drop `value` into the hole now resting at `index`, completing an insert. */
export interface SArrFill {
  readonly kind: 'sarr.fill';
  readonly index: number;
  readonly value: number;
}

/** Mark the cell at `index` (found by binary search) as the delete target,
 * turning it into a hole the survivors then shift left past. */
export interface SArrRemoveTarget {
  readonly kind: 'sarr.removeTarget';
  readonly index: number;
}

/** Drop the now-duplicated tail slot, completing a delete. */
export interface SArrPop {
  readonly kind: 'sarr.pop';
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface SArrResult {
  readonly kind: 'sarr.result';
  readonly found: boolean;
}

export type SortedArrayEvent =
  | SArrCompare
  | SArrAppendHole
  | SArrShift
  | SArrFill
  | SArrRemoveTarget
  | SArrPop
  | SArrResult;

// ── Linked list (docs/PLAN.md §8, "Linear", singly / doubly) ────────────────

/** Visit the node at position `index` (0-based from the head), comparing its
 * `value` against `target` (one node-visit — a cost event). `matched` ends the
 * walk. Shared by the singly and doubly lists: their observable cost is identical
 * (the doubly list only adds back-pointers, drawn by the renderer). */
export interface LlVisit {
  readonly kind: 'll.visit';
  readonly index: number;
  readonly value: number;
  readonly target: number;
  readonly matched: boolean;
}

/** Splice a new node carrying `value` at the head (insert — O(1), no visits). */
export interface LlInsertHead {
  readonly kind: 'll.insertHead';
  readonly value: number;
}

/** Unlink the node at position `index` (found during delete); its neighbours
 * reconnect and the survivors slide together. */
export interface LlUnlink {
  readonly kind: 'll.unlink';
  readonly index: number;
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface LlResult {
  readonly kind: 'll.result';
  readonly found: boolean;
}

export type LinkedListEvent = LlVisit | LlInsertHead | LlUnlink | LlResult;

/**
 * One pointer write of the **doubly** list — the steps a back pointer adds (docs/PLAN.md
 * §8; docs/METHODOLOGY.md §2.11). Not a cost event: the node-visit counter never ticks
 * on a link update, on either list, which is why the doubly list's counts equal the
 * singly list's exactly while it does more writes.
 *
 * Addressing (duplicates rule out values): `from` / `to` are **display positions** —
 * indices into the list's nodes as drawn at that frame, which change only on
 * `ll.insertHead` (the new node is prepended, still unlinked) and `ll.unlink` (the
 * bypassed node is dropped). So a delete's two relinks name the node *being removed*
 * by its op-start position even though the forward walk can no longer reach it.
 * `from: null` is the list's own handle in that direction — `head` for a `next`
 * write, `tail` for a `prev` write; `to: null` is ∅ (end of the list that way).
 */
export interface DllRelink {
  readonly kind: 'dll.relink';
  readonly link: 'next' | 'prev';
  readonly from: number | null;
  readonly to: number | null;
}

/** The doubly list's stream: the singly list's events plus its pointer writes. */
export type DoublyListEvent = LinkedListEvent | DllRelink;

// ── Binary search tree (docs/PLAN.md §8, "Trees / heaps", unbalanced) ───────
//
// Nodes are addressed by a **root path** — the sequence of left/right steps from
// the root — which is the tree analog of the linear structures' slot indices: it
// is stable between the teaching impl (which walked it) and the renderer (which
// folds it), so the events never reference the model's animation ids. A `[]` path
// is the root.
//
// **Cost-counting convention (the Phase 4 Rust twin must mirror this, risk R1):**
// the BST's declared cost metric is **key comparisons** (docs/PLAN.md §8), and the
// *only* cost event is `bst.compare` — one per node examined on a search path
// (insert/search/delete's find phase). The in-order-successor walk of a two-child
// delete (`bst.descend`) follows pointers (right once, then left to the bottom)
// and performs **no key comparisons**, so it is deliberately *not* a cost event —
// exactly as the Rust op-counter will count it (the successor min-walk increments
// no comparison counter). This keeps `countCostEvents(stream) === op-count` for
// search, insert, *and* delete (pinned in `src/viz/trace.bst.test.ts`).

/** One step down the tree: to the left or right child. */
export type BstStep = 'L' | 'R';

/** Which way the search proceeds from the compared node, or that it matched. With
 * multiset semantics insert descends `right` on an equal key (never `match`); a
 * search/delete *find* stops on `match`. */
export type BstDir = 'left' | 'right' | 'match';

/** Compare `target` against the key `value` at the node reached by `path` (one key
 * comparison — the BST's only cost event). `dir` is the branch taken next (or
 * `match`); the renderer highlights the node and, on a miss, the chosen subtree. */
export interface BstCompare {
  readonly kind: 'bst.compare';
  readonly path: readonly BstStep[];
  readonly value: number;
  readonly target: number;
  readonly dir: BstDir;
}

/** Attach a new leaf carrying `value` at `path` (the full path to the new node;
 * its parent is `path[0..-1]`, its side is the last step). `path === []` seeds the
 * root of an empty tree. No comparison — the compares that located the slot
 * preceded it. */
export interface BstInsert {
  readonly kind: 'bst.insert';
  readonly path: readonly BstStep[];
  readonly value: number;
}

/** Mark the node at `path` (found by the search) as the delete target — a
 * highlight-only marker before the removal events that follow. */
export interface BstRemoveTarget {
  readonly kind: 'bst.removeTarget';
  readonly path: readonly BstStep[];
}

/** Step onto the node at `path` while walking to the in-order successor of a
 * two-child delete (right once, then left to the bottom). Pointer-following, *not*
 * a comparison — highlight-only, never a cost event. */
export interface BstDescend {
  readonly kind: 'bst.descend';
  readonly path: readonly BstStep[];
}

/** Copy the successor's `value` up into the node at `path` (the two-child delete's
 * value-copy step). The node keeps its animation id — the number changes in place;
 * the successor node is then removed by a following `bst.remove`. */
export interface BstReplaceValue {
  readonly kind: 'bst.replaceValue';
  readonly path: readonly BstStep[];
  readonly value: number;
}

/** Remove the node at `path`, which is guaranteed to have **at most one child**
 * (a leaf, a one-child node, or the in-order successor — whose left is always
 * empty). The reducer replaces it with that single child, or `null` for a leaf. */
export interface BstRemove {
  readonly kind: 'bst.remove';
  readonly path: readonly BstStep[];
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface BstResult {
  readonly kind: 'bst.result';
  readonly found: boolean;
}

export type BstEvent =
  | BstCompare
  | BstInsert
  | BstRemoveTarget
  | BstDescend
  | BstReplaceValue
  | BstRemove
  | BstResult;

// ── AVL tree (docs/PLAN.md §8, "Trees / heaps", balanced) ───────────────────
//
// A **balanced multiset BST** sharing the BST's ordering (`key < node` ⇒ left,
// else right), addressing (root path, {@link BstStep}[]), and value-copy delete,
// so it reuses the generic binary-tree display model. The one structural addition
// is the **rotation** — the rebalancing step that keeps every node's balance
// factor in {-1, 0, +1}, so the height (and the comparison cost) stays O(log n)
// where the unbalanced BST degenerates to O(n) on sorted input.
//
// **Cost metric — comparisons + rotations (docs/PLAN.md §8), and both are cost
// events.** `avl.compare` is emitted once per node examined on a find path, and
// `avl.rotate` once per single rotation (a double rotation is two). So — unlike
// the sorted array, whose insert/delete carry an *untagged* `+ shifts` term — the
// honesty gate `countCostEvents(stream) === op-count` holds for **search, insert,
// AND delete** (pinned in `src/viz/trace.avl.test.ts`). The in-order-successor
// walk of a two-child delete (`avl.descend`) follows pointers — no key comparison,
// so not a cost event — exactly as in the BST. The Phase 4 Rust twin must mirror
// both conventions (the successor walk counts no comparison; each rotation counts
// one) or the cross-language corpus mismatches (risk R1).

/** Compare `target` against the key `value` at the node reached by `path` (one key
 * comparison — a cost event). `dir` is the branch taken next (or `match`). */
export interface AvlCompare {
  readonly kind: 'avl.compare';
  readonly path: readonly BstStep[];
  readonly value: number;
  readonly target: number;
  readonly dir: BstDir;
}

/** Attach a new leaf carrying `value` at `path` (its parent is `path[0..-1]`).
 * `path === []` seeds the root of an empty tree. No comparison. The rebalancing
 * rotations (if any) follow as `avl.rotate` events. */
export interface AvlInsert {
  readonly kind: 'avl.insert';
  readonly path: readonly BstStep[];
  readonly value: number;
}

/** Mark the node at `path` (found by the search) as the delete target — a
 * highlight-only marker before the removal/rebalance events that follow. */
export interface AvlRemoveTarget {
  readonly kind: 'avl.removeTarget';
  readonly path: readonly BstStep[];
}

/** Step onto the node at `path` while walking to the in-order successor of a
 * two-child delete (right once, then left to the bottom). Pointer-following, *not*
 * a comparison — highlight-only, never a cost event. */
export interface AvlDescend {
  readonly kind: 'avl.descend';
  readonly path: readonly BstStep[];
}

/** Copy the successor's `value` up into the node at `path` (the two-child delete's
 * value-copy step). The node keeps its id — the number changes in place. */
export interface AvlReplaceValue {
  readonly kind: 'avl.replaceValue';
  readonly path: readonly BstStep[];
  readonly value: number;
}

/** Remove the node at `path`, guaranteed to have **at most one child** (a leaf, a
 * one-child node, or the in-order successor — whose left is always empty). The
 * reducer replaces it with that single child, or `null`. */
export interface AvlRemove {
  readonly kind: 'avl.remove';
  readonly path: readonly BstStep[];
}

/** Rotate the subtree rooted at `path` (the **pivot**) one step `dir` — the AVL's
 * rebalancing primitive (one rotation = one cost unit, a cost event). A `right`
 * rotation lifts the pivot's left child into its place; a `left` rotation lifts the
 * right child. A double rotation (LR / RL) is emitted as the child rotation then
 * the pivot rotation, exactly as the algorithm performs it. `value` is the pivot's
 * key, carried for the caption: after the fold the pivot has moved down one level,
 * so `path` no longer addresses it. */
export interface AvlRotate {
  readonly kind: 'avl.rotate';
  readonly path: readonly BstStep[];
  readonly dir: 'left' | 'right';
  readonly value: number;
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface AvlResult {
  readonly kind: 'avl.result';
  readonly found: boolean;
}

export type AvlEvent =
  | AvlCompare
  | AvlInsert
  | AvlRemoveTarget
  | AvlDescend
  | AvlReplaceValue
  | AvlRemove
  | AvlRotate
  | AvlResult;

// ── Binary min-heap (docs/PLAN.md §8, "Trees / heaps") ──────────────────────
//
// Array-backed **complete binary tree**; the renderer draws BOTH the array and the
// implicit tree (the child of position `i` lives at `2i+1` / `2i+2`,
// docs/PLAN.md §5). A **different op set** (docs/PLAN.md §4.1, §8): insert / peek /
// extract-min, plus an O(n) `search` shown as a deliberate contrast (heaps are not
// search structures). Cost metric — **comparisons + swaps (docs/PLAN.md §8)**:
// `heap.compare` (a sift key-comparison between two positions), `heap.scan` (a
// search's linear key-comparison), and `heap.swap` are the cost events, so
// `countCostEvents(stream) === op-count` holds for insert, extract-min, AND search
// (pinned in `src/viz/trace.heap.test.ts`). `peek` is O(1) with no cost.

/** Append `value` at the tail array slot — the start of an insert, before the
 * sift-up restores the heap order. No comparison. */
export interface HeapAppend {
  readonly kind: 'heap.append';
  readonly value: number;
}

/** Compare the keys at positions `a` and `b` during a sift (one comparison — a
 * cost event). `winner` is the position holding the **smaller** key (min-heap):
 * `a` or `b`. */
export interface HeapCompare {
  readonly kind: 'heap.compare';
  readonly a: number;
  readonly b: number;
  readonly winner: number;
}

/** Compare the cell at `index` against `target` during the O(n) search scan (one
 * comparison — a cost event). `matched` ends the scan. */
export interface HeapScan {
  readonly kind: 'heap.scan';
  readonly index: number;
  readonly target: number;
  readonly matched: boolean;
}

/** Swap the keys at positions `i` and `j` (one swap — a cost event). Both cells
 * keep their ids, so the renderer animates the exchange in the array and the tree. */
export interface HeapSwap {
  readonly kind: 'heap.swap';
  readonly i: number;
  readonly j: number;
}

/** Highlight the root as the minimum being extracted (highlight-only; the
 * structural refill is the following `heap.replaceRoot`). */
export interface HeapExtractRoot {
  readonly kind: 'heap.extractRoot';
  readonly value: number;
}

/** Drop the root and move the last cell into the root slot — extract-min's refill,
 * before the sift-down (the moved cell keeps its id, so it animates from the tail
 * to the root). `value` is the key moved up; on a one-element heap this just empties
 * it. Not a cost event (the structural move isn't a compare-driven swap). */
export interface HeapReplaceRoot {
  readonly kind: 'heap.replaceRoot';
  readonly value: number;
}

/** Read the root key without mutating (peek — O(1), no cost). Highlight-only. */
export interface HeapPeek {
  readonly kind: 'heap.peek';
  readonly value: number;
}

/** Terminal marker for a search/extract/peek: whether a key was present. Not a cost event. */
export interface HeapResult {
  readonly kind: 'heap.result';
  readonly found: boolean;
}

export type HeapEvent =
  | HeapAppend
  | HeapCompare
  | HeapScan
  | HeapSwap
  | HeapExtractRoot
  | HeapReplaceRoot
  | HeapPeek
  | HeapResult;

// ── Trie (docs/PLAN.md §8, "Specialized" — the only string-key structure with an
// animation) ────────────────────────────────────────────────────────────────
//
// The trie is the first animated structure whose keys are **strings**, and the
// first whose nodes are addressed by a path of **UTF-8 bytes** rather than by a
// slot index or an L/R step. `path` is the full byte sequence from the root to
// the node the event acts on — the trie's analog of {@link BstStep}[], and `[]`
// is the root. A multi-byte character therefore occupies several levels, which
// is what the view draws: one node per *byte*, not per character.
//
// **Cost metric — char-steps (docs/PLAN.md §8):** one step for entering the root
// plus one per key byte whose child lookup is attempted, so a stored key of L
// bytes costs `1 + L` and an absent key costs `1 + d` where d is the depth the
// walk fell off at. The within-node child lookup (a binary search over ≤256
// entries in Rust, a `Map` get in TS) is bounded by the alphabet and deliberately
// **not** counted. So the two cost events are `trie.enterRoot` and `trie.step`,
// and `countCostEvents(stream) === op-count` holds for **search, insert, AND
// delete** (pinned in `src/viz/trace.trie.test.ts`, against the cross-language
// string corpus). The structural events — creating a node, flipping the terminal
// flag, pruning — carry no char-step, exactly as the Rust twin counts them.

/** Enter the root to begin a walk (one char-step — a cost event; every trie op's
 * count starts here). `key` is the whole key being walked, carried for the caption. */
export interface TrieEnterRoot {
  readonly kind: 'trie.enterRoot';
  readonly key: string;
}

/** Look up the child for `byte` at the node reached by `path` (one char-step — a
 * cost event). `path` addresses the node being *left*, so the child is at
 * `[...path, byte]`.
 *
 * `hit` says whether that child existed. A miss means opposite things in the two
 * directions, which `creates` disambiguates: on a **search or delete** the walk is
 * over and the key is absent (`creates: false`); on an **insert** a missing child is
 * the ordinary case — the very next event is `trie.create` and the walk carries on
 * (`creates: true`). Without this the renderer would tint a perfectly normal insert
 * step as a failure and the caption would call the key absent. `creates` is `false`
 * whenever `hit` is true (nothing needs creating). */
export interface TrieStep {
  readonly kind: 'trie.step';
  readonly path: readonly number[];
  readonly byte: number;
  readonly hit: boolean;
  readonly creates: boolean;
}

/** Materialize the missing child node at `path` (the full path to the new node;
 * its parent is `path[0..-1]`, its byte is the last element). Insert only — the
 * step that looked for it and missed came immediately before. No char-step. */
export interface TrieCreate {
  readonly kind: 'trie.create';
  readonly path: readonly number[];
}

/** Mark the node at `path` as the end of a stored key (insert's final step).
 * `alreadyPresent` is true when the flag was already set — the set semantics'
 * duplicate collapse, where nothing changes. No char-step. */
export interface TrieMarkTerminal {
  readonly kind: 'trie.markTerminal';
  readonly path: readonly number[];
  readonly alreadyPresent: boolean;
}

/** Clear the terminal flag at `path` — the delete itself, before any pruning. The
 * node survives this event; the `trie.prune` events that follow (if any) remove
 * what the clearing left useless. No char-step. */
export interface TrieClearTerminal {
  readonly kind: 'trie.clearTerminal';
  readonly path: readonly number[];
}

/** Unlink the node at `path`, which is guaranteed to be a **leaf** left neither
 * terminal nor a parent (`is_prunable` in the Rust twin). Emitted deepest-first as
 * the delete unwinds, so each one removes a leaf and never a subtree — the reducer
 * relies on that and would otherwise silently accept a malformed stream. No
 * char-step. */
export interface TriePrune {
  readonly kind: 'trie.prune';
  readonly path: readonly number[];
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost
 * event. Note the trie's own trap — a walk can reach a node without finding a key,
 * because a *proper prefix* of a stored key costs the full depth and still reports
 * `found: false`. */
export interface TrieResult {
  readonly kind: 'trie.result';
  readonly found: boolean;
}

export type TrieEvent =
  | TrieEnterRoot
  | TrieStep
  | TrieCreate
  | TrieMarkTerminal
  | TrieClearTerminal
  | TriePrune
  | TrieResult;

// ── Skip list (docs/PLAN.md §8, "Specialized") ──────────────────────────────
//
// A probabilistic **ordered multiset** whose tower heights come from each key's
// hash rather than a coin (see `src/structures/skipList.ts`), so the whole shape is
// a pure function of the key set. Nodes are addressed by their **level-0 index** —
// the rank in ascending order — the skip list's analog of the array's slot index
// and the tree's root path. A search or delete never mutates before its terminal
// event and an insert splices last, so an index is stable across an op's whole
// stream. The head sentinel is index `-1`.
//
// **Cost metric — node-visits (docs/PLAN.md §8):** one per node whose key is
// inspected (one comparison each). Entering the head and dropping off the end of an
// express lane cost nothing, exactly as `descend` counts them. The one cost event
// is `skip.inspect`, so `countCostEvents(stream) === op-count` holds for **search,
// insert, AND delete** — search and delete pinned against the Rust corpus in
// `src/viz/trace.skip.test.ts`, insert self-consistent only (the corpus has no
// insert column, like the trie's).
//
// **The level-0 double comparison is honest.** On a hit, the descent's level-0 step
// compares node X (`X < target`? → no → drop), and then the membership check
// compares the SAME X (`X === target`? → yes). Two comparisons on one node, both
// counted (the Rust twin counts them the same way). The renderer/caption must show
// the second as a separate equality test, never dedupe it.

/** How a node inspection resolved. `advance`/`stop` are the descent's two outcomes
 * (move right along this lane, or drop a level); `found`/`notFound` are the level-0
 * membership check that search and delete finish with. */
export type SkipOutcome = 'advance' | 'stop' | 'found' | 'notFound';

/** Begin a walk at the head sentinel, on the top express lane. `topLevel` is the
 * highest lane in use; it is `-1` only for an **empty** list, where no lane exists
 * and no inspect follows. Not a cost event — entering the head is free (the skip
 * list's op-count starts at the first node inspected, unlike the trie's root). */
export interface SkipEnter {
  readonly kind: 'skip.enter';
  readonly key: number;
  readonly topLevel: number;
}

/** Inspect the node at level-0 `index`, reached by following lane `level` forward
 * from where the walk stands (`at`; `-1` = the head) — one key comparison, a cost
 * event. `outcome` says what the comparison decided (see {@link SkipOutcome}). A
 * level-0 `stop` and the `found`/`notFound` that follows it inspect the SAME node
 * (`at`'s level-0 successor): the descent asks "`< target`?" and the membership
 * check asks "`=== target`?". Two honest comparisons on one node — never deduped. */
export interface SkipInspect {
  readonly kind: 'skip.inspect';
  readonly at: number;
  readonly index: number;
  readonly level: number;
  readonly value: number;
  readonly target: number;
  readonly outcome: SkipOutcome;
}

/** Lane `level` has no next node from where the walk stands (`at`; `-1` = head):
 * drop a level with no comparison. Free — the skip list pays nothing for running
 * off the end of an express lane, which is why an above-max miss is its cheapest
 * query (docs/METHODOLOGY.md §4 hurdle 9). */
export interface SkipLaneEnd {
  readonly kind: 'skip.laneEnd';
  readonly at: number;
  readonly level: number;
}

/** Splice a new node of height `height` at level-0 `index` (insert). The express
 * lanes are re-derived from height + order (a correct skip list has a node on lane
 * `i` iff its height > `i`), so no per-level link is carried. No comparison — the
 * inspects that located the slot preceded it. */
export interface SkipInsert {
  readonly kind: 'skip.insert';
  readonly index: number;
  readonly value: number;
  readonly height: number;
}

/** Mark the node at level-0 `index` (found by the descent's membership check) as
 * the delete target — a highlight-only marker before the unlink. */
export interface SkipRemoveTarget {
  readonly kind: 'skip.removeTarget';
  readonly index: number;
}

/** Unlink the node at level-0 `index` from every lane it occupied (delete). */
export interface SkipRemove {
  readonly kind: 'skip.remove';
  readonly index: number;
}

/** Terminal marker for a search/delete: whether the key was present. Not a cost event. */
export interface SkipResult {
  readonly kind: 'skip.result';
  readonly found: boolean;
}

export type SkipListEvent =
  | SkipEnter
  | SkipInspect
  | SkipLaneEnd
  | SkipInsert
  | SkipRemoveTarget
  | SkipRemove
  | SkipResult;

// ── Graph (docs/PLAN.md §8, "Specialized") ──────────────────────────────────
//
// An undirected adjacency-list **multigraph** over dense vertex ids `0..V` (see
// `src/structures/graph.ts`). Its op set is not insert/search/delete but a
// whole-graph **traversal** from a source — BFS (a queue, mark-on-enqueue) or DFS
// (an explicit stack, **mark-on-push**, never recursion). An adjacency entry is
// addressed by `(from, slot)`: entry `slot` of `adj[from]`. The graph is static
// for the length of a traversal, so an address is stable across the whole stream.
//
// **Cost metric — vertex-visits + edge-visits (docs/PLAN.md §8):** one per vertex
// taken off the frontier (`graph.visit`) and one per adjacency entry examined
// (`graph.examine`), whether or not it leads anywhere new. Those are exactly the two
// counter increments in both twins, so `countCostEvents(stream) === ops` — which is
// `V + 2E` on a connected graph and the reached component's `V′ + 2E′` otherwise —
// pinned against the Rust corpus (`conformance/corpus-graph.txt`) in
// `src/viz/trace.graph.test.ts`. Marking a vertex and putting it on the frontier
// (`graph.start` for the source, `graph.mark` for every later discovery) costs
// nothing: it is a consequence of an examine already counted.
//
// **The mark is its own frame on purpose.** DFS marks a vertex when it is *pushed*,
// not when it is popped — so a vertex can be marked and still waiting on the stack,
// and a later edge to it is skipped even though it has not been visited yet. That is
// the real rule both twins run (and the corpus's `dfs_variant` case pins), and it is
// not textbook recursion; a separate `graph.mark` step is what makes it watchable.

/** Which traversal a stream belongs to — it decides which end of the frontier a
 * `graph.visit` takes from (the queue's front for BFS, the stack's top for DFS). */
export type GraphAlgo = 'bfs' | 'dfs';

/** Begin a traversal: mark `source` and put it on the (empty) frontier. Not a cost
 * event. Emitted only for a valid source — an out-of-range source (or an empty
 * graph) produces a stream with no start, no visit, and `ops: 0`. */
export interface GraphStart {
  readonly kind: 'graph.start';
  readonly algo: GraphAlgo;
  readonly source: number;
}

/** Take `vertex` off the frontier (dequeue for BFS, pop for DFS) and process it —
 * one **vertex-visit**, a cost event. The vertex is always the frontier's out-end
 * (front of the queue / top of the stack); the fold relies on that and
 * `model.test.ts` pins it at every visit. */
export interface GraphVisit {
  readonly kind: 'graph.visit';
  readonly algo: GraphAlgo;
  readonly vertex: number;
}

/** Examine adjacency entry `slot` of `adj[from]`, whose neighbour is `to` — one
 * **edge-visit**, a cost event, paid whether or not it discovers anything.
 * `discovers` is true when `to` was not yet marked; the very next event is then the
 * `graph.mark` that marks it and puts it on the frontier. When it is false, `to` is
 * already marked — in DFS that can mean "still waiting on the stack", not "visited".
 * A self-loop's two entries in `adj[from]` are examined as two separate events. */
export interface GraphExamine {
  readonly kind: 'graph.examine';
  readonly from: number;
  readonly slot: number;
  readonly to: number;
  readonly discovers: boolean;
}

/** Mark `vertex` and put it on the frontier (enqueue / push) — the step the examine
 * just before it decided. Not a cost event. This is where mark-on-push happens. */
export interface GraphMark {
  readonly kind: 'graph.mark';
  readonly vertex: number;
}

/** Terminal marker: the frontier is empty. `reached` is how many vertices were
 * visited (the source's connected component). Not a cost event. */
export interface GraphDone {
  readonly kind: 'graph.done';
  readonly reached: number;
}

export type GraphEvent = GraphStart | GraphVisit | GraphExamine | GraphMark | GraphDone;

// ── Union + cost tagging ────────────────────────────────────────────────────

export type VizEvent =
  | ArrayEvent
  | HashSetEvent
  | HashSetOaEvent
  | SortedArrayEvent
  | DoublyListEvent
  | BstEvent
  | AvlEvent
  | HeapEvent
  | TrieEvent
  | SkipListEvent
  | GraphEvent;
export type VizEventKind = VizEvent['kind'];

/** Sink the teaching impls emit into. Typed per family at the call site
 * (`Tracer<ArrayEvent>` / `Tracer<HashSetEvent>`). */
export type Tracer<E extends VizEvent> = (event: E) => void;

/**
 * Event kinds that carry one unit of a structure's cost metric (docs/PLAN.md
 * §8): an array comparison, a hash, a chain-step. The count of these in an op's
 * stream is exactly the op's op-count — the invariant pinned in `trace.test.ts`.
 */
export const COST_EVENT_KINDS: ReadonlySet<VizEventKind> = new Set<VizEventKind>([
  'arr.compare',
  'hs.hash',
  'hs.probe',
  // Open addressing: hashes + slot probes (docs/METHODOLOGY.md §2.8). `hoa.stop` — the
  // empty slot that ends a walk — is drawn but free, like the end of a chain, and the
  // rehash's re-placement walks are uncounted; so the gate holds for search, insert,
  // AND delete.
  'hoa.hash',
  'hoa.probe',
  'sarr.compare',
  'll.visit',
  // Doubly list: `dll.relink` is deliberately absent — a pointer write is not a
  // node-visit, so the doubly list's cost events equal the singly list's.
  // BST: the in-order-successor descend (`bst.descend`) follows pointers, not
  // key comparisons, so only `bst.compare` is a cost event (see the convention
  // note above and risk R1). This holds for search, insert, *and* delete.
  'bst.compare',
  // AVL: comparisons + rotations (docs/PLAN.md §8). Both are discrete cost events,
  // so the gate holds for search, insert, AND delete (the `avl.descend` successor
  // walk carries no comparison, like the BST).
  'avl.compare',
  'avl.rotate',
  // Min-heap: comparisons + swaps (docs/PLAN.md §8). Sift comparisons, search-scan
  // comparisons, and swaps are the cost events.
  'heap.compare',
  'heap.scan',
  'heap.swap',
  // Trie: char-steps (docs/PLAN.md §8) — entering the root, plus one per key byte
  // looked up. The structural events (create / terminal flags / prune) carry no
  // char-step, so the gate holds for search, insert, AND delete.
  'trie.enterRoot',
  'trie.step',
  // Skip list: node-visits (docs/PLAN.md §8) — one comparison per node inspected on
  // the walk. Entering the head and dropping off a lane's end (`skip.laneEnd`) cost
  // nothing; the structural events (insert / remove) carry no comparison. So the
  // gate holds for search, insert, AND delete.
  'skip.inspect',
  // Graph: vertex-visits + edge-visits (docs/PLAN.md §8) — one per vertex taken off
  // the frontier, one per adjacency entry examined. Starting, marking and finishing
  // are free, so the gate holds for BFS and DFS alike (and both total V + 2E on a
  // connected graph).
  'graph.visit',
  'graph.examine',
]);

/** Count the cost-bearing events in a stream (the op-count it represents). */
export function countCostEvents(events: readonly VizEvent[]): number {
  let n = 0;
  for (const e of events) if (COST_EVENT_KINDS.has(e.kind)) n += 1;
  return n;
}
