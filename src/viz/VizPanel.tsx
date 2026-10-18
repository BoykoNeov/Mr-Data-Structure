import { useMemo, useRef, useState } from 'react';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { HashSetOaF64 } from '../structures/hashSetOa';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { BstF64 } from '../structures/bst';
import { AvlF64 } from '../structures/avl';
import { RbtF64 } from '../structures/rbt';
import { BTreeF64 } from '../structures/btree';
import { MinHeapF64 } from '../structures/heap';
import { TrieStr } from '../structures/trie';
import { SkipListF64 } from '../structures/skipList';
import { GraphAdj } from '../structures/graph';
import { DynArrayStr } from '../structures/dynArrayStr';
import { HashSetStr } from '../structures/hashSetStr';
import { browserSession } from '../persist/session';
import type { ArrayEvent, HashSetEvent, HashSetOaEvent, SortedArrayEvent, LinkedListEvent, DoublyListEvent, BstEvent, AvlEvent, RbtEvent, BstStep, BTreeEvent, HeapEvent, TrieEvent, SkipListEvent, GraphEvent, GraphAlgo } from './events';
import {
  arrayModel, foldArray, hashModel, foldHash, isHole, type ArrayModel, type HashModel,
  oaModel, foldOa, type OaModel,
  foldSortedArray, linkedModel, foldLinkedList, type LinkedListModel,
  doublyModel, foldDoublyList, type DoublyListModel,
  bstModel, foldBst, type BstModel,
  avlModel, foldAvl, type AvlModel,
  rbtModel, foldRbt, rbtNodeAtPath, type RbtModel,
  btreeModel, foldBTree, type BTreeModel,
  heapModel, foldHeap, type HeapModel,
  trieModel, foldTrie, type TrieModel,
  skipModel, foldSkip, type SkipModel,
  graphModel, foldGraph, type GraphModel,
} from './model';
import * as P from './player';
import { usePlayer } from './usePlayer';
import { ArrayView } from './ArrayView';
import { HashSetView } from './HashSetView';
import { OpenAddressingView } from './OpenAddressingView';
import { SortedArrayView } from './SortedArrayView';
import { LinkedListView } from './LinkedListView';
import { DoublyListView } from './DoublyListView';
import { BstView } from './BstView';
import { AvlView } from './AvlView';
import { RbtView } from './RbtView';
import { BTreeView } from './BTreeView';
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

type Kind = 'array' | 'sorted' | 'singly' | 'doubly' | 'hashset' | 'hashoa' | 'bst' | 'avl' | 'rbt' | 'btree' | 'heap' | 'trie' | 'skiplist' | 'graph'
  | 'arraystr' | 'hashstr';
const ARRAY_SEED = [42, 7, 88, 7, 23];
const SORTED_SEED = [12, 25, 37, 44, 58, 70];
// Inserted at the head, so the displayed head→tail order is [40, 30, 20, 10].
const LIST_SEED = [10, 20, 30, 40];
// Six keys → 8 buckets; one more distinct insert (e.g. 70) trips a rehash → 16.
const HASH_SEED = [10, 20, 30, 40, 50, 60];
// The open-addressing tab reuses HASH_SEED on purpose: the same hash, start size and 0.75
// threshold give the same 8 slots and the same rehash point (a 7th distinct key → 16), so
// the two tabs compare key for key (docs/METHODOLOGY.md §2.8). With these keys 30, 40, 50
// and 60 all hash to slot 5, so linear probing spills them into 6, 7 and round to 0 — one
// run that wraps the end of the table, where chaining keeps one bucket of four. A miss
// homed at 6 (55) is caught in that run and pays 4 to chaining's 1 — primary clustering;
// and deleting 40 leaves a tombstone that search(60) must step over, still paying 5.
// `trace.hoa.test.ts` pins each of those numbers by computing them from the twin.
export const OA_SEED: readonly number[] = HASH_SEED;
export const OA_INTRO =
  'Open-addressing hash set (linear probing) — the same keys, hash and 8 slots as the hash set tab, but one flat array: a key whose home slot is taken goes to the next free slot, wrapping from the end to slot 0. Here 30, 40, 50 and 60 all hash to slot 5, so they fill 5, 6, 7 and wrap round to 0. Try search(55): its home is slot 6, so it is caught in that run and pays 4, where the chaining table pays 1. Then delete(40) and search(60) again: it still pays 5, because the deleted slot became a tombstone the walk must step over — emptying it would cut 60 off. Cost is hashes + slot probes; the empty slot that ends a walk is free.';
