/**
 * Teaching implementation of the **AVL tree** (docs/PLAN.md §8, "Trees / heaps",
 * balanced) — the TypeScript twin of the Phase 4 Rust bench impl.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm the benchmark will measure; the Rust twin (and a cross-language
 * conformance corpus) land in Phase 4, so the canonical algorithm is fixed here
 * for them to mirror.
 *
 * Semantics: a **height-balanced multiset BST**. It shares the unbalanced BST's
 * ordering rule — `key < node` ⇒ left, otherwise (≥) ⇒ **right**, so equal keys
 * accumulate in the right subtree and the in-order traversal is non-decreasing —
 * and its **value-copy (Hibbard) delete**. The difference is the *self-balancing*:
 * after every insert/delete the path back to the root is retraced, each node's
 * height updated, and a **rotation** applied wherever the balance factor leaves
 * {-1, 0, +1}. So where the naive BST degenerates to an O(n) chain on sorted input
 * (the headline demo, docs/PLAN.md §4.3), the AVL stays O(log n) — the contrast the
 * two tree tabs make visible.
 *
 * **Cost metric — comparisons + rotations (docs/PLAN.md §8), and the Phase 4
 * contract.** The reported `ops` counts **key comparisons** (one per node examined
 * on a find path — search, insert, and delete's *find* phase) **plus rotations**
 * (one per single rotation; a double rotation is two). The height/balance-factor
 * arithmetic of the retrace is *not* a key comparison and is not counted; nor is
 * the in-order-successor walk of a two-child delete (it follows pointers). The
 * Phase 4 Rust op-counter must count the same way, or the cross-language corpus
 * mismatches (risk R1).
 *
 * Every op accepts an optional {@link Tracer} that yields the animation step-events
 * (docs/PLAN.md §5). Each `avl.compare` / `avl.rotate` is emitted exactly where the
 * cost counter ticks, so any op's cost-event count equals its op-count (the
 * invariant pinned in `src/viz/trace.avl.test.ts`).
 */

import type { Tracer, AvlEvent, BstStep } from '../viz/events';

/** Result of a search: membership plus the cost-metric op-count (comparisons). */
export interface SearchResult {
  readonly found: boolean;
  /** Key comparisons on the search path (no rotations on a search). */
  readonly ops: number;
}

/** Result of an insert: the cost-metric op-count (comparisons + rotations). */
export interface InsertResult {
  /** Comparisons descending to the slot, plus any rebalancing rotations. */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the op-count to do it
 * (comparisons to find it + rebalancing rotations; the successor walk is free). */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}

/** An immutable snapshot of the tree shape — value plus left/right subtrees — used
 * to seed the renderer's display model (`src/viz/model.ts`). Structurally identical
 * to the BST's shape (the display model is shared); `null` is an empty (sub)tree. */
export interface AvlShape {
  readonly value: number;
  readonly left: AvlShape | null;
  readonly right: AvlShape | null;
}

/** Internal mutable node; carries its subtree `height` for O(1) balance checks.
 * A fresh leaf has height 1. Ids live in the display model, not here. */
class Node {
  left: Node | null = null;
  right: Node | null = null;
  height = 1;
  constructor(public value: number) {}
}

export class AvlF64 {
  private root: Node | null = null;
  private count = 0;
  /** Transient cost accumulator (comparisons + rotations), reset at the start of
   * each public op and read at its end — recursion makes a field cleaner than
   * threading the count through every return. */
  private opCount = 0;

  /** Build by inserting each key in order (the tree self-balances as it grows). */
  static fromKeys(keys: readonly number[]): AvlF64 {
    const t = new AvlF64();
    for (const k of keys) t.insert(k);
    return t;
  }

  /** Number of stored keys (`n`); duplicates each count. */
  get size(): number {
    return this.count;
  }

  /** Height of the tree (0 when empty); a balanced n-node AVL is ≤ ~1.44·log₂n. */
  get height(): number {
    return this.h(this.root);
  }

  private h(n: Node | null): number {
    return n === null ? 0 : n.height;
  }

  private update(n: Node): void {
    n.height = 1 + Math.max(this.h(n.left), this.h(n.right));
  }

