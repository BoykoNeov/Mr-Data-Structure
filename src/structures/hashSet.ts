/**
 * Teaching implementation of the separate-chaining hash set (docs/PLAN.md §8,
 * "Hashing" family) — the TypeScript twin of the Rust bench impl
 * (bench-engine/src/structures/hash_set.rs).
 *
 * Conformance is exacting here (docs/PLAN.md §12): bucket count, growth policy,
 * the {@link mixF64} hash, and the rehash redistribution order must all match
 * Rust, because together they fix the chain order — and therefore both the
 * iteration order and the search op-count (hashes + chain-steps). Any drift in
 * one of them shows up as a corpus mismatch.
 *
 * Semantics: a **set** — duplicates collapse on insert (first occurrence wins).
 * Buckets are a power of two (index by mask), doubling when the load factor
 * would exceed 0.75, which keeps chains short so search reads as O(1). `delete`
 * removes the chain entry in place (`Array.splice`), preserving chain order; the
 * table never shrinks.
 *
 * Every op accepts an optional {@link Tracer} that yields the animation
 * step-events (docs/PLAN.md §5) — the hash, each chain-step probe, inserts,
 * removes, and the per-key redistribution of a rehash. As with the array
 * (docs/PLAN.md §2.1), each cost event is emitted exactly where the op-count
 * ticks, so a search stream's cost-event count equals its op-count (the
 * invariant in `src/viz/trace.test.ts`); the untraced path allocates nothing.
 */

import { mixF64 } from './mix';
import type { SearchResult, DeleteResult } from './dynArray';
import type { Tracer, HashSetEvent, RehashMove } from '../viz/events';

const INITIAL_BUCKETS = 4;
/** Grow when `len / buckets` would exceed this (docs/PLAN.md §8). */
const MAX_LOAD = 0.75;

export class HashSetF64 {
  private buckets: number[][];
  private count = 0;

  constructor() {
    this.buckets = Array.from({ length: INITIAL_BUCKETS }, () => []);
  }

  /** Build from a key sequence by inserting each in order (duplicates collapse). */
  static fromKeys(keys: readonly number[]): HashSetF64 {
    const s = new HashSetF64();
    for (const k of keys) s.insert(k);
    return s;
  }

  /** Number of distinct stored keys. */
  get size(): number {
    return this.count;
  }

  /**
   * Bucket index for `key`: the low bits of the hash. The mask is applied to the
   * `bigint` hash *before* the `Number()` conversion, so we never round-trip a
   * full 64-bit value through an f64 (`buckets.length - 1` is small and exact).
   */
  private bucketIndex(key: number): number {
    return Number(mixF64(key) & BigInt(this.buckets.length - 1));
  }

  /** Insert with dedupe; grow (rehash) when the load factor is exceeded. */
  insert(key: number, trace?: Tracer<HashSetEvent>): void {
    const idx = this.bucketIndex(key);
    trace?.({ kind: 'hs.hash', key, bucket: idx });
    const bucket = this.buckets[idx];
    for (let pos = 0; pos < bucket.length; pos++) {
      const matched = bucket[pos] === key;
      trace?.({ kind: 'hs.probe', bucket: idx, pos, target: key, matched });
      if (matched) {
        trace?.({ kind: 'hs.duplicate', bucket: idx, pos });
        return;
      }
    }
    bucket.push(key);
    this.count += 1;
    trace?.({ kind: 'hs.insert', bucket: idx, value: key });
    if (this.count > MAX_LOAD * this.buckets.length) this.rehash(trace);
  }

  /**
   * Double the bucket count and redistribute. The traversal order — old buckets
   * by index, each chain front-to-back, appended to the new bucket — is part of
   * the observable contract and mirrors the Rust impl exactly. When tracing, the
   * per-key relocation is captured in `moves` (old-iteration order) so the
   * redistribution can animate (docs/PLAN.md §5).
   */
  private rehash(trace?: Tracer<HashSetEvent>): void {
    const oldCap = this.buckets.length;
    const newCount = oldCap * 2;
    const next: number[][] = Array.from({ length: newCount }, () => []);
    const mask = BigInt(newCount - 1);
    const moves: RehashMove[] | undefined = trace ? [] : undefined;
    for (const bucket of this.buckets) {
      for (const k of bucket) {
        const toBucket = Number(mixF64(k) & mask);
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
  search(target: number, trace?: Tracer<HashSetEvent>): SearchResult {
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
   * order (no swap-remove), the TS twin of the Rust `remove_key`. The table never
   * shrinks. Returns membership and the op-count (hashes + chain-steps).
   */
  delete(target: number, trace?: Tracer<HashSetEvent>): DeleteResult {
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
  keysInOrder(): number[] {
    const out: number[] = [];
    for (const bucket of this.buckets) out.push(...bucket);
    return out;
  }

  /** A copy of the bucket layout (each chain front-to-back) — the hash set's
   * display model for the visualizer (docs/PLAN.md §5). */
  snapshotBuckets(): number[][] {
    return this.buckets.map((b) => b.slice());
  }

  /** Longest chain — proof the load-factor policy keeps search O(1) (a test hook). */
  maxChain(): number {
    let max = 0;
    for (const bucket of this.buckets) max = Math.max(max, bucket.length);
    return max;
  }
}
