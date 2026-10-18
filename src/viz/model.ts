/**
 * Display models and the event fold (docs/PLAN.md §5). A renderer shows the
 * structure at frame `f` by folding `events[0..f)` over the model captured
 * *before* the op (see {@link ./player}). Keeping the fold here — pure, no JSX —
 * means the animation's correctness is unit-tested, not eyeballed (the advisor's
 * "make the logic bulletproof, treat pixels as smoke").
 *
 * Each stored item carries a stable `id` independent of its value, so a renderer
 * can animate a *moving* item (an array shift, a rehash relocation) by tracking
 * identity across frames — values alone can't (the structures hold duplicates).
 * Reducers are total: structural events transform the model; highlight-only
 * events (`compare`, `probe`, `result`, …) return it unchanged (the view derives
 * the highlight from the active event instead).
 */

import type {
  ArrayEvent, HashSetEvent, HashSetOaEvent, SortedArrayEvent, LinkedListEvent, DoublyListEvent, BstEvent, BstStep, AvlEvent, HeapEvent,
  TrieEvent, SkipListEvent, GraphEvent, GraphAlgo,
} from './events';
import type { BstShape } from '../structures/bst';
import type { DoublyShape } from '../structures/linkedList';
import type { TrieShape } from '../structures/trie';

/** A stored array cell with a stable identity for animation. */
export interface Cell {
  readonly id: number;
  readonly value: number;
}

/** The vacated slot during a shift-compact delete. It carries its own id and
 * bubbles toward the tail as the survivors shift left, so every intermediate
 * frame keeps unique slot ids (each frame must be renderable, not just the
 * last). It's dropped by the final `arr.pop`. */
export interface Hole {
  readonly id: number;
  readonly hole: true;
}

/** A slot in the array view: a real cell or the transient delete hole. */
export type Slot = Cell | Hole;

export const isHole = (s: Slot): s is Hole => 'hole' in s;

/** The array's display state: ordered slots plus the next free id. */
export interface ArrayModel {
  readonly cells: readonly Slot[];
  readonly nextId: number;
}

/** Build the initial array model from the structure's current keys. */
export function arrayModel(values: readonly number[]): ArrayModel {
  return { cells: values.map((value, id) => ({ id, value })), nextId: values.length };
}

/** Fold one array event into the model (docs/PLAN.md §8 shift-compact delete). */
export function reduceArray(m: ArrayModel, e: ArrayEvent): ArrayModel {
  switch (e.kind) {
    case 'arr.append':
      return { cells: [...m.cells, { id: m.nextId, value: e.value }], nextId: m.nextId + 1 };
    case 'arr.removeTarget': {
      // Replace the found cell with a hole (its own id); the survivors then shift
      // left past it. The hole is what makes every shift frame renderable.
      const cells = m.cells.slice();
      cells[e.index] = { id: m.nextId, hole: true };
      return { cells, nextId: m.nextId + 1 };
    }
    case 'arr.shift': {
      // The survivor at `from` slides left into `to`; the hole swaps to `from`,
      // bubbling one step toward the tail. Swapping (not overwriting) keeps every
      // slot id unique within the frame — no duplicate React keys.
      const cells = m.cells.slice();
      const tmp = cells[e.to];
      cells[e.to] = cells[e.from];
      cells[e.from] = tmp;
      return { cells, nextId: m.nextId };
    }
    case 'arr.pop':
      return { cells: m.cells.slice(0, -1), nextId: m.nextId };
    // highlight-only: compare / result — no structural change.
    default:
      return m;
  }
}

/** A stored hash-set chip with a stable identity for animation. */
export interface Chip {
  readonly id: number;
  readonly value: number;
}

/** The hash set's display state: buckets of chains, plus the next free id. */
export interface HashModel {
  readonly buckets: readonly (readonly Chip[])[];
  readonly nextId: number;
}

/** Build the initial hash model from the structure's bucket snapshot. */
export function hashModel(buckets: readonly (readonly number[])[]): HashModel {
  let id = 0;
  const out = buckets.map((b) => b.map((value) => ({ id: id++, value })));
  return { buckets: out, nextId: id };
}

/** Fold one hash-set event into the model (insert / chain-remove / rehash). */
export function reduceHash(m: HashModel, e: HashSetEvent): HashModel {
  switch (e.kind) {
    case 'hs.insert': {
      const buckets = m.buckets.map((b, i) =>
        i === e.bucket ? [...b, { id: m.nextId, value: e.value }] : b,
      );
      return { buckets, nextId: m.nextId + 1 };
    }
    case 'hs.chainRemove': {
      const buckets = m.buckets.map((b, i) =>
        i === e.bucket ? b.filter((_, pos) => pos !== e.pos) : b,
      );
      return { buckets, nextId: m.nextId };
    }
    case 'hs.rehash': {
      // Redistribute by zipping current chips (old-iteration order: buckets by
      // index, chains front-to-back) with the event's per-key moves, so each
      // chip keeps its id as it relocates.
      const next: Chip[][] = Array.from({ length: e.newCap }, () => []);
      let i = 0;
      for (const bucket of m.buckets) {
        for (const chip of bucket) {
          const move = e.moves[i++];
          next[move.toBucket].push(chip);
        }
      }
      return { buckets: next, nextId: m.nextId };
    }
    // highlight-only: hash / probe / duplicate / result — no structural change.
    default:
      return m;
  }
}

