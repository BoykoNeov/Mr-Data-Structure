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
 * would exceed 0.75, which keeps chains short so search reads as O(1).
 */

import { mixF64 } from './mix';
import type { SearchResult } from './dynArray';

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
  insert(key: number): void {
    const idx = this.bucketIndex(key);
    const bucket = this.buckets[idx];
    if (bucket.includes(key)) return;
    bucket.push(key);
    this.count += 1;
    if (this.count > MAX_LOAD * this.buckets.length) this.rehash();
  }

  /**
   * Double the bucket count and redistribute. The traversal order — old buckets
   * by index, each chain front-to-back, appended to the new bucket — is part of
   * the observable contract and mirrors the Rust impl exactly.
   */
  private rehash(): void {
    const newCount = this.buckets.length * 2;
    const next: number[][] = Array.from({ length: newCount }, () => []);
    const mask = BigInt(newCount - 1);
    for (const bucket of this.buckets) {
      for (const k of bucket) {
        next[Number(mixF64(k) & mask)].push(k);
      }
    }
    this.buckets = next;
  }

  /**
   * Hash once, then walk that bucket's chain comparing keys. Returns membership
   * and the cost-metric count: 1 (the hash) plus one chain-step per key compared
   * — identical to the Rust impl's `search_one_counted`.
   */
  search(target: number): SearchResult {
    let ops = 1; // the hash
    const bucket = this.buckets[this.bucketIndex(target)];
    for (const k of bucket) {
      ops += 1; // chain-step
      if (k === target) return { found: true, ops };
    }
    return { found: false, ops };
  }

  /** Keys in bucket-walk order (buckets by index, each chain front-to-back). */
  keysInOrder(): number[] {
    const out: number[] = [];
    for (const bucket of this.buckets) out.push(...bucket);
    return out;
  }

  /** Longest chain — proof the load-factor policy keeps search O(1) (a test hook). */
  maxChain(): number {
    let max = 0;
    for (const bucket of this.buckets) max = Math.max(max, bucket.length);
    return max;
  }
}
