import { describe, it, expect } from 'vitest';
import {
  generateGaussian,
  generateReverseSorted,
  generateSorted,
  generateUniform,
  generateZipfian,
  type Dataset,
} from '../data';
import { AvlF64, BstF64, BTreeF64, DynArrayF64, HashSetF64, HashSetOaF64, SkipListF64 } from '../structures';
import { buildDataset, DEFAULT_PICKER } from '../ui/DatasetPicker';
import {
  buildNumericProbes,
  DEFAULT_PROBE_MIX,
  describeMix,
  midRangeAbsent,
  missFormOf,
  probeCounts,
  PROBE_MIX_CHOICES,
  summarizeMix,
  type ProbeMix,
} from './probeMix';
import { buildStringProbes } from './stringWorkload';

/**
 * The opt-in **mid-range** form of the numeric absent probes (docs/PLAN.md §13 probe-mix
 * item (a); docs/METHODOLOGY.md §4 hurdles 9 and 15). The default form's byte-identity with
 * the calibrated workload is pinned in `probeMix.test.ts` against frozen copies; this file
 * pins the new form and that choosing it touches nothing but the absent block.
 */

const bytesOf = (a: Float64Array) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const numericKeys = (d: Dataset) => Float64Array.from(d.keys as readonly number[]);
const mid = (presentFraction: number): ProbeMix => ({ presentFraction, missForm: 'midRange' });

const DATASETS: Array<[string, Float64Array]> = [
  ['default picker (uniform, with repeats)', numericKeys(buildDataset(DEFAULT_PICKER))],
  ['sorted 0 … n−1 (no room between neighbours)', numericKeys(generateSorted(5_000))],
  ['reverse-sorted', numericKeys(generateReverseSorted(5_000))],
  ['zipfian (duplicate-heavy)', numericKeys(generateZipfian(5_000, 500, 1, 3))],
  ['gaussian floats', numericKeys(generateGaussian(5_000, 0, 1000, 9))],
  ['negative range', numericKeys(generateUniform(5_000, -10_000, -1, true, 4))],
];
const SIZES = [0, 1, 2, 5, 10, 63, 64, 65, 129, 1000, 5000];

