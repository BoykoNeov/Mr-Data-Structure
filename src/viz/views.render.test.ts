import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { SortedArrayView } from './SortedArrayView';
import { LinkedListView } from './LinkedListView';
import { SortedPanel, LinkedPanel } from './VizPanel';
import { arrayModel, foldSortedArray, linkedModel, foldLinkedList } from './model';
import type { SortedArrayEvent, LinkedListEvent, Tracer } from './events';

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
});