// Root-first insertion order yields a balanced 3-level tree; inserting a sorted
// run (e.g. 90, 95, 99) then visibly degenerates it to a right-leaning chain.
const BST_SEED = [50, 30, 70, 20, 40, 60, 80];
// Same keys as the BST — but the AVL stays balanced; inserting a sorted run keeps it
// O(log n) (watch the rotations) where the BST tab degenerates to a chain.
const AVL_SEED = [50, 30, 70, 20, 40, 60, 80];
// The red-black tab reuses AVL_SEED so the two balanced trees compare key for key. Its
// colours: 50, 30 and 70 black, the four leaves red — so any first insert meets a red
// parent with a red uncle (three recolours, no rotation). The intro's numbers are computed
// from the twins and pinned in `trace.rbt.test.ts`: the sorted run 90, 95, 99 costs both
// trees 3, 5, 5 ops while this one also makes 10 recolours (free in the count); and
// deleting 20, 40, then 30 removes a black leaf, so its path is one black short and the
// fix-up runs on an empty (NIL) child. Nothing here claims fewer rotations than the AVL —
// the scheme's promise is a per-operation bound (docs/METHODOLOGY.md §2.9).
export const RBT_SEED: readonly number[] = AVL_SEED;
export const RBT_INTRO =
  'Red-black tree — the AVL tab’s ordering and keys, balanced by colour instead of height: no red node may have a red child, and every path down has the same number of black nodes. It pays the AVL’s metric, comparisons + rotations; colour changes are tallied on their own and are not in the ops. Its promise is a bound per operation — at most 2 rotations per insert and 3 per delete — not fewer rotations overall. Insert 90, 95, 99: both tabs pay 3, 5, 5 ops, and this tree also makes 10 recolours. To watch the delete fix-up, delete 20, 40 and then 30: removing a black leaf leaves its path one black short.';
// The B-tree tab draws nodes of minimum degree 3 (at most 5 keys) so the tree fits on
// screen; the benchmark's nodes hold up to 31 (t = 16). Same algorithm, same counting —
// the corpus covers t = 2, 3 and 16. The seed was chosen by computing it: the root holds
// 30, 60, 75 over four leaves, one of them full and one at the minimum, so
//  - search(60) finds 60 in the root and still walks on to a leaf: 5 comparisons in only
//    2 nodes — the deferred equality test, and the hops the op-count cannot see;
//  - insert(33) lands in the full leaf and splits it;
//  - delete(70) leaves its leaf short and borrows from the left sibling; then delete(85)
//    and delete(90) leave the last leaf short with no sibling to spare a key, so it merges.
// `trace.btree.test.ts` pins each of those. No sentence here compares its op-count with
// the AVL's: its comparisons should match a binary tree's; its saving is node hops.
export const BTREE_EXPLORE_T = 3;
export const BTREE_SEED: readonly number[] = [30, 10, 50, 70, 20, 90, 40, 60, 80, 15, 25, 35, 45, 55, 65, 75, 85];
export const BTREE_INTRO =
  'B-tree — wide nodes that each hold several sorted keys (at most 5 here, so the tree fits on screen; the benchmark’s hold 31 — the same algorithm, counted the same way). A lookup binary-searches inside each node and drops to one child, and every leaf sits at the same depth. It never stops early on a match in an inner node: it remembers the best candidate and makes one equality test at the leaf. Try search(60): 60 is in the root, yet the walk goes on to a leaf — 5 comparisons in 2 nodes. The nodes visited are shown beside the count because fewer node hops are the B-tree’s real saving, and the op-count cannot see them. Insert 33 to split a full leaf; delete 70 to borrow a key from a sibling, then delete 85 and 90 to merge two leaves.';

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
/**
 * The text-key array and hash set share one seed (docs/PLAN.md §5, §8): the trie's
 * five keys plus `ant`, so the three text tabs compare key for key. It was chosen by
 * computing the benchmark's string hash, not guessed, and is the corpus's `explore`
 * case (`conformance/corpus-str.txt`), so every number the intros quote is also a
 * Rust-generated line — and `trace.str.test.ts` / `VizPanel.test.ts` pin each one:
 *  - six distinct keys settle the set at **8 buckets** (a 4th key doubles 4 → 8), so
 *    one more distinct key doubles it to 16, as on the number tab;
 *  - two buckets are shared: **car + ant** (equal byte lengths, so the chain-step
 *    compares bytes) and **café + dog** (5 bytes vs 3, rejected on length alone);
 *  - `cafe` (4 bytes) is a different byte sequence from `café` (5 — é is `C3 A9`) and
 *    hashes to `cat`'s bucket — a miss that pays a chain-step — while `ca` hashes to an empty bucket and pays only
 *    the hash; in the array the same `cafe` scans all six (café is 5 bytes, cafe 4);
 *  - `owl` hashes to car + ant's bucket, so its insert walks both, and as the 7th key
 *    it doubles the table: car and ant part, café and dog stay together (they agree
 *    on the extra hash bit), which is why growth shortens chains on average only.
 * Change a key and these facts move with it; that is the point of computing them.
 */
export const TEXT_SEED: readonly string[] = ['car', 'cart', 'cat', 'café', 'dog', 'ant'];
export const ARRAY_STR_INTRO =
  'Dynamic array of text keys — the number array’s algorithm on strings, with the trie tab’s keys plus ant: a scan from the front, one comparison per key examined (a whole-key test, not one per letter), and delete shifts the tail left. Rust’s == on two strings checks their byte lengths first, so a key of another length is rejected without reading a letter — cheaper on the clock, the same one comparison in the count. Try search("dog"): 5 comparisons. Then search("cafe"): it looks like café, but é is two bytes in UTF-8 (café is 5 bytes, cafe 4), so it misses after all 6. delete("cart") costs 2 comparisons + 4 shifts.';