/** Fold a whole event prefix into the model — the renderer's per-frame state. */
export function foldArray(initial: ArrayModel, events: readonly ArrayEvent[]): ArrayModel {
  return events.reduce(reduceArray, initial);
}

export function foldHash(initial: HashModel, events: readonly HashSetEvent[]): HashModel {
  return events.reduce(reduceHash, initial);
}

// ── Open-addressing hash set ────────────────────────────────────────────────
// One flat slot array. A live slot holds a {@link Chip} (stable id, so a rebuild can
// fly each key to its new slot); a deleted key's marker is the distinct `'tomb'` — it
// must never be drawn as empty, because the whole lesson is that a walk does not stop
// there. `oaSlotsOf` turns the model back into the twin's `slots()` notation, and
// `model.test.ts` pins the two equal after every op — and, through the corpus lines, to
// the Rust layout.

/** One drawn slot: a live key, a tombstone, or empty (`null`). */
export type OaSlot = Chip | 'tomb' | null;

/** The open-addressing set's display state: its slots in index order, plus the next free id. */
export interface OaModel {
  readonly slots: readonly OaSlot[];
  readonly nextId: number;
}

/** Build the model from the twin's `slots()` (`'.'` empty, `'x'` tombstone, else a key). */
export function oaModel(slots: readonly (number | '.' | 'x')[]): OaModel {
  let id = 0;
  const out = slots.map((s): OaSlot => (s === '.' ? null : s === 'x' ? 'tomb' : { id: id++, value: s }));
  return { slots: out, nextId: id };
}

/** The model in the twin's `slots()` notation — what the fold is checked against. */
export function oaSlotsOf(m: OaModel): (number | '.' | 'x')[] {
  return m.slots.map((s) => (s === null ? '.' : s === 'tomb' ? 'x' : s.value));
}

/** Fold one open-addressing event. `place` fills a slot (an empty one, or the tombstone
 * it reuses); `tombstone` marks a deleted slot; `rehash` rebuilds the table by zipping
 * the live chips, **in slot order**, with the event's moves — tombstones vanish. The walk
 * events (hash / probe / stop / duplicate / result) are highlight-only. */
export function reduceOa(m: OaModel, e: HashSetOaEvent): OaModel {
  switch (e.kind) {
    case 'hoa.place': {
      const slots = m.slots.slice();
      slots[e.slot] = { id: m.nextId, value: e.value };
      return { slots, nextId: m.nextId + 1 };
    }
    case 'hoa.tombstone': {
      const slots = m.slots.slice();
      slots[e.slot] = 'tomb';
      return { slots, nextId: m.nextId };
    }
    case 'hoa.rehash': {
      const slots: OaSlot[] = Array.from({ length: e.newCap }, () => null);
      let i = 0;
      for (const s of m.slots) {
        if (s === null || s === 'tomb') continue;
        slots[e.moves[i++].toSlot] = s;
      }
      return { slots, nextId: m.nextId };
    }
    default:
      return m;
  }
}

export function foldOa(initial: OaModel, events: readonly HashSetOaEvent[]): OaModel {
  return events.reduce(reduceOa, initial);
}

// ── Sorted array ────────────────────────────────────────────────────────────
// Reuses the {@link ArrayModel} shape (cells + holes + nextId); only the event
// vocabulary differs (binary-search compares, and an insert that opens a gap by
// shifting *right*). Build the initial model with {@link arrayModel}.

/** Fold one sorted-array event into the model (docs/PLAN.md §8 binary search +
 * shift insert/delete). `sarr.shift` swaps the slot with its neighbour either
 * way — right to open an insert gap, left to compact a delete — so the hole keeps
 * a unique id every frame (each prefix is renderable). */
export function reduceSortedArray(m: ArrayModel, e: SortedArrayEvent): ArrayModel {
  switch (e.kind) {
    case 'sarr.appendHole':
      return { cells: [...m.cells, { id: m.nextId, hole: true }], nextId: m.nextId + 1 };
    case 'sarr.shift': {
      const cells = m.cells.slice();
      const tmp = cells[e.to];
      cells[e.to] = cells[e.from];
      cells[e.from] = tmp;
      return { cells, nextId: m.nextId };
    }
    case 'sarr.fill': {
      // The hole resting at `index` becomes a real cell — reuse its id so the
      // value "drops into" the same slot rather than a new one appearing.
      const cells = m.cells.slice();
      cells[e.index] = { id: cells[e.index].id, value: e.value };
      return { cells, nextId: m.nextId };
    }
    case 'sarr.removeTarget': {
      const cells = m.cells.slice();
      cells[e.index] = { id: m.nextId, hole: true };
      return { cells, nextId: m.nextId + 1 };
    }
    case 'sarr.pop':
      return { cells: m.cells.slice(0, -1), nextId: m.nextId };
    // highlight-only: compare / result — no structural change.
    default:
      return m;
  }
}

