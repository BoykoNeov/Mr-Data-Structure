/**
 * Teaching implementation of the **open-addressing (linear-probing) hash set**
 * (docs/PLAN.md §8 "Hashing", §13) — the TypeScript twin of the Rust bench impl
 * (bench-engine/src/structures/hash_set_oa.rs), held to it slot for slot by
 * `conformance/corpus-hoa.txt` (docs/PLAN.md §12).
 *
 * It is built to be read against the chaining {@link HashSetF64}: the same {@link mixF64}
 * hash, the same 4-slot start, the same 0.75 growth threshold and the same doubling, so at
 * every size the two tables have the same capacity and load factor and only the collision
 * strategy differs. A colliding key here goes to the next free slot of the one flat array,
 * so collisions from neighbouring home slots merge into one run (primary clustering).
 *
 * **Cost metric: hashes + slot probes** — one for the hash, one per *occupied* slot
 * examined (a live key compared, or a tombstone stepped over). The empty slot that ends a
 * walk is free, exactly as the end of a chain is free in the chaining set, so the two
 * op-counts line up unit for unit (docs/METHODOLOGY.md §2.8).
 *
 * **Delete leaves a tombstone**, and four rules — all mirrored exactly from Rust, because
 * together they fix the layout and therefore every probe count — keep churn honest:
 *  1. insert reuses the **first** tombstone on its path, after walking on to an empty
 *     slot to confirm the key is absent;
 *  2. tombstones count toward the load: rehash when `live + tombs > L · cap`, purging
 *     in place when `live ≤ L · cap / 2`, otherwise doubling (the table never shrinks) —
 *     `L` is 0.75 unless the constructor is given another threshold (below);
 *  3. {@link HashSetOaF64.setChurnKey} primes each churn key with an untimed
 *     insert+delete pair, repeating whole passes until one changes nothing;
 *  4. churn cycles a block of `clamp(⌊len / 32⌋, 1, 16)` consecutive keys, not one.
 *
 * `insert` / `search` / `delete` accept an optional {@link Tracer} that yields the
 * animation step-events (docs/PLAN.md §5): each cost event is emitted exactly where the
 * op-count ticks, so a stream's cost-event count equals its op-count for all three ops
 * (`src/viz/trace.hoa.test.ts`, chained to the corpus). The empty slot that ends a walk
 * (`hoa.stop`) and the rehash's re-placement are traced but free, as they are uncounted.
 * The churn helpers stay untraced; the untraced path allocates nothing.
 *
 * The threshold `L` is a constructor option (docs/PLAN.md §13, the load-factor control),
 * mirroring Rust's `with_max_load`: the Compare page's opt-in 0.5 / 0.9 tables. Every rule
 * reads `L` where it read 0.75, and the default — what `new HashSetOaF64()` and the Explore
 * tab's seed build — is exactly the 0.75 table the corpus pins.
 */

import { mixF64 } from './mix';
import type { Tracer, HashSetOaEvent, HoaMove } from '../viz/events';

const INITIAL_SLOTS = 4;
/** Rehash when `(live + tombstones) / slots` would exceed this — the chaining set's 0.75, and
 * the threshold whenever the constructor is given none. */
const MAX_LOAD = 0.75;
const CHURN_BLOCK_MAX = 16;
const KEYS_PER_CHURN_KEY = 32;
const MAX_PRIMING_PASSES = 8;

const EMPTY = 0;
const LIVE = 1;
const TOMB = 2;

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
/** Whether a key was removed plus the op-count. */
export interface DeleteResult {
  readonly removed: boolean;
  readonly ops: number;
}

/** One slot of the table, as the corpus writes it: `'.'` empty, `'x'` tombstone, else the key. */
export type Slot = number | '.' | 'x';

/** How many churn keys a set of `len` stored keys churns: `clamp(⌊len / 32⌋, 1, 16)`. */
export function churnBlock(len: number): number {
  return Math.min(CHURN_BLOCK_MAX, Math.max(1, Math.floor(len / KEYS_PER_CHURN_KEY)));
}

export class HashSetOaF64 {
  private keys: Float64Array = new Float64Array(INITIAL_SLOTS);
  private state: Uint8Array = new Uint8Array(INITIAL_SLOTS);
  private count = 0;
  private tombs = 0;
  private rehashes = 0;
  private churnKeys: number[] = [];
  private readonly load: number;

