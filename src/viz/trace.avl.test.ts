import { describe, it, expect } from 'vitest';
import { AvlF64 } from '../structures/avl';
import { countCostEvents, type AvlEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty
 * gate, risk R1) for the AVL tree. Its cost metric is **comparisons + rotations**
 * (docs/PLAN.md §8), and *both* are tagged cost events (`avl.compare`,
 * `avl.rotate`), so unlike the sorted array (an untagged `+ shifts` term):
 *
 *     countCostEvents(stream) === op-count
 *
 * holds for **search, insert, AND delete**. The in-order-successor walk of a
 * two-child delete (`avl.descend`) follows pointers — no comparison — so it is
 * deliberately not a cost event, the contract the Phase 4 Rust op-counter mirrors.
 *
 * The AVL gets its Rust twin (and a cross-language corpus) in Phase 4; until then
 * this pins the tracer to the counter within TypeScript.
 */

const SEED = [50, 30, 70, 20, 40, 60, 80]; // balanced 3-level tree

describe('AVL search: cost-events == comparison count', () => {
  const probes = [50, 20, 80, 35, 75, 40, 1];
  it.each(probes)('search(%i)', (p) => {
    const t = AvlF64.fromKeys(SEED);
    const events: AvlEvent[] = [];
    const r = t.search(p, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'avl.result', found: r.found });
  });
});

describe('AVL insert: cost-events == comparisons + rotations', () => {
  // A mix: leaf inserts (no rotation) and sorted-run inserts (forced rotations).
  const cases: [string, number[], number][] = [
    ['leaf, no rotation', SEED, 35],
    ['duplicate (descends right)', SEED, 50],
    ['forces a rotation', [10, 20, 30, 40], 50], // a sorted run keeps rotating
    ['into empty', [], 42],
  ];
  it.each(cases)('%s', (_label, build, k) => {
    const t = AvlF64.fromKeys(build);
    const events: AvlEvent[] = [];
    const r = t.insert(k, (e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    // exactly one structural attach.
    expect(events.filter((e) => e.kind === 'avl.insert').length).toBe(1);
  });

  it('a rotating insert actually emits avl.rotate events that count toward ops', () => {
    const t = AvlF64.fromKeys([30, 20]); // about to be left-heavy
    const events: AvlEvent[] = [];
    const r = t.insert(10, (e) => events.push(e)); // LL → one right rotation
    const rotations = events.filter((e) => e.kind === 'avl.rotate').length;
    expect(rotations).toBe(1);
    const compares = events.filter((e) => e.kind === 'avl.compare').length;
    expect(r.ops).toBe(compares + rotations);
    expect(countCostEvents(events)).toBe(r.ops);
  });
});

describe('AVL delete: cost-events == comparisons + rotations', () => {
  const cases: [string, number[], number][] = [
    ['leaf', SEED, 20],
    ['two-child', SEED, 30],
    ['root (two-child)', SEED, 50],
    ['forces a rebalance', [50, 30, 70, 80], 30],
    ['absent', SEED, 99],
  ];
  it.each(cases)('delete %s', (_label, build, k) => {
    const t = AvlF64.fromKeys(build);
    const events: AvlEvent[] = [];
    const r = t.delete(k, (e) => events.push(e));
    // descend / removeTarget / replaceValue / remove carry no cost; only
    // compares + rotations count.
    expect(countCostEvents(events)).toBe(r.ops);
    expect(events[events.length - 1]).toEqual({ kind: 'avl.result', found: r.removed });
  });
});
