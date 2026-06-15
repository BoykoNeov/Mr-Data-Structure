/**
 * Teaching implementations of the singly and doubly linked lists (docs/PLAN.md
 * §8, "Linear" family) — the TypeScript twins of the Phase 4 Rust bench impls.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm the benchmark will measure; the Rust twins land in Phase 4, so the
 * canonical algorithm is fixed here for them to mirror.
 *
 * Both lists share one algorithm and one **observable cost**: `insert` is O(1)
 * at the head (0 node-visits), `search` and `delete` are O(n) linear walks whose
 * cost metric is **node-visits** (one per node examined, short-circuiting on a
 * match). They differ only in how the renderer draws them — the doubly list adds
 * back-pointers — and in the Phase 4 Rust node representation (singly keeps a
 * `next`; doubly keeps `next` + `prev`, so it can unlink without a prior walk to
 * the predecessor). The teaching surface (membership, head→tail order, op-count)
 * is identical, so the algorithm lives once in {@link LinkedListF64} and the two
 * structures are thin named subclasses.
 *
 * The backing is a plain array with the head at index 0; this is a faithful model
 * of the observable surface (the reported op-count is the node-visit count, not
 * the JS array cost — teaching impls are "small n, speed irrelevant", §2.1).
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5). Each `ll.visit` is emitted exactly where the
 * node-visit counter ticks, so a *search* (or *delete*) stream's cost-event count
 * equals its op-count (the invariant pinned in `src/viz/trace.linear.test.ts`).
 */

import type { Tracer, LinkedListEvent } from '../viz/events';

/** Result of a search: membership plus the cost-metric op-count (node-visits). */
export interface SearchResult {
  readonly found: boolean;
  /** Nodes visited (the list's declared cost metric, docs/PLAN.md §8). */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the node-visit count. */
export interface DeleteResult {
  readonly removed: boolean;
  /** Nodes visited to find the key (the unlink itself is free). */
  readonly ops: number;
}

/** Shared linked-list algorithm (head insert, linear search/delete by
 * node-visits). Not instantiated directly — use {@link SinglyLinkedListF64} or
 * {@link DoublyLinkedListF64}. */
export class LinkedListF64 {
  /** Nodes head (index 0) → tail. Duplicates kept — multiset semantics. */
  protected readonly nodes: number[] = [];

  /** Splice a key at the head (O(1), no node-visits). Newest ends up first. */
  insert(key: number, trace?: Tracer<LinkedListEvent>): void {
    this.nodes.unshift(key);
    trace?.({ kind: 'll.insertHead', value: key });
  }

  /** Number of stored nodes (`n`). */
  get size(): number {
    return this.nodes.length;
  }

  /** Walk from the head, visiting each node until a match or the end. Returns
   * membership and the node-visit count (1-based position of the match, or `n`). */
  search(target: number, trace?: Tracer<LinkedListEvent>): SearchResult {
    let ops = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      ops += 1;
      const matched = this.nodes[i] === target;
      trace?.({ kind: 'll.visit', index: i, value: this.nodes[i], target, matched });
      if (matched) {
        trace?.({ kind: 'll.result', found: true });
        return { found: true, ops };
      }
    }
    trace?.({ kind: 'll.result', found: false });
    return { found: false, ops };
  }

  /** Walk from the head to the first matching node, then unlink it (neighbours
   * reconnect). Returns membership and the node-visit count to find it. */
  delete(target: number, trace?: Tracer<LinkedListEvent>): DeleteResult {
    let ops = 0;
    let found = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      ops += 1;
      const matched = this.nodes[i] === target;
      trace?.({ kind: 'll.visit', index: i, value: this.nodes[i], target, matched });
      if (matched) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      trace?.({ kind: 'll.result', found: false });
      return { removed: false, ops };
    }
    trace?.({ kind: 'll.unlink', index: found });
    this.nodes.splice(found, 1);
    trace?.({ kind: 'll.result', found: true });
    return { removed: true, ops };
  }

  /** Keys head → tail (head insert ⇒ reverse insertion order). */
  keysInOrder(): number[] {
    return this.nodes.slice();
  }
}

/** Singly linked list — one `next` pointer per node (docs/PLAN.md §8). */
export class SinglyLinkedListF64 extends LinkedListF64 {
  static fromKeys(keys: readonly number[]): SinglyLinkedListF64 {
    const l = new SinglyLinkedListF64();
    for (const k of keys) l.insert(k);
    return l;
  }
}

/** Doubly linked list — `next` + `prev` pointers per node (docs/PLAN.md §8).
 * Same observable cost as the singly list; the renderer draws the back-pointers. */
export class DoublyLinkedListF64 extends LinkedListF64 {
  static fromKeys(keys: readonly number[]): DoublyLinkedListF64 {
    const l = new DoublyLinkedListF64();
    for (const k of keys) l.insert(k);
    return l;
  }
}