export const HASH_STR_INTRO =
  'Hash set of text keys — the number hash set’s algorithm on strings, with the benchmark’s own string hash (FNV-1a over the UTF-8 bytes, then the same mixer) and the same 4-bucket start, 0.75 load limit and doubling. The six keys settle into 8 buckets, two of them shared: car with ant, café with dog. The hash is one op however long the key — it reads every byte, but is counted once. Try search("dog"): the hash + 2 chain-steps = 3. search("cafe") lands in a different bucket from café (é is two bytes, so cafe is a different byte sequence and gets an unrelated hash): 2. search("ca") finds an empty bucket: 1, just the hash. insert("owl") walks car and ant (3 ops) and, as the 7th key, doubles the table to 16 — not counted — where car and ant part but café and dog stay together.';
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

/**
 * The doubly list's step caption (docs/METHODOLOGY.md §2.11). It reads the folded model
 * at the active frame to name the nodes a pointer write connects, and names the node a
 * write steps past when there is exactly one (a delete's bypass). Every pointer write is
 * narrated as free and every visit as the singly list's own walk, because the honest
 * claim is that the back link changes *which* pointers get written, not how many nodes a
 * delete has to visit. Exported for `VizPanel.test.ts` — a render smoke can't catch a
 * wrong caption.
 */
