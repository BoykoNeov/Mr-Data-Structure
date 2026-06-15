/**
 * Teaching implementation of the **binary min-heap** (docs/PLAN.md §8, "Trees /
 * heaps") — the TypeScript twin of the Phase 4 Rust bench impl.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm the benchmark will measure; the Rust twin (and a cross-language
 * conformance corpus) land in Phase 4, so the canonical algorithm is fixed here
 * for them to mirror.
 *
 * Representation: the classic **array-backed complete tree** — position `i`'s
 * children are `2i+1` / `2i+2`, its parent `⌊(i-1)/2⌋` — so the renderer draws the
 * one array as both an array and an implicit tree (docs/PLAN.md §5). The heap holds
 * a multiset (duplicates kept; keys are identity, docs/PLAN.md "never dedupe").
 *
 * **A different op set (docs/PLAN.md §4.1, §8): insert / peek / extract-min**, with
 * `search` kept only as an O(n) linear-scan **contrast** (a heap is ordered for
 * *extract-min*, not membership — the demo makes the point that searching it is no
 * better than an unsorted array). So the heap is compared only within its own group,
 * never against the insert/search/delete structures (docs/PLAN.md §8, risk R6).
 *
 * **Cost metric — comparisons + swaps (docs/PLAN.md §8).** `ops` counts key
 * comparisons (sift comparisons; search-scan comparisons) **plus** swaps. The
 * structural "move the last element to the root" of extract-min is *not* a
 * compare-driven swap and is not counted. The Phase 4 Rust op-counter must count
 * the same way (risk R1).
 *
 * Every op accepts an optional {@link Tracer} that yields the animation step-events
 * (docs/PLAN.md §5). Each `heap.compare` / `heap.scan` / `heap.swap` is emitted
 * exactly where the cost counter ticks, so any op's cost-event count equals its
 * op-count (the invariant pinned in `src/viz/trace.heap.test.ts`).
 */

import type { Tracer, HeapEvent } from '../viz/events';

/** Result of an insert: the cost-metric op-count (comparisons + swaps to sift up). */
export interface InsertResult {
  readonly ops: number;
}

/** Result of an extract-min: the removed minimum (`undefined` if empty) plus the
 * comparisons + swaps of the sift-down. */
export interface ExtractResult {
  readonly min: number | undefined;
  readonly ops: number;
}

/** Result of the O(n) contrast search: membership plus the comparison count. */
export interface SearchResult {
  readonly found: boolean;
  readonly ops: number;
}

/** Result of a peek: the minimum without removing it (`undefined` if empty). O(1). */
export interface PeekResult {
  readonly min: number | undefined;
}

export class MinHeapF64 {
  /** The backing array; index 0 is the root (the minimum). */
  private readonly heap: number[] = [];

  /** Build by inserting each key in order (each sifts up into place). */
  static fromKeys(keys: readonly number[]): MinHeapF64 {
    const h = new MinHeapF64();
    for (const k of keys) h.insert(k);
    return h;
  }

  /** Number of stored keys (`n`). */
  get size(): number {
    return this.heap.length;
  }

  /** A copy of the backing array (heap order, not sorted) — seeds the display model. */
  toArray(): number[] {
    return this.heap.slice();
  }

  private swap(i: number, j: number): void {
    const t = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = t;
  }

  /**
   * Insert `key`: append at the tail, then **sift up** — while it is smaller than
   * its parent, swap them. Emits `heap.append`, then per level a `heap.compare`
   * (child vs parent) and, while it keeps rising, a `heap.swap`. Returns
   * comparisons + swaps.
   */
  insert(key: number, trace?: Tracer<HeapEvent>): InsertResult {
    let ops = 0;
    this.heap.push(key);
    trace?.({ kind: 'heap.append', value: key });
    let i = this.heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      ops += 1;
      const childSmaller = this.heap[i] < this.heap[p];
      trace?.({ kind: 'heap.compare', a: i, b: p, winner: childSmaller ? i : p });
      if (!childSmaller) break;
      this.swap(i, p);
      ops += 1;
      trace?.({ kind: 'heap.swap', i, j: p });
      i = p;
    }
    return { ops };
  }

  /** Read the minimum (root) without removing it (O(1), no cost). */
  peek(trace?: Tracer<HeapEvent>): PeekResult {
    if (this.heap.length === 0) {
      trace?.({ kind: 'heap.result', found: false });
      return { min: undefined };
    }
    trace?.({ kind: 'heap.peek', value: this.heap[0] });
    trace?.({ kind: 'heap.result', found: true });
    return { min: this.heap[0] };
  }

  /**
   * Extract the minimum: take the root, move the last element into the root slot,
   * then **sift down** — while a child is smaller, swap with the smaller child.
   * Emits `heap.extractRoot` (the min leaving) and `heap.replaceRoot` (the refill),
   * then per level the child-vs-child and parent-vs-child `heap.compare`s and the
   * `heap.swap`s. Returns the minimum and comparisons + swaps.
   */
  extractMin(trace?: Tracer<HeapEvent>): ExtractResult {
    if (this.heap.length === 0) {
      trace?.({ kind: 'heap.result', found: false });
      return { min: undefined, ops: 0 };
    }
    let ops = 0;
    const min = this.heap[0];
    trace?.({ kind: 'heap.extractRoot', value: min });
    const last = this.heap.pop()!;
    if (this.heap.length === 0) {
      // The heap held a single element — popping the root emptied it; nothing sifts.
      trace?.({ kind: 'heap.replaceRoot', value: min });
      trace?.({ kind: 'heap.result', found: true });
      return { min, ops };
    }
    this.heap[0] = last;
    trace?.({ kind: 'heap.replaceRoot', value: last });
    const n = this.heap.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l >= n) break;
      let smaller = l;
      if (r < n) {
        ops += 1;
        const rightSmaller = this.heap[r] < this.heap[l];
        trace?.({ kind: 'heap.compare', a: l, b: r, winner: rightSmaller ? r : l });
        if (rightSmaller) smaller = r;
      }
      ops += 1;
      const childSmaller = this.heap[smaller] < this.heap[i];
      trace?.({ kind: 'heap.compare', a: i, b: smaller, winner: childSmaller ? smaller : i });
      if (!childSmaller) break;
      this.swap(i, smaller);
      ops += 1;
      trace?.({ kind: 'heap.swap', i, j: smaller });
      i = smaller;
    }
    trace?.({ kind: 'heap.result', found: true });
    return { min, ops };
  }

  /** O(n) linear scan for `target` — the deliberate contrast op (docs/PLAN.md §8):
   * a heap gives no search shortcut, so this walks every slot until a match. Returns
   * membership and the comparison count. */
  search(target: number, trace?: Tracer<HeapEvent>): SearchResult {
    let ops = 0;
    for (let i = 0; i < this.heap.length; i++) {
      ops += 1;
      const matched = this.heap[i] === target;
      trace?.({ kind: 'heap.scan', index: i, target, matched });
      if (matched) {
        trace?.({ kind: 'heap.result', found: true });
        return { found: true, ops };
      }
    }
    trace?.({ kind: 'heap.result', found: false });
    return { found: false, ops };
  }
}
