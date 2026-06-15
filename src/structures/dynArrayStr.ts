/**
 * Teaching implementation of the unsorted dynamic array of **string** keys
 * (docs/PLAN.md §8, "Linear" family) — the TypeScript twin of the Rust bench
 * impl (bench-engine/src/structures/dyn_array_str.rs), and the string sibling of
 * {@link DynArrayF64}.
 *
 * Same algorithm as the numeric twin, different key type: a **multiset** (the
 * data layer never dedupes), linear scan from the front, cost metric
 * **comparisons** (one per element examined, short-circuiting on the first
 * match). String equality is JS `===`, which compares by code units — and since
 * both languages hash/compare the same UTF-8-decoded keys, the observable
 * results match Rust's byte comparison (asserted by the conformance corpus,
 * docs/PLAN.md §12).
 */

import type { SearchResult } from './dynArray';

export class DynArrayStr {
  private readonly data: string[] = [];

  /** Append a key (O(1) amortized). Duplicates are kept — multiset semantics. */
  insert(key: string): void {
    this.data.push(key);
  }

  /** Build from a key sequence by inserting each in order. */
  static fromKeys(keys: readonly string[]): DynArrayStr {
    const a = new DynArrayStr();
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
  search(target: string): SearchResult {
    let ops = 0;
    for (const k of this.data) {
      ops += 1;
      if (k === target) return { found: true, ops };
    }
    return { found: false, ops };
  }

  /** Keys in storage (= insertion) order; the array's iteration order. */
  keysInOrder(): string[] {
    return this.data.slice();
  }
}