describe('mid-range misses: the workload is honest', () => {
  it.each(DATASETS)('%s — every miss is absent, interior, distinct; counts match the default form', (_name, keys) => {
    for (const n of SIZES.filter((s) => s <= keys.length)) {
      const stored = new Set(Array.from(keys.subarray(0, n)));
      const distinct = [...stored].sort((a, b) => a - b);
      for (const f of PROBE_MIX_CHOICES) {
        const { present, absent } = probeCounts(n, { presentFraction: f });
        const def = buildNumericProbes(keys, n, { presentFraction: f });
        const got = buildNumericProbes(keys, n, mid(f));
        // Same count as the default form, and the present block is byte-identical.
        expect(got).toHaveLength(def.length);
        expect(got).toHaveLength(present + absent);
        expect(bytesOf(got.subarray(0, present))).toEqual(bytesOf(def.subarray(0, present)));
        const miss = Array.from(got.subarray(present));
        expect(miss.every((k) => !stored.has(k))).toBe(true);
        expect(new Set(miss).size).toBe(miss.length);
        // Interior whenever the prefix has two distinct keys: between min and max, never past.
        if (distinct.length >= 2) {
          expect(miss.every((k) => k > distinct[0] && k < distinct[distinct.length - 1])).toBe(true);
        }
      }
    }
  });

  it('naming the default form explicitly is the default — byte for byte', () => {
    const keys = DATASETS[0][1];
    for (const n of SIZES) {
      for (const presentFraction of PROBE_MIX_CHOICES) {
        expect(bytesOf(buildNumericProbes(keys, n, { presentFraction, missForm: 'aboveMax' }))).toEqual(
          bytesOf(buildNumericProbes(keys, n, { presentFraction })),
        );
      }
    }
    expect(missFormOf(DEFAULT_PROBE_MIX)).toBe('aboveMax');
    expect(missFormOf(mid(0.5))).toBe('midRange');
  });

  it('is a different workload from the default (the switch is not a no-op)', () => {
    const keys = DATASETS[0][1];
    expect(bytesOf(buildNumericProbes(keys, 1_000, mid(0.5)))).not.toEqual(
      bytesOf(buildNumericProbes(keys, 1_000, DEFAULT_PROBE_MIX)),
    );
  });

  it('on a dense integer permutation the misses are half-integers, one per gap', () => {
    const keys = numericKeys(generateReverseSorted(1_000)); // 999 … 0: no integer is free inside
    const miss = Array.from(midRangeAbsent(keys, 1_000, 128, 999));
    expect(miss.every((k) => k - Math.floor(k) === 0.5)).toBe(true);
    expect(new Set(miss.map(Math.floor)).size).toBe(128); // 128 distinct gaps
  });

  it('spreads over the whole key range by rank, not one gap and not by value', () => {
    // Even ranks: on 0 … n−1 each eighth of the range gets an eighth of the misses.
    const keys = numericKeys(generateSorted(10_000));
    const miss = Array.from(midRangeAbsent(keys, 10_000, 128, 9_999));
    for (let b = 0; b < 8; b++) {
      const inBin = miss.filter((k) => k >= b * 1_250 && k < (b + 1) * 1_250).length;
      expect(inBin).toBe(16);
    }
    // By rank, not by value: on a heavy-tailed sample the misses follow the keys, so the
    // middle half of the *ranks* holds half the misses even though it is a narrow band of values.
    const g = numericKeys(generateGaussian(10_000, 0, 1000, 5));
    const sorted = Array.from(g).sort((a, b) => a - b);
    const q1 = sorted[2_500];
    const q3 = sorted[7_500];
    const gm = Array.from(midRangeAbsent(g, 10_000, 128, sorted[sorted.length - 1]));
    const inside = gm.filter((k) => k > q1 && k < q3).length;
    expect(inside).toBeGreaterThanOrEqual(62);
    expect(inside).toBeLessThanOrEqual(66);
  });

  it('more misses than gaps: they share gaps evenly inside, still distinct and absent', () => {
    const keys = Float64Array.from([10, 0, 30, 20, 10]); // gaps (0,10) (10,20) (20,30)
    const miss = Array.from(midRangeAbsent(keys, 5, 7, 30)).sort((a, b) => a - b);
    expect(miss).toHaveLength(7);
    expect(new Set(miss).size).toBe(7);
    expect(miss.every((k) => k > 0 && k < 30 && k % 10 !== 0)).toBe(true);
    // 7 over 3 gaps: 2 + 3 + 2, each run evenly placed inside its gap.
    expect(miss.filter((k) => k < 10)).toHaveLength(2);
    expect(miss.filter((k) => k > 10 && k < 20)).toHaveLength(3);
    expect(miss.filter((k) => k > 20)).toHaveLength(2);
    expect(miss.filter((k) => k > 10 && k < 20)).toEqual([12.5, 15, 17.5]);
  });

  it('falls back to max + 1 … only where the data has no interior gap', () => {
    expect(Array.from(midRangeAbsent(Float64Array.from([7, 7, 7]), 3, 3, 7)).sort((x, y) => x - y)).toEqual([8, 9, 10]);
    expect(Array.from(midRangeAbsent(new Float64Array(0), 0, 2, 0)).sort((x, y) => x - y)).toEqual([1, 2]);
    // n = 1 through the full builder: one key, no gap, all misses fall back — still absent.
    const one = buildNumericProbes(Float64Array.from([5]), 1, mid(0));
    expect(Array.from(one).every((k) => k > 5)).toBe(true);
    // Neighbours one ulp apart have no double between them: dropped, then filled from above.
    const a = 1;
    const b = 1 + Number.EPSILON;
    const tight = Array.from(midRangeAbsent(Float64Array.from([a, b]), 2, 2, b));
    expect(tight.every((k) => k !== a && k !== b)).toBe(true);
    expect(new Set(tight).size).toBe(2);
    // NaN / ±Infinity keys make no gap (a gap needs two finite neighbours).
    const odd = Float64Array.from([Number.NaN, 0, Number.POSITIVE_INFINITY, 4, Number.NEGATIVE_INFINITY]);
    const om = Array.from(midRangeAbsent(odd, 5, 3, 4));
    expect(om.every((k) => k > 0 && k < 4)).toBe(true);
  });

  it('is deterministic and leaves the keys it read untouched', () => {
    const keys = numericKeys(generateUniform(3_000, 0, 3_000, true, 2));
    const before = bytesOf(keys);
    for (const f of PROBE_MIX_CHOICES) {
      expect(bytesOf(buildNumericProbes(keys, 3_000, mid(f)))).toEqual(bytesOf(buildNumericProbes(keys, 3_000, mid(f))));
    }
    expect(bytesOf(keys)).toEqual(before); // the sort is on a copy
  });

  it('is shuffled, not handed over in rank order (no cache-warm runs of neighbouring misses)', () => {
    const keys = numericKeys(generateSorted(10_000));
    const miss = Array.from(midRangeAbsent(keys, 10_000, 128, 9_999));
    let ascents = 0;
    for (let i = 1; i < miss.length; i++) if (miss[i] > miss[i - 1]) ascents++;
    expect(ascents).toBeGreaterThan(40);
    expect(ascents).toBeLessThan(87);
  });

  it('string probes ignore the form — they are derived from stored keys either way', () => {
    const keys = ['apple', 'banana', 'cherry', 'date', 'elder', 'fig', 'grape'];
    for (const f of PROBE_MIX_CHOICES) {
      expect(buildStringProbes(keys, mid(f))).toEqual(buildStringProbes(keys, { presentFraction: f }));
    }
  });
});

