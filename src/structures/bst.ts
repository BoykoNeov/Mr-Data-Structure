/**
 * Teaching implementation of the unbalanced binary search tree (docs/PLAN.md §8,
 * "Trees / heaps" family) — the TypeScript twin of the Phase 4 Rust bench impl.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) the teaching impl runs the *same*
 * algorithm the benchmark will measure; the Rust twin (and a cross-language
 * conformance corpus) land in Phase 4, so the canonical algorithm is fixed here
 * for them to mirror.
 *
 * Semantics: an **unbalanced multiset BST** — keys are identity and duplicates are
 * retained (docs/PLAN.md "Keys are identity; never dedupe"). The ordering rule is
 * `key < node` ⇒ left, otherwise (≥) ⇒ **right**, so equal keys accumulate in the
 * right subtree and the in-order traversal is non-decreasing. No balancing — this
 * is the structure that **degenerates to O(n) on sorted input** (docs/PLAN.md §8,
 * §4.3), the headline demo; the balanced AVL twin is a later Phase 3 batch.
 *
 * **Cost metric — comparisons (docs/PLAN.md §8), and the Phase 4 contract.** The
 * reported `ops` counts **key comparisons** only: one per node examined on a
 * search path (search, insert, and delete's *find* phase). The in-order-successor
 * walk of a two-child delete follows pointers (right once, then left to the
 * bottom) and performs **no key comparison**, so it does *not* contribute to
 * `ops` — the Phase 4 Rust op-counter must count the same way (its successor
 * min-walk increments no comparison counter), or the cross-language corpus
 * mismatches (risk R1). Delete uses the textbook **value-copy (Hibbard)** scheme:
 * a two-child node takes its in-order successor's value, then the successor (which
 * has no left child) is unlinked.
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5). Each `bst.compare` is emitted exactly where the
 * comparison counter ticks, so any op's cost-event count equals its op-count (the
 * invariant pinned in `src/viz/trace.bst.test.ts`). The optional-call
 * short-circuits the untraced path so it allocates nothing.
 */

import type { Tracer, BstEvent, BstStep } from '../viz/events';

/** Result of a search: membership plus the cost-metric op-count (comparisons). */
export interface SearchResult {
  readonly found: boolean;
  /** Key comparisons on the search path (the BST's cost metric, docs/PLAN.md §8). */
  readonly ops: number;
}

/** Result of an insert: the cost-metric op-count (comparisons to find the slot). */
export interface InsertResult {
  /** Key comparisons descending to the new leaf's slot (0 for the first key). */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the comparison op-count to
 * find it (the successor walk and structural surgery carry no comparisons). */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}

/** An immutable snapshot of the tree shape — value plus left/right subtrees — used
 * to seed the renderer's display model (`src/viz/model.ts`). Carries no animation
 * ids; the model assigns those. `null` is an empty (sub)tree. */
export interface BstShape {
  readonly value: number;
  readonly left: BstShape | null;
  readonly right: BstShape | null;
}

/** Internal mutable node. Ids live in the display model, not here. */
class Node {
  left: Node | null = null;
  right: Node | null = null;
  constructor(public value: number) {}
}

export class BstF64 {
  private root: Node | null = null;
  private count = 0;

  /** Build by inserting each key in order (insertion order fixes the shape). */
  static fromKeys(keys: readonly number[]): BstF64 {
    const t = new BstF64();
    for (const k of keys) t.insert(k);
    return t;
  }

  /** Number of stored keys (`n`); duplicates each count. */
  get size(): number {
    return this.count;
  }

