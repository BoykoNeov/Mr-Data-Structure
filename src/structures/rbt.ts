/**
 * Teaching implementation of the **red-black tree** (docs/PLAN.md §8 "Trees / heaps",
 * §13's balancing-scheme comparison) — the TypeScript twin of the Rust bench impl
 * (`bench-engine/src/structures/rbt.rs`), pinned to it by `conformance/corpus-rbt.txt`.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) this runs the *same* algorithm the benchmark
 * measures: the classic CLRS scheme (not left-leaning), on a **multiset** — `key < node` ⇒
 * left, otherwise (≥) ⇒ right, so equal keys go right and the in-order traversal is the
 * sorted multiset — with the BST's and the AVL's **value-copy (Hibbard) delete**: the first
 * matching node on the way down is removed, and a two-child match takes its in-order
 * successor's value while the successor's node is the one unlinked.
 *
 * **Cost metric — comparisons + rotations, exactly the AVL's** (docs/PLAN.md §8): one per
 * node examined on a find path (the match included), plus one per single rotation. The
 * successor walk is free. **Recolours are counted separately, not in `ops`** — the AVL has
 * no colour to pay for — and a recolour is *a write that changes a node's colour* (a new
 * node born red is not one; a node that goes red then back to black counts twice). The Rust
 * twin counts identically, or the corpus mismatches (risk R1).
 *
 * `insert` / `search` / `delete` accept an optional {@link Tracer} for the Explore
 * animation (docs/PLAN.md §5). Each `rbt.compare` / `rbt.rotate` is emitted where the
 * op-count ticks and each `rbt.recolour` where the recolour counter ticks, so both counts
 * can be read off the stream (`src/viz/trace.rbt.test.ts` chains them to the corpus).
 * Node paths are computed from the parent links at the moment of each event — a rotation
 * moves nodes. The untraced path allocates nothing extra.
 */

import type { Tracer, RbtEvent, RbtCase, BstStep } from '../viz/events';

/** Result of a search: membership plus the cost-metric op-count (comparisons). */
export interface SearchResult {
  readonly found: boolean;
  /** Key comparisons on the search path (a search never rotates). */
  readonly ops: number;
}

/** The breakdown every mutation reports. `ops = comparisons + rotations`. */
export interface RbtCost {
  /** The shared cost metric, unit-for-unit with the AVL: comparisons + rotations. */
  readonly ops: number;
  readonly comparisons: number;
  /** Single rotations (a double rotation is two). At most 2 per insert, 3 per delete. */
  readonly rotations: number;
  /** Writes that changed a node's colour. **Not** part of `ops`. */
  readonly recolours: number;
}

/** Result of a delete: whether a key was removed plus its cost breakdown. */
export interface DeleteResult extends RbtCost {
  readonly removed: boolean;
}

/** An immutable snapshot of the tree — value, colour, subtrees — for tests and a later
 * renderer. `null` is an empty (sub)tree. */
export interface RbtShape {
  readonly value: number;
  readonly red: boolean;
  readonly left: RbtShape | null;
  readonly right: RbtShape | null;
}

/** Internal mutable node with a parent link (CLRS needs it for the bottom-up fix-ups). */
class Node {
  left: Node | null = null;
  right: Node | null = null;
  red = true;
  constructor(
    public value: number,
    public parent: Node | null,
  ) {}
}

/** NIL is black, as is every absent child. */
const isRed = (n: Node | null): boolean => n !== null && n.red;

export class RbtF64 {
  private root: Node | null = null;
  private count = 0;
  /** Transient tallies, reset at the start of each public op and read at its end. */
  private cmp = 0;
  private rot = 0;
  private recol = 0;
  /** The active op's tracer, set for the length of one public op. */
  private trace: Tracer<RbtEvent> | undefined;

  /** Build by inserting each key in order. */
  static fromKeys(keys: readonly number[]): RbtF64 {
    const t = new RbtF64();
    for (const k of keys) t.insert(k);
    return t;
  }

  /** Number of stored keys (`n`); duplicates each count. */
  get size(): number {
    return this.count;
  }

  /** Height in nodes (0 when empty); a red-black tree keeps it ≤ 2·log₂(n+1). */
  get height(): number {
    const h = (n: Node | null): number => (n === null ? 0 : 1 + Math.max(h(n.left), h(n.right)));
    return h(this.root);
  }

  private reset(): void {
    this.cmp = 0;
    this.rot = 0;
    this.recol = 0;
  }

