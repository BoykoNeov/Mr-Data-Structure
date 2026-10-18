import { describe, it, expect } from 'vitest';
import { HashSetBsF64, churnBlock } from './hashSetBs';
import { HashSetOaF64, churnBlock as oaChurnBlock } from './hashSetOa';
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

/** Every live key reachable from its home without crossing an empty slot. */
function pathsUnbroken(s: HashSetBsF64): boolean {
  const slots = s.slots();
  const mask = slots.length - 1;
  return slots.every((sl, pos) => {
    if (sl === '.') return true;
    for (let i = Number(mixF64(sl) & BigInt(mask)); i !== pos; i = (i + 1) & mask) {
      if (slots[i] === '.') return false;
    }
    return true;
  });
}

describe('HashSetBsF64 — teaching twin of the Rust backward-shift set', () => {
  it('answers membership and collapses duplicates (set semantics)', () => {
    const s = HashSetBsF64.fromKeys([5, 5, 7, 5, 9]);
    expect(s.size).toBe(3);
    expect(s.search(7).found).toBe(true);
    expect(s.search(8).found).toBe(false);
    expect(s.insert(9)).toEqual({ inserted: false, ops: expect.any(Number) });
  });

  it('counts like the other hash sets: a home-slot hit is hash + 1, a lone delete scans nothing', () => {
    expect(HashSetBsF64.fromKeys([42]).search(42)).toEqual({ found: true, ops: 2 });
    expect(new HashSetBsF64().search(1)).toEqual({ found: false, ops: 1 });
    expect(HashSetBsF64.fromKeys([42]).deleteSplit(42)).toEqual({ removed: true, find: 2, shift: 0 });
  });

  it('grows at the chaining set’s points, so all three hash sets share a load factor at every n', () => {
    const chainingCap = (n: number) => {
      let b = 4;
      for (let len = 1; len <= n; len++) if (len > 0.75 * b) b *= 2;
      return b;
    };
    const keys = Array.from({ length: 5000 }, (_, i) => i);
    for (const n of [0, 1, 3, 4, 7, 50, 1000, 5000]) {
      expect(HashSetBsF64.fromKeys(keys.slice(0, n)).capacity).toBe(chainingCap(n));
    }
  });

  it('a delete-free build is the tombstone set’s table, slot for slot', () => {
    const keys = shuffled(3000).map((k) => k * 7 + 3);
    for (const n of [0, 6, 7, 500, 3000]) {
      const bs = HashSetBsF64.fromKeys(keys.slice(0, n));
      const oa = HashSetOaF64.fromKeys(keys.slice(0, n));
      expect(bs.slots()).toEqual(oa.slots());
    }
    expect([0, 31, 32, 100, 511, 512, 10_000].map(churnBlock)).toEqual(
      [0, 31, 32, 100, 511, 512, 10_000].map(oaChurnBlock),
    );
  });

  it('agrees with a reference Set through an interleaved workload, with no broken probe path', () => {
    const s = new HashSetBsF64();
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
      expect(s.slots().filter((sl) => sl !== '.').length).toBe(s.size); // no tombstones
      expect(pathsUnbroken(s)).toBe(true);
    }
    expect([...s.keysInOrder()].sort((a, b) => a - b)).toEqual([...ref].sort((a, b) => a - b));
  });

  it('with no priming, the first counted pair is the steady state and the table stays as built', () => {
    const keys = shuffled(3000);
    for (const n of [250, 1000, 3000]) {
      const s = HashSetBsF64.fromKeys(keys.slice(0, n));
      const built = s.slots();
      s.setChurnKey(1e9);
      expect(s.slots()).toEqual(built);
      const first = s.churnCounted();
      for (let r = 0; r < 50; r++) expect(s.churnCounted()).toBe(first);
      expect(s.slots()).toEqual(built);
    }
  });

  it('at the load threshold the settle doubles the table before anything is counted', () => {
    const s = HashSetBsF64.fromKeys([0, 1, 2, 3, 4, 5]); // 6 keys = 0.75 · 8
    expect(s.capacity).toBe(8);
    s.setChurnKey(6);
    expect(s.capacity).toBe(16);
    const settled = s.slots();
    const c = s.churnCounted();
    expect(s.churnCounted()).toBe(c);
    expect(s.slots()).toEqual(settled);
  });
});
