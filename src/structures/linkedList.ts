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
 * match). The doubly list's `prev` lets it unlink the node it found without having
 * carried the node behind it — invisible to the op-count, so the two report equal
 * counts on every sequence (docs/METHODOLOGY.md §2.11).
 *
 * The **singly** twin ({@link LinkedListF64} / {@link SinglyLinkedListF64}) is backed
 * by a plain array with the head at index 0 — a faithful model of its observable
 * surface (the reported op-count is the node-visit count, not the JS array cost;
 * teaching impls are "small n, speed irrelevant", §2.1). The **doubly** twin
 * ({@link DoublyLinkedListF64}) holds real `next` / `prev` links in an index arena
 * like its Rust twin, because its back links are what it exists to show: the
 * backward walk and the animation's pointer writes are only honest if the links exist.
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5). Each `ll.visit` is emitted exactly where the
 * node-visit counter ticks, so a *search* (or *delete*) stream's cost-event count
 * equals its op-count (the invariant pinned in `src/viz/trace.linear.test.ts`).
 */

import type { Tracer, LinkedListEvent, DoublyListEvent } from '../viz/events';

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

/** The singly list's algorithm (head insert, linear search/delete by node-visits) on
 * an array backing. Not instantiated directly — use {@link SinglyLinkedListF64}. (The
 * bench worker's `LinkedListF64` is the WASM class of the same name, not this one.) */
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

/** The observable surface both list twins share — what the cross-language conformance
 * drives. The doubly list is a separate class (real links, its own event stream), so this
 * is the type the two have in common. */
export interface LinkedListTwin {
  insert(key: number): void;
  search(target: number): SearchResult;
  delete(target: number): DeleteResult;
  keysInOrder(): number[];
  readonly size: number;
}

/** A doubly list's links by **position** (0 = head, following `next`): the snapshot the
 * Explore animation starts from and is checked against (`src/viz/model.test.ts`). `null`
 * is ∅ or an empty handle. */
export interface DoublyShape {
  readonly values: readonly number[];
  readonly next: readonly (number | null)[];
  readonly prev: readonly (number | null)[];
  readonly head: number | null;
  readonly tail: number | null;
}

/** An arena node: value plus both links, as indices into the arena. */
interface DllNode {
  value: number;
  next: number | null;
  prev: number | null;
}

/**
 * Doubly linked list — `next` + `prev` pointers per node (docs/PLAN.md §8), and since
 * Phase 6 the teaching twin of a bench structure of its own
 * (`bench-engine/src/structures/doubly_linked_list.rs`, StructureId `'dll'`), pinned by
 * `conformance/corpus-dll.txt` — the measurement that shows the second pointer buys
 * nothing on insert / search / delete-by-key (docs/METHODOLOGY.md §2.11).
 *
 * Unlike the singly twin this one holds **real links**, mirroring the Rust twin's index
 * arena: `head` / `tail` handles, `null` links, freed slots reused by the next insert (so
 * a stale `prev` from a slot's previous life would show). That is what makes
 * {@link keysReversed} a back-link integrity check on this side too, and what lets the
 * animation draw the links the structure actually holds.
 *
 * Same algorithm and cost as the singly list — head insert visits nothing; search and the
 * delete *find* walk from the head, one node-visit per node examined. The unlink goes
 * through the found node's own `prev`, so the walk never carries a trailing predecessor —
 * the whole of what the second pointer changes, and invisible to the op-count. Every
 * pointer write is traced as a `dll.relink` step (not a cost event), in the Rust twin's
 * order.
 */
export class DoublyLinkedListF64 implements LinkedListTwin {
  private readonly nodes: DllNode[] = [];
  /** Newest node; `null` when empty. */
  private head: number | null = null;
  /** Oldest node; `null` when empty. A real O(1) handle, never used to delete (see the Rust twin). */
  private tail: number | null = null;
  /** Slots vacated by delete, reused (last freed first) by the next insert, as in Rust. */
  private readonly free: number[] = [];
  private count = 0;

  static fromKeys(keys: readonly number[]): DoublyLinkedListF64 {
    const l = new DoublyLinkedListF64();
    for (const k of keys) l.insert(k);
    return l;
  }

  /** Number of stored nodes (`n`). */
  get size(): number {
    return this.count;
  }