  /** Balance factor = height(right) − height(left); the invariant keeps it in
   * {-1, 0, +1}, and a rotation fires the moment an insert/delete pushes it to ±2. */
  private balance(n: Node): number {
    return this.h(n.right) - this.h(n.left);
  }

  /**
   * Insert `key`, descending `key < node` ⇒ left else right (equal keys go right,
   * keeping the multiset), then retrace and rebalance. Emits one `avl.compare` per
   * node on the path, an `avl.insert` at the new leaf's slot, and an `avl.rotate`
   * per rebalancing rotation. Returns comparisons + rotations.
   */
  insert(key: number, trace?: Tracer<AvlEvent>): InsertResult {
    this.opCount = 0;
    this.root = this.insertAt(this.root, key, [], trace);
    this.count += 1;
    return { ops: this.opCount };
  }

  private insertAt(node: Node | null, key: number, path: BstStep[], trace?: Tracer<AvlEvent>): Node {
    if (node === null) {
      trace?.({ kind: 'avl.insert', path, value: key });
      return new Node(key);
    }
    this.opCount += 1;
    const goLeft = key < node.value;
    trace?.({ kind: 'avl.compare', path: [...path], value: node.value, target: key, dir: goLeft ? 'left' : 'right' });
    if (goLeft) node.left = this.insertAt(node.left, key, [...path, 'L'], trace);
    else node.right = this.insertAt(node.right, key, [...path, 'R'], trace);
    this.update(node);
    return this.rebalance(node, path, trace);
  }

