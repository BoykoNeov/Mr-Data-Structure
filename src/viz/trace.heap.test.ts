import { describe, it, expect } from 'vitest';
import { MinHeapF64 } from '../structures/heap';
import { countCostEvents, type HeapEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty
 * gate, risk R1) for the binary min-heap. Its cost metric is **comparisons +
 * swaps** (docs/PLAN.md §8); the cost events are the sift comparisons
 * (`heap.compare`), the search-scan comparisons (`heap.scan`), and the swaps
 * (`heap.swap`), so:
 *
 *     countCostEvents(stream) === op-count
 *
 * holds for **insert, extract-min, AND search**. The structural "move the last
 * element to the root" of extract-min (`heap.replaceRoot`) is not a compare-driven
 * swap and is deliberately not a cost event. `peek` is O(1) with no cost.
 */

const SEED = [50, 30, 70, 20, 40, 60, 10]; // a valid min-heap (root 10)

describe('heap insert: cost-events == comparisons + swaps', () => {
  const keys = [5, 35, 100, 25, 10]; // a new min, mid values, a new max, a duplicate
  it.each(keys)('insert(%i)', (k) => {
    const h = MinHeapF64.fromKeys(SEED);
    const events: HeapEvent[] = [];
    const r = h.insert(k, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[0]).toEqual({ kind: 'heap.append', value: k });
  });
});

describe('heap extract-min: cost-events == comparisons + swaps', () => {
  it('extract from a full heap', () => {
    const h = MinHeapF64.fromKeys(SEED);
    const events: HeapEvent[] = [];
    const r = h.extractMin((e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'heap.result', found: true });
  });

  it('repeated extraction stays consistent down to empty', () => {
    const h = MinHeapF64.fromKeys(SEED);
    for (let i = 0; i < SEED.length; i++) {
      const events: HeapEvent[] = [];
      const r = h.extractMin((e) => events.push(e));
      expect(countCostEvents(events)).toBe(r.ops);
    }
    // empty extract: no cost events, result false.
    const events: HeapEvent[] = [];
    const r = h.extractMin((e) => events.push(e));
    expect(r.ops).toBe(0);
    expect(countCostEvents(events)).toBe(0);
    expect(events).toEqual([{ kind: 'heap.result', found: false }]);
  });
});

describe('heap insert: absolute op-counts (anchored, not just self-consistent)', () => {
  // Hand-computed totals, so a *symmetric* miscount (drop a compare from both the
  // tracer and the counter) can't slip past the `countCostEvents === ops` gate.
  it('sifts all the way up: 1 compare + 1 swap = 2', () => {
    const h = MinHeapF64.fromKeys([10, 20]);
    const events: HeapEvent[] = [];
    const r = h.insert(5, (e) => events.push(e)); // 5 < 10 → swap to the root, then stop
    expect(r.ops).toBe(2);
    expect(countCostEvents(events)).toBe(2);
    expect(events.filter((e) => e.kind === 'heap.swap').length).toBe(1);
  });
  it('stops at the first compare: 1 compare + 0 swaps = 1', () => {
    const h = MinHeapF64.fromKeys([10, 20]);
    const events: HeapEvent[] = [];
    const r = h.insert(25, (e) => events.push(e)); // 25 ≥ 10 → no swap
    expect(r.ops).toBe(1);
    expect(countCostEvents(events)).toBe(1);
    expect(events.filter((e) => e.kind === 'heap.swap').length).toBe(0);
  });
});

describe('heap search: cost-events == scan comparisons', () => {
  const probes = [10, 70, 50, 999];
  it.each(probes)('search(%i)', (p) => {
    const h = MinHeapF64.fromKeys(SEED);
    const events: HeapEvent[] = [];
    const r = h.search(p, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'heap.result', found: r.found });
  });
});

describe('heap peek: O(1), no cost events', () => {
  it('peek emits a highlight + result but no cost', () => {
    const h = MinHeapF64.fromKeys(SEED);
    const events: HeapEvent[] = [];
    h.peek((e) => events.push(e));
    expect(countCostEvents(events)).toBe(0);
    expect(events).toEqual([
      { kind: 'heap.peek', value: 10 },
      { kind: 'heap.result', found: true },
    ]);
  });
});
