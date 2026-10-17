import { describe, it, expect } from 'vitest';
import { fitComplexity } from '../bench/fit';
import type { StructureId, SweepPoint } from '../bench/measure';
import { buildDataset, DEFAULT_PICKER } from './DatasetPicker';
import { HashSetF64, DynArrayF64 } from '../structures';
import type { SeriesView } from './SweepChart';
import { legendValue, storedShare, storedSizeNotes, topDedupedPoint } from './storedSize';

const view = (structure: StructureId, pts: Array<[number, number | undefined]>): SeriesView => {
  const points: SweepPoint[] = pts.map(([n, storedN]) => ({
    n, nanosPerOp: 1, opCount: 1, batch: 1, reps: 1, stddevNanos: 0, minNanos: 1, maxNanos: 1,
    ...(storedN === undefined ? {} : { storedN }),
  }));
  return {
    series: { structure, op: 'search', points },
    fit: fitComplexity(points.map((p) => p.n), points.map(() => 1)),
    color: '#000',
  };
};

describe('stored size next to input size', () => {
  it('finds the largest n at which a structure held fewer keys than it was given', () => {
    expect(topDedupedPoint(view('hashset', [[10, 10], [100, 97], [1000, 632]]))).toEqual({ n: 1000, storedN: 632 });
    // A multiset that holds everything, and a series with no counts at all, say nothing.
    expect(topDedupedPoint(view('array', [[10, 10], [1000, 1000]]))).toBeNull();
    expect(topDedupedPoint(view('array', [[10, undefined], [1000, undefined]]))).toBeNull();
  });

  it('writes one note per de-duplicating structure, naming the axis', () => {
    const notes = storedSizeNotes([
      view('array', [[100_000, 100_000]]),
      view('hashset', [[1000, 990], [100_000, 63_212]]),
      // The same structure's churn series on a smaller ladder: the larger-n reading wins.
      { ...view('hashset', [[4000, 3920]]), series: { ...view('hashset', [[4000, 3920]]).series, op: 'churn' } },
    ]);
    expect(notes).toEqual([
      'The hash set keeps one copy of each repeated key: at n = 100,000 input keys it holds 63,212 (63%). ' +
        'The x-axis counts input keys, not stored ones.',
    ]);
    expect(storedSizeNotes([view('array', [[10, 10]])])).toEqual([]);
  });

  it('never rounds a real loss up to 100%', () => {
    expect(storedShare({ n: 100_000, storedN: 99_999 })).toBe('99%');
  });

  it('adds the stored count to the hover read-out only where it differs', () => {
    const p: SweepPoint = { n: 1000, nanosPerOp: 1, opCount: 1, batch: 1, reps: 1, stddevNanos: 0, minNanos: 1, maxNanos: 1 };
    expect(legendValue(12.3456, { ...p, storedN: 632 })).toBe('12.35 (holds 632 of 1,000)');
    expect(legendValue(12.3456, { ...p, storedN: 1000 })).toBe('12.35');
    expect(legendValue(12.3456, p)).toBe('12.35');
    expect(legendValue(null, p)).toBe('--');
  });

  it('the default dataset really does make the hash set hold fewer keys than the array', () => {
    // Why this is on the default charts and not just the zipfian preset: the default uniform
    // generator draws integers *with replacement* from [0, n], so ~1 − 1/e of them are
    // distinct. Read off the TS twins, whose `size` mirrors the Rust `len()` the worker asks.
    const keys = buildDataset(DEFAULT_PICKER).keys as readonly number[];
    const set = HashSetF64.fromKeys(keys);
    const arr = DynArrayF64.fromKeys(keys);
    expect(arr.size).toBe(100_000);
    expect(set.size).toBe(new Set(keys).size);
    expect(set.size / keys.length).toBeGreaterThan(0.6);
    expect(set.size / keys.length).toBeLessThan(0.66);
  });
});