  /** Allocate a node, reusing a freed slot. Both links are written in full. */
  private alloc(value: number, next: number | null, prev: number | null): number {
    const node = { value, next, prev };
    const slot = this.free.pop();
    if (slot !== undefined) {
      this.nodes[slot] = node;
      return slot;
    }
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  /** Splice a key at the head (O(1), no node-visits): the new node points forward at the
   * old head, the old head (or, on an empty list, the tail handle) points back at it, and
   * the head handle moves — three pointer writes where the singly list makes two. */
  insert(key: number, trace?: Tracer<DoublyListEvent>): void {
    const oldHead = this.head;
    const id = this.alloc(key, oldHead, null);
    trace?.({ kind: 'll.insertHead', value: key });
    trace?.({ kind: 'dll.relink', link: 'next', from: 0, to: oldHead === null ? null : 1 });
    if (oldHead === null) {
      this.tail = id;
      trace?.({ kind: 'dll.relink', link: 'prev', from: null, to: 0 });
    } else {
      this.nodes[oldHead].prev = id;
      trace?.({ kind: 'dll.relink', link: 'prev', from: 1, to: 0 });
    }
    this.head = id;
    trace?.({ kind: 'dll.relink', link: 'next', from: null, to: 0 });
    this.count += 1;
  }

  /** Walk from the head, one visit per node examined — the singly list's walk, unchanged:
   * `prev` has nothing to offer a search. */
  search(target: number, trace?: Tracer<DoublyListEvent>): SearchResult {
    let ops = 0;
    for (let cur = this.head, i = 0; cur !== null; cur = this.nodes[cur].next, i++) {
      ops += 1;
      const value = this.nodes[cur].value;
      const matched = value === target;
      trace?.({ kind: 'll.visit', index: i, value, target, matched });
      if (matched) {
        trace?.({ kind: 'll.result', found: true });
        return { found: true, ops };
      }
    }
    trace?.({ kind: 'll.result', found: false });
    return { found: false, ops };
  }

  /** Delete-by-value: walk from the head to the first match (counted — the same visits as
   * the singly list), then unlink it through its own links (free). */
  delete(target: number, trace?: Tracer<DoublyListEvent>): DeleteResult {
    let ops = 0;
    for (let cur = this.head, i = 0; cur !== null; cur = this.nodes[cur].next, i++) {
      ops += 1;
      const value = this.nodes[cur].value;
      const matched = value === target;
      trace?.({ kind: 'll.visit', index: i, value, target, matched });
      if (matched) {
        this.unlink(cur, i, trace);
        trace?.({ kind: 'll.result', found: true });
        return { removed: true, ops };
      }
    }
    trace?.({ kind: 'll.result', found: false });
    return { removed: false, ops };
  }

  /** Unlink slot `i` (at display position `pos`) through its own links — the one thing
   * `prev` buys. Two pointer writes in the Rust `unlink`'s order, then the node is dropped. */
  private unlink(i: number, pos: number, trace?: Tracer<DoublyListEvent>): void {
    const { prev, next } = this.nodes[i];
    const before = prev === null ? null : pos - 1;
    const after = next === null ? null : pos + 1;
    if (prev === null) this.head = next;
    else this.nodes[prev].next = next;
    trace?.({ kind: 'dll.relink', link: 'next', from: before, to: after });
    if (next === null) this.tail = prev;
    else this.nodes[next].prev = prev;
    trace?.({ kind: 'dll.relink', link: 'prev', from: after, to: before });
    trace?.({ kind: 'll.unlink', index: pos });
    this.free.push(i);
    this.count -= 1;
  }

  /** Arena slots head → tail, following `next`; bounded by `count + 1` steps so a cyclic
   * corruption ends the walk (and fails the caller's comparison) instead of hanging it. */
  private slotsForward(): number[] {
    const out: number[] = [];
    for (let cur = this.head; cur !== null && out.length <= this.count; cur = this.nodes[cur].next) out.push(cur);
    return out;
  }

  /** Keys head → tail, following `next` (head insert ⇒ reverse insertion order). */
  keysInOrder(): number[] {
    return this.slotsForward().map((i) => this.nodes[i].value);
  }

  /** Keys tail → head, following `prev` — **the back-link integrity check**, as on the
   * Rust side (`keys_in_reverse`). No canonical op reads `prev` on its walk, so corrupt
   * back-links would pass every search, delete and op-count; only this walk catches them
   * (pinned equal to the reversed forward order after every op of a random stream in
   * `linkedList.test.ts`, and by the `dll_order_rev*` corpus lines). Bounded like
   * {@link slotsForward}. */
  keysReversed(): number[] {
    const out: number[] = [];
    for (let cur = this.tail; cur !== null && out.length <= this.count; cur = this.nodes[cur].prev) {
      out.push(this.nodes[cur].value);
    }
    return out;
  }

  /** The links as they are, by position — the Explore animation's starting picture. A
   * link to a slot the forward walk does not reach maps to `-1`, so a corrupt list cannot
   * snapshot as a healthy one. */
  snapshot(): DoublyShape {
    const slots = this.slotsForward();
    const pos = new Map(slots.map((s, p) => [s, p] as const));
    const at = (s: number | null): number | null => (s === null ? null : (pos.get(s) ?? -1));
    return {
      values: slots.map((s) => this.nodes[s].value),
      next: slots.map((s) => at(this.nodes[s].next)),
      prev: slots.map((s) => at(this.nodes[s].prev)),
      head: at(this.head),
      tail: at(this.tail),
    };
  }
}

