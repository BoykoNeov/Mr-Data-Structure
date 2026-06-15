import { describe, it, expect } from 'vitest';
import { SortedArrayF64 } from './sortedArray';
import type { SortedArrayEvent } from '../viz/events';

describe('SortedArrayF64 — teaching impl (binary search)', () => {
  it('fromKeys sorts and keeps duplicates (multiset)', () => {
    const a = SortedArrayF64.fromKeys([30, 10, 20, 10]);
    expect(a.keysInOrder()).toEqual([10, 10, 20, 30]);
    expect(a.size).toBe(4);
  });

  it('search reports membership and a logarithmic comparison count', () => {
    const a = SortedArrayF64.fromKeys([10, 20, 30, 40, 50, 60, 70]); // n = 7
    expect(a.search(40)).toEqual({ found: true, ops: 1 }); // mid hits immediately
    // An absent key bottoms out the search; comparisons ≤ ceil(log2(n+1)).
    const miss = a.search(35);
    expect(miss.found).toBe(false);
    expect(miss.ops).toBeLessThanOrEqual(3);
  });

  it('search agrees with a reference over a random sorted workload', () => {
    const keys = Array.from({ length: 200 }, (_, i) => (i * 7) % 53);
    const a = SortedArrayF64.fromKeys(keys);
    const ref = new Set(keys);
    expect(a.keysInOrder()).toEqual([...keys].sort((x, y) => x - y));
    for (let q = -5; q < 60; q++) {
      expect(a.search(q).found).toBe(ref.has(q));
    }
  });

  it('insert keeps the array sorted and counts comparisons + shifts', () => {
    const a = SortedArrayF64.fromKeys([10, 20, 40, 50]);
    // Insert 30: binary-search the slot, then shift the tail (40,50) right.
    const r = a.insert(30);
    expect(a.keysInOrder()).toEqual([10, 20, 30, 40, 50]);
    expect(r.ops).toBeGreaterThan(0);
    // Inserting the new max shifts nothing — only the binary-search comparisons.
    const before = a.keysInOrder();
    a.insert(99);
    expect(a.keysInOrder()).toEqual([...before, 99]);
  });

  it('insert places duplicates while staying sorted', () => {
    const a = SortedArrayF64.fromKeys([1, 3, 5]);
    a.insert(3);
    a.insert(3);
    expect(a.keysInOrder()).toEqual([1, 3, 3, 3, 5]);
  });

  it('delete removes one occurrence, compacts, and counts comparisons + shifts', () => {
    const a = SortedArrayF64.fromKeys([10, 20, 30, 40, 50]);
    const r = a.delete(20);
    expect(r.removed).toBe(true);
    expect(r.ops).toBeGreaterThan(0);
    expect(a.keysInOrder()).toEqual([10, 30, 40, 50]);
    // Absent key: binary search bottoms out, nothing removed.
    const miss = a.delete(99);
    expect(miss.removed).toBe(false);
    expect(a.keysInOrder()).toEqual([10, 30, 40, 50]);
  });

  it('delete removes only one of several duplicates', () => {
    const a = SortedArrayF64.fromKeys([5, 5, 5, 7]);
    expect(a.delete(5).removed).toBe(true);
    expect(a.keysInOrder()).toEqual([5, 5, 7]);
  });

  it('insert then delete round-trips against a reference multiset', () => {
    const a = new SortedArrayF64();
    const ref: number[] = [];
    const add = (k: number) => {
      a.insert(k);
      ref.push(k);
      ref.sort((x, y) => x - y);
    };
    const del = (k: number) => {
      const res = a.delete(k);
      const idx = ref.indexOf(k);
      if (idx === -1) expect(res.removed).toBe(false);
      else {
        expect(res.removed).toBe(true);
        ref.splice(idx, 1);
      }
      expect(a.keysInOrder()).toEqual(ref);
    };
    for (const k of [42, 7, 7, 88, 13, 7, 99, 1]) add(k);
    for (const k of [7, 7, 99, 5, 42, 1, 7, 88, 13]) del(k);
    expect(a.keysInOrder()).toEqual([]);
  });

  it('emits a binary-search compare stream ending in a result marker', () => {
    const a = SortedArrayF64.fromKeys([10, 20, 30, 40, 50, 60, 70]);
    const events: SortedArrayEvent[] = [];
    const r = a.search(70, (e) => events.push(e));
    const compares = events.filter((e) => e.kind === 'sarr.compare');
    expect(compares.length).toBe(r.ops);
    // every compare's midpoint lies inside its reported window
    for (const e of compares) {
      if (e.kind === 'sarr.compare') expect(e.index >= e.lo && e.index < e.hi).toBe(true);
    }
    expect(events[events.length - 1]).toEqual({ kind: 'sarr.result', found: true });
  });
});
