/**
 * Teaching implementation of the **backward-shift hash set** — linear probing with no
 * tombstones (docs/PLAN.md §8 "Hashing", §13) — the TypeScript twin of the Rust bench impl
 * (bench-engine/src/structures/hash_set_bs.rs), held to it slot for slot by
 * `conformance/corpus-hbs.txt` (docs/PLAN.md §12).
 *
 * It is built to be read against the tombstone set ({@link HashSetOaF64}): the same
 * {@link mixF64} hash, the same 4-slot start, 0.75 threshold and doubling (and so the
 * chaining set's), the same step-one probe and the same rehash re-placement order. A table
 * built with no deletes is therefore the tombstone set's table slot for slot; only a delete
 * tells them apart.
 *
 * **Delete shifts instead of marking** (Knuth's Algorithm R): after removing the key, walk
 * on through the rest of the run and move back every key whose home slot does not lie
 * cyclically between the hole and that key's slot; the last hole becomes empty. Nothing is
 * left behind, so a churn insert+delete restores the table bit for bit.
 *
 * **Cost metric: hashes + slot probes** — one for the hash, one per occupied slot examined,
 * the empty slot that ends a walk free (docs/METHODOLOGY.md §2.8). The delete's **shift
 * scan** costs **a probe plus a hash per occupied slot**, since deciding whether a key may
 * move back needs its home slot and no hash is stored. {@link HashSetBsF64.deleteSplit}
 * reports the two parts separately, as the corpus does.
 *
 * Churn uses the tombstone set's block — `clamp(⌊len / 32⌋, 1, 16)` consecutive absent keys
 * — and **no priming**; {@link HashSetBsF64.setChurnKey} runs one *capacity settle* pass,
 * which changes nothing unless the set sits exactly at its load threshold (then the churn
 * insert doubles the table before anything is counted). Mirrors Rust `set_churn_key`.
 *
 * Not animated yet (no tracer): an Explore tab for it is a follow-up.
 */

import { mixF64 } from './mix';

const INITIAL_SLOTS = 4;
/** Double when `live / slots` would exceed this — the chaining set's 0.75. */
const MAX_LOAD = 0.75;
const CHURN_BLOCK_MAX = 16;
const KEYS_PER_CHURN_KEY = 32;
const MAX_SETTLE_PASSES = 4;

const EMPTY = 0;
const LIVE = 1;

/** Membership plus the cost-metric op-count (hashes + slot probes). */
export interface SearchResult {
  readonly found: boolean;
  readonly ops: number;
}
/** Whether the key was newly stored (false for a duplicate) plus the op-count. */
export interface InsertResult {
  readonly inserted: boolean;
  readonly ops: number;
}
/** Whether a key was removed plus the op-count (find walk + shift scan). */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}
/** A delete's cost split: the find walk, and the backward-shift scan (2 per slot scanned). */
export interface DeleteSplit {
  readonly removed: boolean;
  readonly find: number;
  readonly shift: number;
}

/** One slot of the table, as the corpus writes it: `'.'` empty, else the key. */
export type Slot = number | '.';

/** How many churn keys a set of `len` stored keys churns: the tombstone set's block rule. */
export function churnBlock(len: number): number {
  return Math.min(CHURN_BLOCK_MAX, Math.max(1, Math.floor(len / KEYS_PER_CHURN_KEY)));
}

export class HashSetBsF64 {
  private keys: Float64Array = new Float64Array(INITIAL_SLOTS);
  private state: Uint8Array = new Uint8Array(INITIAL_SLOTS);
  private count = 0;
  private rehashes = 0;
  private churnKeys: number[] = [];

  /** Build from a key sequence by inserting each in order (duplicates collapse). */
  static fromKeys(keys: readonly number[]): HashSetBsF64 {
    const s = new HashSetBsF64();
    for (const k of keys) s.insert(k);
    return s;
  }

  /** Number of distinct stored keys. */
  get size(): number {
    return this.count;
  }
  /** Number of slots. */
  get capacity(): number {
    return this.state.length;
  }

  /** Home slot: the hash's low bits, masked as a `bigint` before any `Number()` conversion. */
  private home(key: number, cap = this.state.length): number {
    return Number(mixF64(key) & BigInt(cap - 1));
  }

  /** Walk from the home slot until the key (hit) or an empty slot (miss). */
  search(target: number): SearchResult {
    let ops = 1; // the hash
    const cap = this.state.length;
    let i = this.home(target);
    for (let step = 0; step < cap; step++) {
      if (this.state[i] === EMPTY) return { found: false, ops };
      ops += 1; // slot probe (key compared)
      if (this.keys[i] === target) return { found: true, ops };
      i = (i + 1) & (cap - 1);
    }
    return { found: false, ops };
  }

