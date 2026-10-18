/**
 * Teaching implementation of the **B-tree** (docs/PLAN.md §8 "Trees / heaps", balanced;
 * Phase 6) — the TypeScript twin of the Rust bench impl
 * (`bench-engine/src/structures/btree.rs`), held to it by `conformance/corpus-btree.txt`.
 *
 * Per the dual-impl spine (docs/PLAN.md §2.1) this runs the *same* algorithm the benchmark
 * measures, rule for rule — the Rust module doc lists every rule and why; in short:
 *
 * - **Nodes** of minimum degree `t` hold at most `2t − 1` keys (and `2t` children); every
 *   node but the root holds at least `t − 1`; all leaves sit at one depth.
 * - **Search** binary-searches each node for the first key `≥ k` (one comparison per probe),
 *   remembers it as the candidate, and always descends to a leaf; a single deferred equality
 *   test at the end decides membership (none when no key `≥ k` was seen).
 * - **Insert** descends by the first key `> k` (equal keys go right, like the AVL), splitting
 *   any full node *before* entering it (the CLRS proactive split) and paying one comparison
 *   against the lifted median to choose a half.
 * - **Delete** finds like search, removes the key from its leaf or replaces an internal
 *   candidate with the leaf's last key (its in-order predecessor — the descent already
 *   stands on it), then repairs **underflow only** (fewer than `t − 1` keys) on the way
 *   back up: borrow left, else borrow right, else merge (left if there is one) and continue.
 *   Not CLRS's single-pass pre-fill, which thrashes split/merge on every churn pair
 *   (docs/METHODOLOGY.md §2.10).
 *
 * **Cost metric — comparisons + splits/merges/borrows (docs/PLAN.md §8).** One op per key
 * comparison and one per structural event, the B-tree's counterpart to the AVL's
 * rotations. Key *moves* are not counted (bounded block copies), and neither is a root
 * collapse (part of the merge that caused it). The Rust op-counter counts identically or the
 * corpus mismatches (risk R1).
 *
 * A **multiset**: duplicates are kept (CLAUDE.md "keys are identity"), and a delete removes
 * the first occurrence in sorted order.
 *
 * `insert` / `search` / `delete` accept an optional {@link Tracer} for the Explore
 * animation (docs/PLAN.md §5): every cost event is emitted where the op-count ticks, and
 * every split / borrow / merge where its `eventCounts()` tally ticks, so both can be read
 * off the stream (`src/viz/trace.btree.test.ts`, chained to the corpus). Nodes are named by
 * their child-index path from the root. The untraced path allocates nothing extra.
 */

import type { Tracer, BTreeEvent } from '../viz/events';

/** Result of a search: membership plus the op-count (comparisons). */
export interface SearchResult {
  readonly found: boolean;
  readonly ops: number;
}

/** A search with its second clock-free figure: the nodes visited (always the height). */
export interface SearchProfile extends SearchResult {
  readonly nodeVisits: number;
}

/** Result of an insert: comparisons + splits. */
export interface InsertResult {
  readonly ops: number;
}

/** Result of a delete: whether a key was removed, plus comparisons + merges/borrows. */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}

/** Structural-event tallies, mirroring the Rust `event_counts` order. */
export interface BTreeEvents {
  split: number;
  borrowLeft: number;
  borrowRight: number;
  mergeLeft: number;
  mergeRight: number;
}

/** A node of {@link BTreeF64.snapshot}: its keys, and its children (`null` for a leaf). */
export interface BTreeShape {
  readonly keys: readonly number[];
  readonly kids: readonly BTreeShape[] | null;
}

/** The shipped minimum degree — up to 31 keys a node — matching the Rust `MIN_DEGREE`. */
export const BTREE_MIN_DEGREE = 16;

class Node {
  keys: number[] = [];
  /** `null` for a leaf; otherwise exactly `keys.length + 1` children. */
  kids: Node[] | null;
  constructor(leaf: boolean) {
    this.kids = leaf ? null : [];
  }
  get leaf(): boolean {
    return this.kids === null;
  }
}

export class BTreeF64 {
  private root: Node | null = null;
  private count = 0;
  private opCount = 0;
  /** The active op's tracer, set for the length of one public op. */
  private trace: Tracer<BTreeEvent> | undefined;
  private readonly events: BTreeEvents = {
    split: 0,
    borrowLeft: 0,
    borrowRight: 0,
    mergeLeft: 0,
    mergeRight: 0,
  };

  /** @param t minimum degree, ≥ 2 (default {@link BTREE_MIN_DEGREE}). */
  constructor(readonly t: number = BTREE_MIN_DEGREE) {
    if (!Number.isInteger(t) || t < 2) throw new Error('a B-tree needs minimum degree t >= 2');
  }

