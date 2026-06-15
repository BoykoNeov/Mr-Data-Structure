import { describe, it, expect } from 'vitest';
import { MinHeapF64 } from './heap';
import type { HeapEvent } from '../viz/events';

/** Assert the min-heap property over the backing array: every parent ≤ its
 * children. This is the structural invariant the sifts must preserve. */
function assertHeap(arr: readonly number[]): void {
  for (let i = 0; i < arr.length; i++) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    if (l < arr.length) expect(arr[i]).toBeLessThanOrEqual(arr[l]);
    if (r < arr.length) expect(arr[i]).toBeLessThanOrEqual(arr[r]);
  }
}

describe('MinHeapF64 — teaching impl (array-backed binary min-heap)', () => {
  it('fromKeys builds a valid heap with the minimum at the root', () => {
    const h = MinHeapF64.fromKeys([50, 30, 70, 20, 40, 60, 10]);
    expect(h.size).toBe(7);
    assertHeap(h.toArray());
    expect(h.toArray()[0]).toBe(10);
    expect(h.peek().min).toBe(10);
  });

  it('insert sifts a new minimum all the way to the root', () => {
    const h = MinHeapF64.fromKeys([20, 30, 40]);
    const r = h.insert(5);
    expect(h.toArray()[0]).toBe(5);
    assertHeap(h.toArray());
    // 5 rises from a leaf to the root: comparisons + swaps both > 0.
    expect(r.ops).toBeGreaterThan(0);
  });

  it('inserting a new maximum stays put (one comparison, no swap)', () => {
    const h = MinHeapF64.fromKeys([10, 20, 30]);
    const r = h.insert(99); // bigger than its parent → no sift
    expect(r.ops).toBe(1); // one comparison, zero swaps
    assertHeap(h.toArray());
  });

  it('extract-min returns the keys in ascending order (heap-sort)', () => {
    const input = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0];
    const h = MinHeapF64.fromKeys(input);
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const r = h.extractMin();
      out.push(r.min!);
      assertHeap(h.toArray()); // invariant holds after every extraction
    }
    expect(out).toEqual([...input].sort((a, b) => a - b));
    expect(h.size).toBe(0);
  });

  it('peek does not mutate; extract-min on an empty heap is undefined', () => {
    const h = MinHeapF64.fromKeys([10, 20]);
    expect(h.peek().min).toBe(10);
    expect(h.size).toBe(2);
    expect(h.extractMin().min).toBe(10);
    expect(h.extractMin().min).toBe(20);
    expect(h.extractMin().min).toBeUndefined();
    expect(h.peek().min).toBeUndefined();
  });

  it('keeps duplicates (multiset) and extracts them too', () => {
    const h = MinHeapF64.fromKeys([5, 5, 5, 1, 5]);
    expect(h.size).toBe(5);
    const out = [h.extractMin().min, h.extractMin().min, h.extractMin().min];
    expect(out).toEqual([1, 5, 5]);
  });

  it('search is an O(n) scan agreeing with a reference set', () => {
    const keys = [50, 30, 70, 20, 40, 60, 10];
    const h = MinHeapF64.fromKeys(keys);
    const ref = new Set(keys);
    for (let q = 0; q <= 80; q += 5) expect(h.search(q).found).toBe(ref.has(q));
    // absent key scans the whole array.
    expect(h.search(999).ops).toBe(h.size);
  });

  it('round-trips a churn of inserts and extracts, invariant held throughout', () => {
    const h = new MinHeapF64();
    const ref: number[] = [];
    for (const k of [42, 17, 88, 13, 60, 99, 1, 55, 17, 23, 8, 71]) {
      h.insert(k);
      ref.push(k);
      assertHeap(h.toArray());
    }
    ref.sort((a, b) => a - b);
    const out: number[] = [];
    while (h.size > 0) {
      out.push(h.extractMin().min!);
      assertHeap(h.toArray());
    }
    expect(out).toEqual(ref);
  });

  it('emits a cost stream (compares + scans + swaps) whose length is the op-count', () => {
    for (const run of [
      (h: MinHeapF64, push: (e: HeapEvent) => void) => h.insert(5, push),
      (h: MinHeapF64, push: (e: HeapEvent) => void) => h.extractMin(push),
      (h: MinHeapF64, push: (e: HeapEvent) => void) => h.search(40, push),
    ]) {
      const h = MinHeapF64.fromKeys([50, 30, 70, 20, 40, 60, 10]);
      const events: HeapEvent[] = [];
      run(h, (e) => events.push(e));
      const cost = events.filter(
        (e) => e.kind === 'heap.compare' || e.kind === 'heap.scan' || e.kind === 'heap.swap',
      ).length;
      // The op's reported ops equals the cost-event count — re-derive ops by re-running.
      const fresh = MinHeapF64.fromKeys([50, 30, 70, 20, 40, 60, 10]);
      const ops =
        events[0]?.kind === 'heap.scan'
          ? fresh.search(40).ops
          : events[0]?.kind === 'heap.append'
            ? fresh.insert(5).ops
            : fresh.extractMin().ops;
      expect(cost).toBe(ops);
    }
  });
});
