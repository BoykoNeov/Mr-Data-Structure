import { describe, it, expect } from 'vitest';
import { HashSetOaF64, churnBlock } from './hashSetOa';
import { HashSetF64 } from './hashSet';
import { mixF64 } from './mix';

/** A fixed-seed permutation of 0..n-1 (xorshift32 — deterministic, no RNG dependency). */
function shuffled(n: number): number[] {
  const v = Array.from({ length: n }, (_, i) => i);
  let s = 0x9e3779b9 >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const j = s % (i + 1);
    [v[i], v[j]] = [v[j], v[i]];
  }
  return v;
}

describe('HashSetOaF64 — teaching twin of the Rust open-addressing set', () => {
  it('answers membership and collapses duplicates (set semantics)', () => {
    const s = HashSetOaF64.fromKeys([5, 5, 7, 5, 9]);
    expect(s.size).toBe(3);
    expect(s.search(7).found).toBe(true);
    expect(s.search(8).found).toBe(false);
    expect(s.insert(9)).toEqual({ inserted: false, ops: expect.any(Number) });
  });

  it('counts like the chaining set: a home-slot hit is hash + 1, a miss on an empty slot is the hash alone', () => {
    expect(HashSetOaF64.fromKeys([42]).search(42)).toEqual({ found: true, ops: 2 });
    expect(new HashSetOaF64().search(1)).toEqual({ found: false, ops: 1 });
  });

  it('grows at the chaining set’s points, so both tables share a load factor at every n', () => {
    // Chaining's rule (hash_set.rs): start at 4, double whenever len > 0.75 · buckets.
    const chainingCap = (n: number) => {
      let b = 4;
      for (let len = 1; len <= n; len++) if (len > 0.75 * b) b *= 2;
      return b;
    };
    const keys = Array.from({ length: 5000 }, (_, i) => i);
    for (const n of [0, 1, 3, 4, 7, 50, 1000, 5000]) {
      expect(HashSetOaF64.fromKeys(keys.slice(0, n)).capacity).toBe(chainingCap(n));
    }
  });

  it('agrees with a reference Set through an interleaved insert/delete/search workload', () => {
    const s = new HashSetOaF64();
    const ref = new Set<number>();
    let x = 12345;
    for (let step = 0; step < 4000; step++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const k = (x >> 8) % 40;
      const op = (x >> 4) % 3;
      if (op === 0) {
        expect(s.insert(k).inserted).toBe(!ref.has(k));
        ref.add(k);
      } else if (op === 1) expect(s.delete(k).removed).toBe(ref.delete(k));
      else expect(s.search(k).found).toBe(ref.has(k));
      expect(s.size).toBe(ref.size);
      // The termination invariant: tombstones count toward the load, so an empty slot remains.
      expect(s.size + s.tombstones).toBeLessThanOrEqual(0.75 * s.capacity);
    }
    expect([...s.keysInOrder()].sort((a, b) => a - b)).toEqual([...ref].sort((a, b) => a - b));
  });

  it('a key behind a tombstone stays reachable, and re-insert reuses that tombstone', () => {
    const s = HashSetOaF64.fromKeys(Array.from({ length: 200 }, (_, i) => i));
    const slots = s.slots();
    const mask = s.capacity - 1;
    const pos = slots.findIndex(
      (sl, i) => typeof sl === 'number' && Number(mixF64(sl) & BigInt(mask)) !== i,
    );
    expect(pos).toBeGreaterThanOrEqual(0); // 200 keys in 512 slots collide somewhere
    const displaced = slots[pos] as number;
    const blocker = slots[(pos + mask) & mask] as number;
    const before = s.search(displaced).ops;
    expect(s.delete(blocker).removed).toBe(true);
    expect(s.search(displaced)).toEqual({ found: true, ops: before });
    expect(s.insert(blocker).inserted).toBe(true);
    expect(s.tombstones).toBe(0);
    expect(s.slots()).toEqual(slots);
  });

  it('churn block size is clamp(⌊len / 32⌋, 1, 16)', () => {
    expect([0, 31, 32, 100, 511, 512, 10_000].map(churnBlock)).toEqual([1, 1, 1, 3, 15, 16, 16]);
  });

  it('after priming, the per-pair churn cost does not drift and each pair restores the layout', () => {
    const keys = shuffled(3000);
    for (const n of [250, 1000, 3000]) {
      const s = HashSetOaF64.fromKeys(keys.slice(0, n));
      s.setChurnKey(1e9);
      const primed = s.slots();
      const first = s.churnCounted();
      for (let r = 0; r < 50; r++) expect(s.churnCounted()).toBe(first);
      expect(s.slots()).toEqual(primed);
      expect(s.size).toBe(new Set(keys.slice(0, n)).size);
    }
  });

  it('its probes cost more than the chaining set’s at the same load factor — primary clustering', () => {
    const keys = shuffled(5000);
    const oa = HashSetOaF64.fromKeys(keys);
    const ch = HashSetF64.fromKeys(keys);
    let oaOps = 0;
    let chOps = 0;
    for (let i = 0; i < 4000; i++) {
      oaOps += oa.search(1e6 + i).ops;
      chOps += ch.search(1e6 + i).ops;
    }
    expect(oaOps / 4000).toBeGreaterThan(1.5 * (chOps / 4000));
  });
});
