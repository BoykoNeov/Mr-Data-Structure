/**
 * Teaching implementation of the skip list (docs/PLAN.md §8, "Specialized") — the
 * TypeScript twin of the Rust bench impl (`bench-engine/src/structures/skip_list.rs`),
 * held to it by `conformance/corpus-skip.txt` (docs/PLAN.md §12, risk R1).
 *
 * Semantics: an **ordered multiset**, like the BST and the sorted array — ascending
 * order, duplicates retained (docs/PLAN.md "Keys are identity; never dedupe"), and a new
 * equal key placed **after** the equals already stored, so the level-0 walk is
 * insertion-stable among equals.
 *
 * **Node heights come from the key, not from a coin.** The textbook skip list flips one
 * per insert; this one derives it:
 *
 * ```text
 * height(key) = 1 + min(MAX_LEVEL - 1, trailingZeros(splitMix64(toBits(key) ^ HEIGHT_SALT)))
 * ```
 *
 * `trailingZeros` of a well-mixed 64-bit hash is geometric with p = ½, so the shape is the
 * textbook one — but the list becomes a **pure function of its key set**. That is what
 * makes this twin possible at all: it can reproduce the Rust corpus exactly, *and* insert
 * a key the corpus never saw (which replaying recorded heights could not do). The Rust
 * module doc carries the full reasoning, including why an RNG would also break the
 * deterministic op-count signal under adaptive batching.
 *
 * **Cost metric — node-visits** (docs/PLAN.md §8): one op per node *inspected* on the
 * walk, which is one key comparison each. Dropping a level costs nothing, the same rule
 * that makes the BST's successor walk free.
 */

import { splitMix64, toBits } from './mix';

/**
 * Ceiling on a tower's height, and the head sentinel's width. **Part of the conformance
 * contract**, not a tuning knob — it truncates the height distribution, so it changes
 * op-counts in both languages at once. Must equal the Rust `skip_list::MAX_LEVEL`.
 */
export const MAX_LEVEL = 24;

/**
 * The height hash's salt, mirroring the Rust `HEIGHT_SALT`. It exists because
 * `splitMix64(toBits(0)) === 0n` — the finalizer maps zero to itself — and
 * `trailingZeros(0)` is 64, so hashing the raw bits would hand the key `0` a full-height
 * tower. `0` is one of the commonest keys real data contains, and a stray 24-level express
 * lane costs every later descent an extra inspection per level.
 */
const HEIGHT_SALT = 0x9e3779b97f4a7c15n;

const MASK64 = (1n << 64n) - 1n;

/** Trailing zero count of a 64-bit `bigint` (64 for zero), mirroring Rust's `trailing_zeros`. */
function trailingZeros64(h: bigint): number {
  if (h === 0n) return 64;
  let n = 0;
  let v = h & MASK64;
  while ((v & 1n) === 0n) {
    v >>= 1n;
    n += 1;
  }
  return n;
}

/**
 * The number of levels `key`'s tower occupies — geometric with p = ½, deterministic in
 * the key, clamped to {@link MAX_LEVEL}. The clamp guards the one remaining zero-hash
 * input: the f64 whose bit pattern *is* the salt.
 */
export function towerHeight(key: number): number {
  const h = splitMix64(toBits(key) ^ HEIGHT_SALT);
  return 1 + Math.min(trailingZeros64(h), MAX_LEVEL - 1);
}

/** Result of a search: membership plus the structure's cost-metric op-count. */
export interface SearchResult {
  readonly found: boolean;
  /** Node-visits (one key comparison each), the skip list's cost metric. */
  readonly ops: number;
}

/** Result of a delete: whether a key was removed plus the node-visits it cost. */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}

interface Node {
  readonly value: number;
  /** `forward[i]` is the next node at level `i`; the array's length *is* the tower height. */
  readonly forward: (Node | null)[];
}

export class SkipListF64 {
  /** The head sentinel's forward links, always {@link MAX_LEVEL} wide. */
  private readonly head: (Node | null)[] = new Array<Node | null>(MAX_LEVEL).fill(null);
  /** Levels currently in use (0 when empty); levels below this are all non-empty. */
  private level = 0;
  private count = 0;

  /** Build by inserting each key in turn. Insertion order cannot change the result. */
  static fromKeys(keys: readonly number[]): SkipListF64 {
    const s = new SkipListF64();
    for (const k of keys) s.insert(k);
    return s;
  }

  /** Number of stored keys (`n`); duplicates each count. */
  get size(): number {
    return this.count;
  }

  /** Number of levels currently in use. */
  get topLevel(): number {
    return this.level;
  }