  /**
   * Insert `key`, descending `key < node` ⇒ left else right (equal keys go right,
   * keeping the multiset). Emits one `bst.compare` per node on the path to the new
   * leaf's slot, then a `bst.insert` carrying that slot's full path (`[]` for the
   * root of an empty tree). Returns the comparison count.
   */
  insert(key: number, trace?: Tracer<BstEvent>): InsertResult {
    const leaf = new Node(key);
    if (this.root === null) {
      this.root = leaf;
      this.count += 1;
      trace?.({ kind: 'bst.insert', path: [], value: key });
      return { ops: 0 };
    }
    let cur = this.root;
    const path: BstStep[] = [];
    let ops = 0;
    for (;;) {
      ops += 1;
      const goLeft = key < cur.value;
      trace?.({ kind: 'bst.compare', path: [...path], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      const step: BstStep = goLeft ? 'L' : 'R';
      const child = goLeft ? cur.left : cur.right;
      path.push(step);
      if (child === null) {
        if (goLeft) cur.left = leaf;
        else cur.right = leaf;
        trace?.({ kind: 'bst.insert', path, value: key });
        this.count += 1;
        return { ops };
      }
      cur = child;
    }
  }

  /** Search for `key`, comparing at each node until a match or a null child.
   * Returns membership and the comparison count. */
  search(key: number, trace?: Tracer<BstEvent>): SearchResult {
    let cur = this.root;
    const path: BstStep[] = [];
    let ops = 0;
    while (cur !== null) {
      ops += 1;
      if (key === cur.value) {
        trace?.({ kind: 'bst.compare', path: [...path], value: cur.value, target: key, dir: 'match' });
        trace?.({ kind: 'bst.result', found: true });
        return { found: true, ops };
      }
      const goLeft = key < cur.value;
      trace?.({ kind: 'bst.compare', path: [...path], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      path.push(goLeft ? 'L' : 'R');
      cur = goLeft ? cur.left : cur.right;
    }
    trace?.({ kind: 'bst.result', found: false });
    return { found: false, ops };
  }

  /**
   * Delete the first matching key (value-copy / Hibbard, docs/PLAN.md §8): find it
   * by comparison, then — if it has two children — copy its in-order successor's
   * value up and unlink the successor (which has no left child); otherwise splice
   * the node out with its single child or `null`. Returns membership and the
   * comparison count to find it (the successor walk and surgery are not
   * comparisons — see the cost-metric note above).
   */
  delete(key: number, trace?: Tracer<BstEvent>): DeleteResult {
    // ── Find the target by comparison, recording its path. ──
    let cur = this.root;
    const path: BstStep[] = [];
    let ops = 0;
    let target: Node | null = null;
    while (cur !== null) {
      ops += 1;
      if (key === cur.value) {
        trace?.({ kind: 'bst.compare', path: [...path], value: cur.value, target: key, dir: 'match' });
        target = cur;
        break;
      }
      const goLeft = key < cur.value;
      trace?.({ kind: 'bst.compare', path: [...path], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      path.push(goLeft ? 'L' : 'R');
      cur = goLeft ? cur.left : cur.right;
    }
    if (target === null) {
      trace?.({ kind: 'bst.result', found: false });
      return { removed: false, ops };
    }
    trace?.({ kind: 'bst.removeTarget', path: [...path] });

    if (target.left !== null && target.right !== null) {
      // ── Two children: descend to the in-order successor (min of the right
      // subtree), copy its value up, then unlink it (no left child). No compares. ──
      const succPath: BstStep[] = [...path, 'R'];
      let succ = target.right;
      trace?.({ kind: 'bst.descend', path: [...succPath] });
      while (succ.left !== null) {
        succPath.push('L');
        succ = succ.left;
        trace?.({ kind: 'bst.descend', path: [...succPath] });
      }
      trace?.({ kind: 'bst.replaceValue', path: [...path], value: succ.value });
      target.value = succ.value;
      trace?.({ kind: 'bst.remove', path: succPath });
      this.replaceAtPath(succPath, succ.right); // successor has no left child
    } else {
      // ── Leaf or one child: splice the node out with its single child (or null).
      // `left ?? right` picks the present child whichever side it's on. ──
      trace?.({ kind: 'bst.remove', path: [...path] });
      this.replaceAtPath(path, target.left ?? target.right);
    }
    this.count -= 1;
    trace?.({ kind: 'bst.result', found: true });
    return { removed: true, ops };
  }

  /** Replace the node reached by `path` with `replacement` by rewriting its
   * parent's link (or the root when `path` is empty). */
  private replaceAtPath(path: readonly BstStep[], replacement: Node | null): void {
    if (path.length === 0) {
      this.root = replacement;
      return;
    }
    let parent = this.root!;
    for (let i = 0; i < path.length - 1; i++) {
      parent = (path[i] === 'L' ? parent.left : parent.right)!;
    }
    if (path[path.length - 1] === 'L') parent.left = replacement;
    else parent.right = replacement;
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
  snapshot(): BstShape | null {
    const walk = (n: Node | null): BstShape | null =>
      n === null ? null : { value: n.value, left: walk(n.left), right: walk(n.right) };
    return walk(this.root);
  }
}