export function foldSortedArray(initial: ArrayModel, events: readonly SortedArrayEvent[]): ArrayModel {
  return events.reduce(reduceSortedArray, initial);
}

// ── Linked list (singly / doubly) ───────────────────────────────────────────

/** A stored list node with a stable identity for animation. */
export interface ListNode {
  readonly id: number;
  readonly value: number;
}

/** The list's display state: nodes head-to-tail, plus the next free id. */
export interface LinkedListModel {
  readonly nodes: readonly ListNode[];
  readonly nextId: number;
}

/** Build the initial list model from the structure's head-to-tail keys. */
export function linkedModel(values: readonly number[]): LinkedListModel {
  return { nodes: values.map((value, id) => ({ id, value })), nextId: values.length };
}

/** Fold one linked-list event into the model. `ll.insertHead` prepends a fresh
 * node; `ll.unlink` drops the node at its position and the survivors slide
 * together. Visits/results are highlight-only. Shared by singly + doubly. */
export function reduceLinkedList(m: LinkedListModel, e: LinkedListEvent): LinkedListModel {
  switch (e.kind) {
    case 'll.insertHead':
      return { nodes: [{ id: m.nextId, value: e.value }, ...m.nodes], nextId: m.nextId + 1 };
    case 'll.unlink':
      return { nodes: m.nodes.filter((_, i) => i !== e.index), nextId: m.nextId };
    // highlight-only: visit / result — no structural change.
    default:
      return m;
  }
}

export function foldLinkedList(initial: LinkedListModel, events: readonly LinkedListEvent[]): LinkedListModel {
  return events.reduce(reduceLinkedList, initial);
}

// ── Doubly linked list ──────────────────────────────────────────────────────
// Unlike the singly model this one stores **real links** (by node id), because the
// doubly animation's subject is the pointer writes: mid-delete the removed node is
// still drawn, already bypassed by both of its neighbours, until `ll.unlink` drops it;
// mid-insert the new node is drawn before anything points at it. Deriving the arrows
// from display order (as the singly view does) would draw neither state. The fold is
// checked against the twin's own links after every op (`model.test.ts`), so the
// picture is the structure's, not a reconstruction.

/** A drawn doubly-list node: its links name other nodes' ids (`null` = ∅). */
export interface DoublyNode {
  readonly id: number;
  readonly value: number;
  readonly next: number | null;
  readonly prev: number | null;
}

/** Nodes in display order (op-start head→tail, plus a just-inserted head or a
 * not-yet-dropped removed node), the two handles (ids), and the next free id. */
export interface DoublyListModel {
  readonly nodes: readonly DoublyNode[];
  readonly head: number | null;
  readonly tail: number | null;
  readonly nextId: number;
}

/** Build the model from the twin's positional snapshot; ids start as positions. */
export function doublyModel(shape: DoublyShape): DoublyListModel {
  return {
    nodes: shape.values.map((value, id) => ({ id, value, next: shape.next[id], prev: shape.prev[id] })),
    head: shape.head,
    tail: shape.tail,
    nextId: shape.values.length,
  };
}

/** The model's links by display position — comparable to the twin's `snapshot()`. A
 * link to an id no longer drawn maps to `-1`, as the twin maps an unreachable slot. */
export function doublyShapeOf(m: DoublyListModel): DoublyShape {
  const pos = new Map(m.nodes.map((n, p) => [n.id, p] as const));
  const at = (id: number | null): number | null => (id === null ? null : (pos.get(id) ?? -1));
  return {
    values: m.nodes.map((n) => n.value),
    next: m.nodes.map((n) => at(n.next)),
    prev: m.nodes.map((n) => at(n.prev)),
    head: at(m.head),
    tail: at(m.tail),
  };
}

/** Fold one doubly-list event. `ll.insertHead` prepends an unlinked node; each
 * `dll.relink` writes one link (or handle) exactly as the event names it; `ll.unlink`
 * drops the node at that position — by then nothing points at it. Visits and results
 * are highlight-only. */
export function reduceDoublyList(m: DoublyListModel, e: DoublyListEvent): DoublyListModel {
  switch (e.kind) {
    case 'll.insertHead':
      return { ...m, nodes: [{ id: m.nextId, value: e.value, next: null, prev: null }, ...m.nodes], nextId: m.nextId + 1 };
    case 'dll.relink': {
      const to = e.to === null ? null : m.nodes[e.to].id;
      if (e.from === null) return e.link === 'next' ? { ...m, head: to } : { ...m, tail: to };
      const from = e.from;
      return { ...m, nodes: m.nodes.map((n, i) => (i === from ? { ...n, [e.link]: to } : n)) };
    }
    case 'll.unlink':
      return { ...m, nodes: m.nodes.filter((_, i) => i !== e.index) };
    default:
      return m;
  }
}

