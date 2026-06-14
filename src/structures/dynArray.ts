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
 * first match).
 */

/** Result of a search: membership plus the structure's cost-metric op-count. */
export interface SearchResult {
  readonly found: boolean;
  /** Comparisons performed (the array's declared cost metric, docs/PLAN.md §8). */
  readonly ops: number;
}

export class DynArrayF64 {
  private readonly data: number[] = [];

  /** Append a key (O(1) amortized). Duplicates are kept — multiset semantics. */
  insert(key: number): void {
    this.data.push(key);
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
  search(target: number): SearchResult {
    let ops = 0;
    for (const k of this.data) {
      ops += 1;
      if (k === target) return { found: true, ops };
    }
    return { found: false, ops };
  }

  /** Keys in storage (= insertion) order; the array's iteration order. */
  keysInOrder(): number[] {
    return this.data.slice();
  }
}
