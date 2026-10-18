/**
 * Teaching implementation of the separate-chaining hash set of **string** keys
 * (docs/PLAN.md §8, "Hashing" family) — the TypeScript twin of the Rust bench
 * impl (bench-engine/src/structures/hash_set_str.rs), and the string sibling of
 * {@link HashSetF64}.
 *
 * Same algorithm as the numeric twin, with {@link mixStr} (FNV-1a over UTF-8 +
 * SplitMix64) in place of {@link mixF64}. Conformance is exacting (docs/PLAN.md
 * §12): bucket count, growth policy, the hash, and the rehash redistribution
 * order together fix the chain order — and therefore both the iteration order
 * and the op-count (hashes + chain-steps) of search, insert and delete. Any drift
 * shows up as a corpus mismatch (`conformance/corpus-str.txt`).
 *
 * Semantics: a **set** — duplicates collapse on insert (first occurrence wins).
 * Buckets are a power of two (index by mask), doubling when the load factor
 * would exceed 0.75, which keeps chains short so search reads as O(1). `delete`
 * removes the chain entry in place (`Array.splice`), preserving chain order; the
 * table never shrinks.
 *
 * The hash is **one op** however long the key — FNV-1a reads every UTF-8 byte, so
 * its clock cost grows with the key's length, but the metric counts it once, as
 * Rust does. A chain-step is one whole-key comparison (length-first in Rust).
 *
 * Every op accepts an optional {@link Tracer} yielding the numeric hash set's own
 * step-events, keyed by string (docs/PLAN.md §5): `hs.hash` and `hs.probe` are
 * emitted exactly where the op-count ticks, so for search, insert AND delete the
 * stream's cost-event count is the op-count (`src/viz/trace.str.test.ts`). A rehash
 * is drawn (`hs.rehash`) and never counted. The untraced path allocates nothing.
 */

import { mixStr } from './mix';
import type { SearchResult, DeleteResult } from './dynArray';
import type { InsertResult } from './hashSetOa';
import type { Tracer, HashSetEvent, RehashMove } from '../viz/events';

const INITIAL_BUCKETS = 4;
/** Grow when `len / buckets` would exceed this (docs/PLAN.md §8). */
const MAX_LOAD = 0.75;

export class HashSetStr {
  private buckets: string[][];
  private count = 0;

  constructor() {
    this.buckets = Array.from({ length: INITIAL_BUCKETS }, () => []);
  }

  /** Build from a key sequence by inserting each in order (duplicates collapse). */
  static fromKeys(keys: readonly string[]): HashSetStr {
    const s = new HashSetStr();
    for (const k of keys) s.insert(k);
    return s;
  }

  /** Number of distinct stored keys. */
  get size(): number {
    return this.count;
  }

  /**
   * Bucket index for `key`: the low bits of the hash. The mask is applied to the
   * `bigint` hash *before* the `Number()` conversion (`buckets.length - 1` is
   * small and exact), mirroring the Rust impl's `mix_str(key) & (len - 1)`.
   */
  private bucketIndex(key: string): number {
    return Number(mixStr(key) & BigInt(this.buckets.length - 1));
  }

  /**
   * Insert with dedupe; grow (rehash) when the load factor is exceeded. Returns
   * whether the key was newly stored and the op-count — 1 (the hash) plus one
   * chain-step per key compared on the dedupe walk — the Rust `insert_one_counted`.
   * The rehash it may trigger is structural and uncounted, as in Rust.
   */
  insert(key: string, trace?: Tracer<HashSetEvent<string>>): InsertResult {
    let ops = 1; // the hash
    const idx = this.bucketIndex(key);
    trace?.({ kind: 'hs.hash', key, bucket: idx });
    const bucket = this.buckets[idx];
    for (let pos = 0; pos < bucket.length; pos++) {
      ops += 1; // chain-step (dedupe check)
      const matched = bucket[pos] === key;
      trace?.({ kind: 'hs.probe', bucket: idx, pos, target: key, matched });
      if (matched) {
        trace?.({ kind: 'hs.duplicate', bucket: idx, pos });
        return { inserted: false, ops };
      }
    }
    bucket.push(key);
    this.count += 1;
    trace?.({ kind: 'hs.insert', bucket: idx, value: key });
    if (this.count > MAX_LOAD * this.buckets.length) this.rehash(trace);
    return { inserted: true, ops };
  }

