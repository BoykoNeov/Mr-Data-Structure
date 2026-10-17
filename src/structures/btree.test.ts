import { describe, it, expect } from 'vitest';
import { BTREE_MIN_DEGREE, BTreeF64 } from './btree';

/**
 * Unit tests for the B-tree teaching twin (docs/PLAN.md §8; docs/METHODOLOGY.md §2.10).
 * Cross-language agreement lives in `conformance-btree.test.ts`; these pin the same
 * hand-checked op-counts as the Rust unit tests (so a drift fails locally, before the
 * corpus), a seeded random model check with duplicates everywhere, and the TS mirror of the
 * churn honesty pin — after warm-up an insert+delete pair of an edge key restructures
 * nothing.
 */

/** Same serialization as the corpus's `btree_levels`. */
function shape(b: BTreeF64): string {
  const lv = b.levels();
  if (lv.length === 0) return '-';
  return lv.map((level) => level.map((n) => n.join(',')).join(' ')).join(' | ');
}

/** A tiny seeded xorshift so the random check is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const totalEvents = (b: BTreeF64): number =>
  Object.values(b.eventCounts()).reduce((a, x) => a + x, 0);

describe('BTreeF64 — teaching impl (multiset B-tree of minimum degree t)', () => {
  it('ships at t = 16, matching the Rust MIN_DEGREE', () => {
    expect(BTREE_MIN_DEGREE).toBe(16);
    expect(new BTreeF64().t).toBe(16);
    expect(() => new BTreeF64(1)).toThrow();
  });

  it('keeps the sorted multiset, duplicates retained', () => {
    const b = BTreeF64.fromKeys([5, 3, 5, 1, 5, 3, 9, 5], 2);
    expect(b.keysInOrder()).toEqual([1, 3, 3, 5, 5, 5, 5, 9]);
    expect(b.size).toBe(8);
    expect(b.check()).toBeNull();
  });

  it('splits a full root before inserting (CLRS) — split + two probes', () => {
    const b = BTreeF64.fromKeys([1, 2, 3], 2);
    expect(shape(b)).toBe('1,2,3');
    expect(b.insert(4).ops).toBe(3);
    expect(shape(b)).toBe('2 | 1 3,4');
  });

  it('a split on the way down costs the split plus one side test', () => {
    const b = BTreeF64.fromKeys([1, 2, 3, 4, 5], 2);
    expect(shape(b)).toBe('2 | 1 3,4,5');
    expect(b.insert(6).ops).toBe(4);
    expect(shape(b)).toBe('2,4 | 1 3 5,6');
  });

  it('search is a lower-bound descent to a leaf with one deferred equality test', () => {
    const b = BTreeF64.fromKeys([1, 2, 3, 4, 5, 6], 2); // 2,4 | 1 3 5,6
    expect(b.profile(4)).toEqual({ found: true, ops: 4, nodeVisits: 2 });
    // Above the max there is never a candidate, so there is no equality test at all.
    expect(b.profile(99)).toEqual({ found: false, ops: 2, nodeVisits: 2 });
    for (const p of [0, 1, 2, 3.5, 6, 7]) expect(b.profile(p).nodeVisits).toBe(b.height);
  });

  it('replaces an internal key with the leaf predecessor, then borrows right', () => {
    const b = BTreeF64.fromKeys([1, 2, 3, 4, 5, 6, 7], 2);
    expect(shape(b)).toBe('2,4 | 1 3 5,6,7');
    expect(b.delete(4).removed).toBe(true);
    expect(shape(b)).toBe('2,5 | 1 3 6,7');
    expect(b.check()).toBeNull();
  });

  it('an empty tree costs nothing and a delete of an absent key changes nothing', () => {
    expect(new BTreeF64().search(1)).toEqual({ found: false, ops: 0 });
    expect(new BTreeF64().delete(1)).toEqual({ removed: false, ops: 0 });
    for (const t of [2, 3, 16]) {
      const b = BTreeF64.fromKeys(Array.from({ length: 300 }, (_, i) => i * 2), t);
      const before = shape(b);
      const ev = totalEvents(b);
      for (const p of [-1, 1, 299, 301, 1000]) expect(b.delete(p).removed).toBe(false);
      expect(shape(b)).toBe(before);
      expect(totalEvents(b)).toBe(ev);
    }
  });

  it('tracks a sorted-array multiset through random dup-heavy streams (t = 2, 3, 16)', () => {
    const next = rng(0xb7ee);
    for (const t of [2, 3, 16]) {
      for (let round = 0; round < 30; round++) {
        const b = new BTreeF64(t);
        const model: number[] = [];
        const ops = t === 16 ? 1200 : 200;
        for (let i = 0; i < ops; i++) {
          const k = Math.floor(next() * 9) - 4; // nine values ⇒ duplicates everywhere
          if (next() < 0.45) {
            const at = model.indexOf(k);
            expect(b.delete(k).removed).toBe(at !== -1);
            if (at !== -1) model.splice(at, 1);
          } else {
            b.insert(k);
            model.push(k);
          }
          if (i % 7 === 0 || t !== 16) {
            expect(b.check()).toBeNull();
            expect(b.keysInOrder()).toEqual([...model].sort((x, y) => x - y));
          }
        }
        expect(b.size).toBe(model.length);
        for (let q = -6; q <= 6; q++) expect(b.search(q).found).toBe(model.includes(q));
      }
    }
  });

  it('a drain exercises every repair path and empties the tree', () => {
    const b = BTreeF64.fromKeys(Array.from({ length: 40 }, (_, i) => i + 1), 2);
    const order = Array.from({ length: 40 }, (_, i) => ((i * 17) % 40) + 1);
    for (const k of order) {
      expect(b.delete(k).removed).toBe(true);
      expect(b.check()).toBeNull();
    }
    expect(b.size).toBe(0);
    expect(b.height).toBe(0);
    const ev = b.eventCounts();
    expect(ev.borrowLeft + ev.borrowRight).toBeGreaterThan(0);
    expect(ev.mergeLeft).toBeGreaterThan(0);
    expect(ev.mergeRight).toBeGreaterThan(0);
  });

  /**
   * The TS mirror of `btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`:
   * the repair-on-underflow delete has hysteresis, so once settled an insert+delete pair of
   * `min − 1` / `max + 1` splits, borrows and merges nothing, and its op-count stops moving.
   */
  it('churn at both ends settles into zero restructures', () => {
    for (const t of [2, 16]) {
      for (const n of [31, 100, 1000]) {
        const asc = Array.from({ length: n }, (_, i) => i);
        for (const keys of [asc, [...asc].reverse()]) {
          const b = BTreeF64.fromKeys(keys, t);
          const pair = (k: number): number => b.insert(k).ops + b.delete(k).ops;
          for (let i = 0; i < 32; i++) {
            pair(-1);
            pair(n);
          }
          const settled = [pair(-1), pair(n)];
          const ev = totalEvents(b);
          const nodes = b.nodeCount();
          for (let i = 0; i < 200; i++) {
            expect([pair(-1), pair(n)]).toEqual(settled);
          }
          expect(totalEvents(b)).toBe(ev);
          expect(b.nodeCount()).toBe(nodes);
          expect(b.size).toBe(n);
        }
      }
    }
  });
});
