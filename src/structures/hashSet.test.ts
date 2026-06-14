import { describe, it, expect } from 'vitest';
import { HashSetF64 } from './hashSet';

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
});
