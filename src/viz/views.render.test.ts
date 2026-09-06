import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { BstF64 } from '../structures/bst';
import { AvlF64 } from '../structures/avl';
import { MinHeapF64 } from '../structures/heap';
import { TrieStr } from '../structures/trie';
import { SortedArrayView } from './SortedArrayView';
import { LinkedListView } from './LinkedListView';
import { BstView } from './BstView';
import { AvlView } from './AvlView';
import { HeapView } from './HeapView';
import { TrieView } from './TrieView';
import { SortedPanel, LinkedPanel, BstPanel, AvlPanel, HeapPanel, TriePanel } from './VizPanel';
import {
  arrayModel, foldSortedArray, linkedModel, foldLinkedList, bstModel, foldBst,
  avlModel, foldAvl, heapModel, foldHeap, trieModel, foldTrie,
} from './model';
import type { SortedArrayEvent, LinkedListEvent, BstEvent, AvlEvent, HeapEvent, TrieEvent, Tracer } from './events';

/**
 * Render smoke for the Phase-3-breadth views. `verify:browser` only drives the
 * default sweep tab, so a render-time crash in these new views (a bad index, an
 * undefined slot mid-shift) would slip past the browser gate (the advisor's
 * blind spot). The fold logic is proven in `model.test.ts`; here we render
 * *every animation frame* of search / insert / delete to static SVG and assert
 * it produces markup without throwing — exercising the renderer over each prefix
 * the Player can show, not just the final state.
 */

const renderEveryFrame = <E, M>(
  before: M,
  events: readonly E[],
  fold: (m: M, es: readonly E[]) => M,
  render: (model: M, active: E | undefined) => string,
) => {
  for (let f = 0; f <= events.length; f++) {
    const model = fold(before, events.slice(0, f));
    const active = f > 0 ? events[f - 1] : undefined;
    const html = render(model, active);
    expect(html).toContain('<svg');
  }
};

describe('SortedArrayView renders every frame without throwing', () => {
  const cases: [string, number[], (a: SortedArrayF64, t: Tracer<SortedArrayEvent>) => void][] = [
    ['search found', [12, 25, 37, 44, 58, 70], (a, t) => a.search(44, t)],
    ['search absent', [12, 25, 37, 44, 58, 70], (a, t) => a.search(50, t)],
    ['insert middle', [10, 20, 40, 50], (a, t) => a.insert(30, t)],
    ['insert new min', [20, 30, 40], (a, t) => a.insert(5, t)],
    ['insert new max', [20, 30, 40], (a, t) => a.insert(99, t)],
    ['delete middle', [10, 20, 30, 40, 50], (a, t) => a.delete(20, t)],
    ['delete absent', [10, 20, 30], (a, t) => a.delete(99, t)],
  ];
  it.each(cases)('%s', (_label, build, op) => {
    const a = SortedArrayF64.fromKeys(build);
    const before = arrayModel(a.keysInOrder());
    const events: SortedArrayEvent[] = [];
    op(a, (e) => events.push(e));
    renderEveryFrame(before, events, foldSortedArray, (model, active) =>
      renderToStaticMarkup(createElement(SortedArrayView, { model, active })),
    );
  });

  it('renders the empty array', () => {
    const html = renderToStaticMarkup(createElement(SortedArrayView, { model: arrayModel([]), active: undefined }));
    expect(html).toContain('(empty)');
  });
});

describe.each([
  ['singly', false, SinglyLinkedListF64],
  ['doubly', true, DoublyLinkedListF64],
] as const)('LinkedListView (%s) renders every frame without throwing', (_label, doubly, List) => {
  const cases: [string, number[], (l: InstanceType<typeof List>, t: Tracer<LinkedListEvent>) => void][] = [
    ['search found', [10, 20, 30, 40], (l, t) => l.search(20, t)],
    ['search absent', [10, 20, 30, 40], (l, t) => l.search(99, t)],
    ['insert head', [10, 20, 30], (l, t) => l.insert(5, t)],
    ['delete middle', [10, 20, 30, 40], (l, t) => l.delete(30, t)],
    ['delete head', [10, 20, 30], (l, t) => l.delete(30, t)],
    ['delete absent', [10, 20, 30], (l, t) => l.delete(99, t)],
  ];
  it.each(cases)('%s', (_c, build, op) => {
    const l = List.fromKeys(build);
    const before = linkedModel(l.keysInOrder());
    const events: LinkedListEvent[] = [];
    op(l, (e) => events.push(e));
    renderEveryFrame(before, events, foldLinkedList, (model, active) =>
      renderToStaticMarkup(createElement(LinkedListView, { model, active, doubly })),
    );
  });

  it('renders the empty list', () => {
    const html = renderToStaticMarkup(
      createElement(LinkedListView, { model: linkedModel([]), active: undefined, doubly }),
    );
    expect(html).toContain('(empty)');
  });
});

