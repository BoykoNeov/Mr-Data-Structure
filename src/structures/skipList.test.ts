import { describe, it, expect } from 'vitest';
import { MAX_LEVEL, SkipListF64, towerHeight } from './skipList';

/**
 * Unit tests for the skip-list teaching twin (docs/PLAN.md §8). The cross-language
 * agreement lives in `conformance-skip.test.ts`; these pin the behaviour the corpus
 * cannot reach — the height rule's anchors (the mirror of the Rust
 * `skip_list::tests::height_anchors_are_pinned`, so a drift is caught here before the
 * corpus), the insertion-order independence the whole design buys, and the invariant that
 * every level is a sorted subsequence of the one below it.
 */
describe('towerHeight — the hash-derived height rule', () => {
  /** The same anchors the Rust unit test pins, so either side drifting fails locally. */
  it('matches the pinned Rust anchors', () => {
    expect(towerHeight(0)).toBe(1);
    expect(towerHeight(1)).toBe(1);
    expect(towerHeight(5)).toBe(3);
    expect(towerHeight(7)).toBe(4);
    expect(towerHeight(37)).toBe(6);
    expect(towerHeight(116)).toBe(9);
    expect(towerHeight(0.5)).toBe(3);
    expect(towerHeight(-1)).toBe(2);
    expect(towerHeight(1_000_000)).toBe(1);
  });

  it('halves level by level — geometric with p = ½', () => {
    const atLeast = new Array<number>(6).fill(0);
    for (let i = 0; i < 4000; i++) {
      const h = towerHeight(i);
      for (let level = 0; level < atLeast.length; level++) if (h >= level + 1) atLeast[level] += 1;
    }
    for (let level = 1; level < atLeast.length; level++) {
      const ratio = atLeast[level] / atLeast[level - 1];
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    }
  });

  /**
   * The clamp, on the only input that still hashes to zero: the f64 whose bit pattern is
   * the salt. It asks for 64 levels and must get {@link MAX_LEVEL}.
   */
  it('clamps the salt’s own key instead of building a 64-level tower', () => {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setBigUint64(0, 0x9e3779b97f4a7c15n, false);
    const pathological = bits.getFloat64(0, false);
    expect(towerHeight(pathological)).toBe(MAX_LEVEL);
    const s = SkipListF64.fromKeys([pathological, 1, 2]);
    expect(s.topLevel).toBe(MAX_LEVEL);
    expect(s.search(pathological).found).toBe(true);
  });
});

describe('SkipListF64 — teaching impl (ordered multiset, no rebalancing)', () => {
  it('keeps keys ascending with duplicates retained', () => {
    const s = SkipListF64.fromKeys([5, 1, 5, 3, 5, 2]);
    expect(s.keysInOrder()).toEqual([1, 2, 3, 5, 5, 5]);
    expect(s.size).toBe(6);
  });

  it('finds present keys and rejects absent ones', () => {
    const s = SkipListF64.fromKeys(Array.from({ length: 64 }, (_, i) => i));
    expect(s.search(0).found).toBe(true);
    expect(s.search(63).found).toBe(true);
    expect(s.search(64).found).toBe(false);
    expect(s.search(-1).found).toBe(false);
    expect(new SkipListF64().search(1)).toEqual({ found: false, ops: 0 });
  });

  /**
   * The property the hash-derived heights buy: the list a key set builds does not depend
   * on the order the keys arrived in. It is why the skip list keeps its class on the
   * reverse-sorted input that degenerates a naive BST — with no rotations and no RNG.
   */
  it('builds the same list whatever order the keys arrive in', () => {
    const ascending = Array.from({ length: 200 }, (_, i) => i);
    const descending = [...ascending].reverse();
    const shuffled = [...ascending];
    [shuffled[0], shuffled[137]] = [shuffled[137], shuffled[0]];

    const a = SkipListF64.fromKeys(ascending);
    const d = SkipListF64.fromKeys(descending);
    const s = SkipListF64.fromKeys(shuffled);

    expect(d.levelKeys()).toEqual(a.levelKeys());
    expect(s.levelKeys()).toEqual(a.levelKeys());
    expect(d.search(199)).toEqual(a.search(199));
  });

  it('keeps every level a sorted subsequence of the one below it', () => {
    const s = SkipListF64.fromKeys(Array.from({ length: 2000 }, (_, i) => i));
    const levels = s.levelKeys();
    expect(levels.length).toBeGreaterThanOrEqual(8);
    for (const lvl of levels) {
      expect([...lvl].sort((x, y) => x - y)).toEqual(lvl);
    }
    for (let i = 1; i < levels.length; i++) {
      const lower = levels[i - 1];
      let at = 0;
      for (const k of levels[i]) {
        at = lower.indexOf(k, at);
        expect(at).toBeGreaterThanOrEqual(0);
      }
    }
    for (const k of levels[0]) {
      expect(levels.filter((lvl) => lvl.includes(k)).length).toBe(towerHeight(k));
    }
  });

  /**
   * A delete that only fixed level 0 would leave a dangling express link — and would still
   * answer every membership question correctly, which is exactly why the corpus pins the
   * level lists rather than trusting the order.
   */
  it('unlinks a deleted key from every level of its tower', () => {
    const keys = Array.from({ length: 500 }, (_, i) => i);
    const s = SkipListF64.fromKeys(keys);
    expect(towerHeight(116)).toBe(9);
    expect(s.delete(116).removed).toBe(true);
    for (const lvl of s.levelKeys()) expect(lvl).not.toContain(116);
    expect(s.size).toBe(keys.length - 1);
    expect(s.search(116).found).toBe(false);
    expect(s.keysInOrder()).toEqual(keys.filter((k) => k !== 116));
  });

  it('removes one occurrence at a time from a run of equal keys', () => {
    const s = SkipListF64.fromKeys([5, 5, 5, 7]);
    expect(s.delete(5).removed).toBe(true);
    expect(s.keysInOrder()).toEqual([5, 5, 7]);
    expect(s.delete(5).removed).toBe(true);
    expect(s.delete(5).removed).toBe(true);
    expect(s.delete(5).removed).toBe(false);
    expect(s.keysInOrder()).toEqual([7]);
  });

  it('collapses its levels as it empties', () => {
    const s = SkipListF64.fromKeys(Array.from({ length: 300 }, (_, i) => i));
    for (let i = 0; i < 300; i++) expect(s.delete(i).removed).toBe(true);
    expect(s.size).toBe(0);
    expect(s.topLevel).toBe(0);
    expect(s.levelKeys()).toEqual([]);
  });

  /** Search cost grows like log n, not n — the deterministic half of the O(log n) claim. */
  it('costs only a few more node-visits on a 16× larger list', () => {
    const small = SkipListF64.fromKeys(Array.from({ length: 1000 }, (_, i) => i));
    const big = SkipListF64.fromKeys(Array.from({ length: 16_000 }, (_, i) => i));
    const smallOps = small.search(999).ops;
    const bigOps = big.search(999).ops;
    expect(bigOps).toBeGreaterThan(smallOps);
    expect(bigOps).toBeLessThan(smallOps + 20);
    expect(bigOps).toBeLessThan(100);
  });
});