  /** Build by inserting each key in order. */
  static fromKeys(keys: readonly number[], t: number = BTREE_MIN_DEGREE): BTreeF64 {
    const b = new BTreeF64(t);
    for (const k of keys) b.insert(k);
    return b;
  }

  /** Number of stored keys; duplicates each count. */
  get size(): number {
    return this.count;
  }

  /** Levels from root to leaf (0 when empty) — the node-visits of every search. */
  get height(): number {
    let h = 0;
    for (let x = this.root; x !== null; x = x.kids === null ? null : x.kids[0]) h += 1;
    return h;
  }

  private get maxKeys(): number {
    return 2 * this.t - 1;
  }

  /** First index with `keys[i] >= k`; one comparison per probe. `at` names `x` when tracing. */
  private lowerBound(x: Node, k: number, at?: readonly number[]): number {
    let lo = 0;
    let hi = x.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      this.opCount += 1;
      const right = x.keys[mid] < k;
      this.trace?.({ kind: 'btree.probe', path: at!, lo, hi, mid, value: x.keys[mid], target: k, bound: 'lower', right });
      if (right) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index with `keys[i] > k` (equal keys go right); one comparison per probe. */
  private upperBound(x: Node, k: number, at?: readonly number[]): number {
    let lo = 0;
    let hi = x.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      this.opCount += 1;
      const right = x.keys[mid] <= k;
      this.trace?.({ kind: 'btree.probe', path: at!, lo, hi, mid, value: x.keys[mid], target: k, bound: 'upper', right });
      if (right) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Membership plus comparisons. */
  search(key: number, trace?: Tracer<BTreeEvent>): SearchResult {
    const { found, ops } = this.profile(key, trace);
    return { found, ops };
  }

  /** Membership, comparisons, and node-visits (docs/METHODOLOGY.md §2.10). */
  profile(key: number, trace?: Tracer<BTreeEvent>): SearchProfile {
    this.opCount = 0;
    let visits = 0;
    if (this.root === null) {
      trace?.({ kind: 'btree.result', found: false, nodeVisits: 0 });
      return { found: false, ops: 0, nodeVisits: 0 };
    }
    this.trace = trace;
    const path: number[] | undefined = trace ? [] : undefined;
    let cand: number | null = null;
    let x: Node = this.root;
    for (;;) {
      visits += 1;
      const i = this.lowerBound(x, key, path && [...path]);
      const fresh = i < x.keys.length;
      if (fresh) cand = x.keys[i];
      trace?.({ kind: 'btree.descend', path: [...path!], index: i, candidate: cand, fresh, leaf: x.kids === null });
      if (x.kids === null) break;
      path?.push(i);
      x = x.kids[i];
    }
    let found = false;
    if (cand !== null) {
      this.opCount += 1; // the deferred equality test
      found = cand === key;
      trace?.({ kind: 'btree.check', target: key, candidate: cand, found });
    }
    trace?.({ kind: 'btree.result', found, nodeVisits: visits });
    this.trace = undefined;
    return { found, ops: this.opCount, nodeVisits: visits };
  }

  /** CLRS split of the full child `i` of `x`: the median moves up, the top half moves right. */
  private splitChild(x: Node, i: number, at?: readonly number[]): void {
    const t = this.t;
    const y = x.kids![i];
    this.trace?.({ kind: 'btree.split', path: at!, index: i, median: y.keys[t - 1], t });
    const z = new Node(y.leaf);
    z.keys = y.keys.slice(t);
    const median = y.keys[t - 1];
    y.keys.length = t - 1;
    if (y.kids !== null) {
      z.kids = y.kids.slice(t);
      y.kids.length = t;
    }
    x.keys.splice(i, 0, median);
    x.kids!.splice(i + 1, 0, z);
    this.events.split += 1;
  }

  /** Insert `key` (duplicates kept, placed after equal keys). Returns comparisons + splits. */
  insert(key: number, trace?: Tracer<BTreeEvent>): InsertResult {
    this.opCount = 0;
    this.trace = trace;
    if (this.root === null) this.root = new Node(true);
    if (this.root.keys.length === this.maxKeys) {
      trace?.({ kind: 'btree.growRoot' });
      const s = new Node(false);
      s.kids!.push(this.root);
      this.root = s;
      this.splitChild(s, 0, trace && []);
      this.opCount += 1; // the split
    }
    const path: number[] | undefined = trace ? [] : undefined;
    let x: Node = this.root;
    for (;;) {
      let i = this.upperBound(x, key, path && [...path]);
      if (x.kids === null) {
        x.keys.splice(i, 0, key);
        trace?.({ kind: 'btree.insertKey', path: [...path!], index: i, value: key });
        break;
      }
      if (x.kids[i].keys.length === this.maxKeys) {
        this.splitChild(x, i, path && [...path]);
        this.opCount += 2; // the split, and the comparison against the lifted median
        const right = x.keys[i] <= key;
        trace?.({ kind: 'btree.medianCompare', path: [...path!], index: i, median: x.keys[i], target: key, right });
        if (right) i += 1;
      }
      trace?.({ kind: 'btree.descend', path: [...path!], index: i, candidate: null, fresh: false, leaf: false });
      path?.push(i);
      x = x.kids[i];
    }
    this.count += 1;
    this.trace = undefined;
    return { ops: this.opCount };
  }

  /** Delete the first occurrence of `key` in sorted order. */
  delete(key: number, trace?: Tracer<BTreeEvent>): DeleteResult {
    this.opCount = 0;
    if (this.root === null) {
      trace?.({ kind: 'btree.result', found: false, nodeVisits: 0 });
      return { removed: false, ops: 0 };
    }
    this.trace = trace;
    const path: { node: Node; idx: number }[] = [];
    let cand: { level: number; idx: number } | null = null;
    let x: Node = this.root;
    for (;;) {
      const i = this.lowerBound(x, key, trace && this.pathAt(path, path.length));
      path.push({ node: x, idx: i });
      const fresh = i < x.keys.length;
      if (fresh) cand = { level: path.length - 1, idx: i };
      trace?.({
        kind: 'btree.descend',
        path: this.pathAt(path, path.length - 1),
        index: i,
        candidate: cand === null ? null : path[cand.level].node.keys[cand.idx],
        fresh,
        leaf: x.kids === null,
      });
      if (x.kids === null) break;
      x = x.kids[i];
    }
    if (cand === null) return this.finish(false, path.length);
    this.opCount += 1; // the deferred equality test
    const cn = path[cand.level].node;
    trace?.({ kind: 'btree.check', target: key, candidate: cn.keys[cand.idx], found: cn.keys[cand.idx] === key });
    if (cn.keys[cand.idx] !== key) return this.finish(false, path.length);
    const leaf = path[path.length - 1].node;
    if (cand.level === path.length - 1) {
      trace?.({ kind: 'btree.removeKey', path: this.pathAt(path, cand.level), index: cand.idx });
      leaf.keys.splice(cand.idx, 1);
    } else {
      // Below the candidate every key is < key, so the descent walked the rightmost path of
      // its left child: the leaf's last key is the in-order predecessor.
      trace?.({
        kind: 'btree.replaceWithPred',
        path: this.pathAt(path, cand.level),
        index: cand.idx,
        leafPath: this.pathAt(path, path.length - 1),
        value: leaf.keys[leaf.keys.length - 1],
      });
      cn.keys[cand.idx] = leaf.keys.pop()!;
    }
    this.count -= 1;
    this.repair(path, path.length - 1);
    return this.finish(true, path.length);
  }

  /** End a delete: the terminal event (with the nodes visited) and the result. */
  private finish(removed: boolean, visits: number): DeleteResult {
    this.trace?.({ kind: 'btree.result', found: removed, nodeVisits: visits });
    this.trace = undefined;
    return { removed, ops: this.opCount };
  }

  /** The child-index path of the node at `level` of a delete's descent (tracing only). */
  private pathAt(path: readonly { idx: number }[], level: number): number[] {
    return path.slice(0, level).map((p) => p.idx);
  }

  /** Repair underflow upward from `lvl`: borrow left, else borrow right, else merge. */
  private repair(path: { node: Node; idx: number }[], lvl: number): void {
    const min = this.t - 1;
    for (;;) {
      const n = path[lvl].node;
      if (lvl === 0) {
        if (n.keys.length === 0) {
          this.trace?.({ kind: 'btree.collapseRoot' });
          this.root = n.kids === null ? null : n.kids[0];
        }
        return;
      }
      if (n.keys.length >= min) return;
      const { node: p, idx: c } = path[lvl - 1];
      const kids = p.kids!;
      this.opCount += 1; // exactly one structural event repairs this level
      const at = this.trace && this.pathAt(path, lvl - 1);
      if (c > 0 && kids[c - 1].keys.length > min) {
        this.trace?.({ kind: 'btree.borrow', path: at!, child: c, from: 'left' });
        const l = kids[c - 1];
        n.keys.unshift(p.keys[c - 1]);
        p.keys[c - 1] = l.keys.pop()!;
        if (n.kids !== null) n.kids.unshift(l.kids!.pop()!);
        this.events.borrowLeft += 1;
        return;
      }
      if (c < p.keys.length && kids[c + 1].keys.length > min) {
        this.trace?.({ kind: 'btree.borrow', path: at!, child: c, from: 'right' });
        const r = kids[c + 1];
        n.keys.push(p.keys[c]);
        p.keys[c] = r.keys.shift()!;
        if (n.kids !== null) n.kids.push(r.kids!.shift()!);
        this.events.borrowRight += 1;
        return;
      }
      if (c > 0) {
        this.trace?.({ kind: 'btree.merge', path: at!, index: c - 1, side: 'left' });
        this.merge(p, c - 1);
        this.events.mergeLeft += 1;
      } else {
        this.trace?.({ kind: 'btree.merge', path: at!, index: c, side: 'right' });
        this.merge(p, c);
        this.events.mergeRight += 1;
      }
      lvl -= 1;
    }
  }

  /** Merge child `i + 1` of `p` into child `i`, pulling separator `i` down between them. */
  private merge(p: Node, i: number): void {
    const a = p.kids![i];
    const b = p.kids![i + 1];
    a.keys.push(p.keys[i], ...b.keys);
    if (a.kids !== null) a.kids.push(...b.kids!);
    p.keys.splice(i, 1);
    p.kids!.splice(i + 1, 1);
  }

  /** Keys in ascending (in-order) order — the sorted multiset. */
  keysInOrder(): number[] {
    const out: number[] = [];
    const walk = (x: Node): void => {
      for (let i = 0; i < x.keys.length; i++) {
        if (x.kids !== null) walk(x.kids[i]);
        out.push(x.keys[i]);
      }
      if (x.kids !== null) walk(x.kids[x.keys.length]);
    };
    if (this.root !== null) walk(this.root);
    return out;
  }

  /** The shape, level by level from the root: each level's nodes, each node's keys. */
  levels(): number[][][] {
    const out: number[][][] = [];
    let cur: Node[] = this.root === null ? [] : [this.root];
    while (cur.length > 0) {
      out.push(cur.map((n) => [...n.keys]));
      cur = cur[0].kids === null ? [] : cur.flatMap((n) => n.kids!);
    }
    return out;
  }

  /** An immutable nested snapshot — each node's keys and children — for the Explore
   * animation's starting model (`levels()` flattens away which child is whose). */
  snapshot(): BTreeShape | null {
    const walk = (x: Node): BTreeShape => ({ keys: [...x.keys], kids: x.kids === null ? null : x.kids.map(walk) });
    return this.root === null ? null : walk(this.root);
  }

  /** Live node count. */
  nodeCount(): number {
    let n = 0;
    for (const level of this.levels()) n += level.length;
    return n;
  }

  /** Structural-event tallies since construction. */
  eventCounts(): Readonly<BTreeEvents> {
    return { ...this.events };
  }

  /**
   * Every B-tree invariant, or a description of the first broken one: occupancy, one leaf
   * depth, keys inside their separators (inclusive — a multiset), and `size` agreeing.
   */
  check(): string | null {
    if (this.root === null) return this.count === 0 ? null : `empty root, size ${this.count}`;
    let leafDepth = -1;
    let stored = 0;
    const walk = (x: Node, depth: number, lo: number, hi: number): string | null => {
      const l = x.keys.length;
      stored += l;
      if (x !== this.root && (l < this.t - 1 || l > this.maxKeys)) return `node holds ${l} keys`;
      if (x === this.root && (l === 0 || l > this.maxKeys)) return `root holds ${l} keys`;
      for (let i = 0; i < l; i++) {
        if (x.keys[i] < lo || x.keys[i] > hi) return `key ${x.keys[i]} outside [${lo}, ${hi}]`;
        if (i > 0 && x.keys[i - 1] > x.keys[i]) return 'node keys out of order';
      }
      if (x.kids === null) {
        if (leafDepth === -1) leafDepth = depth;
        return leafDepth === depth ? null : `leaves at depths ${leafDepth} and ${depth}`;
      }
      if (x.kids.length !== l + 1) return `node with ${l} keys has ${x.kids.length} children`;
      for (let i = 0; i <= l; i++) {
        const err = walk(x.kids[i], depth + 1, i === 0 ? lo : x.keys[i - 1], i === l ? hi : x.keys[i]);
        if (err !== null) return err;
      }
      return null;
    };
    const err = walk(this.root, 0, -Infinity, Infinity);
    if (err !== null) return err;
    return stored === this.count ? null : `stored ${stored} keys, size says ${this.count}`;
  }
}
