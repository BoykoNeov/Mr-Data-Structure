import { useMemo, useRef, useState } from 'react';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { SortedArrayF64 } from '../structures/sortedArray';
import { LinkedListF64, SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { BstF64 } from '../structures/bst';
import { AvlF64 } from '../structures/avl';
import { MinHeapF64 } from '../structures/heap';
import { TrieStr } from '../structures/trie';
import { SkipListF64 } from '../structures/skipList';
import { GraphAdj } from '../structures/graph';
import { browserSession } from '../persist/session';
import type { ArrayEvent, HashSetEvent, SortedArrayEvent, LinkedListEvent, BstEvent, AvlEvent, HeapEvent, TrieEvent, SkipListEvent, GraphEvent, GraphAlgo } from './events';
import {
  arrayModel, foldArray, hashModel, foldHash, isHole, type ArrayModel, type HashModel,
  foldSortedArray, linkedModel, foldLinkedList, type LinkedListModel,
  bstModel, foldBst, type BstModel,
  avlModel, foldAvl, type AvlModel,
  heapModel, foldHeap, type HeapModel,
  trieModel, foldTrie, type TrieModel,
  skipModel, foldSkip, type SkipModel,
  graphModel, foldGraph, type GraphModel,
} from './model';
import * as P from './player';
import { usePlayer } from './usePlayer';
import { ArrayView } from './ArrayView';
import { HashSetView } from './HashSetView';
import { SortedArrayView } from './SortedArrayView';
import { LinkedListView } from './LinkedListView';
import { BstView } from './BstView';
import { AvlView } from './AvlView';
import { HeapView } from './HeapView';
import { TrieView, byteLabel } from './TrieView';
import { SkipListView } from './SkipListView';
import { GraphView } from './GraphView';
import { Controls, type OpSpec } from './Controls';

/**
 * The exploration panel (docs/PLAN.md §5): pick a structure, run insert / search
 * / delete on a key, and step through the resulting animation. Each op is run on
 * the teaching impl with a tracer; the emitted step-events feed the player, and
 * the renderer folds them into the per-frame picture (docs/PLAN.md §2.1 — the
 * user watches *exactly* the comparisons the benchmark counts).
 *
 * The animation base is recaptured from the structure's snapshot at the start of
 * each op, so `fold(base, events)` always equals the structure's real post-op
 * state (validated in `model.test.ts`).
 */

type Kind = 'array' | 'sorted' | 'singly' | 'doubly' | 'hashset' | 'bst' | 'avl' | 'heap' | 'trie' | 'skiplist' | 'graph';
const ARRAY_SEED = [42, 7, 88, 7, 23];
const SORTED_SEED = [12, 25, 37, 44, 58, 70];
// Inserted at the head, so the displayed head→tail order is [40, 30, 20, 10].
const LIST_SEED = [10, 20, 30, 40];
// Six keys → 8 buckets; one more distinct insert (e.g. 70) trips a rehash → 16.
const HASH_SEED = [10, 20, 30, 40, 50, 60];
// Root-first insertion order yields a balanced 3-level tree; inserting a sorted
// run (e.g. 90, 95, 99) then visibly degenerates it to a right-leaning chain.
const BST_SEED = [50, 30, 70, 20, 40, 60, 80];
// Same keys as the BST — but the AVL stays balanced; inserting a sorted run keeps it
// O(log n) (watch the rotations) where the BST tab degenerates to a chain.
const AVL_SEED = [50, 30, 70, 20, 40, 60, 80];
// Built by sifting each key up; the result is a valid min-heap (root = 10).
const HEAP_SEED = [50, 30, 70, 20, 40, 60, 10];
// Every key here is a teaching decision (docs/PLAN.md §5): `car`/`cart`/`cat` share
// a prefix, so a delete prunes *selectively* — deleting `cart` drops one node while
// `ca` survives on two other keys' paths; `car` is a **proper prefix** of `cart`, so
// searching `car` after deleting it walks the full depth and still misses (the
// terminal ring is the difference); `café` is multi-byte, so its `é` occupies TWO
// levels labelled `C3` / `A9` — the trie walks UTF-8 bytes, not characters, and
// that fact previously lived only in docstrings; and `dog` gives the root a second
// branch so the picture is a tree rather than a chain.
const TRIE_SEED = ['car', 'cart', 'cat', 'café', 'dog'];
// Each height here is a teaching decision, but an indirect one: a skip list's tower
// heights are a pure function of the keys (docs/PLAN.md §8 — a hash, not a coin), so
// this seed was chosen by computing them. It yields a four-lane staircase — `220` is a
// height-4 tower whose top lane skips straight from the head to the far right, while
// `10` and the two `50`s live only on level 0 — and the **duplicate 50** shows the
// multiset keeping equal keys in insertion order along the bottom lane. Change a key
// and the shape changes with it; that is the point of hash-derived heights.
const SKIP_SEED = [10, 30, 40, 50, 50, 90, 220, 270];
/**
 * The graph seed (docs/PLAN.md §5, §8). Every part is a teaching decision, and
 * `trace.graph.test.ts` pins each consequence by computing it from the twin:
 *  - **BFS and DFS visibly disagree on order** (BFS 0 3 1 5 2 6 4, DFS 0 5 6 4 2 1 3)
 *    while costing the same 27 — the headline.
 *  - **Mark-on-push DFS differs from textbook recursion** (which would go
 *    0 3 2 1 4 6 5), so the animation demonstrates the rule the twins actually run;
 *    when DFS pops 2 it meets 3 and 1 still *waiting on the stack* and skips them.
 *  - a **parallel 1–2 edge** (edges 4 and 8) and a **self-loop on 4** (edge 9): each
 *    is two adjacency entries, so each costs two edge-visits (Σ deg = 2E).
 *  - **vertex 7 is isolated**, so a traversal from 0 reaches 7 of 8 vertices and costs
 *    0's component's V′ + 2E′ = 7 + 20, not the whole graph's V + 2E = 28.
 * Ids are deliberately *not* numbered by BFS layer, so BFS order is not mistaken for
 * "ascending id order". The layout is hand-placed in columns by distance from 0
 * (0 | 3 1 5 | 2 6 | 4), with 7 set apart.
 */
export const GRAPH_SEED: {
  readonly vertices: number;
  readonly edges: readonly number[];
  readonly layout: readonly (readonly [number, number])[];
} = {
  vertices: 8,
  // edge k = pair k:  0–3  0–1  0–5  3–2  1–2  5–6  2–4  6–4  1–2 (parallel)  4–4 (loop)
  edges: [0, 3, 0, 1, 0, 5, 3, 2, 1, 2, 5, 6, 2, 4, 6, 4, 1, 2, 4, 4],
  layout: [
    [50, 140], // 0 — the default source
    [165, 140], // 1
    [290, 90], // 2
    [165, 50], // 3
    [400, 160], // 4 — carries the self-loop
    [165, 230], // 5
    [290, 225], // 6
    [400, 40], // 7 — isolated, set apart
  ],
};

type Op = 'search' | 'insert' | 'delete';
type HeapOp = 'insert' | 'extractMin' | 'peek' | 'search';
const HEAP_OPS: readonly OpSpec<HeapOp>[] = [
  { op: 'insert', label: 'insert' },
  { op: 'extractMin', label: 'extract-min', needsValue: false },
  { op: 'peek', label: 'peek', needsValue: false },
  { op: 'search', label: 'search' },
];

function describeArray(e: ArrayEvent | undefined, m: ArrayModel): string {
  if (!e) return '';
  switch (e.kind) {
    case 'arr.compare': {
      const slot = m.cells[e.index];
      const shown = slot && !isHole(slot) ? slot.value : '?';
      return `compare cell [${e.index}] (${shown}) vs ${e.target} → ${e.matched ? 'match ✓' : 'no match'}`;
    }
    case 'arr.append': return `append ${e.value} at the tail (O(1))`;
    case 'arr.removeTarget': return `found at [${e.index}] — now shift the tail left to close the gap`;
    case 'arr.shift': return `shift cell [${e.from}] → [${e.to}]`;
    case 'arr.pop': return 'drop the vacated tail slot';
    case 'arr.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeSortedArray(e: SortedArrayEvent | undefined, m: ArrayModel): string {
  if (!e) return '';
  switch (e.kind) {
    case 'sarr.compare': {
      const slot = m.cells[e.index];
      const shown = slot && !isHole(slot) ? slot.value : '?';
      const dir = e.matched
        ? 'match ✓'
        : typeof shown === 'number' && shown < e.target
          ? 'too small → search the right half'
          : 'too big → search the left half';
      return `binary search [${e.lo},${e.hi}): mid [${e.index}] = ${shown} vs ${e.target} → ${dir}`;
    }
    case 'sarr.appendHole': return 'open a slot at the tail to make room';
    case 'sarr.shift': return `shift cell [${e.from}] → [${e.to}]`;
    case 'sarr.fill': return `drop ${e.value} into the gap at [${e.index}]`;
    case 'sarr.removeTarget': return `found at [${e.index}] — now shift the tail left to close the gap`;
    case 'sarr.pop': return 'drop the vacated tail slot';
    case 'sarr.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeLinkedList(e: LinkedListEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'll.visit':
      return `visit node [${e.index}] (${e.value}) vs ${e.target} → ${e.matched ? 'match ✓' : 'follow next →'}`;
    case 'll.insertHead': return `insert ${e.value} at the head (O(1), no walk)`;
    case 'll.unlink': return `unlink node [${e.index}] — reconnect its neighbours`;
    case 'll.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeHash(e: HashSetEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'hs.hash': return `hash(${e.key}) → bucket [${e.bucket}]`;
    case 'hs.probe':
      return `probe bucket [${e.bucket}] pos ${e.pos} vs ${e.target} → ${e.matched ? 'match ✓' : 'no match'}`;
    case 'hs.insert': return `insert ${e.value} into bucket [${e.bucket}]`;
    case 'hs.duplicate': return 'already present → set keeps one copy (no insert)';
    case 'hs.chainRemove': return `remove from bucket [${e.bucket}] pos ${e.pos} (chain order preserved)`;
    case 'hs.rehash':
      return `rehash: ${e.oldCap} → ${e.newCap} buckets, redistribute ${e.moves.length} keys`;
    case 'hs.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeBst(e: BstEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'bst.compare': {
      const dir = e.dir === 'match' ? 'match ✓' : e.dir === 'left' ? 'smaller → go left' : '≥ → go right';
      return `compare ${e.target} vs node ${e.value} → ${dir}`;
    }
    case 'bst.insert': return e.path.length === 0 ? `insert ${e.value} as the root` : `insert ${e.value} as a new leaf`;
    case 'bst.removeTarget': return 'found the node to delete';
    case 'bst.descend': return 'walk to the in-order successor (smallest key in the right subtree)';
    case 'bst.replaceValue': return `copy the successor (${e.value}) up into the deleted node`;
    case 'bst.remove': return 'unlink the node (it has at most one child now)';
    case 'bst.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeAvl(e: AvlEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'avl.compare': {
      const dir = e.dir === 'match' ? 'match ✓' : e.dir === 'left' ? 'smaller → go left' : '≥ → go right';
      return `compare ${e.target} vs node ${e.value} → ${dir}`;
    }
    case 'avl.insert': return e.path.length === 0 ? `insert ${e.value} as the root` : `insert ${e.value} as a new leaf`;
    case 'avl.removeTarget': return 'found the node to delete';
    case 'avl.descend': return 'walk to the in-order successor (smallest key in the right subtree)';
    case 'avl.replaceValue': return `copy the successor (${e.value}) up into the deleted node`;
    case 'avl.remove': return 'unlink the node (it has at most one child now)';
    case 'avl.rotate': return `rotate ${e.dir} at ${e.value} — rebalance (this is the cost beyond a plain BST)`;
    case 'avl.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

function describeHeap(e: HeapEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'heap.append': return `append ${e.value} at the tail, then sift it up`;
    case 'heap.compare':
      return `compare [${e.a}] vs [${e.b}] → smaller is [${e.winner}]`;
    case 'heap.scan':
      return `scan [${e.index}] vs ${e.target} → ${e.matched ? 'match ✓' : 'no match (heaps have no search shortcut)'}`;
    case 'heap.swap': return `swap [${e.i}] ⇄ [${e.j}]`;
    case 'heap.extractRoot': return `extract the minimum (${e.value}) at the root`;
    case 'heap.replaceRoot': return 'move the last element to the root, then sift it down';
    case 'heap.peek': return `peek → minimum is ${e.value} (O(1), no change)`;
    case 'heap.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

/** Render a key's bytes the way the view labels its nodes, so a caption naming a
 * byte and the node it highlights read the same (`é` → `C3` `A9`). */
function describeTrie(e: TrieEvent | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'trie.enterRoot':
      return `walk "${e.key}" from the root — one char-step per UTF-8 byte`;
    case 'trie.step':
      if (e.hit) return `byte '${byteLabel(e.byte)}' → follow that child (one char-step)`;
      return e.creates
        ? `no child for '${byteLabel(e.byte)}' yet — the insert makes one and walks on`
        : `no child for '${byteLabel(e.byte)}' — the walk falls off here, so the key is absent`;
    case 'trie.create':
      return `create the node for '${byteLabel(e.path[e.path.length - 1])}' (the key extends the trie)`;
    case 'trie.markTerminal':
      return e.alreadyPresent
        ? 'a key already ends here → the set keeps one copy (no change)'
        : 'mark this node terminal — a stored key ends here';
    case 'trie.clearTerminal':
      return 'clear the terminal flag — no key ends here any more';
    case 'trie.prune':
      return `prune the node for '${byteLabel(e.path[e.path.length - 1])}' — nothing ends there and nothing hangs off it`;
    case 'trie.result':
      return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

/** The caption is op-agnostic — it reads the comparison's direction from the value vs
 * the target rather than being told which op is running, so `advance`/`stop` word
 * themselves correctly whether the descent used `<` (search/delete) or `≤` (insert).
 * An `advance` on an *equal* key can only be an insert (search/delete stop before the
 * first equal), so that branch says so rather than mislabelling it "smaller". Exported
 * for `VizPanel.test.ts` — a render smoke can't catch a wrong caption. */
export function describeSkip(e: SkipListEvent | undefined): string {
  if (!e) return '';
  const col = (i: number) => (i < 0 ? 'the head' : `node [${i}]`);
  switch (e.kind) {
    case 'skip.enter':
      return e.topLevel < 0
        ? `"${e.key}" — the list is empty, nothing to walk`
        : `start at the head on the top express lane (level ${e.topLevel})`;
    case 'skip.inspect': {
      const rel = e.value < e.target ? '<' : e.value > e.target ? '>' : '=';
      if (e.outcome === 'advance')
        return rel === '='
          ? `compare ${e.value} = ${e.target} → equal; an insert goes after the stored equals, so move right along level ${e.level}`
          : `compare ${e.value} < ${e.target} → smaller, move right along level ${e.level}`;
      if (e.outcome === 'stop')
        return e.level > 0
          ? `compare ${e.value} ${rel} ${e.target} → not smaller, drop to level ${e.level - 1}`
          : `compare ${e.value} ${rel} ${e.target} → not smaller; this is the candidate on the base list`;
      if (e.outcome === 'found')
        return `equality test on the same node: ${e.value} = ${e.target} → found ✓`;
      // notFound — the level-0 equality test on the node the descent stopped at
      return `equality test on the same node: ${e.value} ≠ ${e.target} → not found ✗`;
    }
    case 'skip.laneEnd':
      return e.level > 0
        ? `level ${e.level} ends after ${col(e.at)} — drop to level ${e.level - 1} (no comparison)`
        : `the base list ends after ${col(e.at)} — the key is not here (no comparison)`;
    case 'skip.insert':
      return `splice ${e.value} at position ${e.index} — its tower is ${e.height} level${e.height === 1 ? '' : 's'} tall (set by the key's hash, not a coin)`;
    case 'skip.removeTarget':
      return `found ${col(e.index)} — now unlink it from every level it occupies`;
    case 'skip.remove':
      return 'unlinked — the express lanes above it close up';
    case 'skip.result':
      return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

/**
 * The graph's step caption. It reads the folded model at the active frame, because
 * the honest wording of a skipped entry depends on *why* it is skipped: a neighbour
 * already **visited**, or one only **marked** — in DFS, marked on push and still
 * waiting on the stack, which is exactly where this traversal parts from textbook
 * recursion. Exported for `VizPanel.test.ts` (a render smoke can't catch a wrong
 * caption).
 */
export function describeGraph(e: GraphEvent | undefined, m: GraphModel): string {
  if (!e) return '';
  switch (e.kind) {
    case 'graph.start':
      return e.algo === 'bfs'
        ? `start at ${e.source}: mark it and put it in the queue (free — marking is not a visit)`
        : `start at ${e.source}: mark it and push it onto the stack (free — marking is not a visit)`;
    case 'graph.visit':
      return e.algo === 'bfs'
        ? `dequeue ${e.vertex} from the front of the queue and visit it — one vertex-visit`
        : `pop ${e.vertex} off the top of the stack and visit it — one vertex-visit`;
    case 'graph.examine': {
      const deg = m.incident[e.from]?.length ?? 0;
      const where = `entry ${e.slot + 1} of ${deg} in ${e.from}’s list`;
      if (e.to === e.from)
        return `${where} is ${e.from} itself — a self-loop sits in its own list twice, so it costs two edge-visits and leads nowhere new`;
      const copies = m.edges.filter(([a, b]) => (a === e.from && b === e.to) || (a === e.to && b === e.from)).length;
      const par = copies > 1 ? ` (one of ${copies} parallel ${e.from}–${e.to} edges — each copy is its own entry)` : '';
      if (e.discovers) return `${where}: ${e.to} is unmarked → discovered — one edge-visit${par}`;
      if (m.state[e.to] === 'visited') return `${where}: ${e.to} is already visited → skip, still one edge-visit${par}`;
      return m.algo === 'dfs'
        ? `${where}: ${e.to} is already marked — marked when it was pushed and still waiting on the stack, not yet visited — so it is not pushed again (recursive DFS would go there now). Still one edge-visit${par}`
        : `${where}: ${e.to} is already marked and waiting in the queue → not enqueued twice, still one edge-visit${par}`;
    }
    case 'graph.mark':
      return m.algo === 'dfs'
        ? `mark ${e.vertex} now, on push — before it is visited — and push it onto the stack (free)`
        : `mark ${e.vertex} and add it to the back of the queue (free)`;
    case 'graph.done': {
      const missed = m.numVertices - e.reached;
      return missed === 0
        ? `frontier empty — all ${e.reached} vertices reached`
        : `frontier empty — reached ${e.reached} of ${m.numVertices}; the ${missed === 1 ? 'other vertex is' : `other ${missed} are`} not connected to the start and cost nothing`;
    }
  }
}

/**
 * The graph's summary line after a traversal (docs/PLAN.md §8): the cost split into
 * its two counted parts, **both** traversals' orders and counts (the other one run
 * untraced), and — when the start's component is not the whole graph — the reached
 * count and why the total is `V′ + 2E′` rather than `V + 2E`. `E′` is counted here
 * independently, from the edges with both endpoints reached, so the `= V′ + 2E′`
 * claim is a check rather than a relabelling (pinned in `VizPanel.test.ts`).
 */
export function summarizeGraph(g: GraphAdj, m: GraphModel, source: number, ran: GraphAlgo): string {
  const bfs = g.bfs(source);
  const dfs = g.dfs(source);
  const first = ran === 'bfs' ? { name: 'BFS', t: bfs } : { name: 'DFS', t: dfs };
  const second = ran === 'bfs' ? { name: 'DFS', t: dfs } : { name: 'BFS', t: bfs };
  const reachedSet = new Set(first.t.order);
  const eReached = m.edges.filter(([a, b]) => reachedSet.has(a) && reachedSet.has(b)).length;
  const v = first.t.reached;
  const whole = v === m.numVertices;
  const formula = whole ? `V + 2E = ${v} + 2·${eReached}` : `V′ + 2E′ = ${v} + 2·${eReached}`;
  const orders = `${first.name} from ${source} → ${first.t.order.join(' ')} · ${second.name} from ${source} → ${second.t.order.join(' ')}`;
  const cost =
    bfs.ops === dfs.ops
      ? `the same ${bfs.ops} ops each (${v} vertex-visits + ${bfs.ops - v} edge-visits = ${formula})${bfs.order.join() === dfs.order.join() ? '' : ', in different orders'}`
      : `${first.name} ${first.t.ops} ops, ${second.name} ${second.t.ops} ops`;
  const total = m.numVertices + 2 * m.edges.length;
  const scope =
    whole
      ? `Reached all ${v} vertices, so this is the whole graph’s V + 2E.`
      : `Reached ${v} of ${m.numVertices} vertices: the rest are not connected to ${source} and cost nothing, so this is ${source}’s component, not the whole graph’s V + 2E = ${total}.`;
  return `${orders} — ${cost}. ${scope}`;
}

const GRAPH_OPS: readonly OpSpec<GraphAlgo>[] = [
  { op: 'bfs', label: 'BFS', needsValue: false },
  { op: 'dfs', label: 'DFS', needsValue: false },
];

function ArrayPanel() {
  const ref = useRef<DynArrayF64 | null>(null);
  if (ref.current === null) ref.current = DynArrayF64.fromKeys(ARRAY_SEED);
  const [base, setBase] = useState<ArrayModel>(() => arrayModel(ARRAY_SEED));
  const [summary, setSummary] = useState('');
  const player = usePlayer<ArrayEvent>();

  const onOp = (op: Op, value: number) => {
    const a = ref.current!;
    const snapshot = arrayModel(a.keysInOrder()); // before-state
    const events: ArrayEvent[] = [];
    const push = (e: ArrayEvent) => events.push(e);
    if (op === 'search') {
      const r = a.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons`);
    } else if (op === 'insert') {
      a.insert(value, push);
      setSummary(`insert(${value}) → appended (O(1), no comparisons)`);
    } else {
      const r = a.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} comparisons + shifts`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldArray(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Unsorted dynamic array — linear scan; delete is an ordered shift-compact.'}</p>
      <ArrayView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeArray(active, model)} />
    </>
  );
}

function HashPanel() {
  const ref = useRef<HashSetF64 | null>(null);
  if (ref.current === null) ref.current = HashSetF64.fromKeys(HASH_SEED);
  const [base, setBase] = useState<HashModel>(() => hashModel(HashSetF64.fromKeys(HASH_SEED).snapshotBuckets()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<HashSetEvent>();

  const onOp = (op: Op, value: number) => {
    const s = ref.current!;
    const snapshot = hashModel(s.snapshotBuckets()); // before-state
    const events: HashSetEvent[] = [];
    const push = (e: HashSetEvent) => events.push(e);
    if (op === 'search') {
      const r = s.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} ops (hash + chain-steps)`);
    } else if (op === 'insert') {
      s.insert(value, push);
      const rehashed = events.some((e) => e.kind === 'hs.rehash');
      setSummary(`insert(${value})${rehashed ? ' → triggered a rehash' : ''}`);
    } else {
      const r = s.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} ops (hash + chain-steps)`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldHash(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Separate-chaining hash set — hash to a bucket, walk the chain; load factor 0.75 triggers a rehash.'}</p>
      <HashSetView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeHash(active)} />
    </>
  );
}

// Exported for the render-smoke test (`views.render.test.ts`) — the browser gate
// only drives the default sweep tab, so mounting these panels is otherwise never
// exercised. Not part of the public UI surface; `VizPanel` is the entry point.
export function SortedPanel() {
  const ref = useRef<SortedArrayF64 | null>(null);
  if (ref.current === null) ref.current = SortedArrayF64.fromKeys(SORTED_SEED);
  const [base, setBase] = useState<ArrayModel>(() => arrayModel(SortedArrayF64.fromKeys(SORTED_SEED).keysInOrder()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<SortedArrayEvent>();

  const onOp = (op: Op, value: number) => {
    const a = ref.current!;
    const snapshot = arrayModel(a.keysInOrder()); // before-state
    const events: SortedArrayEvent[] = [];
    const push = (e: SortedArrayEvent) => events.push(e);
    if (op === 'search') {
      const r = a.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons (binary search)`);
    } else if (op === 'insert') {
      const r = a.insert(value, push);
      setSummary(`insert(${value}) → placed in order · ${r.ops} comparisons + shifts`);
    } else {
      const r = a.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} comparisons + shifts`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldSortedArray(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Sorted array — binary search (O(log n)); insert/delete shift the tail to keep it ordered.'}</p>
      <SortedArrayView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeSortedArray(active, model)} />
    </>
  );
}

export function LinkedPanel({ doubly }: { readonly doubly: boolean }) {
  const List = doubly ? DoublyLinkedListF64 : SinglyLinkedListF64;
  const ref = useRef<LinkedListF64 | null>(null);
  if (ref.current === null) ref.current = List.fromKeys(LIST_SEED);
  const [base, setBase] = useState<LinkedListModel>(() => linkedModel(List.fromKeys(LIST_SEED).keysInOrder()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<LinkedListEvent>();

  const onOp = (op: Op, value: number) => {
    const l = ref.current!;
    const snapshot = linkedModel(l.keysInOrder()); // before-state
    const events: LinkedListEvent[] = [];
    const push = (e: LinkedListEvent) => events.push(e);
    if (op === 'search') {
      const r = l.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} node-visits`);
    } else if (op === 'insert') {
      l.insert(value, push);
      setSummary(`insert(${value}) → spliced at the head (O(1), no walk)`);
    } else {
      const r = l.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} node-visits`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldLinkedList(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);
  const kind = doubly ? 'Doubly' : 'Singly';

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || `${kind} linked list — O(1) head insert; search/delete walk the chain (node-visits).`}</p>
      <LinkedListView model={model} active={active} doubly={doubly} />
      <Controls player={player} onOp={onOp} caption={describeLinkedList(active)} />
    </>
  );
}

export function BstPanel() {
  const ref = useRef<BstF64 | null>(null);
  if (ref.current === null) ref.current = BstF64.fromKeys(BST_SEED);
  const [base, setBase] = useState<BstModel>(() => bstModel(BstF64.fromKeys(BST_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<BstEvent>();

  const onOp = (op: Op, value: number) => {
    const t = ref.current!;
    const snapshot = bstModel(t.snapshot()); // before-state
    const events: BstEvent[] = [];
    const push = (e: BstEvent) => events.push(e);
    if (op === 'search') {
      const r = t.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons`);
    } else if (op === 'insert') {
      const r = t.insert(value, push);
      setSummary(`insert(${value}) → placed · ${r.ops} comparisons`);
    } else {
      const r = t.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} comparisons`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldBst(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Unbalanced BST — go left if smaller, right if ≥; insert a sorted run to watch it degenerate to O(n).'}</p>
      <BstView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeBst(active)} />
    </>
  );
}

export function AvlPanel() {
  const ref = useRef<AvlF64 | null>(null);
  if (ref.current === null) ref.current = AvlF64.fromKeys(AVL_SEED);
  const [base, setBase] = useState<AvlModel>(() => avlModel(AvlF64.fromKeys(AVL_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<AvlEvent>();

  const onOp = (op: Op, value: number) => {
    const t = ref.current!;
    const snapshot = avlModel(t.snapshot()); // before-state
    const events: AvlEvent[] = [];
    const push = (e: AvlEvent) => events.push(e);
    if (op === 'search') {
      const r = t.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons`);
    } else if (op === 'insert') {
      const r = t.insert(value, push);
      const rot = events.filter((e) => e.kind === 'avl.rotate').length;
      setSummary(`insert(${value}) → placed · ${r.ops} ops (comparisons${rot ? ` + ${rot} rotation${rot > 1 ? 's' : ''}` : ''})`);
    } else {
      const r = t.delete(value, push);
      const rot = events.filter((e) => e.kind === 'avl.rotate').length;
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} ops (comparisons${rot ? ` + ${rot} rotation${rot > 1 ? 's' : ''}` : ''})`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldAvl(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Balanced AVL — same ordering as the BST, but it rotates to stay O(log n). Insert a sorted run and watch the balance factors and rotations (the BST tab degenerates instead).'}</p>
      <AvlView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeAvl(active)} />
    </>
  );
}

export function HeapPanel() {
  const ref = useRef<MinHeapF64 | null>(null);
  if (ref.current === null) ref.current = MinHeapF64.fromKeys(HEAP_SEED);
  const [base, setBase] = useState<HeapModel>(() => heapModel(MinHeapF64.fromKeys(HEAP_SEED).toArray()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<HeapEvent>();

  const onOp = (op: HeapOp, value: number) => {
    const h = ref.current!;
    const snapshot = heapModel(h.toArray()); // before-state
    const events: HeapEvent[] = [];
    const push = (e: HeapEvent) => events.push(e);
    if (op === 'search') {
      const r = h.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons (O(n) scan — a heap is not a search structure)`);
    } else if (op === 'insert') {
      const r = h.insert(value, push);
      setSummary(`insert(${value}) → sifted up · ${r.ops} ops (comparisons + swaps)`);
    } else if (op === 'peek') {
      const r = h.peek(push);
      setSummary(r.min === undefined ? 'peek → heap is empty' : `peek → minimum is ${r.min} (O(1))`);
    } else {
      const r = h.extractMin(push);
      setSummary(r.min === undefined ? 'extract-min → heap is empty' : `extract-min → ${r.min} · ${r.ops} ops (comparisons + swaps to sift down)`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldHeap(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Binary min-heap — insert / peek / extract-min (a different op set). The array and the tree are the same data; search is an O(n) scan, shown as a contrast.'}</p>
      <HeapView model={model} active={active} />
      <Controls<HeapEvent, HeapOp> player={player} onOp={onOp} caption={describeHeap(active)} ops={HEAP_OPS} />
    </>
  );
}

export function TriePanel() {
  const ref = useRef<TrieStr | null>(null);
  if (ref.current === null) ref.current = TrieStr.fromKeys(TRIE_SEED);
  const [base, setBase] = useState<TrieModel>(() => trieModel(TrieStr.fromKeys(TRIE_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<TrieEvent>();

  const onOp = (op: Op, key: string) => {
    const t = ref.current!;
    const snapshot = trieModel(t.snapshot()); // before-state
    const events: TrieEvent[] = [];
    const push = (e: TrieEvent) => events.push(e);
    if (op === 'search') {
      const r = t.search(key, push);
      // A walk that never fell off but still missed is the trie's own trap: the key
      // is a *proper prefix* of a stored one. Say so rather than let "not found"
      // after a full-depth walk look like a bug.
      const fellOff = events.some((e) => e.kind === 'trie.step' && !e.hit);
      const prefix = !r.found && !fellOff ? ' — the walk reached the last node, but no key ends there (a proper prefix is not a key)' : '';
      setSummary(`search("${key}") → ${r.found ? 'found' : 'not found'} · ${r.ops} char-steps${prefix}`);
    } else if (op === 'insert') {
      const r = t.insert(key, push);
      const created = events.filter((e) => e.kind === 'trie.create').length;
      const dup = events.some((e) => e.kind === 'trie.markTerminal' && e.alreadyPresent);
      setSummary(
        `insert("${key}") → ${dup ? 'already present (set semantics)' : `${created} new node${created === 1 ? '' : 's'}`} · ${r.ops} char-steps`,
      );
    } else {
      const r = t.delete(key, push);
      const pruned = events.filter((e) => e.kind === 'trie.prune').length;
      setSummary(
        `delete("${key}") → ${r.found ? `removed, ${pruned} node${pruned === 1 ? '' : 's'} pruned` : 'absent'} · ${r.ops} char-steps`,
      );
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldTrie(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>
        {summary ||
          'Trie (prefix tree) — string keys, one node per UTF-8 byte (café is five levels: the é is C3 A9). Cost is char-steps: the root plus one per byte looked up, so it depends on the key length and not at all on how many keys are stored. The inner ring marks a node where a stored key ends — try search("car"), then delete("car") and search it again.'}
      </p>
      <TrieView model={model} active={active} />
      <Controls<TrieEvent, Op>
        player={player}
        keyKind="string"
        onOp={onOp}
        caption={describeTrie(active)}
      />
    </>
  );
}

export function SkipListPanel() {
  const ref = useRef<SkipListF64 | null>(null);
  if (ref.current === null) ref.current = SkipListF64.fromKeys(SKIP_SEED);
  const [base, setBase] = useState<SkipModel>(() => skipModel(SkipListF64.fromKeys(SKIP_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<SkipListEvent>();

  const onOp = (op: Op, value: number) => {
    const s = ref.current!;
    const snapshot = skipModel(s.snapshot()); // before-state
    const events: SkipListEvent[] = [];
    const push = (e: SkipListEvent) => events.push(e);
    if (op === 'search') {
      const r = s.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} node-visits`);
    } else if (op === 'insert') {
      const r = s.insert(value, push);
      const ins = events.find((e) => e.kind === 'skip.insert');
      const h = ins && ins.kind === 'skip.insert' ? ins.height : 1;
      setSummary(`insert(${value}) → tower height ${h} · ${r.ops} node-visits (the link surgery is free)`);
    } else {
      const r = s.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${r.ops} node-visits`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldSkip(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>
        {summary ||
          'Skip list — a sorted linked list (level 0) with hash-built express lanes above it, so search is O(log n) with nothing to rebalance. Each tower’s height comes from its key’s hash, not a coin, so the shape is a pure function of the keys. Its cost is uneven: a search past the largest key (try 999) rides the top lane and is its cheapest query, while a mid-range miss (try 100) pays about one comparison per level — half a benchmark’s absent probes land in the cheap end (docs/METHODOLOGY.md §4).'}
      </p>
      <SkipListView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeSkip(active)} />
    </>
  );
}

export function GraphPanel() {
  const ref = useRef<GraphAdj | null>(null);
  if (ref.current === null) ref.current = GraphAdj.fromEdges(GRAPH_SEED.edges, GRAPH_SEED.vertices);
  // The graph is static (the op set here is traversal only), so the base never changes.
  const base = useMemo(() => graphModel(GRAPH_SEED.vertices, GRAPH_SEED.edges), []);
  const intro = useMemo(() => {
    const g = GraphAdj.fromEdges(GRAPH_SEED.edges, GRAPH_SEED.vertices);
    const b = g.bfs(0);
    const d = g.dfs(0);
    return `From 0, BFS visits ${b.order.join(' ')} and DFS ${d.order.join(' ')} — ${b.ops} and ${d.ops} ops.`;
  }, []);
  const [summary, setSummary] = useState('');
  const player = usePlayer<GraphEvent>();

  const onOp = (op: GraphAlgo, value: number) => {
    const g = ref.current!;
    // A source must be a real vertex id: `adjLists[1.5]` is undefined (PLAN §10 trap 3).
    if (!Number.isInteger(value) || value < 0 || value >= g.numVertices()) {
      setSummary(`no vertex ${value} — the vertices are 0 to ${g.numVertices() - 1} (leave the box blank to start at 0)`);
      player.loadEvents([]);
      return;
    }
    const events: GraphEvent[] = [];
    const push = (e: GraphEvent) => events.push(e);
    if (op === 'bfs') g.bfs(value, push);
    else g.dfs(value, push);
    setSummary(summarizeGraph(g, base, value, op));
    player.loadEvents(events);
  };

  const model = useMemo(() => foldGraph(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>
        <strong>BFS and DFS cost the same V + 2E and visit in different orders.</strong>{' '}
        {summary ||
          `Graph — an undirected adjacency list that keeps parallel edges and self-loops; its op set is a whole-graph traversal, not insert/search/delete. The cost is one vertex-visit per vertex taken off the frontier (a queue for BFS, a stack for DFS) plus one edge-visit per adjacency entry examined. DFS here marks a vertex when it is pushed — not when it is popped, and not by recursion — so watch it skip edges to vertices still waiting on the stack. This graph has a parallel 1–2 edge and a self-loop on 4 (two entries each), and vertex 7 is not connected to 0. ${intro} Run BFS or DFS (blank box = start at 0, or type a start vertex).`}
      </p>
      <GraphView model={model} active={active} layout={GRAPH_SEED.layout} />
      <Controls<GraphEvent, GraphAlgo> player={player} onOp={onOp} caption={describeGraph(active, model)} ops={GRAPH_OPS} placeholder="start vertex" enterOp="bfs" />
    </>
  );
}

const tab = (selected: boolean): React.CSSProperties => ({
  padding: '6px 14px', fontSize: 14, cursor: 'pointer', borderRadius: 6,
  border: '1px solid ' + (selected ? '#4a90d9' : '#ccc'),
  background: selected ? '#e7f1ff' : '#fff', fontWeight: selected ? 600 : 400,
});

const TABS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: 'array', label: 'dynamic array' },
  { kind: 'sorted', label: 'sorted array' },
  { kind: 'singly', label: 'singly linked list' },
  { kind: 'doubly', label: 'doubly linked list' },
  { kind: 'hashset', label: 'hash set' },
  { kind: 'bst', label: 'binary search tree' },
  { kind: 'avl', label: 'AVL tree' },
  { kind: 'heap', label: 'min-heap' },
  { kind: 'trie', label: 'trie (text keys)' },
  { kind: 'skiplist', label: 'skip list' },
  { kind: 'graph', label: 'graph (BFS / DFS)' },
];

function panelFor(kind: Kind) {
  switch (kind) {
    case 'array': return <ArrayPanel />;
    case 'sorted': return <SortedPanel />;
    // distinct keys force a remount between the two lists so the ref re-seeds.
    case 'singly': return <LinkedPanel key="singly" doubly={false} />;
    case 'doubly': return <LinkedPanel key="doubly" doubly />;
    case 'hashset': return <HashPanel />;
    case 'bst': return <BstPanel />;
    case 'avl': return <AvlPanel />;
    case 'heap': return <HeapPanel />;
    case 'trie': return <TriePanel />;
    case 'skiplist': return <SkipListPanel />;
    case 'graph': return <GraphPanel />;
  }
}

/** Whether a stored string names a real Explore tab — the saved tab is checked against {@link TABS} itself. */
export function isExploreKind(k: string): k is Kind {
  return TABS.some((t) => t.kind === k);
}

export function VizPanel() {
  // The selected tab is remembered on this browser (docs/PLAN.md §13); 'array' when nothing is saved.
  const [kind, setKind] = useState<Kind>(() => browserSession().exploreTab(isExploreKind) ?? 'array');
  return (
    <section style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.kind} style={tab(kind === t.kind)} onClick={() => { setKind(t.kind); browserSession().saveExploreTab(t.kind); }}>
            {t.label}
          </button>
        ))}
      </div>
      {panelFor(kind)}
    </section>
  );
}
