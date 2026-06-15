import { describe, it, expect } from 'vitest';
import { BstF64 } from '../structures/bst';
import { countCostEvents, type BstEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty
 * gate, risk R1) for the unbalanced BST. The animation must show *exactly* the
 * cost the benchmark reports, so the only cost event — `bst.compare` — is emitted
 * where the comparison counter ticks:
 *
 *     countCostEvents(stream) === op-count.
 *
 * Unlike the sorted array (whose insert/delete add an untagged `+ shifts` term),
 * the BST's cost metric is comparisons *only*, so the equality holds for **search,
 * insert, AND delete**. A two-child delete's in-order-successor walk
 * (`bst.descend`) follows pointers, not key comparisons, so it is deliberately not
 * a cost event — the contract the Phase 4 Rust op-counter must mirror.
 *
 * The BST gets its Rust twin (and a cross-language corpus) in Phase 4; until then
 * this pins the tracer to the counter within TypeScript.
 */

const SEED = [50, 30, 70, 20, 40, 60, 80]; // balanced 3-level tree

describe('BST search: cost-events == comparison count', () => {
  const probes = [50, 20, 80, 35, 75, 40, 1]; // hits, misses, leaves, root
  it.each(probes)('search(%i)', (p) => {
    const t = BstF64.fromKeys(SEED);
    const events: BstEvent[] = [];
    const r = t.search(p, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'bst.result', found: r.found });
  });
});

describe('BST insert: cost-events == comparison count', () => {
  const keys = [35, 90, 10, 65, 50]; // 50 duplicates the root → descends right
  it.each(keys)('insert(%i)', (k) => {
    const t = BstF64.fromKeys(SEED);
    const events: BstEvent[] = [];
    const r = t.insert(k, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    // exactly one structural attach, and it ends the stream (no result marker).
    expect(events.filter((e) => e.kind === 'bst.insert').length).toBe(1);
    expect(events[events.length - 1].kind).toBe('bst.insert');
  });

  it('the first insert into an empty tree does zero comparisons', () => {
    const t = new BstF64();
    const events: BstEvent[] = [];
    const r = t.insert(42, (e) => events.push(e));
    expect(r.ops).toBe(0);
    expect(countCostEvents(events)).toBe(0);
    expect(events).toEqual([{ kind: 'bst.insert', path: [], value: 42 }]);
  });
});

describe('BST delete: cost-events == comparison count', () => {
  const cases: [string, number[], number][] = [
    ['leaf', SEED, 20],
    ['two-child', SEED, 30],
    ['root (two-child)', SEED, 50],
    ['one-child, left', [50, 30, 20], 30],
    ['one-child, right', [50, 30, 40], 30],
    ['absent', SEED, 99],
  ];
  it.each(cases)('delete %s', (_label, build, k) => {
    const t = BstF64.fromKeys(build);
    const events: BstEvent[] = [];
    const r = t.delete(k, (e) => events.push(e));
    // The descend / surgery events carry no comparison — only the find compares count.
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'bst.result', found: r.removed });
  });
});
