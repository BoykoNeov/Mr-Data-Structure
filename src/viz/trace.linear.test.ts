import { describe, it, expect } from 'vitest';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { countCostEvents, type SortedArrayEvent, type LinkedListEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty
 * gate, risk R1) for the Phase-3-breadth linear structures. The animation must
 * show *exactly* the cost the benchmark reports, so the cost-bearing events
 * (`sarr.compare`, `ll.visit`) are emitted where the cost counter ticks:
 *
 *     countCostEvents(stream) === op-count.
 *
 * Scope (mirrors what each structure's cost metric counts, docs/PLAN.md §8):
 *  - Sorted array: **search** only — its `ops` is comparisons. Insert/delete add
 *    a `+ shifts` term that is *not* a cost event, so the equality holds for
 *    search alone (asserting it for insert/delete would fail by design).
 *  - Linked list: **search and delete** — both `ops` are pure node-visits (the
 *    unlink is free); insert is O(1) with zero visits.
 *
 * These structures get their Rust twins (and a cross-language corpus) in Phase 4;
 * until then this pins the tracer to the counter within TypeScript.
 */

describe('sorted array: search cost-events == comparison count', () => {
  const a = SortedArrayF64.fromKeys([12, 25, 37, 44, 58, 70, 81, 93, 99]);
  const probes = [12, 44, 99, 1, 50, 70, 100];
  it.each(probes)('search(%i)', (p) => {
    const events: SortedArrayEvent[] = [];
    const r = a.search(p, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'sarr.result', found: r.found });
  });
});

describe.each([
  ['SinglyLinkedListF64', SinglyLinkedListF64],
  ['DoublyLinkedListF64', DoublyLinkedListF64],
] as const)('%s: visit cost-events == node-visit count', (_name, List) => {
  const seed = [5, 12, 19, 27, 33, 41, 41, 58];
  const probes = [5, 27, 41, 99, 58, 12, 1000];

  it.each(probes)('search(%i)', (p) => {
    const l = List.fromKeys(seed);
    const events: LinkedListEvent[] = [];
    const r = l.search(p, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'll.result', found: r.found });
  });

  it.each(probes)('delete(%i)', (p) => {
    const l = List.fromKeys(seed);
    const events: LinkedListEvent[] = [];
    const r = l.delete(p, (e) => events.push(e));
    // delete cost is pure node-visits (the unlink carries no cost event).
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'll.result', found: r.removed });
  });

  it('insert performs zero node-visits (O(1) head)', () => {
    const l = List.fromKeys(seed);
    const events: LinkedListEvent[] = [];
    l.insert(7, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(0);
  });
});