export function foldDoublyList(initial: DoublyListModel, events: readonly DoublyListEvent[]): DoublyListModel {
  return events.reduce(reduceDoublyList, initial);
}

/** Ids reachable from the head by following `next` (bounded, so a bad frame cannot
 * hang the view). A drawn node outside this set is *not in the list*: a new node no
 * handle points at yet, or a removed one its neighbours already skip. */
export function doublyReachable(m: DoublyListModel): ReadonlySet<number> {
  const byId = new Map(m.nodes.map((n) => [n.id, n] as const));
  const seen = new Set<number>();
  for (let cur = m.head; cur !== null && !seen.has(cur) && seen.size <= m.nodes.length; cur = byId.get(cur)?.next ?? null) {
    seen.add(cur);
  }
  return seen;
}

// ── Binary search tree (docs/PLAN.md §8, "Trees / heaps", unbalanced) ────────
// Nodes are addressed by a root path (`'L'|'R'[]`); each carries a stable `id` so
// the renderer can transition a node to its new (x, y) as siblings shift. The
// reducer is "dumb" — it applies the structural change the event already located,
// never re-running the search/compare logic (that lives in the teaching impl), so
// `foldBst(before, events)` mirrors the structure by construction (model.test.ts).

/** A stored tree node with a stable identity for animation. */
export interface BstDisplayNode {
  readonly id: number;
  readonly value: number;
  readonly left: BstDisplayNode | null;
  readonly right: BstDisplayNode | null;
}

/** The tree's display state: the root subtree plus the next free id. */
export interface BstModel {
  readonly root: BstDisplayNode | null;
  readonly nextId: number;
}

/** Build the initial tree model from the structure's shape snapshot, assigning a
 * fresh id to each node (pre-order — the order is irrelevant, only uniqueness is). */
export function bstModel(shape: BstShape | null): BstModel {
  let id = 0;
  const walk = (s: BstShape | null): BstDisplayNode | null =>
    s === null ? null : { id: id++, value: s.value, left: walk(s.left), right: walk(s.right) };
  const root = walk(shape);
  return { root, nextId: id };
}

/** Apply `edit` to the (possibly null) node reached by `path`, path-copying the
 * spine so the result is a fresh immutable tree sharing untouched subtrees. A `[]`
 * path edits the root; descending the final step into a null slot lets an insert
 * materialize a new child there. */
function editAtPath(
  node: BstDisplayNode | null,
  path: readonly BstStep[],
  edit: (target: BstDisplayNode | null) => BstDisplayNode | null,
): BstDisplayNode | null {
  if (path.length === 0) return edit(node);
  const [step, ...rest] = path;
  if (node === null) return node; // invalid path (never produced by a valid stream)
  return step === 'L'
    ? { ...node, left: editAtPath(node.left, rest, edit) }
    : { ...node, right: editAtPath(node.right, rest, edit) };
}

/** Fold one BST event into the model. Structural events (`insert`,
 * `replaceValue`, `remove`) edit the node at their path; `remove` always targets a
 * node with ≤1 child, so it splices in that child (or null). Compares / descends /
 * removeTarget / result are highlight-only (the view derives the highlight from the
 * active event). */
export function reduceBst(m: BstModel, e: BstEvent): BstModel {
  switch (e.kind) {
    case 'bst.insert': {
      const node: BstDisplayNode = { id: m.nextId, value: e.value, left: null, right: null };
      return { root: editAtPath(m.root, e.path, () => node), nextId: m.nextId + 1 };
    }
    case 'bst.replaceValue': {
      const root = editAtPath(m.root, e.path, (t) => (t === null ? null : { ...t, value: e.value }));
      return { root, nextId: m.nextId };
    }
    case 'bst.remove': {
      // The node at `path` has at most one child — replace it with that child (or
      // null). `left ?? right` picks whichever side is present.
      const root = editAtPath(m.root, e.path, (t) => (t === null ? null : t.left ?? t.right));
      return { root, nextId: m.nextId };
    }
    // highlight-only: compare / removeTarget / descend / result — no structural change.
    default:
      return m;
  }
}

export function foldBst(initial: BstModel, events: readonly BstEvent[]): BstModel {
  return events.reduce(reduceBst, initial);
}

/** Resolve a root path to the node it addresses in `model`, or `undefined` if the
 * path runs off the tree (defensive — the renderer highlights nothing then). Used
 * by {@link ./BstView} to turn a compare/descend event's path into a node to tint. */
export function bstNodeAtPath(model: BstModel, path: readonly BstStep[]): BstDisplayNode | undefined {
  let cur = model.root;
  for (const step of path) {
    if (cur === null) return undefined;
    cur = step === 'L' ? cur.left : cur.right;
  }
  return cur ?? undefined;
}

// ── AVL tree (docs/PLAN.md §8, "Trees / heaps", balanced) ────────────────────
// The AVL reuses the generic binary-tree display model (its node shape is identical
// to the BST's: `{ id, value, left, right }`) and the root-path addressing. The one
// extra reducer case is the **rotation**, which restructures the subtree at a path
// while preserving node ids — so the renderer animates each node sliding to its new
// place. The aliases below let `AvlView` read in AVL terms.

