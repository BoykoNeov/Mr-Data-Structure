import { useMemo, useRef, useState } from 'react';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { SortedArrayF64 } from '../structures/sortedArray';
import { LinkedListF64, SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { BstF64 } from '../structures/bst';
import type { ArrayEvent, HashSetEvent, SortedArrayEvent, LinkedListEvent, BstEvent } from './events';
import {
  arrayModel, foldArray, hashModel, foldHash, isHole, type ArrayModel, type HashModel,
  foldSortedArray, linkedModel, foldLinkedList, type LinkedListModel,
  bstModel, foldBst, type BstModel,
} from './model';
import * as P from './player';
import { usePlayer } from './usePlayer';
import { ArrayView } from './ArrayView';
import { HashSetView } from './HashSetView';
import { SortedArrayView } from './SortedArrayView';
import { LinkedListView } from './LinkedListView';
import { BstView } from './BstView';
import { Controls } from './Controls';

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

type Kind = 'array' | 'sorted' | 'singly' | 'doubly' | 'hashset' | 'bst';
const ARRAY_SEED = [42, 7, 88, 7, 23];
const SORTED_SEED = [12, 25, 37, 44, 58, 70];
// Inserted at the head, so the displayed head→tail order is [40, 30, 20, 10].
const LIST_SEED = [10, 20, 30, 40];
// Six keys → 8 buckets; one more distinct insert (e.g. 70) trips a rehash → 16.
const HASH_SEED = [10, 20, 30, 40, 50, 60];
// Root-first insertion order yields a balanced 3-level tree; inserting a sorted
// run (e.g. 90, 95, 99) then visibly degenerates it to a right-leaning chain.
const BST_SEED = [50, 30, 70, 20, 40, 60, 80];

type Op = 'search' | 'insert' | 'delete';

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
  }
}

export function VizPanel() {
  const [kind, setKind] = useState<Kind>('array');
  return (
    <section style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.kind} style={tab(kind === t.kind)} onClick={() => setKind(t.kind)}>
            {t.label}
          </button>
        ))}
      </div>
      {panelFor(kind)}
    </section>
  );
}