  private cost(): RbtCost {
    return { ops: this.cmp + this.rot, comparisons: this.cmp, rotations: this.rot, recolours: this.recol };
  }

  /** Set `n`'s colour, counting a recolour only when the colour actually changes. NIL
   * (`null`) is always black and is never written. */
  private paint(n: Node | null, red: boolean): void {
    if (n === null) return;
    if (n.red !== red) {
      this.recol += 1;
      this.trace?.({ kind: 'rbt.recolour', path: this.pathOf(n), value: n.value, red });
    }
    n.red = red;
  }

  /** `n`'s root path, read from the parent links now (only called when tracing). */
  private pathOf(n: Node): BstStep[] {
    const steps: BstStep[] = [];
    for (let c = n; c.parent !== null; c = c.parent) steps.push(c.parent.left === c ? 'L' : 'R');
    return steps.reverse();
  }

  /** The path of `n`, or — when `n` is NIL — of the empty `side` child of `parent`. */
  private addr(n: Node | null, parent: Node, side: BstStep): BstStep[] {
    return n !== null ? this.pathOf(n) : [...this.pathOf(parent), side];
  }

  /** Emit a fix-up case marker (only called when tracing). */
  private fix(op: 'insert' | 'delete', c: RbtCase, left: boolean, at: BstStep[], nil: boolean, other: BstStep[] | null): void {
    this.trace?.({ kind: 'rbt.fixCase', op, case: c, side: left ? 'left' : 'right', at, nil, other });
  }

  /** Replace `old` with `next` in `old`'s parent (or at the root). */
  private replaceChild(parent: Node | null, old: Node, next: Node | null): void {
    if (parent === null) this.root = next;
    else if (parent.left === old) parent.left = next;
    else parent.right = next;
  }

  /** CLRS LEFT-ROTATE: lift `x.right` into `x`'s place. One op. */
  private rotateLeft(x: Node): void {
    this.rot += 1;
    this.trace?.({ kind: 'rbt.rotate', path: this.pathOf(x), dir: 'left', value: x.value });
    const y = x.right!;
    x.right = y.left;
    if (y.left !== null) y.left.parent = x;
    y.parent = x.parent;
    this.replaceChild(x.parent, x, y);
    y.left = x;
    x.parent = y;
  }

  /** CLRS RIGHT-ROTATE: lift `y.left` into `y`'s place. One op. */
  private rotateRight(y: Node): void {
    this.rot += 1;
    this.trace?.({ kind: 'rbt.rotate', path: this.pathOf(y), dir: 'right', value: y.value });
    const x = y.left!;
    y.left = x.right;
    if (x.right !== null) x.right.parent = y;
    x.parent = y.parent;
    this.replaceChild(y.parent, y, x);
    x.right = y;
    y.parent = x;
  }