export type AvlDisplayNode = BstDisplayNode;
export type AvlModel = BstModel;
/** Build the initial AVL model from the structure's shape snapshot (= {@link bstModel}). */
export const avlModel = bstModel;
/** Resolve a root path to the node it addresses (= {@link bstNodeAtPath}). */
export const avlNodeAtPath = bstNodeAtPath;

/** Rotate the subtree rooted at `path` one step `dir`, **preserving every node's
 * id** (each node keeps its identity as it moves). A `right` rotation lifts the
 * pivot's left child into its place; a `left` rotation lifts the right child — exact
 * mirrors of the teaching impl's `rotateRight`/`rotateLeft`, so `foldAvl(before,
 * events)` reproduces the structure (model.test.ts). */
function rotateAtPath(
  node: BstDisplayNode | null,
  path: readonly BstStep[],
  dir: 'left' | 'right',
): BstDisplayNode | null {
  return editAtPath(node, path, (pivot) => {
    if (pivot === null) return null; // invalid path (never produced by a valid stream)
    if (dir === 'right') {
      const x = pivot.left!;
      // x rises to the pivot's slot; the pivot becomes x's right child, taking x's
      // old right subtree as its new left.
      return { ...x, right: { ...pivot, left: x.right } };
    }
    const y = pivot.right!;
    return { ...y, left: { ...pivot, right: y.left } };
  });
}

/** Fold one AVL event into the model. `insert`/`replaceValue`/`remove` mirror the
 * BST reducer; `rotate` restructures the pivot's subtree. Compares / descends /
 * removeTarget / result are highlight-only (the view derives the highlight from the
 * active event and the imbalance from the folded shape). */
export function reduceAvl(m: AvlModel, e: AvlEvent): AvlModel {
  switch (e.kind) {
    case 'avl.insert': {
      const node: BstDisplayNode = { id: m.nextId, value: e.value, left: null, right: null };
      return { root: editAtPath(m.root, e.path, () => node), nextId: m.nextId + 1 };
    }
    case 'avl.replaceValue': {
      const root = editAtPath(m.root, e.path, (t) => (t === null ? null : { ...t, value: e.value }));
      return { root, nextId: m.nextId };
    }
    case 'avl.remove': {
      const root = editAtPath(m.root, e.path, (t) => (t === null ? null : t.left ?? t.right));
      return { root, nextId: m.nextId };
    }
    case 'avl.rotate':
      return { root: rotateAtPath(m.root, e.path, e.dir), nextId: m.nextId };
    // highlight-only: compare / removeTarget / descend / result — no structural change.
    default:
      return m;
  }
}

export function foldAvl(initial: AvlModel, events: readonly AvlEvent[]): AvlModel {
  return events.reduce(reduceAvl, initial);
}

// ── Binary min-heap (docs/PLAN.md §8, "Trees / heaps") ───────────────────────
// Array-backed: the heap reuses the {@link ArrayModel} (cells + ids), and the view
// derives the implicit tree from the slot indices (child of `i` at `2i+1`/`2i+2`).
// `heap.swap` exchanges two cells (ids kept → animated); `heap.replaceRoot` drops
// the root and moves the last cell into its slot (extract-min's refill).

export type HeapModel = ArrayModel;
/** Build the initial heap model from the structure's backing array (= {@link arrayModel}). */
export const heapModel = (values: readonly number[]): HeapModel => arrayModel(values);

/** Fold one heap event into the model (append / swap / replaceRoot). The compares,
 * scans, peek, extractRoot, and result are highlight-only. */
export function reduceHeap(m: HeapModel, e: HeapEvent): HeapModel {
  switch (e.kind) {
    case 'heap.append':
      return { cells: [...m.cells, { id: m.nextId, value: e.value }], nextId: m.nextId + 1 };
    case 'heap.swap': {
      // Exchange the two cells in place (both keep their ids → the renderer animates
      // the swap in the array and the implicit tree).
      const cells = m.cells.slice();
      const tmp = cells[e.i];
      cells[e.i] = cells[e.j];
      cells[e.j] = tmp;
      return { cells, nextId: m.nextId };
    }
    case 'heap.replaceRoot': {
      // Drop the root; move the last cell into its slot (keeping the moved cell's id
      // so it flies from the tail to the root). A one-element heap just empties.
      if (m.cells.length <= 1) return { cells: [], nextId: m.nextId };
      const last = m.cells[m.cells.length - 1];
      return { cells: [last, ...m.cells.slice(1, -1)], nextId: m.nextId };
    }
    // highlight-only: compare / scan / extractRoot / peek / result — no structural change.
    default:
      return m;
  }
}

export function foldHeap(initial: HeapModel, events: readonly HeapEvent[]): HeapModel {
  return events.reduce(reduceHeap, initial);
}