  /**
   * An empty table at rehash threshold `maxLoad` (default 0.75). Like Rust's
   * `with_max_load`, rejects anything outside `[0.25, 1)`: at 1 a miss could find no empty
   * slot to stop at, and below 0.25 one doubling may not restore the threshold.
   */
  constructor(maxLoad: number = MAX_LOAD) {
    if (!(maxLoad >= 0.25 && maxLoad < 1)) {
      throw new Error(`open-addressing max load ${maxLoad} outside [0.25, 1)`);
    }
    this.load = maxLoad;
  }

  /** Build from a key sequence by inserting each in order (duplicates collapse). */
  static fromKeys(keys: readonly number[], maxLoad: number = MAX_LOAD): HashSetOaF64 {
    const s = new HashSetOaF64(maxLoad);
    for (const k of keys) s.insert(k);
    return s;
  }

  /** The rehash threshold this table was built with. */
  get maxLoad(): number {
    return this.load;
  }

  /** Number of distinct stored keys. */
  get size(): number {
    return this.count;
  }
  /** Number of slots. */
  get capacity(): number {
    return this.state.length;
  }
  /** Number of tombstones currently in the table. */
  get tombstones(): number {
    return this.tombs;
  }

  /** Home slot: the hash's low bits, masked as a `bigint` before any `Number()` conversion. */
  private home(key: number, cap = this.state.length): number {
    return Number(mixF64(key) & BigInt(cap - 1));
  }

  /** Walk from the home slot until the key (hit) or an empty slot (miss). */
  search(target: number, trace?: Tracer<HashSetOaEvent>): SearchResult {
    let ops = 1; // the hash
    const cap = this.state.length;
    const home = this.home(target);
    trace?.({ kind: 'hoa.hash', key: target, home });
    let i = home;
    for (let step = 0; step < cap; step++) {
      const st = this.state[i];
      if (st === EMPTY) {
        trace?.({ kind: 'hoa.stop', home, slot: i, reuse: null });
        trace?.({ kind: 'hoa.result', found: false });
        return { found: false, ops };
      }
      ops += 1; // slot probe: a live key compared, or a tombstone stepped over
      const matched = st === LIVE && this.keys[i] === target;
      trace?.(this.probeEvent(home, i, target, matched));
      if (matched) {
        trace?.({ kind: 'hoa.result', found: true });
        return { found: true, ops };
      }
      i = (i + 1) & (cap - 1);
    }
    trace?.({ kind: 'hoa.result', found: false });
    return { found: false, ops };
  }

  /** The `hoa.probe` event for occupied slot `i` (only built when tracing). `reuse` is an
   * insert's first tombstone so far (`-1` = none, and always for search / delete). */
  private probeEvent(home: number, i: number, target: number, matched: boolean, reuse = -1): HashSetOaEvent {
    const live = this.state[i] === LIVE;
    return {
      kind: 'hoa.probe',
      home,
      slot: i,
      state: live ? 'live' : 'tomb',
      value: live ? this.keys[i] : null,
      target,
      matched,
      reuse: reuse < 0 ? null : reuse,
    };
  }

  /**
   * Walk to the first empty slot to dedupe, remembering the first tombstone passed; store
   * the key there (or in the empty slot if none), then rehash if live + tombstones exceed
   * the threshold. Identical to the Rust `insert_generic::<_, true>`.
   */
  insert(key: number, trace?: Tracer<HashSetOaEvent>): InsertResult {
    let ops = 1; // the hash
    const cap = this.state.length;
    const home = this.home(key);
    trace?.({ kind: 'hoa.hash', key, home });
    let i = home;
    let firstTomb = -1;
    let empty = -1;
    for (let step = 0; step < cap; step++) {
      const st = this.state[i];
      if (st === EMPTY) {
        empty = i;
        trace?.({ kind: 'hoa.stop', home, slot: i, reuse: firstTomb < 0 ? null : firstTomb });
        break;
      }
      ops += 1; // slot probe
      if (st === LIVE) {
        const matched = this.keys[i] === key;
        trace?.(this.probeEvent(home, i, key, matched, firstTomb));
        if (matched) {
          trace?.({ kind: 'hoa.duplicate', slot: i });
          return { inserted: false, ops };
        }
      } else {
        if (firstTomb < 0) firstTomb = i;
        trace?.(this.probeEvent(home, i, key, false, firstTomb));
      }
      i = (i + 1) & (cap - 1);
    }
    let slot: number;
    if (firstTomb >= 0) {
      slot = firstTomb;
      this.tombs -= 1;
    } else if (empty >= 0) {
      slot = empty;
    } else {
      throw new Error('load invariant broken: no empty slot');
    }
    this.state[slot] = LIVE;
    this.keys[slot] = key;
    this.count += 1;
    trace?.({ kind: 'hoa.place', slot, value: key, reused: slot === firstTomb });
    if (this.count + this.tombs > this.load * cap) this.rehash(trace);
    return { inserted: true, ops };
  }

