import { describe, it, expect } from 'vitest';
import { HashSetF64 } from './hashSet';
import type { HashSetEvent } from '../viz/events';

describe('HashSetF64 — teaching impl mirrors the Rust hash set', () => {
  it('answers membership correctly', () => {
    const s = HashSetF64.fromKeys([1, 2, 3, 4, 5]);
    expect(s.search(3).found).toBe(true);
    expect(s.search(99).found).toBe(false);
  });

  it('dedupes on insert (set semantics)', () => {
    const s = HashSetF64.fromKeys([7, 7, 7, 8]);
    expect(s.size).toBe(2);
  });

  it('every search counts at least the hash; a hit also counts chain-steps', () => {
    const s = HashSetF64.fromKeys([1, 2, 3]);
    const hit = s.search(2);
    expect(hit.found).toBe(true);
    expect(hit.ops).toBeGreaterThanOrEqual(2);
    const miss = s.search(123456);
    expect(miss.found).toBe(false);
    expect(miss.ops).toBeGreaterThanOrEqual(1);
  });

  it('load-factor policy keeps chains short (search stays O(1))', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => i);
    const s = HashSetF64.fromKeys(keys);
    expect(s.size).toBe(1000);
    expect(s.maxChain()).toBeLessThanOrEqual(6);
  });

  it('membership agrees with a reference Set over a random workload', () => {
    const keys = Array.from({ length: 300 }, (_, i) => (i * 31) % 97);
    const s = HashSetF64.fromKeys(keys);
    const ref = new Set(keys);
    expect(s.size).toBe(ref.size);
    for (let q = -5; q < 110; q++) {
      expect(s.search(q).found).toBe(ref.has(q));
    }
  });

  it('keysInOrder returns every distinct key exactly once', () => {
    const keys = [5, 5, 7, 9, 7, 1, 1, 1];
    const s = HashSetF64.fromKeys(keys);
    expect([...s.keysInOrder()].sort((a, b) => a - b)).toEqual([1, 5, 7, 9]);
  });

  it('delete removes the key, counts hash + chain-steps, and is idempotent', () => {
    const s = HashSetF64.fromKeys([1, 2, 3]);
    const del = s.delete(2);
    expect(del.removed).toBe(true);
    expect(del.ops).toBeGreaterThanOrEqual(2); // hash + ≥1 chain-step
    expect(s.size).toBe(2);
    expect(s.search(2).found).toBe(false);
    // Deleting an absent key removes nothing but still costs the hash.
    const again = s.delete(2);
    expect(again.removed).toBe(false);
    expect(again.ops).toBeGreaterThanOrEqual(1);
    expect(s.size).toBe(2);
  });

  it('delete preserves chain order (no swap-remove)', () => {
    // Small fixed table: keys 0,4,8 share bucket 0 (4 buckets, mask = 3) only if
    // their hashes collide — so assert on iteration order via the public surface
    // rather than bucket internals: deleting a middle key keeps the rest ordered.
    const s = HashSetF64.fromKeys([10, 20, 30, 40, 50]);
    const before = s.keysInOrder();
    s.delete(30);
    const after = s.keysInOrder();
    expect(after).toEqual(before.filter((k) => k !== 30));
  });

  it('delete agrees with a reference Set over a random workload', () => {
    const keys = Array.from({ length: 300 }, (_, i) => (i * 31) % 97);
    const s = HashSetF64.fromKeys(keys);
    const ref = new Set(keys);
    for (const q of [0, 96, 31, 31, 200, 5, 62]) {
      const had = ref.has(q);
      expect(s.delete(q).removed).toBe(had);
      ref.delete(q);
      expect(s.size).toBe(ref.size);
      expect(s.search(q).found).toBe(false);
    }
  });

  it('insert emits a hash → probe* → insert stream, with rehash carrying all moves', () => {
    const s = new HashSetF64();
    const events: HashSetEvent[] = [];
    // 4 initial buckets, rehash when count would exceed 0.75*4 = 3, i.e. on the
    // 4th distinct insert.
    for (const k of [1, 2, 3, 4]) s.insert(k, (e) => events.push(e));
    const rehash = events.find((e) => e.kind === 'hs.rehash');
    expect(rehash).toBeDefined();
    if (rehash && rehash.kind === 'hs.rehash') {
      expect(rehash.oldCap).toBe(4);
      expect(rehash.newCap).toBe(8);
      // every live key is redistributed.
      expect(rehash.moves.map((m) => m.value).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(rehash.moves.every((m) => m.toBucket >= 0 && m.toBucket < 8)).toBe(true);
    }
  });
});