  /** The node after `cur` at `level`; `null` reads the head sentinel. */
  private fwd(cur: Node | null, level: number): Node | null {
    return cur === null ? this.head[level] : cur.forward[level];
  }

  private setFwd(cur: Node | null, level: number, next: Node | null): void {
    if (cur === null) this.head[level] = next;
    else cur.forward[level] = next;
  }

  /**
   * The shared descent: top level down to level 0, advancing while the forward node's key
   * compares less than `target`, recording the last node visited per level in `update`.
   * Counts **one op per node inspected**.
   *
   * `pastEqual` is the only difference between the insert descent and the search/delete
   * one: `false` advances while `value < target` (stopping before the first equal key —
   * what search and delete need), `true` while `value <= target` (stopping after the last,
   * so a new equal lands behind the stored equals).
   */
  private descend(
    target: number,
    pastEqual: boolean,
    update: (Node | null)[],
  ): { cur: Node | null; ops: number } {
    let cur: Node | null = null; // the head sentinel
    let ops = 0;
    for (let i = this.level - 1; i >= 0; i--) {
      for (;;) {
        const nx = this.fwd(cur, i);
        if (nx === null) break;
        ops += 1;
        if (pastEqual ? nx.value <= target : nx.value < target) cur = nx;
        else break;
      }
      update[i] = cur;
    }
    return { cur, ops };
  }

  /**
   * Search for `key`: descend to its level-0 predecessor, then inspect the one node that
   * could hold it. The final equality test is counted too, so a miss past the end of the
   * list costs one op less than a hit.
   */
  search(target: number): SearchResult {
    const update = new Array<Node | null>(MAX_LEVEL).fill(null);
    const { cur, ops } = this.descend(target, false, update);
    const nx = this.fwd(cur, 0);
    if (nx === null) return { found: false, ops };
    return { found: nx.value === target, ops: ops + 1 };
  }

  /**
   * Insert `key` (multiset — a new equal key goes *after* the stored equals). The tower
   * height comes from the key, so the resulting list is a function of the key set alone.
   * Returns the descent's node-visits; the link surgery is free.
   */
  insert(key: number): { ops: number } {
    // `update` starts at the head everywhere, which is already the right predecessor for
    // every level the list does not yet use — a taller-than-current tower links straight
    // off the sentinel.
    const update = new Array<Node | null>(MAX_LEVEL).fill(null);
    const { ops } = this.descend(key, true, update);

    const height = towerHeight(key);
    if (height > this.level) this.level = height;
    const node: Node = { value: key, forward: new Array<Node | null>(height).fill(null) };
    for (let j = 0; j < height; j++) {
      node.forward[j] = this.fwd(update[j], j);
      this.setFwd(update[j], j, node);
    }
    this.count += 1;
    return { ops };
  }

  /**
   * Delete the **first** occurrence of `target`. Counts the descent's node-visits plus the
   * one equality test that identifies the victim; unlinking carries no comparisons.
   */
  delete(target: number): DeleteResult {
    const update = new Array<Node | null>(MAX_LEVEL).fill(null);
    const { cur, ops } = this.descend(target, false, update);

    const victim = this.fwd(cur, 0);
    if (victim === null) return { removed: false, ops };
    if (victim.value !== target) return { removed: false, ops: ops + 1 };

    // Unlink at every level the victim occupies. Duplicates of a key all share its height,
    // and the victim is the first node ≥ key in level-0 order, so below its height that is
    // the node each `update[j]` points at; the guard is the textbook belt-and-braces.
    for (let j = 0; j < victim.forward.length; j++) {
      if (this.fwd(update[j], j) === victim) this.setFwd(update[j], j, victim.forward[j]);
    }
    this.count -= 1;
    while (this.level > 0 && this.head[this.level - 1] === null) this.level -= 1;
    return { removed: true, ops: ops + 1 };
  }

  /** Keys in ascending order — the level-0 walk, which *is* the iteration order. */
  keysInOrder(): number[] {
    const out: number[] = [];
    for (let n = this.head[0]; n !== null; n = n.forward[0]) out.push(n.value);
    return out;
  }

  /**
   * The keys visible at each level, level 0 first — the **express-lane profile**, and the
   * dimension membership and op-count cannot supply on their own. A skip list whose upper
   * levels are mis-linked still answers every membership query correctly (level 0 alone is
   * a sorted linked list) while being an O(n) structure, so this is what the conformance
   * corpus pins — the counterpart to the BST corpus's pre-order shape.
   */
  levelKeys(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.level; i++) {
      const lvl: number[] = [];
      for (let n = this.head[i]; n !== null; n = n.forward[i]) lvl.push(n.value);
      out.push(lvl);
    }
    return out;
  }
}