describe('mid-range misses: provenance', () => {
  it('the summary names the form only when it is not the default', () => {
    expect(summarizeMix(DEFAULT_PROBE_MIX, 100_000)).toEqual({ presentFraction: 0.5, present: 64, absent: 64, atN: 100_000 });
    expect('missForm' in summarizeMix({ presentFraction: 0.5, missForm: 'aboveMax' }, 10)).toBe(false);
    const s = summarizeMix(mid(0), 100_000);
    expect(s.missForm).toBe('midRange');
    expect(describeMix(s)).toBe(
      'search probes: 0% present / 100% absent (0 + 128 per point at n = 100,000); misses fall between stored keys (mid-range), not past the largest',
    );
    // A 50/50 mid-range run is not the calibrated workload, so it does not claim to be.
    expect(describeMix(summarizeMix(mid(0.5), 1_000))).not.toMatch(/calibrated default/);
  });
});

/**
 * What the form does to the curves, on the clock-free TS twins (whose op-counts the
 * conformance corpora tie to the Rust bench twins).
 */
describe('what mid-range misses change (op-counts, no clock)', () => {
  const meanOps = (search: (k: number) => { ops: number }, probes: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < probes.length; i++) sum += search(probes[i]).ops;
    return sum / probes.length;
  };
  const ABOVE: ProbeMix = { presentFraction: 0 };
  const MID: ProbeMix = mid(0);

  it('reverse-sorted BST: an above-max miss costs one comparison, a mid-range miss walks the chain (hurdle 15)', () => {
    const keys = numericKeys(generateReverseSorted(4_000));
    const at = (n: number, mix: ProbeMix) => {
      const t = BstF64.fromKeys(Array.from(keys.subarray(0, n))); // a left chain
      return meanOps((k) => t.search(k), buildNumericProbes(keys, n, mix));
    };
    for (const n of [1_000, 4_000]) {
      expect(at(n, ABOVE)).toBe(1);
      // A miss between j and j + 1 costs n − j comparisons; spread evenly by rank, ≈ n/2.
      const m = at(n, MID);
      expect(m / n).toBeGreaterThan(0.45);
      expect(m / n).toBeLessThan(0.55);
    }
    // The class comes back: 4× the keys, ≈ 4× the cost — where above-max reads exactly flat.
    expect(at(4_000, MID) / at(1_000, MID)).toBeCloseTo(4, 1);
    expect(at(4_000, ABOVE) / at(1_000, ABOVE)).toBe(1);
  });

  it('the AVL on the same keys stays logarithmic under either form', () => {
    const keys = numericKeys(generateReverseSorted(16_000));
    const at = (n: number) => {
      const t = AvlF64.fromKeys(Array.from(keys.subarray(0, n)));
      return meanOps((k) => t.search(k), buildNumericProbes(keys, n, MID));
    };
    expect(at(16_000) / at(1_000)).toBeLessThan(1.6); // log₂ 16k / log₂ 1k ≈ 1.4
  });

  it('skip list: a mid-range miss is dearer than an above-max one (closes hurdle 9’s gap)', () => {
    const keys = numericKeys(generateUniform(10_000, 0, 1e9, true, 8));
    const s = SkipListF64.fromKeys(Array.from(keys));
    const above = meanOps((k) => s.search(k), buildNumericProbes(keys, 10_000, ABOVE));
    const midr = meanOps((k) => s.search(k), buildNumericProbes(keys, 10_000, MID));
    const hits = meanOps((k) => s.search(k), buildNumericProbes(keys, 10_000, { presentFraction: 1 }));
    expect(midr).toBeGreaterThan(above);
    // A mid-range miss descends to the gap a hit would descend to: about a hit's cost.
    expect(midr / hits).toBeGreaterThan(0.8);
    expect(midr / hits).toBeLessThan(1.25);
  });

  it('hash sets: a half-integer miss is an ordinary key to a hash — flat in n, near the above-max cost', () => {
    // Fairness for the structures that hash rather than compare: the mid-range form must not
    // hand either set a cheaper or a dearer miss than `max + 1 …` does (both hash the f64 bits).
    const keys = numericKeys(generateUniform(20_000, 0, 20_000, true, 8)); // dense: misses are k + ½
    for (const make of [(k: number[]) => HashSetF64.fromKeys(k), (k: number[]) => HashSetOaF64.fromKeys(k)]) {
      const at = (n: number, mix: ProbeMix) => {
        const s = make(Array.from(keys.subarray(0, n)));
        return meanOps((k) => s.search(k), buildNumericProbes(keys, n, mix));
      };
      expect(at(20_000, MID) / at(1_000, MID)).toBeLessThan(1.5);
      for (const n of [1_000, 20_000]) {
        const ratio = at(n, MID) / at(n, ABOVE);
        expect(ratio).toBeGreaterThan(0.5);
        expect(ratio).toBeLessThan(2);
      }
    }
  });

  it('B-tree: a mid-range miss costs within one comparison of a hit, as BTreeSearchNote says', () => {
    const keys = numericKeys(generateUniform(10_000, 0, 1e9, true, 8));
    const t = BTreeF64.fromKeys(Array.from(keys));
    const midr = meanOps((k) => t.search(k), buildNumericProbes(keys, 10_000, MID));
    const hits = meanOps((k) => t.search(k), buildNumericProbes(keys, 10_000, { presentFraction: 1 }));
    expect(Math.abs(midr - hits)).toBeLessThanOrEqual(1);
  });

  it('unsorted array: a miss still reads all n — the form moves nothing for a scan', () => {
    const keys = numericKeys(generateUniform(5_000, 0, 1e9, true, 8));
    const a = DynArrayF64.fromKeys(Array.from(keys));
    expect(meanOps((k) => a.search(k), buildNumericProbes(keys, 5_000, MID))).toBe(5_000);
  });
});