describe('BstView renders every frame without throwing', () => {
  const cases: [string, number[], (t: BstF64, tr: Tracer<BstEvent>) => void][] = [
    ['search found', [50, 30, 70, 20, 40], (t, tr) => t.search(20, tr)],
    ['search absent', [50, 30, 70], (t, tr) => t.search(35, tr)],
    ['insert leaf', [50, 30, 70], (t, tr) => t.insert(40, tr)],
    ['insert into empty', [], (t, tr) => t.insert(42, tr)],
    ['insert duplicate (right)', [50, 30], (t, tr) => t.insert(50, tr)],
    ['delete leaf', [50, 30, 70, 20], (t, tr) => t.delete(20, tr)],
    ['delete one-child (left)', [50, 30, 20], (t, tr) => t.delete(30, tr)],
    ['delete two-child', [50, 30, 70, 60, 80], (t, tr) => t.delete(70, tr)],
    ['delete root two-child', [50, 30, 70, 20, 40, 60, 80], (t, tr) => t.delete(50, tr)],
    ['delete to empty', [42], (t, tr) => t.delete(42, tr)],
    ['delete absent', [50, 30, 70], (t, tr) => t.delete(99, tr)],
  ];
  it.each(cases)('%s', (_label, build, op) => {
    const t = BstF64.fromKeys(build);
    const before = bstModel(t.snapshot());
    const events: BstEvent[] = [];
    op(t, (e) => events.push(e));
    renderEveryFrame(before, events, foldBst, (model, active) =>
      renderToStaticMarkup(createElement(BstView, { model, active })),
    );
  });

  it('renders the empty tree', () => {
    const html = renderToStaticMarkup(createElement(BstView, { model: bstModel(null), active: undefined }));
    expect(html).toContain('(empty)');
  });
});

describe('AvlView renders every frame without throwing', () => {
  const cases: [string, number[], (t: AvlF64, tr: Tracer<AvlEvent>) => void][] = [
    ['search found', [50, 30, 70, 20, 40], (t, tr) => t.search(20, tr)],
    ['search absent', [50, 30, 70], (t, tr) => t.search(35, tr)],
    ['insert leaf (no rotation)', [50, 30, 70], (t, tr) => t.insert(40, tr)],
    ['insert into empty', [], (t, tr) => t.insert(42, tr)],
    ['LL insert (single rotation)', [30, 20], (t, tr) => t.insert(10, tr)],
    ['LR insert (double rotation)', [30, 10], (t, tr) => t.insert(20, tr)],
    ['sorted-run insert (cascading)', [10, 20, 30, 40, 50], (t, tr) => t.insert(60, tr)],
    ['delete leaf', [50, 30, 70, 20], (t, tr) => t.delete(20, tr)],
    ['delete two-child', [50, 30, 70, 60, 80], (t, tr) => t.delete(70, tr)],
    ['delete that rebalances', [50, 30, 70, 20, 40, 60, 80, 10], (t, tr) => t.delete(70, tr)],
    ['delete to empty', [42], (t, tr) => t.delete(42, tr)],
    ['delete absent', [50, 30, 70], (t, tr) => t.delete(99, tr)],
  ];
  it.each(cases)('%s', (_label, build, op) => {
    const t = AvlF64.fromKeys(build);
    const before = avlModel(t.snapshot());
    const events: AvlEvent[] = [];
    op(t, (e) => events.push(e));
    renderEveryFrame(before, events, foldAvl, (model, active) =>
      renderToStaticMarkup(createElement(AvlView, { model, active })),
    );
  });

  it('renders the empty tree', () => {
    const html = renderToStaticMarkup(createElement(AvlView, { model: avlModel(null), active: undefined }));
    expect(html).toContain('(empty)');
  });
});

describe('HeapView renders every frame without throwing', () => {
  const cases: [string, number[], (h: MinHeapF64, tr: Tracer<HeapEvent>) => void][] = [
    ['insert new min', [50, 30, 70, 20, 40, 60, 10], (h, tr) => h.insert(5, tr)],
    ['insert new max', [10, 20, 30], (h, tr) => h.insert(99, tr)],
    ['extract-min (sift-down)', [50, 30, 70, 20, 40, 60, 10], (h, tr) => h.extractMin(tr)],
    ['extract-min to empty', [42], (h, tr) => h.extractMin(tr)],
    ['peek', [50, 30, 70], (h, tr) => h.peek(tr)],
    ['search found', [50, 30, 70, 20], (h, tr) => h.search(70, tr)],
    ['search absent', [50, 30, 70], (h, tr) => h.search(999, tr)],
  ];
  it.each(cases)('%s', (_label, build, op) => {
    const h = MinHeapF64.fromKeys(build);
    const before = heapModel(h.toArray());
    const events: HeapEvent[] = [];
    op(h, (e) => events.push(e));
    renderEveryFrame(before, events, foldHeap, (model, active) =>
      renderToStaticMarkup(createElement(HeapView, { model, active })),
    );
  });

  it('renders the empty heap', () => {
    const html = renderToStaticMarkup(createElement(HeapView, { model: heapModel([]), active: undefined }));
    expect(html).toContain('(empty)');
  });
});