export function describeDoubly(e: DoublyListEvent | undefined, m: DoublyListModel): string {
  if (!e) return '';
  const node = (i: number) => `node [${i}] (${m.nodes[i]?.value ?? '?'})`;
  switch (e.kind) {
    case 'll.visit':
      return `visit node [${e.index}] (${e.value}) vs ${e.target} → ${e.matched ? 'match ✓' : 'follow next →'} — one node-visit, the same walk a singly list makes`;
    case 'll.insertHead':
      return `create a node for ${e.value} — nothing points at it yet`;
    case 'dll.relink': {
      const owner = e.from === null ? (e.link === 'next' ? 'head' : 'tail') : `${node(e.from)}.${e.link}`;
      const target = e.to === null ? '∅' : node(e.to);
      // positions strictly between the write's two ends, in display order
      const [lo, hi] = e.link === 'next' ? [e.from ?? -1, e.to ?? m.nodes.length] : [e.to ?? -1, e.from ?? m.nodes.length];
      const past = hi - lo === 2 ? `, stepping past ${node(lo + 1)}` : '';
      return `${owner} → ${target}${past} — a pointer write: free, not a node-visit`;
    }
    case 'll.unlink':
      return `nothing points at node [${e.index}] any more — drop it. prev spared the walk from carrying the node behind it; finding the node took exactly the visits a singly list takes`;
    case 'll.result':
      return e.found ? 'result: found ✓' : 'result: not found ✗';
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

const utf8 = new TextEncoder();
/** A key's UTF-8 byte length — what Rust's string `==` checks first. Never JS
 * `.length` (UTF-16 units): `"café".length` and `"cafe".length` are both 4, but the
 * keys are 5 and 4 bytes, and that difference is the whole comparison. */
export const byteLength = (s: string): number => utf8.encode(s).length;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Did this whole-key comparison end on Rust's byte-length check (no byte read)? */
export const rejectedOnLength = (stored: string, target: string): boolean => byteLength(stored) !== byteLength(target);

/**
 * One whole-key comparison, worded the way Rust's `==` on string slices runs it
 * (CLAUDE.md, the string probe gotcha): byte lengths first, bytes only if they agree.
 * Either way it is **one** comparison in the count — the per-byte detail is free
 * narration of what that one comparison does on the clock, never a cost of its own.
 * When the keys have the same number of characters but not the same number of bytes
 * (café vs cafe) it says so, because that is the case JS `.length` would hide.
 */
function compareText(stored: string, target: string, matched: boolean): string {
  const bs = byteLength(stored);
  const bt = byteLength(target);
  if (matched) return `"${stored}" = "${target}" → same ${bs}-byte length, so the bytes are compared: match ✓ (one comparison)`;
  if (bs !== bt) {
    const chars = [...stored].length === [...target].length ? ` — both ${[...stored].length} characters, but not the same number of UTF-8 bytes` : '';
    return `"${stored}" (${plural(bs, 'byte')}) vs "${target}" (${plural(bt, 'byte')}) → no match: the byte lengths differ, so Rust’s == answers before reading a byte${chars} — still one comparison`;
  }
  return `"${stored}" vs "${target}" → same ${bs}-byte length, so the bytes are compared until they differ: no match (one comparison)`;
}

/** The text-key array's step caption (docs/PLAN.md §5, §8). It reads the folded model
 * for the compared cell's key, so the length-first wording uses the real stored text.
 * Exported for `VizPanel.test.ts`. */
export function describeArrayStr(e: ArrayEvent<string> | undefined, m: ArrayModel<string>): string {
  if (!e) return '';
  switch (e.kind) {
    case 'arr.compare': {
      const slot = m.cells[e.index];
      if (!slot || isHole(slot)) return `compare cell [${e.index}] vs "${e.target}"`;
      return `cell [${e.index}]: ${compareText(slot.value, e.target, e.matched)}`;
    }
    case 'arr.append': return `append "${e.value}" at the tail (O(1), no comparisons — duplicates are kept)`;
    case 'arr.removeTarget': return `found at [${e.index}] — now shift the tail left to close the gap`;
    case 'arr.shift': return `shift cell [${e.from}] → [${e.to}] (one shift — in the ops, not a comparison)`;
    case 'arr.pop': return 'drop the vacated tail slot';
    case 'arr.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

/** The text-key hash set's step caption (docs/PLAN.md §5, §8). The hash is narrated as
 * one op that reads every byte; a chain-step as one whole-key comparison, length-first;
 * a rehash as one more hash bit per key, uncounted. Exported for `VizPanel.test.ts`. */
export function describeHashStr(e: HashSetEvent<string> | undefined, m: HashModel<string>): string {
  if (!e) return '';
  switch (e.kind) {
    case 'hs.hash':
      return `hash("${e.key}") → bucket [${e.bucket}] — one op, though FNV-1a reads all ${plural(byteLength(e.key), 'byte')} of the key`;
    case 'hs.probe': {
      const chip = m.buckets[e.bucket]?.[e.pos];
      const what = chip ? compareText(chip.value, e.target, e.matched) : `vs "${e.target}"`;
      return `bucket [${e.bucket}] pos ${e.pos}: ${what} — one chain-step`;
    }
    case 'hs.insert': return `insert "${e.value}" at the end of bucket [${e.bucket}]’s chain`;
    case 'hs.duplicate': return 'already present → the set keeps one copy (no insert)';
    case 'hs.chainRemove': return `remove from bucket [${e.bucket}] pos ${e.pos} (chain order preserved)`;
    case 'hs.rehash':
      return `rehash: ${e.oldCap} → ${e.newCap} buckets, redistribute ${plural(e.moves.length, 'key')} — each key’s bucket now reads one more bit of its hash, so keys that agree on that bit stay together (not counted)`;
    case 'hs.result': return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
}

/**
 * The open-addressing step caption (docs/METHODOLOGY.md §2.8). It reads the folded model
 * for the capacity, so a probe at the last slot can say the walk wraps to slot 0. Two
 * wordings are the point and are pinned in `VizPanel.test.ts`: stepping over a tombstone
 * keeps walking and is still one probe, and the empty slot that stops a walk is free.
 * Nothing here says where in a run a key sits relative to when it was inserted — a
 * rebuild re-places keys in old-slot order, so a run's order is not insertion order.
 */
export function describeOa(e: HashSetOaEvent | undefined, m: OaModel): string {
  if (!e) return '';
  const cap = m.slots.length;
  const next = (s: number) => (s + 1 === cap ? `wraps round to [0]` : `[${s + 1}]`);
  switch (e.kind) {
    case 'hoa.hash':
      return `hash(${e.key}) → home slot [${e.home}] (one op: the hash)`;
    case 'hoa.probe':
      if (e.state === 'tomb') {
        const remember = e.reuse === e.slot ? ` — and remember it: if ${e.target} turns out to be absent, the insert reuses this slot` : '';
        return `slot [${e.slot}] is a tombstone (a deleted key’s marker) — it cannot match, but the walk must not stop here or a key stored past it would be lost; keep walking, still one probe${remember}`;
      }
      return e.matched
        ? `slot [${e.slot}] holds ${e.value} = ${e.target} → match ✓ (one probe)`
        : `slot [${e.slot}] holds ${e.value} ≠ ${e.target} → taken, keep walking: next ${next(e.slot)} (one probe)`;
    case 'hoa.stop':
      return e.reuse === null
        ? `slot [${e.slot}] is empty → the walk stops: the key is absent (free — an empty slot costs nothing, like the end of a chain)`
        : `slot [${e.slot}] is empty → the key is absent (free), so it goes back to the tombstone it remembered at [${e.reuse}]`;
    case 'hoa.place':
      return e.reused
        ? `store ${e.value} in slot [${e.slot}], reusing the tombstone — no tombstone is left behind for later walks to step over`
        : `store ${e.value} in the empty slot [${e.slot}]`;
    case 'hoa.duplicate':
      return 'already present → the set keeps one copy (no insert)';
    case 'hoa.tombstone':
      return `leave a tombstone in slot [${e.slot}] — emptying it would cut off every key stored past it in this run`;
    case 'hoa.rehash': {
      const used = `${e.live} live + ${e.tombs} tombstone${e.tombs === 1 ? '' : 's'} passed ${(e.oldCap * 3) / 4} of ${e.oldCap} slots`;
      return e.newCap === e.oldCap
        ? `${used} → rebuild at the same size, clearing every tombstone (the live keys fit in half the limit, so no doubling). Re-placing the keys is not counted`
        : `${used} → double to ${e.newCap} slots and re-place every live key; tombstones are dropped. Re-placing the keys is not counted`;
    }
    case 'hoa.result':
      return e.found ? 'result: found ✓' : 'result: not found ✗';
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

const otherWay = (side: 'left' | 'right') => (side === 'left' ? 'right' : 'left');

/**
 * The red-black step caption (docs/METHODOLOGY.md §2.9). It reads the folded model to
 * name the nodes a fix-up case talks about (and, for the delete's empty "double black"
 * child, which node it hangs from). Every recolour is narrated as outside the ops, and no
 * caption says the tree rotates less than the AVL — its promise is a per-operation bound.
 * Exported for `VizPanel.test.ts`.
 */
export function describeRbt(e: RbtEvent | undefined, m: RbtModel): string {
  if (!e) return '';
  const val = (path: readonly BstStep[] | null) => (path === null ? '?' : (rbtNodeAtPath(m, path)?.value ?? null));
  const name = (path: readonly BstStep[] | null) => {
    const v = val(path);
    return v === null ? 'an empty (NIL, black) child' : String(v);
  };
  switch (e.kind) {
    case 'rbt.compare': {
      const dir = e.dir === 'match' ? 'match ✓' : e.dir === 'left' ? 'smaller → go left' : '≥ → go right';
      return `compare ${e.target} vs node ${e.value} → ${dir}`;
    }
    case 'rbt.insert':
      return e.path.length === 0
        ? `insert ${e.value} as the root — born red; the root is painted black at the end`
        : `insert ${e.value} as a new red leaf — new nodes are born red, which is not a recolour`;
    case 'rbt.removeTarget':
      return 'found the node to delete';
    case 'rbt.descend':
      return 'walk to the in-order successor (smallest key in the right subtree) — pointer-following, free';
    case 'rbt.replaceValue':
      return `copy the successor (${e.value}) up into the deleted node — it keeps its colour; the successor’s node is the one that leaves`;
    case 'rbt.remove':
      return e.black
        ? `unlink ${e.value} — it was black, so every path through here is now one black short: the delete fix-up repairs that`
        : `unlink ${e.value} — it was red, so no path loses a black: nothing to fix`;
    case 'rbt.rotate':
      return `rotate ${e.dir} at ${e.value} — one rotation, counted in the ops as in the AVL`;
    case 'rbt.recolour':
      return `paint ${e.value} ${e.red ? 'red' : 'black'} — a recolour: tallied on its own, not in the ops (the AVL has no colour to pay for)`;
    case 'rbt.fixCase': {
      const x = e.nil ? `the empty (NIL) ${e.side} child of ${name(e.at.slice(0, -1))}` : name(e.at);
      const o = name(e.other);
      const blackUncle = val(e.other) === null ? 'the uncle is an empty (NIL) child, which counts as black' : `the uncle ${o} is black`;
      switch (e.case) {
        case 'redUncle':
          return `fix-up: ${x} and its parent are both red, and the uncle ${o} is red too → paint the parent and uncle black and the grandparent red, then check two levels up`;
        case 'innerChild':
          return `fix-up: ${x} and its parent are both red, ${blackUncle}, and ${x} is the inner child → rotate the parent ${e.side} first, to straighten the line`;
        case 'outerChild':
          return `fix-up: ${x}, its red parent and its grandparent are in a straight line and ${blackUncle} → paint the parent black and the grandparent red, then rotate the grandparent ${otherWay(e.side)} — done`;
        case 'redSibling':
          return `fix-up: ${x} is one black short and its sibling ${o} is red → swap the sibling’s and the parent’s colours and rotate the parent ${e.side}, so ${x} gets a black sibling`;
        case 'blackNephews':
          return `fix-up: ${x} is one black short; its sibling ${o} and both of the sibling’s children are black → paint ${o} red, which takes a black off that side too, and move the shortfall up to the parent`;
        case 'nearNephewRed':
          return `fix-up: ${x} is one black short and only the sibling ${o}’s near child is red → rotate ${o} ${otherWay(e.side)} so the red child moves to the far side`;
        case 'farNephewRed':
          return `fix-up: ${x} is one black short and the sibling ${o}’s far child is red → the sibling takes the parent’s colour, the parent and that child go black, and the parent rotates ${e.side} — the missing black is restored; done`;
        case 'redX':
          return `fix-up: ${x} is red → paint it black, and the missing black is back`;
      }
      break;
    }
    case 'rbt.result':
      return e.found ? 'result: found ✓' : 'result: not found ✗';
  }
  return '';
}

/**
 * The B-tree step caption (docs/METHODOLOGY.md §2.10). It reads the folded model for the
 * root a collapse leaves behind. The wordings that matter, pinned in `VizPanel.test.ts`:
 * an inner-node match does not stop the walk, a walk with no candidate is absent with no
 * equality test, key moves are free, and the repair runs bottom-up only on underflow (not
 * CLRS's pre-fill). Exported for `VizPanel.test.ts`.
 */
export function describeBTree(e: BTreeEvent | undefined, m: BTreeModel): string {
  if (!e) return '';
  switch (e.kind) {
    case 'btree.probe': {
      const dir =
        e.bound === 'lower'
          ? e.right
            ? `${e.value} < ${e.target} → look right of it`
            : `${e.value} ≥ ${e.target} → look left, keeping ${e.value} in view`
          : e.right
            ? e.value === e.target
              ? `${e.value} = ${e.target} → an insert goes after its equals, so look right`
              : `${e.value} < ${e.target} → look right of it`
            : `${e.value} > ${e.target} → look left of it`;
      return `binary search inside the node: ${dir} (one comparison)`;
    }
    case 'btree.descend':
      if (e.leaf)
        return e.candidate === null
          ? 'reached the leaf, and no key on the whole path was ≥ the target → absent, no equality test needed'
          : `reached the leaf — the walk always ends here; now one equality test on the remembered ${e.candidate}`;
      return e.fresh
        ? `remember ${e.candidate} as the candidate and go down to child ${e.index + 1} — even a key equal to the target does not stop the walk; it goes on to a leaf and tests once there (free: choosing a child is not a comparison)`
        : `go down to child ${e.index + 1}${e.candidate === null ? '' : `, still carrying ${e.candidate}`} (free: choosing a child is not a comparison)`;
    case 'btree.check':
      return `equality test: ${e.candidate} ${e.found ? '=' : '≠'} ${e.target} → ${e.found ? 'found ✓' : 'not found ✗'} — the one comparison the deferral costs`;
    case 'btree.growRoot':
      return 'the root is full: grow a new empty root above it (free) — the tree only ever gets taller at the top, which keeps every leaf at one depth';
    case 'btree.split':
      return `split the full node: its middle key ${e.median} moves up into the parent and the keys above it move to a new right sibling (one structural op)`;
    case 'btree.medianCompare':
      return `compare ${e.target} vs the lifted ${e.median} → continue in the ${e.right ? 'right' : 'left'} half (one comparison)`;
    case 'btree.insertKey':
      return `place ${e.value} in the leaf at slot ${e.index + 1} (free — moving keys inside a node is not counted)`;
    case 'btree.removeKey':
      return 'remove the key from its leaf (free — a key move, not a comparison)';
    case 'btree.replaceWithPred':
      return `the key sits in an inner node: overwrite it with ${e.value}, the last key of the leaf the walk ended in — its in-order predecessor (a key move, free)`;
    case 'btree.borrow':
      return `that node is now below its minimum, so it borrows one key from its ${e.from} sibling through the parent (one structural op) — a borrow ends the repair`;
    case 'btree.merge':
      return 'that node is now below its minimum and its sibling has no key to spare → merge the two, pulling their separating key down from the parent (one structural op); the parent may now be short in turn, so the repair moves up';
    case 'btree.collapseRoot':
      return m.root === null
        ? 'the root has no keys left → remove it; the tree is empty (free)'
        : 'the root has no keys left → remove it; its only child is the new root, one level shorter everywhere (free)';
    case 'btree.result':
      return `${e.found ? 'result: found ✓' : 'result: not found ✗'} · ${e.nodeVisits} node${e.nodeVisits === 1 ? '' : 's'} visited (not in the op-count)`;
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

/** How many of a stream's comparisons ended on Rust's byte-length check — free
 * narration for the summary line, already inside the comparison count. */
function lengthRejects(events: readonly (ArrayEvent<string> | HashSetEvent<string>)[], keyAt: (e: ArrayEvent<string> | HashSetEvent<string>) => string | undefined): number {
  let n = 0;
  for (const e of events) {
    if ((e.kind === 'arr.compare' || e.kind === 'hs.probe') && !e.matched) {
      const stored = keyAt(e);
      if (stored !== undefined && rejectedOnLength(stored, e.target)) n += 1;
    }
  }
  return n;
}

const lengthNote = (n: number) => (n === 0 ? '' : ` (${n} of them settled by the byte-length check alone)`);

export function ArrayStrPanel() {
  const ref = useRef<DynArrayStr | null>(null);
  if (ref.current === null) ref.current = DynArrayStr.fromKeys(TEXT_SEED);
  const [base, setBase] = useState<ArrayModel<string>>(() => arrayModel(TEXT_SEED));
  const [summary, setSummary] = useState('');
  const player = usePlayer<ArrayEvent<string>>();

  const onOp = (op: Op, key: string) => {
    const a = ref.current!;
    const before = a.keysInOrder();
    const snapshot = arrayModel(before); // before-state
    const events: ArrayEvent<string>[] = [];
    const push = (e: ArrayEvent<string>) => events.push(e);
    // A compare only ever reads a cell the delete has not shifted yet, so the
    // before-state names the compared key.
    const rejects = () => lengthRejects(events, (e) => (e.kind === 'arr.compare' ? before[e.index] : undefined));
    if (op === 'search') {
      const r = a.search(key, push);
      setSummary(`search("${key}") → ${r.found ? 'found' : 'not found'} · ${plural(r.ops, 'comparison')}${lengthNote(rejects())}`);
    } else if (op === 'insert') {
      a.insert(key, push);
      setSummary(`insert("${key}") → appended (O(1), no comparisons; duplicates are kept)`);
    } else {
      const r = a.delete(key, push);
      const shifts = events.filter((e) => e.kind === 'arr.shift').length;
      setSummary(
        r.removed
          ? `delete("${key}") → removed · ${r.ops} ops = ${plural(r.ops - shifts, 'comparison')} + ${plural(shifts, 'shift')}`
          : `delete("${key}") → absent · ${plural(r.ops, 'comparison')}${lengthNote(rejects())}`,
      );
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldArray(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || ARRAY_STR_INTRO}</p>
      <ArrayView model={model} active={active} />
      <Controls<ArrayEvent<string>, Op> player={player} keyKind="string" onOp={onOp} caption={describeArrayStr(active, model)} />
    </>
  );
}

export function HashStrPanel() {
  const ref = useRef<HashSetStr | null>(null);
  if (ref.current === null) ref.current = HashSetStr.fromKeys(TEXT_SEED);
  const [base, setBase] = useState<HashModel<string>>(() => hashModel(HashSetStr.fromKeys(TEXT_SEED).snapshotBuckets()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<HashSetEvent<string>>();

  const onOp = (op: Op, key: string) => {
    const s = ref.current!;
    const before = s.snapshotBuckets();
    const snapshot = hashModel(before); // before-state
    const events: HashSetEvent<string>[] = [];
    const push = (e: HashSetEvent<string>) => events.push(e);
    // Every probe precedes any structural change in its op, so the before-state
    // names the probed key.
    const rejects = () => lengthRejects(events, (e) => (e.kind === 'hs.probe' ? before[e.bucket]?.[e.pos] : undefined));
    const cost = (ops: number) => `${ops} ops (the hash + ${plural(ops - 1, 'chain-step')})${lengthNote(rejects())}`;
    if (op === 'search') {
      const r = s.search(key, push);
      setSummary(`search("${key}") → ${r.found ? 'found' : 'not found'} · ${cost(r.ops)}`);
    } else if (op === 'insert') {
      const r = s.insert(key, push);
      const ins = events.find((e) => e.kind === 'hs.insert');
      const rehash = events.find((e) => e.kind === 'hs.rehash');
      const where = ins && ins.kind === 'hs.insert' ? `stored in bucket [${ins.bucket}]` : 'already present (set semantics)';
      const grew = rehash && rehash.kind === 'hs.rehash' ? ` → then doubled to ${rehash.newCap} buckets (the redistribution is not counted)` : '';
      setSummary(`insert("${key}") → ${where}${grew} · ${cost(r.ops)}`);
    } else {
      const r = s.delete(key, push);
      setSummary(`delete("${key}") → ${r.removed ? 'removed' : 'absent'} · ${cost(r.ops)}`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldHash(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || HASH_STR_INTRO}</p>
      <HashSetView model={model} active={active} />
      <Controls<HashSetEvent<string>, Op> player={player} keyKind="string" onOp={onOp} caption={describeHashStr(active, model)} />
    </>
  );
}

export function OpenAddressingPanel() {
  const ref = useRef<HashSetOaF64 | null>(null);
  if (ref.current === null) ref.current = HashSetOaF64.fromKeys(OA_SEED);
  const [base, setBase] = useState<OaModel>(() => oaModel(HashSetOaF64.fromKeys(OA_SEED).slots()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<HashSetOaEvent>();

  const onOp = (op: Op, value: number) => {
    const s = ref.current!;
    const snapshot = oaModel(s.slots()); // before-state
    const events: HashSetOaEvent[] = [];
    const push = (e: HashSetOaEvent) => events.push(e);
    const probes = (ops: number) => `${ops} ops (the hash + ${ops - 1} slot probe${ops === 2 ? '' : 's'})`;
    if (op === 'search') {
      const r = s.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${probes(r.ops)}`);
    } else if (op === 'insert') {
      const r = s.insert(value, push);
      const place = events.find((e) => e.kind === 'hoa.place');
      const rehash = events.find((e) => e.kind === 'hoa.rehash');
      const where =
        place && place.kind === 'hoa.place'
          ? `stored in slot [${place.slot}]${place.reused ? ', reusing a tombstone' : ''}`
          : 'already present (set semantics)';
      const rebuilt =
        rehash && rehash.kind === 'hoa.rehash'
          ? rehash.newCap === rehash.oldCap
            ? ' → then rebuilt at the same size to clear the tombstones'
            : ` → then doubled to ${rehash.newCap} slots`
          : '';
      setSummary(`insert(${value}) → ${where}${rebuilt} · ${probes(r.ops)}`);
    } else {
      const r = s.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed, its slot is now a tombstone' : 'absent'} · ${probes(r.ops)}`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldOa(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || OA_INTRO}</p>
      <OpenAddressingView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeOa(active, model)} />
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

export function LinkedPanel() {
  const ref = useRef<SinglyLinkedListF64 | null>(null);
  if (ref.current === null) ref.current = SinglyLinkedListF64.fromKeys(LIST_SEED);
  const [base, setBase] = useState<LinkedListModel>(() => linkedModel(SinglyLinkedListF64.fromKeys(LIST_SEED).keysInOrder()));
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

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || 'Singly linked list — O(1) head insert; search/delete walk the chain (node-visits).'}</p>
      <LinkedListView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeLinkedList(active)} />
    </>
  );
}

/** The doubly list's intro (docs/METHODOLOGY.md §2.11) — exported so its claim is pinned. */
export const DOUBLY_INTRO =
  'Doubly linked list — every node links both ways (next above, prev below). The back link lets a delete unlink the node it found without carrying the node behind it, but finding that node is the same walk from the head, so search and delete cost exactly the singly list’s node-visits. What the back link does cost is an extra pointer write on every insert and delete — the blue steps here, free in the count.';

export function DoublyPanel() {
  const ref = useRef<DoublyLinkedListF64 | null>(null);
  if (ref.current === null) ref.current = DoublyLinkedListF64.fromKeys(LIST_SEED);
  const [base, setBase] = useState<DoublyListModel>(() => doublyModel(DoublyLinkedListF64.fromKeys(LIST_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<DoublyListEvent>();

  const onOp = (op: Op, value: number) => {
    const l = ref.current!;
    const snapshot = doublyModel(l.snapshot()); // before-state: the links as they are
    const events: DoublyListEvent[] = [];
    const push = (e: DoublyListEvent) => events.push(e);
    const writes = () => events.filter((e) => e.kind === 'dll.relink').length;
    if (op === 'search') {
      const r = l.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} node-visits — the singly list’s walk, visit for visit`);
    } else if (op === 'insert') {
      l.insert(value, push);
      setSummary(`insert(${value}) → spliced at the head · 0 node-visits, ${writes()} pointer writes (a singly list makes 2)`);
    } else {
      const r = l.delete(value, push);
      setSummary(
        r.removed
          ? `delete(${value}) → removed · ${r.ops} node-visits, exactly a singly list’s — then ${writes()} pointer writes, free`
          : `delete(${value}) → absent · ${r.ops} node-visits`,
      );
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldDoublyList(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || DOUBLY_INTRO}</p>
      <DoublyListView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeDoubly(active, model)} />
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

export function RbtPanel() {
  const ref = useRef<RbtF64 | null>(null);
  if (ref.current === null) ref.current = RbtF64.fromKeys(RBT_SEED);
  const [base, setBase] = useState<RbtModel>(() => rbtModel(RbtF64.fromKeys(RBT_SEED).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<RbtEvent>();

  const onOp = (op: Op, value: number) => {
    const t = ref.current!;
    const snapshot = rbtModel(t.snapshot()); // before-state
    const events: RbtEvent[] = [];
    const push = (e: RbtEvent) => events.push(e);
    const split = (r: { ops: number; comparisons: number; rotations: number; recolours: number }) =>
      `${r.ops} ops (${r.comparisons} comparisons + ${r.rotations} rotation${r.rotations === 1 ? '' : 's'}) · ${r.recolours} recolour${r.recolours === 1 ? '' : 's'}, not in the ops`;
    if (op === 'search') {
      const r = t.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons`);
    } else if (op === 'insert') {
      setSummary(`insert(${value}) → placed · ${split(t.insert(value, push))}`);
    } else {
      const r = t.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${split(r)}`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldRbt(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || RBT_INTRO}</p>
      <RbtView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeRbt(active, model)} />
    </>
  );
}

export function BTreePanel() {
  const ref = useRef<BTreeF64 | null>(null);
  if (ref.current === null) ref.current = BTreeF64.fromKeys(BTREE_SEED, BTREE_EXPLORE_T);
  const [base, setBase] = useState<BTreeModel>(() => btreeModel(BTreeF64.fromKeys(BTREE_SEED, BTREE_EXPLORE_T).snapshot()));
  const [summary, setSummary] = useState('');
  const player = usePlayer<BTreeEvent>();

  const onOp = (op: Op, value: number) => {
    const b = ref.current!;
    const snapshot = btreeModel(b.snapshot()); // before-state
    const events: BTreeEvent[] = [];
    const push = (e: BTreeEvent) => events.push(e);
    const structural = () => events.filter((e) => e.kind === 'btree.split' || e.kind === 'btree.borrow' || e.kind === 'btree.merge').length;
    const visits = () => {
      const last = events[events.length - 1];
      return last && last.kind === 'btree.result' ? last.nodeVisits : 0;
    };
    const split = (ops: number, what: string) => {
      const s = structural();
      return `${ops} ops (${ops - s} comparisons${s ? ` + ${s} ${what}` : ''})`;
    };
    if (op === 'search') {
      const r = b.search(value, push);
      setSummary(`search(${value}) → ${r.found ? 'found' : 'not found'} · ${r.ops} comparisons in ${visits()} node${visits() === 1 ? '' : 's'} visited — the hops are not in the op-count`);
    } else if (op === 'insert') {
      const r = b.insert(value, push);
      setSummary(`insert(${value}) → placed · ${split(r.ops, structural() === 1 ? 'split' : 'splits')}`);
    } else {
      const r = b.delete(value, push);
      setSummary(`delete(${value}) → ${r.removed ? 'removed' : 'absent'} · ${split(r.ops, 'borrow/merge')} · ${visits()} nodes visited`);
    }
    setBase(snapshot);
    player.loadEvents(events);
  };

  const model = useMemo(() => foldBTree(base, P.applied(player.state)), [base, player.state]);
  const active = P.current(player.state);

  return (
    <>
      <p style={{ color: '#666', margin: '4px 0' }}>{summary || BTREE_INTRO}</p>
      <BTreeView model={model} active={active} />
      <Controls player={player} onOp={onOp} caption={describeBTree(active, model)} />
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
  { kind: 'hashoa', label: 'hash set (open addressing)' },
  { kind: 'bst', label: 'binary search tree' },
  { kind: 'avl', label: 'AVL tree' },
  { kind: 'rbt', label: 'red-black tree' },
  { kind: 'btree', label: 'B-tree' },
  { kind: 'heap', label: 'min-heap' },
  { kind: 'arraystr', label: 'dynamic array (text keys)' },
  { kind: 'hashstr', label: 'hash set (text keys)' },
  { kind: 'trie', label: 'trie (text keys)' },
  { kind: 'skiplist', label: 'skip list' },
  { kind: 'graph', label: 'graph (BFS / DFS)' },
];

function panelFor(kind: Kind) {
  switch (kind) {
    case 'array': return <ArrayPanel />;
    case 'sorted': return <SortedPanel />;
    case 'singly': return <LinkedPanel />;
    case 'doubly': return <DoublyPanel />;
    case 'hashset': return <HashPanel />;
    case 'hashoa': return <OpenAddressingPanel />;
    case 'bst': return <BstPanel />;
    case 'avl': return <AvlPanel />;
    case 'rbt': return <RbtPanel />;
    case 'btree': return <BTreePanel />;
    case 'heap': return <HeapPanel />;
    case 'trie': return <TriePanel />;
    case 'skiplist': return <SkipListPanel />;
    case 'graph': return <GraphPanel />;
    case 'arraystr': return <ArrayStrPanel />;
    case 'hashstr': return <HashStrPanel />;
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
