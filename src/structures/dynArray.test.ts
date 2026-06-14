import { describe, it, expect } from 'vitest';
import { DynArrayF64 } from './dynArray';

describe('DynArrayF64 — teaching impl mirrors the Rust array', () => {
  it('comparisons equal the 1-based position when found', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30]);
    expect(a.search(10)).toEqual({ found: true, ops: 1 });
    expect(a.search(20)).toEqual({ found: true, ops: 2 });
    expect(a.search(30)).toEqual({ found: true, ops: 3 });
  });

  it('an absent key scans the whole array', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30]);
    expect(a.search(99)).toEqual({ found: false, ops: 3 });
  });

  it('keeps duplicates (multiset) and short-circuits on the first match', () => {
    const a = DynArrayF64.fromKeys([5, 5, 5]);
    expect(a.size).toBe(3);
    expect(a.search(5)).toEqual({ found: true, ops: 1 });
    expect(a.keysInOrder()).toEqual([5, 5, 5]);
  });

  it('iterates in insertion order', () => {
    const a = DynArrayF64.fromKeys([3, 1, 2, 1]);
    expect(a.keysInOrder()).toEqual([3, 1, 2, 1]);
  });

  it('membership agrees with a reference Set over a random workload', () => {
    const keys = Array.from({ length: 200 }, (_, i) => (i * 7) % 53);
    const a = DynArrayF64.fromKeys(keys);
    const ref = new Set(keys);
    for (let q = -5; q < 60; q++) {
      expect(a.search(q).found).toBe(ref.has(q));
    }
  });
});