describe('TrieView renders every frame without throwing', () => {
  // The trie is the only n-ary view and the only one whose delete *removes* nodes
  // mid-stream: the prune unwinding produces intermediate frames that exist
  // nowhere else, and a bad byte path would crash there rather than at the end.
  const cases: [string, string[], (t: TrieStr, tr: Tracer<TrieEvent>) => void][] = [
    ['search found', ['car', 'cart', 'cat'], (t, tr) => t.search('cat', tr)],
    ['search falls off at the first byte', ['car'], (t, tr) => t.search('zebra', tr)],
    ['search a proper prefix (full depth, absent)', ['stack'], (t, tr) => t.search('stac', tr)],
    ['insert into an empty trie', [], (t, tr) => t.insert('car', tr)],
    ['insert a whole new branch', ['car'], (t, tr) => t.insert('dog', tr)],
    ['insert extending a shared prefix', ['car'], (t, tr) => t.insert('cart', tr)],
    ['insert a duplicate', ['car'], (t, tr) => t.insert('car', tr)],
    ['insert a multi-byte key', ['car'], (t, tr) => t.insert('café', tr)],
    ['delete that prunes one node', ['car', 'cart', 'cat'], (t, tr) => t.delete('cart', tr)],
    ['delete that prunes a whole chain', ['car', 'dog'], (t, tr) => t.delete('dog', tr)],
    ['delete a shared-prefix key (prunes nothing)', ['car', 'cart'], (t, tr) => t.delete('car', tr)],
    ['delete absent', ['car', 'cat'], (t, tr) => t.delete('cow', tr)],
    ['delete a multi-byte key', ['café', 'car'], (t, tr) => t.delete('café', tr)],
    ['delete down to empty', ['dog'], (t, tr) => t.delete('dog', tr)],
  ];
  it.each(cases)('%s', (_label, build, op) => {
    const t = TrieStr.fromKeys(build);
    const before = trieModel(t.snapshot());
    const events: TrieEvent[] = [];
    op(t, (e) => events.push(e));
    renderEveryFrame(before, events, foldTrie, (model, active) =>
      renderToStaticMarkup(createElement(TrieView, { model, active })),
    );
  });

  it('renders the empty trie', () => {
    const html = renderToStaticMarkup(
      createElement(TrieView, { model: trieModel(TrieStr.fromKeys([]).snapshot()), active: undefined }),
    );
    expect(html).toContain('(empty)');
  });

  it('labels a multi-byte character by its bytes, not as one node', () => {
    // The claim the seed exists to make: `é` is C3 A9, two levels, two labels.
    const t = TrieStr.fromKeys(['café']);
    const html = renderToStaticMarkup(
      createElement(TrieView, { model: trieModel(t.snapshot()), active: undefined }),
    );
    expect(html).toContain('C3');
    expect(html).toContain('A9');
    expect(html).not.toContain('é');
  });
});

describe('new panels mount without throwing', () => {
  // The views above are pure SVG; the panels add the hook wiring (ref-held
  // structure, usePlayer, the singly↔doubly key-remount). A single SSR pass runs
  // those hooks (useEffect is skipped, so no interval leaks) — this catches a
  // mount-time render crash the browser gate would miss (it only drives the sweep
  // tab). The key-remount *behavior* still needs a real click to verify.
  it('SortedPanel renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(SortedPanel))).toContain('<svg');
  });
  it('LinkedPanel (singly) renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(LinkedPanel, { doubly: false }))).toContain('<svg');
  });
  it('LinkedPanel (doubly) renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(LinkedPanel, { doubly: true }))).toContain('<svg');
  });
  it('BstPanel renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(BstPanel))).toContain('<svg');
  });
  it('AvlPanel renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(AvlPanel))).toContain('<svg');
  });
  it('HeapPanel renders its seeded SVG', () => {
    expect(renderToStaticMarkup(createElement(HeapPanel))).toContain('<svg');
  });
  it('TriePanel renders its seeded SVG (and a text key box, not a number one)', () => {
    const html = renderToStaticMarkup(createElement(TriePanel));
    expect(html).toContain('<svg');
    expect(html).toContain('type="text"');
  });
});
