import { describe, it, expect } from 'vitest';
import { DynArrayF64 } from './dynArray';
import type { ArrayEvent } from '../viz/events';

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

  it('delete counts comparisons + shifts and preserves order (mirrors Rust)', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30]);
    // Remove the front: 1 comparison + 2 shifts to compact.
    expect(a.delete(10)).toEqual({ removed: true, ops: 3 });
    expect(a.keysInOrder()).toEqual([20, 30]);
    // Remove the tail: 2 comparisons (full scan) + 0 shifts.
    expect(a.delete(30)).toEqual({ removed: true, ops: 2 });
    expect(a.keysInOrder()).toEqual([20]);
    // Absent key: full scan, nothing removed.
    expect(a.delete(99)).toEqual({ removed: false, ops: 1 });
  });

  it('delete removes only the first occurrence (multiset)', () => {
    const a = DynArrayF64.fromKeys([5, 5, 7]);
    expect(a.delete(5).removed).toBe(true);
    expect(a.keysInOrder()).toEqual([5, 7]);
  });

  it('delete emits a shift-compact stream that folds to the post-delete array', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30, 40]);
    const events: ArrayEvent[] = [];
    a.delete(20, (e) => events.push(e));
    // compares 10,20 (match) → removeTarget(1) → shift 2→1, 3→2 → pop → result.
    expect(events.map((e) => e.kind)).toEqual([
      'arr.compare', 'arr.compare', 'arr.removeTarget', 'arr.shift', 'arr.shift', 'arr.pop', 'arr.result',
    ]);
    expect(a.keysInOrder()).toEqual([10, 30, 40]);
  });

  it('delete agrees with a reference array over a random workload', () => {
    const keys = Array.from({ length: 120 }, (_, i) => (i * 13) % 37);
    const a = DynArrayF64.fromKeys(keys);
    const ref = keys.slice();
    for (const q of [0, 36, 5, 5, 99, 12, 24]) {
      const before = ref.indexOf(q);
      const res = a.delete(q);
      if (before === -1) {
        expect(res.removed).toBe(false);
      } else {
        expect(res.removed).toBe(true);
        ref.splice(before, 1); // remove first occurrence, preserve order
      }
      expect(a.keysInOrder()).toEqual(ref);
    }
  });
});
