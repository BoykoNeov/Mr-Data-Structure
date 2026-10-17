import { describe, it, expect } from 'vitest';
import { RbtF64 } from './rbt';

/** A small deterministic xorshift, so the randomized checks never flake. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

/**
 * The red-black teaching twin (docs/PLAN.md §8, §13). Hand-computed counts here mirror the
 * Rust unit tests in `bench-engine/src/structures/rbt.rs`; the full cross-language pin is
 * `conformance-rbt.test.ts`.
 */
describe('RbtF64 — teaching impl (CLRS red-black multiset)', () => {
  it('in-order is the sorted multiset, duplicates kept', () => {
    const t = RbtF64.fromKeys([50, 30, 70, 30, 20, 60]);
    expect(t.keysInOrder()).toEqual([20, 30, 30, 50, 60, 70]);
    expect(t.size).toBe(6);
    expect(t.checkInvariants()).toBe(true);
  });

  it('the first insert pays one recolour (born red, blackened as the root) and no ops', () => {
    const t = new RbtF64();
    expect(t.insert(10)).toEqual({ ops: 0, comparisons: 0, rotations: 0, recolours: 1 });
    expect(t.snapshot()).toEqual({ value: 10, red: false, left: null, right: null });
  });

  it('black uncle, straight line → one rotation; zig-zag → two', () => {
    const line = RbtF64.fromKeys([10, 20]);
    expect(line.insert(30)).toEqual({ ops: 3, comparisons: 2, rotations: 1, recolours: 2 });
    const zig = RbtF64.fromKeys([30, 10]);
    expect(zig.insert(20)).toEqual({ ops: 4, comparisons: 2, rotations: 2, recolours: 2 });
    for (const t of [line, zig]) {
      expect(t.snapshot()!.value).toBe(20);
      expect(t.snapshot()!.red).toBe(false);
      expect(t.checkInvariants()).toBe(true);
    }
  });

  it('red uncle → recolour only, no rotation (the root goes red and back: two recolours)', () => {
    const t = RbtF64.fromKeys([20, 10, 30]);
    expect(t.insert(5)).toEqual({ ops: 2, comparisons: 2, rotations: 0, recolours: 4 });
    expect(t.checkInvariants()).toBe(true);
  });

  it('search counts one comparison per node, the match included', () => {
    const t = RbtF64.fromKeys([20, 10, 30]);
    expect(t.search(20)).toEqual({ found: true, ops: 1 });
    expect(t.search(10)).toEqual({ found: true, ops: 2 });
    expect(t.search(99)).toEqual({ found: false, ops: 2 });
    expect(new RbtF64().search(1)).toEqual({ found: false, ops: 0 });
  });

  it('two-child delete counts the find path only; the successor walk is free', () => {
    const t = RbtF64.fromKeys([20, 10, 30]);
    expect(t.delete(20)).toEqual({ removed: true, ops: 1, comparisons: 1, rotations: 0, recolours: 0 });
    expect(t.keysInOrder()).toEqual([10, 30]);
    expect(t.checkInvariants()).toBe(true);
  });

  it('delete removes one occurrence of an equal key and reports misses', () => {
    const t = RbtF64.fromKeys([50, 50, 50, 70]);
    expect(t.delete(50).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([50, 50, 70]);
    expect(t.delete(99).removed).toBe(false);
    expect(t.size).toBe(3);
    expect(t.checkInvariants()).toBe(true);
  });

  it('sorted input stays within the 2·log₂(n+1) height bound', () => {
    const n = 500;
    const t = RbtF64.fromKeys(Array.from({ length: n }, (_, i) => i));
    expect(t.height).toBeLessThanOrEqual(2 * Math.log2(n + 1));
    expect(t.checkInvariants()).toBe(true);
  });

  it('a random insert/delete stream keeps every invariant and the rotation budget (≤ 2 / ≤ 3)', () => {
    const next = rng(0x2545f491);
    const t = new RbtF64();
    const model: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const key = next() % 60;
      if (next() % 3 === 0) {
        const r = t.delete(key);
        const at = model.indexOf(key);
        expect(r.removed).toBe(at !== -1);
        if (at !== -1) model.splice(at, 1);
        expect(r.rotations).toBeLessThanOrEqual(3);
      } else {
        expect(t.insert(key).rotations).toBeLessThanOrEqual(2);
        model.push(key);
      }
      expect(t.size).toBe(model.length);
    }
    expect(t.keysInOrder()).toEqual(sorted(model));
    expect(t.checkInvariants()).toBe(true);
  });

  it('checkInvariants is not vacuous: a tree whose root is red fails it', () => {
    const t = RbtF64.fromKeys([2, 1, 3]);
    expect(t.checkInvariants()).toBe(true);
    // Reach into the private root only to break it — the check must notice.
    (t as unknown as { root: { red: boolean } }).root.red = true;
    expect(t.checkInvariants()).toBe(false);
  });
});
