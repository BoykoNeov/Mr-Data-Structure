/**
 * Teaching implementation of the unsorted dynamic array of **string** keys
 * (docs/PLAN.md §8, "Linear" family) — the TypeScript twin of the Rust bench
 * impl (bench-engine/src/structures/dyn_array_str.rs), and the string sibling of
 * {@link DynArrayF64}.
 *
 * Same algorithm as the numeric twin, different key type: a **multiset** (the
 * data layer never dedupes), linear scan from the front, cost metric
 * **comparisons** (one per element examined, short-circuiting on the first
 * match); `delete` is the ordered shift-compact, costing comparisons + shifts.
 * String equality is JS `===`, which compares by code units — and since both
 * languages hash/compare the same UTF-8-decoded keys, the observable results
 * match Rust's byte comparison (asserted by the conformance corpus, docs/PLAN.md
 * §12, which pins search, the delete sequence and what it leaves behind).
 *
 * One comparison is one *whole-key* test, as Rust counts it — never one per byte.
 * Rust's `==` on two string slices checks the byte lengths first and only then
 * compares bytes, so a key of a different UTF-8 length is rejected without reading
 * any; that changes what a comparison costs on the clock, not the count. The
 * Explore captions say so (docs/PLAN.md §5).
 *
 * Every op accepts an optional {@link Tracer} yielding the numeric array's own
 * step-events, keyed by string (docs/PLAN.md §5): `arr.compare` is emitted exactly
 * where the comparison counter ticks, so a search stream's cost-event count is its
 * op-count, and a delete's is its op-count minus its `arr.shift` steps (a shift is
 * counted in `ops` but drawn as a move, not a cost event — `src/viz/trace.str.test.ts`).
 * The untraced path allocates nothing.
 */

import type { SearchResult, DeleteResult } from './dynArray';
import type { Tracer, ArrayEvent } from '../viz/events';

export class DynArrayStr {
  private readonly data: string[] = [];

  /** Append a key (O(1) amortized). Duplicates are kept — multiset semantics. */
  insert(key: string, trace?: Tracer<ArrayEvent<string>>): void {
    this.data.push(key);
    trace?.({ kind: 'arr.append', value: key });
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
  search(target: string, trace?: Tracer<ArrayEvent<string>>): SearchResult {
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
   * Ordered shift-compact delete of the first occurrence — the TS twin of the Rust
   * `remove_first` / `delete_one_counted`: scan for `target` (one comparison each),
   * then shift every later element one slot left and drop the tail. Returns
   * membership and the op-count (comparisons + shifts). Mutates the array.
   */
  delete(target: string, trace?: Tracer<ArrayEvent<string>>): DeleteResult {
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
  keysInOrder(): string[] {
    return this.data.slice();
  }
}