  /** Search for `key`, comparing at each node until a match or a null child.
   * Returns membership and the comparison count (no rotations). */
  search(key: number, trace?: Tracer<AvlEvent>): SearchResult {
    this.opCount = 0;
    let cur = this.root;
    const path: BstStep[] = [];
    while (cur !== null) {
      this.opCount += 1;
      if (key === cur.value) {
        trace?.({ kind: 'avl.compare', path: [...path], value: cur.value, target: key, dir: 'match' });
        trace?.({ kind: 'avl.result', found: true });
        return { found: true, ops: this.opCount };
      }
      const goLeft = key < cur.value;
      trace?.({ kind: 'avl.compare', path: [...path], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      path.push(goLeft ? 'L' : 'R');
      cur = goLeft ? cur.left : cur.right;
    }
    trace?.({ kind: 'avl.result', found: false });
    return { found: false, ops: this.opCount };
  }

  /**
   * Delete the first matching key (value-copy / Hibbard, docs/PLAN.md §8): find it
   * by comparison; if it has two children copy its in-order successor's value up and
   * unlink the successor, else splice it out with its single child or `null`; then
   * retrace and rebalance. Returns membership and comparisons + rotations.
   */
  delete(key: number, trace?: Tracer<AvlEvent>): DeleteResult {
    this.opCount = 0;
    const before = this.count;
    this.root = this.deleteAt(this.root, key, [], trace);
    const removed = this.count < before;
    trace?.({ kind: 'avl.result', found: removed });
    return { removed, ops: this.opCount };
  }

  private deleteAt(node: Node | null, key: number, path: BstStep[], trace?: Tracer<AvlEvent>): Node | null {
    if (node === null) return null; // ran off the tree — key absent on this path
    this.opCount += 1;
    if (key < node.value) {
      trace?.({ kind: 'avl.compare', path: [...path], value: node.value, target: key, dir: 'left' });
      node.left = this.deleteAt(node.left, key, [...path, 'L'], trace);
    } else if (key > node.value) {
      trace?.({ kind: 'avl.compare', path: [...path], value: node.value, target: key, dir: 'right' });
      node.right = this.deleteAt(node.right, key, [...path, 'R'], trace);
    } else {
      // ── Match: this node holds the key to remove. ──
      trace?.({ kind: 'avl.compare', path: [...path], value: node.value, target: key, dir: 'match' });
      trace?.({ kind: 'avl.removeTarget', path: [...path] });
      if (node.left === null || node.right === null) {
        // Leaf or one child: splice it out (no rebalance at a node that's gone).
        const child = node.left ?? node.right;
        trace?.({ kind: 'avl.remove', path: [...path] });
        this.count -= 1;
        return child;
      }
      // Two children: remove the in-order successor (min of the right subtree) and
      // copy its value up. removeMin descends by pointer (no compares) and does the
      // single count decrement. The value-copy doesn't change heights.
      const rm = this.removeMin(node.right, [...path, 'R'], trace);
      node.right = rm.node;
      trace?.({ kind: 'avl.replaceValue', path: [...path], value: rm.value });
      node.value = rm.value;
    }
    this.update(node);
    return this.rebalance(node, path, trace);
  }

  /** Descend the left spine to the minimum node, unlink it (it has no left child),
   * and rebalance on the way back up — emitting `avl.descend` (pointer-following,
   * no comparison) and any `avl.rotate`s. Returns the new subtree root and the
   * removed minimum's value (the in-order successor of the two-child delete). */
  private removeMin(node: Node, path: BstStep[], trace?: Tracer<AvlEvent>): { node: Node | null; value: number } {
    trace?.({ kind: 'avl.descend', path: [...path] });
    if (node.left === null) {
      trace?.({ kind: 'avl.remove', path: [...path] });
      this.count -= 1;
      return { node: node.right, value: node.value };
    }
    const rm = this.removeMin(node.left, [...path, 'L'], trace);
    node.left = rm.node;
    this.update(node);
    return { node: this.rebalance(node, path, trace), value: rm.value };
  }

  /** Restore the AVL invariant at `node` (whose subtree heights are current),
   * emitting an `avl.rotate` per single rotation. Returns the (possibly new)
   * subtree root. A left-/right-heavy node with an oppositely-leaning child is the
   * double-rotation case — the child is rotated first. */
  private rebalance(node: Node, path: BstStep[], trace?: Tracer<AvlEvent>): Node {
    const bf = this.balance(node);
    if (bf < -1) {
      // Left-heavy. If the left child leans right, it's the LR case: rotate it left first.
      if (this.balance(node.left!) > 0) node.left = this.rotateLeft(node.left!, [...path, 'L'], trace);
      return this.rotateRight(node, path, trace);
    }
    if (bf > 1) {
      // Right-heavy. If the right child leans left, it's the RL case: rotate it right first.
      if (this.balance(node.right!) < 0) node.right = this.rotateRight(node.right!, [...path, 'R'], trace);
      return this.rotateLeft(node, path, trace);
    }
    return node;
  }

  /** Right rotation at pivot `y`: lift `y.left` (`x`) into y's place. Emits the
   * cost event *before* the surgery (so the renderer's reducer mirrors it), counts
   * one rotation, and fixes the two affected heights. */
  private rotateRight(y: Node, path: BstStep[], trace?: Tracer<AvlEvent>): Node {
    this.opCount += 1;
    trace?.({ kind: 'avl.rotate', path: [...path], dir: 'right', value: y.value });
    const x = y.left!;
    y.left = x.right;
    x.right = y;
    this.update(y);
    this.update(x);
    return x;
  }

  /** Left rotation at pivot `x`: lift `x.right` (`y`) into x's place (mirror of
   * {@link rotateRight}). */
  private rotateLeft(x: Node, path: BstStep[], trace?: Tracer<AvlEvent>): Node {
    this.opCount += 1;
    trace?.({ kind: 'avl.rotate', path: [...path], dir: 'left', value: x.value });
    const y = x.right!;
    x.right = y.left;
    y.left = x;
    this.update(x);
    this.update(y);
    return y;
  }

  /** Keys in ascending (= in-order traversal) order; the multiset, sorted. */
  keysInOrder(): number[] {
    const out: number[] = [];
    const walk = (n: Node | null): void => {
      if (n === null) return;
      walk(n.left);
      out.push(n.value);
      walk(n.right);
    };
    walk(this.root);
    return out;
  }

  /** An immutable shape snapshot for the renderer's display model. */
  snapshot(): AvlShape | null {
    const walk = (n: Node | null): AvlShape | null =>
      n === null ? null : { value: n.value, left: walk(n.left), right: walk(n.right) };
    return walk(this.root);
  }
}