  /** Walk as search does; on a hit, leave a tombstone. */
  delete(target: number, trace?: Tracer<HashSetOaEvent>): DeleteResult {
    let ops = 1; // the hash
    const cap = this.state.length;
    const home = this.home(target);
    trace?.({ kind: 'hoa.hash', key: target, home });
    let i = home;
    for (let step = 0; step < cap; step++) {
      const st = this.state[i];
      if (st === EMPTY) {
        trace?.({ kind: 'hoa.stop', home, slot: i, reuse: null });
        trace?.({ kind: 'hoa.result', found: false });
        return { removed: false, ops };
      }
      ops += 1; // slot probe
      const matched = st === LIVE && this.keys[i] === target;
      trace?.(this.probeEvent(home, i, target, matched));
      if (matched) {
        this.state[i] = TOMB;
        this.count -= 1;
        this.tombs += 1;
        trace?.({ kind: 'hoa.tombstone', slot: i });
        trace?.({ kind: 'hoa.result', found: true });
        return { removed: true, ops };
      }
      i = (i + 1) & (cap - 1);
    }
    trace?.({ kind: 'hoa.result', found: false });
    return { removed: false, ops };
  }

  /**
   * Rebuild without tombstones: purge in place when the live keys are at most half the
   * threshold, otherwise double. Live keys are re-placed in old-slot order, each into the
   * first empty slot from its new home — the order Rust uses, which fixes the layout.
   * When tracing, each key's new slot is captured in `moves` (old-slot order) so the
   * rebuild can animate; none of it is counted.
   */
  private rehash(trace?: Tracer<HashSetOaEvent>): void {
    const cap = this.state.length;
    const newCap = this.count > (this.load * cap) / 2 ? cap * 2 : cap;
    const tombs = this.tombs;
    const oldKeys = this.keys;
    const oldState = this.state;
    this.keys = new Float64Array(newCap);
    this.state = new Uint8Array(newCap);
    const moves: HoaMove[] | undefined = trace ? [] : undefined;
    for (let i = 0; i < cap; i++) {
      if (oldState[i] !== LIVE) continue;
      const k = oldKeys[i];
      let j = this.home(k, newCap);
      while (this.state[j] !== EMPTY) j = (j + 1) & (newCap - 1);
      this.state[j] = LIVE;
      this.keys[j] = k;
      moves?.push({ value: k, toSlot: j });
    }
    this.tombs = 0;
    this.rehashes += 1;
    trace?.({ kind: 'hoa.rehash', oldCap: cap, newCap, live: this.count, tombs, moves: moves ?? [] });
  }

  /**
   * Set the churn block `key, key + 1, …` (`churnBlock(size)` keys, each absent) and prime
   * it: one insert+delete per key, then whole passes until one causes no rehash and no new
   * tombstone — the fixed point from which every pair restores the table exactly. A key
   * found present is dropped rather than primed. Mirrors Rust `set_churn_key`.
   */
  setChurnKey(key: number): void {
    this.churnKeys = [];
    const block = churnBlock(this.count);
    for (let j = 0; j < block; j++) {
      const k = key + j;
      if (this.insert(k).inserted) {
        this.delete(k);
        this.churnKeys.push(k);
      }
    }
    for (let pass = 0; pass < MAX_PRIMING_PASSES; pass++) {
      const tombs = this.tombs;
      const rehashes = this.rehashes;
      for (const k of this.churnKeys) {
        this.insert(k);
        this.delete(k);
      }
      if (this.tombs === tombs && this.rehashes === rehashes) break;
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
    for (let i = 0; i < this.state.length; i++) {
      const st = this.state[i];
      out.push(st === EMPTY ? '.' : st === TOMB ? 'x' : this.keys[i]);
    }
    return out;
  }
}
