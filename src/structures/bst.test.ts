import { describe, it, expect } from 'vitest';
import { BstF64 } from './bst';
import type { BstEvent } from '../viz/events';

/** In-order traversal of a valid BST is non-decreasing — the structural
 * invariant. Asserting `keysInOrder()` equals the sorted multiset is therefore a
 * sufficient correctness check for the *structure* (unlike the renderer's fold
 * test, where the same in-order can come from different shapes). */
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

describe('BstF64 — teaching impl (unbalanced multiset BST)', () => {
  it('fromKeys builds a search tree; keysInOrder is sorted, duplicates kept', () => {
    const t = BstF64.fromKeys([50, 30, 70, 30, 20, 60]);
    expect(t.keysInOrder()).toEqual([20, 30, 30, 50, 60, 70]);
    expect(t.size).toBe(6);
  });

  it('insert descends RIGHT on an equal key (multiset, never collapses)', () => {
    const t = BstF64.fromKeys([50]);
    t.insert(50); // equal to the root ⇒ right subtree, not a no-op
    expect(t.size).toBe(2);
    const s = t.snapshot()!;
    expect(s.value).toBe(50);
    expect(s.left).toBeNull();
    expect(s.right).toEqual({ value: 50, left: null, right: null });
  });

  it('search reports membership and a comparison count bounded by height', () => {
    const t = BstF64.fromKeys([50, 30, 70, 20, 40, 60, 80]); // balanced, height 3
    expect(t.search(50)).toEqual({ found: true, ops: 1 }); // root hit
    expect(t.search(20)).toEqual({ found: true, ops: 3 }); // 50→30→20
    const miss = t.search(35);
    expect(miss.found).toBe(false);
    expect(miss.ops).toBeLessThanOrEqual(3);
  });

  it('degenerates to a chain (O(n) search) on sorted input', () => {
    const t = BstF64.fromKeys([10, 20, 30, 40, 50]); // each key is a new right child
    // The deepest key needs n comparisons — the sorted-data degeneration demo.
    expect(t.search(50)).toEqual({ found: true, ops: 5 });
    expect(t.keysInOrder()).toEqual([10, 20, 30, 40, 50]);
  });

  it('search agrees with a reference set over a varied workload', () => {
    const keys = Array.from({ length: 200 }, (_, i) => (i * 31) % 97);
    const t = BstF64.fromKeys(keys);
    const ref = new Set(keys);
    expect(t.keysInOrder()).toEqual(sorted(keys));
    for (let q = -5; q < 105; q++) expect(t.search(q).found).toBe(ref.has(q));
  });

  it('delete removes a leaf, counting only the find comparisons', () => {
    const t = BstF64.fromKeys([50, 30, 70, 20]);
    const r = t.delete(20); // leaf: 50→30→20 = 3 comparisons
    expect(r).toEqual({ removed: true, ops: 3 });
    expect(t.keysInOrder()).toEqual([30, 50, 70]);
  });

  it('delete splices a one-child node — child on the LEFT', () => {
    const t = BstF64.fromKeys([50, 30, 20]); // 30 has only a left child (20)
    expect(t.delete(30).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([20, 50]);
    const s = t.snapshot()!;
    expect(s.left).toEqual({ value: 20, left: null, right: null }); // 20 took 30's place
  });

  it('delete splices a one-child node — child on the RIGHT', () => {
    const t = BstF64.fromKeys([50, 30, 40]); // 30 has only a right child (40)
    expect(t.delete(30).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([40, 50]);
    expect(t.snapshot()!.left).toEqual({ value: 40, left: null, right: null });
  });

  it('delete a two-child node copies the in-order successor up', () => {
    const t = BstF64.fromKeys([50, 30, 70, 60, 80]); // 70 has children 60 (L) and 80 (R)
    expect(t.delete(70).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([30, 50, 60, 80]);
    // successor of 70 = min of its right subtree = 80, copied up; 60 stays the left child.
    expect(t.snapshot()!.right).toEqual({ value: 80, left: { value: 60, left: null, right: null }, right: null });
  });

  it('delete the root (two children) keeps a valid tree', () => {
    const t = BstF64.fromKeys([50, 30, 70, 20, 40, 60, 80]);
    expect(t.delete(50).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([20, 30, 40, 60, 70, 80]);
    expect(t.snapshot()!.value).toBe(60); // in-order successor of 50
  });

  it('delete the root down to empty', () => {
    const t = BstF64.fromKeys([42]);
    expect(t.delete(42).removed).toBe(true);
    expect(t.size).toBe(0);
    expect(t.snapshot()).toBeNull();
    expect(t.keysInOrder()).toEqual([]);
  });

  it('delete removes only one of several duplicates', () => {
    const t = BstF64.fromKeys([50, 50, 50, 70]);
    expect(t.delete(50).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([50, 50, 70]);
    expect(t.size).toBe(3);
    expect(t.delete(99).removed).toBe(false); // absent
  });

  it('insert/delete round-trips against a reference multiset', () => {
    const t = new BstF64();
    const ref: number[] = [];
    const add = (k: number) => {
      t.insert(k);
      ref.push(k);
    };
    const del = (k: number) => {
      const res = t.delete(k);
      const idx = ref.indexOf(k);
      if (idx === -1) expect(res.removed).toBe(false);
      else {
        expect(res.removed).toBe(true);
        ref.splice(idx, 1);
      }
      // in-order == sorted multiset proves the BST invariant held through the op.
      expect(t.keysInOrder()).toEqual(sorted(ref));
      expect(t.size).toBe(ref.length);
    };
    for (const k of [42, 17, 17, 88, 13, 60, 17, 99, 1, 55]) add(k);
    for (const k of [17, 42, 99, 5, 17, 1, 88, 60, 17, 13, 55]) del(k);
    expect(t.keysInOrder()).toEqual([]);
  });

  it('emits a compare stream whose length is the op-count, ending in a result', () => {
    const t = BstF64.fromKeys([50, 30, 70, 20, 40]);
    for (const op of ['search', 'delete'] as const) {
      const fresh = BstF64.fromKeys([50, 30, 70, 20, 40]);
      const events: BstEvent[] = [];
      const r = op === 'search' ? fresh.search(40, (e) => events.push(e)) : fresh.delete(40, (e) => events.push(e));
      const compares = events.filter((e) => e.kind === 'bst.compare');
      expect(compares.length).toBe(r.ops);
      expect(events[events.length - 1]).toEqual({ kind: 'bst.result', found: true });
    }
    expect(t.size).toBe(5); // the shared tree above was untouched
  });
});
