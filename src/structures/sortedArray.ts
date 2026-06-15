/**
 * Teaching implementation of the sorted dynamic array (docs/PLAN.md §8,
 * "Linear" family) — the TypeScript twin of the Phase 4 Rust bench impl.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm the benchmark will measure. The Rust twin lands in Phase 4; this
 * batch (Phase 3 breadth) implements the teaching + animation surface, so the
 * canonical algorithm is fixed here for Phase 4 to mirror.
 *
 * Semantics: a **sorted multiset** — keys are kept ascending and duplicates are
 * retained (the data layer never dedupes, docs/PLAN.md "Keys are identity").
 * `search` is a binary search; the cost metric is **comparisons** (one per
 * midpoint examined). `insert` binary-searches the position then shifts the tail
 * right to open the gap; `delete` binary-searches the key then shifts the tail
 * left to compact (docs/PLAN.md §8 cost metric "comparisons + shifts").
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5). Each `sarr.compare` is emitted exactly where the
 * comparison counter ticks, so a *search* stream's cost-event count equals its
 * op-count (the invariant pinned in `src/viz/trace.linear.test.ts`). The
 * optional-call short-circuits the untraced path so it allocates nothing.
 */

import type { Tracer, SortedArrayEvent } from '../viz/events';

/** Result of a search: membership plus the structure's cost-metric op-count. */
export interface SearchResult {
  readonly found: boolean;
  /** Comparisons performed (binary search), the sorted array's cost metric. */
  readonly ops: number;
}

/** Result of an insert: the cost-metric op-count (comparisons + shifts). */
export interface InsertResult {
  /** Comparisons (binary search) + shifts (open the gap). */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the cost-metric op-count
 * (comparisons to find it + shifts to compact). */
export interface DeleteResult {
  readonly removed: boolean;
  /** Comparisons (binary search) + shifts (compact the tail). */
  readonly ops: number;
}

/** Where a binary search landed: the matching index (or the insertion point if
 * absent), whether the key was found, and the comparisons performed. */
interface Located {
  readonly index: number;
  readonly found: boolean;
  readonly ops: number;
}

export class SortedArrayF64 {
  private readonly data: number[] = [];

  /** Build by inserting each key in order — the array sorts itself. */
  static fromKeys(keys: readonly number[]): SortedArrayF64 {
    const a = new SortedArrayF64();
    for (const k of keys) a.insert(k);
    return a;
  }

  /** Number of stored keys (`n`). */
  get size(): number {
    return this.data.length;
  }

  /**
   * Binary search over the half-open window `[lo, hi)`. Emits one `sarr.compare`
   * per midpoint (the comparison counter), short-circuiting on an exact match.
   * On a miss, `index` is the insertion point (`lo`) that keeps the array sorted.
   * With duplicates this finds *some* occurrence — fine for a multiset.
   */
  private locate(target: number, trace?: Tracer<SortedArrayEvent>): Located {
    let ops = 0;
    let lo = 0;
    let hi = this.data.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      ops += 1;
      const v = this.data[mid];
      const matched = v === target;
      trace?.({ kind: 'sarr.compare', index: mid, lo, hi, target, matched });
      if (matched) return { index: mid, found: true, ops };
      if (v < target) lo = mid + 1;
      else hi = mid;
    }
    return { index: lo, found: false, ops };
  }

  /** Binary search for membership; returns it plus the comparison count. */
  search(target: number, trace?: Tracer<SortedArrayEvent>): SearchResult {
    const r = this.locate(target, trace);
    trace?.({ kind: 'sarr.result', found: r.found });
    return { found: r.found, ops: r.ops };
  }

  /**
   * Insert `key` keeping the array sorted (multiset — duplicates retained):
   * binary-search the position (comparisons), open a tail slot, shift the
   * survivors right one at a time so the hole bubbles back to the insertion
   * point, then drop `key` in. Returns the op-count (comparisons + shifts).
   */
  insert(key: number, trace?: Tracer<SortedArrayEvent>): InsertResult {
    const r = this.locate(key, trace);
    let ops = r.ops;
    const n = this.data.length;
    const i = r.index;
    trace?.({ kind: 'sarr.appendHole' });
    // Bubble the tail hole left to `i`; each survivor shifts one slot right.
    for (let j = n - 1; j >= i; j--) {
      ops += 1;
      trace?.({ kind: 'sarr.shift', from: j, to: j + 1 });
    }
    trace?.({ kind: 'sarr.fill', index: i, value: key });
    this.data.splice(i, 0, key);
    return { ops };
  }

  /**
   * Delete the first occurrence found by binary search: shift the tail left to
   * close the gap, then drop the duplicated tail slot. Returns membership and
   * the op-count (comparisons + shifts). Mutates the array.
   */
  delete(target: number, trace?: Tracer<SortedArrayEvent>): DeleteResult {
    const r = this.locate(target, trace);
    let ops = r.ops;
    if (!r.found) {
      trace?.({ kind: 'sarr.result', found: false });
      return { removed: false, ops };
    }
    const i = r.index;
    trace?.({ kind: 'sarr.removeTarget', index: i });
    const n = this.data.length;
    // Shift the tail left to close the gap (one shift per survivor moved).
    for (let j = i + 1; j < n; j++) {
      ops += 1;
      trace?.({ kind: 'sarr.shift', from: j, to: j - 1 });
    }
    trace?.({ kind: 'sarr.pop' });
    trace?.({ kind: 'sarr.result', found: true });
    this.data.splice(i, 1); // net effect of the shift-left + pop on the backing
    return { removed: true, ops };
  }

  /** Keys in ascending (= iteration) order. */
  keysInOrder(): number[] {
    return this.data.slice();
  }
}