// ── Trie (docs/PLAN.md §8, "Specialized") ───────────────────────────────────
// The only animated structure with *string* keys, and the only n-ary tree. Nodes
// are addressed by a path of UTF-8 **bytes** from the root (the trie's analog of
// the BST's `'L'|'R'` steps); `[]` is the root, which — unlike the BST's — always
// exists, even when the trie is empty. Children are kept in ascending byte order,
// matching both twins' iteration order, so the drawing reads left→right
// lexicographically.

/** A trie node in the display model: the byte on the edge that reaches it (`null`
 * only at the root), whether a stored key ends here, and its children in ascending
 * byte order. The `id` is stable across frames so the renderer can transition a
 * node as its siblings' subtree widths shift it sideways. */
export interface TrieDisplayNode {
  readonly id: number;
  readonly byte: number | null;
  readonly terminal: boolean;
  readonly children: readonly TrieDisplayNode[];
}

/** The trie's display state: the (always present) root plus the next free id. */
export interface TrieModel {
  readonly root: TrieDisplayNode;
  readonly nextId: number;
}

/** Build the initial trie model from the structure's shape snapshot, assigning a
 * fresh id to each node (pre-order — only uniqueness matters). */
export function trieModel(shape: TrieShape): TrieModel {
  let id = 0;
  const walk = (s: TrieShape): TrieDisplayNode => {
    const self = id++;
    return { id: self, byte: s.byte, terminal: s.terminal, children: s.children.map(walk) };
  };
  const root = walk(shape);
  return { root, nextId: id };
}

/** Apply `edit` to the node reached by the byte `path`, path-copying the spine so
 * untouched subtrees are shared. A `[]` path edits the root. A path step whose byte
 * has no child leaves the model untouched (defensive — a valid stream never
 * produces one). */
function editTrieAtPath(
  node: TrieDisplayNode,
  path: readonly number[],
  edit: (target: TrieDisplayNode) => TrieDisplayNode,
): TrieDisplayNode {
  if (path.length === 0) return edit(node);
  const [b, ...rest] = path;
  const i = node.children.findIndex((c) => c.byte === b);
  if (i === -1) return node; // invalid path (never produced by a valid stream)
  const children = node.children.slice();
  children[i] = editTrieAtPath(children[i], rest, edit);
  return { ...node, children };
}

/** Fold one trie event into the model. `create` materializes the child the walk
 * missed, `markTerminal`/`clearTerminal` flip the "a key ends here" flag, and
 * `prune` unlinks a node.
 *
 * **`prune` removes a child, never a subtree** — by construction the teaching impl
 * only emits it for a node left neither terminal nor a parent (the Rust twin's
 * `is_prunable`), deepest-first as the delete unwinds. Splicing a whole subtree
 * here would make the reducer silently accept a malformed stream instead of
 * mirroring the structure. Steps / enterRoot / result are highlight-only. */
export function reduceTrie(m: TrieModel, e: TrieEvent): TrieModel {
  switch (e.kind) {
    case 'trie.create': {
      // The new node's own path; its parent is `path[0..-1]`, its byte the last.
      const parent = e.path.slice(0, -1);
      const byte = e.path[e.path.length - 1];
      const child: TrieDisplayNode = { id: m.nextId, byte, terminal: false, children: [] };
      const root = editTrieAtPath(m.root, parent, (t) => ({
        ...t,
        // Splice in ascending byte order so the drawing stays lexicographic.
        children: [...t.children, child].sort((x, y) => (x.byte ?? -1) - (y.byte ?? -1)),
      }));
      return { root, nextId: m.nextId + 1 };
    }
    case 'trie.markTerminal':
      return { root: editTrieAtPath(m.root, e.path, (t) => ({ ...t, terminal: true })), nextId: m.nextId };
    case 'trie.clearTerminal':
      return { root: editTrieAtPath(m.root, e.path, (t) => ({ ...t, terminal: false })), nextId: m.nextId };
    case 'trie.prune': {
      const parent = e.path.slice(0, -1);
      const byte = e.path[e.path.length - 1];
      const root = editTrieAtPath(m.root, parent, (t) => ({
        ...t,
        children: t.children.filter((c) => c.byte !== byte),
      }));
      return { root, nextId: m.nextId };
    }
    // highlight-only: enterRoot / step / result — no structural change.
    default:
      return m;
  }
}

export function foldTrie(initial: TrieModel, events: readonly TrieEvent[]): TrieModel {
  return events.reduce(reduceTrie, initial);
}

/** Resolve a byte path to the node it addresses, or `undefined` if it runs off the
 * trie (defensive — the renderer then highlights nothing). Used by
 * {@link ./TrieView} to turn a step/create/prune event's path into a node to tint. */
export function trieNodeAtPath(m: TrieModel, path: readonly number[]): TrieDisplayNode | undefined {
  let cur: TrieDisplayNode | undefined = m.root;
  for (const b of path) {
    cur = cur.children.find((c) => c.byte === b);
    if (cur === undefined) return undefined;
  }
  return cur;
}

