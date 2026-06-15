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

// ── Union + cost tagging ────────────────────────────────────────────────────

export type VizEvent = ArrayEvent | HashSetEvent | SortedArrayEvent | LinkedListEvent;
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
  'sarr.compare',
  'll.visit',
]);

/** Count the cost-bearing events in a stream (the op-count it represents). */
export function countCostEvents(events: readonly VizEvent[]): number {
  let n = 0;
  for (const e of events) if (COST_EVENT_KINDS.has(e.kind)) n += 1;
  return n;
}