  /**
   * Walk to the first empty slot to dedupe, store the key there, then double if the live
   * keys exceed the threshold. Identical to the Rust `insert_generic`.
   */
  insert(key: number): InsertResult {
    let ops = 1; // the hash
    const cap = this.state.length;
    let i = this.home(key);
    let empty = -1;
    for (let step = 0; step < cap; step++) {
      if (this.state[i] === EMPTY) {
        empty = i;
        break;
      }
      ops += 1; // slot probe (dedupe check)
      if (this.keys[i] === key) return { inserted: false, ops };
      i = (i + 1) & (cap - 1);
    }
    if (empty < 0) throw new Error('load invariant broken: no empty slot');
    this.state[empty] = LIVE;
    this.keys[empty] = key;
    this.count += 1;
    if (this.count > MAX_LOAD * cap) this.rehash();
    return { inserted: true, ops };
  }

  /** Delete, reporting the find walk and the shift scan together (the churn signal's count). */
  delete(target: number): DeleteResult {
    const r = this.deleteSplit(target);
    return { removed: r.removed, ops: r.find + r.shift };
  }

  /**
   * Delete with the cost split in two — Rust `delete_one_split`. Find the key as search
   * does, then shift: the key at slot `j` may fill the hole at `h` unless its home lies
   * cyclically in `(h, j]`, i.e. unless `(j − home) mod cap < (j − h) mod cap`.
   */
  deleteSplit(target: number): DeleteSplit {
    let find = 1; // the hash
    const cap = this.state.length;
    const mask = cap - 1;
    let i = this.home(target);
    let at = -1;
    for (let step = 0; step < cap; step++) {
      if (this.state[i] === EMPTY) return { removed: false, find, shift: 0 };
      find += 1; // slot probe
      if (this.keys[i] === target) {
        at = i;
        break;
      }
      i = (i + 1) & mask;
    }
    if (at < 0) return { removed: false, find, shift: 0 };
    let shift = 0;
    let hole = at;
    let j = (hole + 1) & mask;
    for (let step = 0; step < cap; step++) {
      if (this.state[j] === EMPTY) break; // free: the end of the run
      shift += 2; // slot probe + the hash of the key found there
      const k = this.keys[j];
      const home = this.home(k, cap);
      if (((j - home) & mask) >= ((j - hole) & mask)) {
        this.keys[hole] = k; // move back into the hole …
        hole = j; // … which opens here instead
      }
      j = (j + 1) & mask;
    }
    this.state[hole] = EMPTY;
    this.count -= 1;
    return { removed: true, find, shift };
  }

  /**
   * Double the table (with no tombstones a rehash is always a doubling). Live keys are
   * re-placed in old-slot order, each into the first empty slot from its new home — the
   * order Rust (and the tombstone set) use, which fixes the layout.
   */
  private rehash(): void {
    const cap = this.state.length;
    const newCap = cap * 2;
    const oldKeys = this.keys;
    const oldState = this.state;
    this.keys = new Float64Array(newCap);
    this.state = new Uint8Array(newCap);
    for (let i = 0; i < cap; i++) {
      if (oldState[i] !== LIVE) continue;
      const k = oldKeys[i];
      let j = this.home(k, newCap);
      while (this.state[j] !== EMPTY) j = (j + 1) & (newCap - 1);
      this.state[j] = LIVE;
      this.keys[j] = k;
    }
    this.rehashes += 1;
  }

  /**
   * Set the churn block `key, key + 1, …` (`churnBlock(size)` keys, present ones dropped),
   * then run the capacity settle: insert+delete passes until one causes no doubling — a
   * no-op below the threshold. Mirrors Rust `set_churn_key`.
   */
  setChurnKey(key: number): void {
    this.churnKeys = [];
    const block = churnBlock(this.count);
    for (let j = 0; j < block; j++) {
      const k = key + j;
      if (!this.search(k).found) this.churnKeys.push(k);
    }
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
      const rehashes = this.rehashes;
      for (const k of this.churnKeys) {
        this.insert(k);
        this.delete(k);
      }
      if (this.rehashes === rehashes) break;
    }
  }

  /** The current churn block (see {@link setChurnKey}). */
  churnBlockKeys(): number[] {
    return this.churnKeys.slice();
  }

  /** Mean op-count of one counted insert+delete per churn key — Rust `churn_counted`. */
  churnCounted(): number {
    if (this.churnKeys.length === 0) return 0;
    let ops = 0;
    for (const k of this.churnKeys) {
      ops += this.insert(k).ops;
      ops += this.delete(k).ops;
    }
    return ops / this.churnKeys.length;
  }

  /** Live keys in slot order — the iteration order. */
  keysInOrder(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.state.length; i++) if (this.state[i] === LIVE) out.push(this.keys[i]);
    return out;
  }

  /** The raw table: one entry per slot — the layout the corpus pins. */
  slots(): Slot[] {
    const out: Slot[] = [];
    for (let i = 0; i < this.state.length; i++) out.push(this.state[i] === EMPTY ? '.' : this.keys[i]);
    return out;
  }
}