// ── Skip list (docs/PLAN.md §8, "Specialized") ───────────────────────────────
// A linked structure drawn as a grid: nodes left→right in ascending (level-0)
// order, each occupying `height` stacked lanes. The express lanes are NOT stored —
// they are **derived** from height + order (a correct skip list has a node on lane
// `i` iff its height > `i`), which is faithful because the teaching twin always
// builds a correct list, and cheaper than carrying per-level links. `skipLevelKeys`
// re-derives the lanes and `model.test.ts` pins it equal to `SkipListF64.levelKeys()`,
// tying the drawing to the express-lane dimension the conformance corpus guards (a
// mis-linked lane still answers every query correctly while being O(n)). Nodes are
// addressed by their level-0 index; the head sentinel is `-1` and is not stored.

/** A stored skip-list node in the display model: its key, its tower height (the
 * number of lanes it occupies), and a stable id so the renderer can transition it
 * sideways as an insert/delete shifts its neighbours. */
export interface SkipDisplayNode {
  readonly id: number;
  readonly value: number;
  readonly height: number;
}

/** The skip list's display state: nodes in ascending level-0 order, plus the next
 * free id. */
export interface SkipModel {
  readonly nodes: readonly SkipDisplayNode[];
  readonly nextId: number;
}

/** Build the initial skip model from the structure's snapshot (value + real tower
 * height per node, in level-0 order), assigning a fresh id to each node. */
export function skipModel(snapshot: readonly { value: number; height: number }[]): SkipModel {
  return {
    nodes: snapshot.map((s, id) => ({ id, value: s.value, height: s.height })),
    nextId: snapshot.length,
  };
}

/** Fold one skip-list event into the model. `insert` splices a new node at its
 * level-0 index; `remove` unlinks the node at its index. Enter / inspect / laneEnd /
 * removeTarget / result are highlight-only (the view derives the highlight from the
 * active event, and the express lanes from the folded heights + order). */
export function reduceSkip(m: SkipModel, e: SkipListEvent): SkipModel {
  switch (e.kind) {
    case 'skip.insert': {
      const node: SkipDisplayNode = { id: m.nextId, value: e.value, height: e.height };
      const nodes = [...m.nodes.slice(0, e.index), node, ...m.nodes.slice(e.index)];
      return { nodes, nextId: m.nextId + 1 };
    }
    case 'skip.remove':
      return { nodes: m.nodes.filter((_, i) => i !== e.index), nextId: m.nextId };
    // highlight-only: enter / inspect / laneEnd / removeTarget / result — no structural change.
    default:
      return m;
  }
}

export function foldSkip(initial: SkipModel, events: readonly SkipListEvent[]): SkipModel {
  return events.reduce(reduceSkip, initial);
}

/** The keys visible on each lane, level 0 first — derived from height + order, the
 * shape a correct skip list has. Mirrors `SkipListF64.levelKeys()`; `model.test.ts`
 * pins the two equal so the drawing is chained to the express-lane dimension the
 * conformance corpus guards. Used by {@link ./SkipListView} to lay out the lanes. */
export function skipLevelKeys(m: SkipModel): number[][] {
  const top = m.nodes.reduce((mx, n) => Math.max(mx, n.height), 0);
  const out: number[][] = [];
  for (let i = 0; i < top; i++) out.push(m.nodes.filter((n) => n.height > i).map((n) => n.value));
  return out;
}

// ── Graph (docs/PLAN.md §8, "Specialized") ───────────────────────────────────
// The graph is **static** during a traversal — BFS and DFS read it and change
// nothing — so the base model is built once from the edge list and only the
// traversal's state is folded: each vertex's mark, the frontier, the visit order,
// how many of each adjacency list's entries have been examined, and which edge
// discovered which vertex (the BFS / DFS tree).
//
// **Adjacency entries are tied to drawn edges by construction.** `incident[u][slot]`
// is the id of the edge behind entry `slot` of `adj[u]`, built by replaying
// `GraphAdj.addEdge`'s two pushes per edge in insertion order — so a parallel edge
// gets its own id per copy, and a self-loop's id appears **twice** in its vertex's
// list. That is what lets the view light the exact edge copy an examine pays for.
// `graphAdjacency` re-derives the neighbour lists from it and `model.test.ts` pins
// them equal to `GraphAdj.adjacency()` (the corpus's adjacency dimension), plus
// "every edge id appears exactly twice" — Σ deg = 2E, enforced in the drawing layer.

/** A vertex's traversal state. `marked` = on the frontier, not yet visited — in DFS
 * this is the mark-on-push state: a vertex is marked when *pushed*, long before it is
 * popped. `visited` = taken off the frontier and processed. */
export type GraphVertexState = 'unseen' | 'marked' | 'visited';