  /**
   * Double the bucket count and redistribute. The traversal order — old buckets
   * by index, each chain front-to-back, appended to the new bucket — is part of
   * the observable contract and mirrors the Rust impl exactly. When tracing, the
   * per-key relocation is captured in `moves` (old-iteration order) so the
   * redistribution can animate (docs/PLAN.md §5).
   */
  private rehash(trace?: Tracer<HashSetEvent<string>>): void {
    const oldCap = this.buckets.length;
    const newCount = oldCap * 2;
    const next: string[][] = Array.from({ length: newCount }, () => []);
    const mask = BigInt(newCount - 1);
    const moves: RehashMove<string>[] | undefined = trace ? [] : undefined;
    for (const bucket of this.buckets) {
      for (const k of bucket) {
        const toBucket = Number(mixStr(k) & mask);
        next[toBucket].push(k);
        moves?.push({ value: k, toBucket });
      }
    }
    this.buckets = next;
    trace?.({ kind: 'hs.rehash', oldCap, newCap: newCount, moves: moves ?? [] });
  }

  /**
   * Hash once, then walk that bucket's chain comparing keys. Returns membership
   * and the cost-metric count: 1 (the hash) plus one chain-step per key compared
   * — identical to the Rust impl's `search_one_counted`.
   */
  search(target: string, trace?: Tracer<HashSetEvent<string>>): SearchResult {
    let ops = 1; // the hash
    const idx = this.bucketIndex(target);
    trace?.({ kind: 'hs.hash', key: target, bucket: idx });
    const bucket = this.buckets[idx];
    for (let pos = 0; pos < bucket.length; pos++) {
      ops += 1; // chain-step
      const matched = bucket[pos] === target;
      trace?.({ kind: 'hs.probe', bucket: idx, pos, target, matched });
      if (matched) {
        trace?.({ kind: 'hs.result', found: true });
        return { found: true, ops };
      }
    }
    trace?.({ kind: 'hs.result', found: false });
    return { found: false, ops };
  }

  /**
   * Hash, walk the chain to find `target`, and splice it out — preserving chain
   * order (no swap-remove), the TS twin of the Rust `remove_key` /
   * `delete_one_counted`. The table never shrinks. Returns membership and the
   * op-count (hashes + chain-steps).
   */
  delete(target: string, trace?: Tracer<HashSetEvent<string>>): DeleteResult {
    let ops = 1; // the hash
    const idx = this.bucketIndex(target);
    trace?.({ kind: 'hs.hash', key: target, bucket: idx });
    const bucket = this.buckets[idx];
    for (let pos = 0; pos < bucket.length; pos++) {
      ops += 1; // chain-step
      const matched = bucket[pos] === target;
      trace?.({ kind: 'hs.probe', bucket: idx, pos, target, matched });
      if (matched) {
        bucket.splice(pos, 1); // preserve chain order
        this.count -= 1;
        trace?.({ kind: 'hs.chainRemove', bucket: idx, pos });
        trace?.({ kind: 'hs.result', found: true });
        return { removed: true, ops };
      }
    }
    trace?.({ kind: 'hs.result', found: false });
    return { removed: false, ops };
  }

  /** Keys in bucket-walk order (buckets by index, each chain front-to-back). */
  keysInOrder(): string[] {
    const out: string[] = [];
    for (const bucket of this.buckets) out.push(...bucket);
    return out;
  }

  /** A copy of the bucket layout (each chain front-to-back) — the display model's
   * seed for the visualizer (docs/PLAN.md §5). */
  snapshotBuckets(): string[][] {
    return this.buckets.map((b) => b.slice());
  }

  /** Longest chain — proof the load-factor policy keeps search O(1) (a test hook). */
  maxChain(): number {
    let max = 0;
    for (const bucket of this.buckets) max = Math.max(max, bucket.length);
    return max;
  }
}
