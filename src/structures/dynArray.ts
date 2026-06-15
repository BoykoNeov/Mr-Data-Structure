/**
 * Teaching implementation of the unsorted dynamic array (docs/PLAN.md §8,
 * "Linear" family) — the TypeScript twin of the Rust bench impl
 * (bench-engine/src/structures/dyn_array.rs).
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm as the benchmarked Rust impl so the user animates exactly what they
 * measure. Phase 2 only needs the observable surface the conformance corpus
 * asserts on (docs/PLAN.md §12) — membership, iteration order, and op-count;
 * the animation step-event stream is Phase 3.
 *
 * Semantics: a **multiset** — duplicates are kept (the data layer never dedupes),
 * matching the Rust impl. Search is a linear scan from the front; the cost
 * metric is **comparisons** (one per element examined, short-circuiting on the
 * first match). `delete` is the ordered shift-compact (docs/PLAN.md §8): scan for
 * the first occurrence (comparisons), then shift the tail left to close the gap.
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5). The tracer is threaded *alongside* the existing
 * op-count logic: each cost event is emitted exactly where the counter ticks, so
 * the stream's cost-event count equals the op-count (the invariant pinned in
 * `src/viz/trace.test.ts`). The optional-call short-circuits argument evaluation,
 * so the untraced path allocates nothing and stays byte-identical (conformance).
 */

import type { Tracer, ArrayEvent } from '../viz/events';

/** Result of a search: membership plus the structure's cost-metric op-count. */
export interface SearchResult {
  readonly found: boolean;
  /** Comparisons performed (the array's declared cost metric, docs/PLAN.md §8). */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the cost-metric op-count
 * (comparisons to find it + shifts to compact). */
export interface DeleteResult {
  readonly removed: boolean;
  /** Comparisons + shifts (the array's declared cost metric, docs/PLAN.md §8). */
  readonly ops: number;
}

export class DynArrayF64 {
  private readonly data: number[] = [];

  /** Append a key (O(1) amortized). Duplicates are kept — multiset semantics. */
  insert(key: number, trace?: Tracer<ArrayEvent>): void {
    this.data.push(key);
    trace?.({ kind: 'arr.append', value: key });
  }

  /** Build from a key sequence by inserting each in order. */
  static fromKeys(keys: readonly number[]): DynArrayF64 {
    const a = new DynArrayF64();
    for (const k of keys) a.insert(k);
    return a;
  }

  /** Number of stored keys (`n`). */
  get size(): number {
    return this.data.length;
  }

  /**
   * Linear scan from the front. Returns membership and the comparison count:
   * the 1-based position of the first match, or `n` for an absent key — exactly
   * the Rust impl's `search_one_counted`.
   */
  search(target: number, trace?: Tracer<ArrayEvent>): SearchResult {
    let ops = 0;
    for (let i = 0; i < this.data.length; i++) {
      ops += 1;
      const matched = this.data[i] === target;
      trace?.({ kind: 'arr.compare', index: i, target, matched });
      if (matched) {
        trace?.({ kind: 'arr.result', found: true });
        return { found: true, ops };
      }
    }
    trace?.({ kind: 'arr.result', found: false });
    return { found: false, ops };
  }

  /**
   * Ordered shift-compact delete of the first occurrence (docs/PLAN.md §8), the
   * TS twin of the Rust `remove_first`: scan for `target` (one comparison each),
   * then shift every later element one slot left and drop the tail. Returns
   * membership and the op-count (comparisons + shifts). Mutates the array.
   */
  delete(target: number, trace?: Tracer<ArrayEvent>): DeleteResult {
    let ops = 0;
    let found = -1;
    for (let i = 0; i < this.data.length; i++) {
      ops += 1;
      const matched = this.data[i] === target;
      trace?.({ kind: 'arr.compare', index: i, target, matched });
      if (matched) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      trace?.({ kind: 'arr.result', found: false });
      return { removed: false, ops };
    }
    trace?.({ kind: 'arr.removeTarget', index: found });
    // Shift the tail left to close the gap (one shift per element moved).
    for (let j = found + 1; j < this.data.length; j++) {
      ops += 1;
      this.data[j - 1] = this.data[j];
      trace?.({ kind: 'arr.shift', from: j, to: j - 1 });
    }
    this.data.pop();
    trace?.({ kind: 'arr.pop' });
    trace?.({ kind: 'arr.result', found: true });
    return { removed: true, ops };
  }

  /** Keys in storage (= insertion) order; the array's iteration order. */
  keysInOrder(): number[] {
    return this.data.slice();
  }
}