/** The graph's display state: the static structure plus the folded traversal. */
export interface GraphModel {
  readonly numVertices: number;
  /** Edge `k`'s endpoints, in insertion order (out-of-range pairs dropped, as
   * `addEdge` drops them). */
  readonly edges: readonly (readonly [number, number])[];
  /** `incident[u][slot]` = the edge id behind entry `slot` of `adj[u]`. */
  readonly incident: readonly (readonly number[])[];
  /** The traversal in progress, or `null` before `graph.start`. */
  readonly algo: GraphAlgo | null;
  readonly state: readonly GraphVertexState[];
  /** The frontier's live contents, insertion order: a BFS queue's front is index 0;
   * a DFS stack's top is the last element. */
  readonly frontier: readonly number[];
  /** Vertices in the order they were visited. */
  readonly order: readonly number[];
  /** The vertex being processed (the last one visited), or `null`. */
  readonly current: number | null;
  /** Per vertex: how many entries of its adjacency list have been examined. */
  readonly examined: readonly number[];
  /** Per edge: how many of its two adjacency entries have been examined (0..2). */
  readonly edgeHits: readonly number[];
  /** Per vertex: the edge whose examine discovered it (the traversal tree), or `null`
   * (the source, and anything not reached). */
  readonly discoveredBy: readonly (number | null)[];
  /** Running cost tallies — exactly the cost events folded so far. */
  readonly vertexVisits: number;
  readonly edgeVisits: number;
  /** True once `graph.done` has been folded. */
  readonly done: boolean;
}

/** Build the base graph model from a flat `[u0, v0, u1, v1, …]` edge buffer — the
 * same input and the same push order as `GraphAdj.fromEdges`. */
export function graphModel(numVertices: number, edgeBuffer: readonly number[]): GraphModel {
  const edges: (readonly [number, number])[] = [];
  const incident: number[][] = Array.from({ length: numVertices }, () => []);
  for (let i = 0; i + 1 < edgeBuffer.length; i += 2) {
    const u = edgeBuffer[i];
    const v = edgeBuffer[i + 1];
    if (u < 0 || v < 0 || u >= numVertices || v >= numVertices) continue;
    const k = edges.length;
    edges.push([u, v]);
    incident[u].push(k); // addEdge: adj[u].push(v)
    incident[v].push(k); //          adj[v].push(u) — a self-loop pushes onto adj[u] twice
  }
  return {
    numVertices,
    edges,
    incident,
    algo: null,
    state: Array.from({ length: numVertices }, (): GraphVertexState => 'unseen'),
    frontier: [],
    order: [],
    current: null,
    examined: Array.from({ length: numVertices }, () => 0),
    edgeHits: edges.map(() => 0),
    discoveredBy: Array.from({ length: numVertices }, (): number | null => null),
    vertexVisits: 0,
    edgeVisits: 0,
    done: false,
  };
}

/** The endpoint of edge `k` that is not `u` (for a self-loop, `u` itself). */
export function otherEnd(m: GraphModel, k: number, u: number): number {
  const [a, b] = m.edges[k];
  return a === u ? b : a;
}

/** The neighbour lists the model's `incident` table implies — mirrors
 * `GraphAdj.adjacency()`; `model.test.ts` pins the two equal. */
export function graphAdjacency(m: GraphModel): number[][] {
  return m.incident.map((ks, u) => ks.map((k) => otherEnd(m, k, u)));
}

const setAt = <T,>(xs: readonly T[], i: number, v: T): T[] => {
  const out = xs.slice();
  out[i] = v;
  return out;
};

/** Fold one graph event. `start` marks the source and seeds the frontier; `visit`
 * takes the frontier's out-end (BFS front / DFS top — `model.test.ts` pins that it is
 * the event's vertex at every visit); `examine` advances that list's cursor, counts
 * the edge copy, and records a discovering edge; `mark` marks + enqueues/pushes. */
export function reduceGraph(m: GraphModel, e: GraphEvent): GraphModel {
  switch (e.kind) {
    case 'graph.start':
      return {
        ...m,
        algo: e.algo,
        state: setAt(m.state, e.source, 'marked'),
        frontier: [e.source],
      };
    case 'graph.visit':
      return {
        ...m,
        frontier: e.algo === 'bfs' ? m.frontier.slice(1) : m.frontier.slice(0, -1),
        state: setAt(m.state, e.vertex, 'visited'),
        order: [...m.order, e.vertex],
        current: e.vertex,
        vertexVisits: m.vertexVisits + 1,
      };
    case 'graph.examine': {
      const k = m.incident[e.from][e.slot];
      return {
        ...m,
        examined: setAt(m.examined, e.from, e.slot + 1),
        edgeHits: setAt(m.edgeHits, k, m.edgeHits[k] + 1),
        discoveredBy: e.discovers ? setAt(m.discoveredBy, e.to, k) : m.discoveredBy,
        edgeVisits: m.edgeVisits + 1,
      };
    }
    case 'graph.mark':
      return { ...m, state: setAt(m.state, e.vertex, 'marked'), frontier: [...m.frontier, e.vertex] };
    case 'graph.done':
      return { ...m, done: true };
  }
}

export function foldGraph(initial: GraphModel, events: readonly GraphEvent[]): GraphModel {
  return events.reduce(reduceGraph, initial);
}