  /**
   * Insert `key` (equal keys go right), then restore the colour invariants bottom-up:
   * red uncle ⇒ recolour and move up two levels; black uncle ⇒ one rotation (straight
   * line) or two (zig-zag), and stop. Returns the cost breakdown.
   */
  insert(key: number, trace?: Tracer<RbtEvent>): RbtCost {
    this.reset();
    this.trace = trace;
    const path: BstStep[] | undefined = trace ? [] : undefined;
    let parent: Node | null = null;
    let cur = this.root;
    let goLeft = false;
    while (cur !== null) {
      this.cmp += 1;
      parent = cur;
      goLeft = key < cur.value;
      trace?.({ kind: 'rbt.compare', path: [...path!], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      path?.push(goLeft ? 'L' : 'R');
      cur = goLeft ? cur.left : cur.right;
    }
    const z = new Node(key, parent);
    if (parent === null) this.root = z;
    else if (goLeft) parent.left = z;
    else parent.right = z;
    this.count += 1;
    trace?.({ kind: 'rbt.insert', path: path!, value: key });
    this.insertFixup(z);
    this.trace = undefined;
    return this.cost();
  }

  private insertFixup(start: Node): void {
    let z = start;
    // A red parent is never the root, so the grandparent exists.
    while (isRed(z.parent)) {
      const p = z.parent!;
      const g = p.parent!;
      if (p === g.left) {
        const u = g.right;
        if (isRed(u)) {
          if (this.trace) this.fix('insert', 'redUncle', true, this.pathOf(z), false, this.pathOf(u!));
          this.paint(p, false);
          this.paint(u, false);
          this.paint(g, true);
          z = g;
        } else {
          if (z === p.right) {
            if (this.trace) this.fix('insert', 'innerChild', true, this.pathOf(z), false, this.addr(u, g, 'R'));
            z = p;
            this.rotateLeft(z);
          }
          const p2 = z.parent!;
          const g2 = p2.parent!;
          if (this.trace) this.fix('insert', 'outerChild', true, this.pathOf(z), false, this.addr(g2.right, g2, 'R'));
          this.paint(p2, false);
          this.paint(g2, true);
          this.rotateRight(g2);
        }
      } else {
        const u = g.left;
        if (isRed(u)) {
          if (this.trace) this.fix('insert', 'redUncle', false, this.pathOf(z), false, this.pathOf(u!));
          this.paint(p, false);
          this.paint(u, false);
          this.paint(g, true);
          z = g;
        } else {
          if (z === p.left) {
            if (this.trace) this.fix('insert', 'innerChild', false, this.pathOf(z), false, this.addr(u, g, 'L'));
            z = p;
            this.rotateRight(z);
          }
          const p2 = z.parent!;
          const g2 = p2.parent!;
          if (this.trace) this.fix('insert', 'outerChild', false, this.pathOf(z), false, this.addr(g2.left, g2, 'L'));
          this.paint(p2, false);
          this.paint(g2, true);
          this.rotateLeft(g2);
        }
      }
    }
    this.paint(this.root, false);
  }

  /** Search for `key`, comparing at each node until a match or a null child. */
  search(key: number, trace?: Tracer<RbtEvent>): SearchResult {
    this.reset();
    const path: BstStep[] | undefined = trace ? [] : undefined;
    let cur = this.root;
    while (cur !== null) {
      this.cmp += 1;
      if (key === cur.value) {
        trace?.({ kind: 'rbt.compare', path: [...path!], value: cur.value, target: key, dir: 'match' });
        trace?.({ kind: 'rbt.result', found: true });
        return { found: true, ops: this.cmp };
      }
      const goLeft = key < cur.value;
      trace?.({ kind: 'rbt.compare', path: [...path!], value: cur.value, target: key, dir: goLeft ? 'left' : 'right' });
      path?.push(goLeft ? 'L' : 'R');
      cur = goLeft ? cur.left : cur.right;
    }
    trace?.({ kind: 'rbt.result', found: false });
    return { found: false, ops: this.cmp };
  }

  /**
   * Delete the first matching key on the way down (value-copy for a two-child match),
   * splice out the node that physically leaves, and — if it was black — run the CLRS
   * delete fix-up (at most three rotations). Returns membership and the cost breakdown.
   */
  delete(key: number, trace?: Tracer<RbtEvent>): DeleteResult {
    this.reset();
    this.trace = trace;
    const path: BstStep[] | undefined = trace ? [] : undefined;
    let z = this.root;
    while (z !== null) {
      this.cmp += 1;
      const dir = key < z.value ? 'left' : key > z.value ? 'right' : 'match';
      trace?.({ kind: 'rbt.compare', path: [...path!], value: z.value, target: key, dir });
      if (dir === 'left') {
        path?.push('L');
        z = z.left;
      } else if (dir === 'right') {
        path?.push('R');
        z = z.right;
      } else break;
    }
    if (z === null) {
      trace?.({ kind: 'rbt.result', found: false });
      this.trace = undefined;
      return { removed: false, ...this.cost() };
    }
    trace?.({ kind: 'rbt.removeTarget', path: path! });
    let y = z;
    if (z.left !== null && z.right !== null) {
      let s = z.right;
      trace?.({ kind: 'rbt.descend', path: this.pathOf(s) });
      while (s.left !== null) {
        s = s.left; // pointer walk — free
        trace?.({ kind: 'rbt.descend', path: this.pathOf(s) });
      }
      z.value = s.value;
      trace?.({ kind: 'rbt.replaceValue', path: this.pathOf(z), value: s.value });
      y = s;
    }
    // y has at most one child.
    const x = y.left ?? y.right;
    const xp = y.parent;
    trace?.({ kind: 'rbt.remove', path: this.pathOf(y), value: y.value, black: !y.red });
    if (x !== null) x.parent = xp;
    const xIsLeft = xp !== null && xp.left === y;
    this.replaceChild(xp, y, x);
    this.count -= 1;
    if (!y.red) this.deleteFixup(x, xp, xIsLeft);
    trace?.({ kind: 'rbt.result', found: true });
    this.trace = undefined;
    return { removed: true, ...this.cost() };
  }

  /** CLRS RB-DELETE-FIXUP with `x`'s parent and side carried explicitly (x may be null). */
  private deleteFixup(start: Node | null, startParent: Node | null, startIsLeft: boolean): void {
    let x = start;
    let xp = startParent;
    let xIsLeft = startIsLeft;
    while (x !== this.root && !isRed(x)) {
      const p = xp!;
      if (xIsLeft) {
        let w = p.right!;
        if (isRed(w)) {
          if (this.trace) this.fix('delete', 'redSibling', true, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, false);
          this.paint(p, true);
          this.rotateLeft(p);
          w = p.right!;
        }
        if (!isRed(w.left) && !isRed(w.right)) {
          if (this.trace) this.fix('delete', 'blackNephews', true, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, true);
          x = p;
          xp = x.parent;
          xIsLeft = xp !== null && xp.left === x;
        } else {
          if (!isRed(w.right)) {
            if (this.trace) this.fix('delete', 'nearNephewRed', true, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
            this.paint(w.left, false);
            this.paint(w, true);
            this.rotateRight(w);
            w = p.right!;
          }
          if (this.trace) this.fix('delete', 'farNephewRed', true, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, p.red);
          this.paint(p, false);
          this.paint(w.right, false);
          this.rotateLeft(p);
          x = this.root;
          xp = null;
        }
      } else {
        let w = p.left!;
        if (isRed(w)) {
          if (this.trace) this.fix('delete', 'redSibling', false, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, false);
          this.paint(p, true);
          this.rotateRight(p);
          w = p.left!;
        }
        if (!isRed(w.right) && !isRed(w.left)) {
          if (this.trace) this.fix('delete', 'blackNephews', false, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, true);
          x = p;
          xp = x.parent;
          xIsLeft = xp !== null && xp.left === x;
        } else {
          if (!isRed(w.left)) {
            if (this.trace) this.fix('delete', 'nearNephewRed', false, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
            this.paint(w.right, false);
            this.paint(w, true);
            this.rotateLeft(w);
            w = p.left!;
          }
          if (this.trace) this.fix('delete', 'farNephewRed', false, this.addr(x, p, xIsLeft ? 'L' : 'R'), x === null, this.pathOf(w));
          this.paint(w, p.red);
          this.paint(p, false);
          this.paint(w.left, false);
          this.rotateRight(p);
          x = this.root;
          xp = null;
        }
      }
    }
    if (this.trace && x !== null && x.red) {
      const up = x.parent;
      this.fix('delete', 'redX', up === null || up.left === x, this.pathOf(x), false, null);
    }
    this.paint(x, false);
  }

  /** Keys in ascending (in-order) order; the multiset, sorted. */
  keysInOrder(): number[] {
    const out: number[] = [];
    const stack: Node[] = [];
    let cur = this.root;
    while (cur !== null || stack.length > 0) {
      while (cur !== null) {
        stack.push(cur);
        cur = cur.left;
      }
      const n = stack.pop()!;
      out.push(n.value);
      cur = n.right;
    }
    return out;
  }

  /** An immutable snapshot of shape and colours. */
  snapshot(): RbtShape | null {
    const walk = (n: Node | null): RbtShape | null =>
      n === null ? null : { value: n.value, red: n.red, left: walk(n.left), right: walk(n.right) };
    return walk(this.root);
  }

  /**
   * Whether every red-black invariant holds — black root, no red node with a red child,
   * equal black height on every root-to-null path, parent links consistent, in-order
   * non-decreasing, reachable count equal to `size`. The TS mirror of the Rust `check_rb`.
   */
  checkInvariants(): boolean {
    if (isRed(this.root)) return false;
    if (this.root !== null && this.root.parent !== null) return false;
    let reached = 0;
    let ok = true;
    const black = (n: Node | null, parent: Node | null): number => {
      if (n === null) return 1;
      reached += 1;
      if (n.parent !== parent) ok = false;
      if (n.red && (isRed(n.left) || isRed(n.right))) ok = false;
      const l = black(n.left, n);
      const r = black(n.right, n);
      if (l !== r) ok = false;
      return l + (n.red ? 0 : 1);
    };
    black(this.root, null);
    const keys = this.keysInOrder();
    for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) ok = false;
    return ok && reached === this.count;
  }
}
