import { describe, it, expect } from 'vitest';
import { AvlF64, type AvlShape } from './avl';
import type { AvlEvent } from '../viz/events';

/** In-order traversal of a valid search tree is non-decreasing. */
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

/** Recompute a node's height from the snapshot and assert the AVL invariant holds
 * at *every* node (|balance factor| ≤ 1). Returns the height so parents can check
 * theirs. Throws via `expect` on the first violation — a strong structural check
 * that the rebalancing actually ran (in-order alone can't see imbalance). */
function avlHeight(shape: AvlShape | null): number {
  if (shape === null) return 0;
  const hl = avlHeight(shape.left);
  const hr = avlHeight(shape.right);
  expect(Math.abs(hr - hl)).toBeLessThanOrEqual(1);
  return 1 + Math.max(hl, hr);
}

describe('AvlF64 — teaching impl (balanced multiset AVL)', () => {
  it('fromKeys builds a balanced search tree; keysInOrder is sorted, duplicates kept', () => {
    const t = AvlF64.fromKeys([50, 30, 70, 30, 20, 60]);
    expect(t.keysInOrder()).toEqual([20, 30, 30, 50, 60, 70]);
    expect(t.size).toBe(6);
    avlHeight(t.snapshot());
  });

  it('insert descends RIGHT on an equal key (multiset, never collapses)', () => {
    const t = AvlF64.fromKeys([50]);
    t.insert(50);
    expect(t.size).toBe(2);
    expect(t.keysInOrder()).toEqual([50, 50]);
  });

  // ── The four rotation cases, each from three insertions. ──
  it('LL case → single right rotation', () => {
    const t = AvlF64.fromKeys([30, 20, 10]);
    expect(t.snapshot()).toEqual({
      value: 20,
      left: { value: 10, left: null, right: null },
      right: { value: 30, left: null, right: null },
    });
  });

  it('RR case → single left rotation', () => {
    const t = AvlF64.fromKeys([10, 20, 30]);
    expect(t.snapshot()!.value).toBe(20);
    expect(t.keysInOrder()).toEqual([10, 20, 30]);
    avlHeight(t.snapshot());
  });

  it('LR case → double rotation (2 rotations counted)', () => {
    const t = new AvlF64();
    t.insert(30);
    t.insert(10);
    const r = t.insert(20); // 30 ← 10 → 20: LR at 30
    expect(t.snapshot()!.value).toBe(20);
    expect(r.ops).toBe(2 + 2); // 2 comparisons descending + 2 rotations (double)
    avlHeight(t.snapshot());
  });

  it('RL case → double rotation', () => {
    const t = AvlF64.fromKeys([10, 30, 20]); // 10 → 30 ← 20: RL at 10
    expect(t.snapshot()!.value).toBe(20);
    expect(t.keysInOrder()).toEqual([10, 20, 30]);
    avlHeight(t.snapshot());
  });

  it('stays O(log n) on sorted input (where the naive BST degenerates)', () => {
    const n = 100;
    const t = new AvlF64();
    for (let i = 1; i <= n; i++) t.insert(i); // strictly increasing — worst case for a BST
    expect(t.keysInOrder()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    // A naive BST would be height n (=100). AVL bound is < 1.44·log₂(n+2).
    expect(t.height).toBeLessThanOrEqual(Math.ceil(1.44 * Math.log2(n + 2)));
    avlHeight(t.snapshot());
  });

  it('search reports membership and a comparison count bounded by height', () => {
    const t = AvlF64.fromKeys([50, 30, 70, 20, 40, 60, 80]);
    expect(t.search(50).found).toBe(true);
    const hit = t.search(20);
    expect(hit.found).toBe(true);
    expect(hit.ops).toBeLessThanOrEqual(t.height);
    const miss = t.search(35);
    expect(miss.found).toBe(false);
    expect(miss.ops).toBeLessThanOrEqual(t.height);
  });

  it('search agrees with a reference set over a varied workload', () => {
    const keys = Array.from({ length: 200 }, (_, i) => (i * 31) % 97);
    const t = AvlF64.fromKeys(keys);
    const ref = new Set(keys);
    expect(t.keysInOrder()).toEqual(sorted(keys));
    avlHeight(t.snapshot());
    for (let q = -5; q < 105; q++) expect(t.search(q).found).toBe(ref.has(q));
  });

  it('delete removes a leaf and keeps the tree balanced', () => {
    const t = AvlF64.fromKeys([50, 30, 70, 20, 40, 60, 80]);
    expect(t.delete(20).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([30, 40, 50, 60, 70, 80]);
    avlHeight(t.snapshot());
  });

  it('delete a two-child node copies the in-order successor up', () => {
    const t = AvlF64.fromKeys([50, 30, 70, 60, 80]);
    expect(t.delete(70).removed).toBe(true);
    expect(t.keysInOrder()).toEqual([30, 50, 60, 80]);
    avlHeight(t.snapshot());
  });

  it('delete can trigger a rebalancing rotation', () => {
    // 50 ← 30,70 ← 80 ; deleting 30 makes the root right-heavy → a left rotation.
    const t = AvlF64.fromKeys([50, 30, 70, 80]);
    const r = t.delete(30, () => {});
    expect(r.removed).toBe(true);
    avlHeight(t.snapshot());
  });

  it('delete the root down to empty', () => {
    const t = AvlF64.fromKeys([42]);
    expect(t.delete(42).removed).toBe(true);
    expect(t.size).toBe(0);
    expect(t.snapshot()).toBeNull();
  });

  it('insert/delete round-trips against a reference multiset, staying balanced', () => {
    const t = new AvlF64();
    const ref: number[] = [];
    const add = (k: number) => {
      t.insert(k);
      ref.push(k);
      expect(t.keysInOrder()).toEqual(sorted(ref));
      avlHeight(t.snapshot());
    };
    const del = (k: number) => {
      const res = t.delete(k);
      const idx = ref.indexOf(k);
      if (idx === -1) expect(res.removed).toBe(false);
      else {
        expect(res.removed).toBe(true);
        ref.splice(idx, 1);
      }
      expect(t.keysInOrder()).toEqual(sorted(ref));
      expect(t.size).toBe(ref.length);
      avlHeight(t.snapshot());
    };
    for (const k of [42, 17, 17, 88, 13, 60, 17, 99, 1, 55, 5, 23, 71, 8]) add(k);
    for (const k of [17, 42, 99, 5, 17, 1, 88, 60, 17, 13, 55, 23, 71, 8]) del(k);
    expect(t.keysInOrder()).toEqual([]);
  });

  it('emits a compare+rotate stream whose length is the op-count', () => {
    const t = new AvlF64();
    for (const k of [10, 20, 30, 40, 50]) t.insert(k); // sorted run → rotations on the way
    const events: AvlEvent[] = [];
    const r = t.insert(60, (e) => events.push(e));
    const cost = events.filter((e) => e.kind === 'avl.compare' || e.kind === 'avl.rotate').length;
    expect(cost).toBe(r.ops);
    expect(events.filter((e) => e.kind === 'avl.insert').length).toBe(1);
  });
});
