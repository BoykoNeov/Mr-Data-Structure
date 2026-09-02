import { describe, it, expect } from 'vitest';
import { fitComplexity } from '../bench/fit';
import type { SweepSeries } from '../bench/measure';
import { CSV_HEADER, toCsv, toJson } from './export';
import type { SeriesView } from './SweepChart';

const series: SweepSeries = {
  structure: 'array',
  op: 'search',
  points: [10, 100, 1000].map((n) => ({
    n, nanosPerOp: n, opCount: n / 2, batch: 8, reps: 5, stddevNanos: 0.1, minNanos: n * 0.9, maxNanos: n * 1.1,
  })),
};
const view: SeriesView = {
  series,
  fit: fitComplexity([10, 100, 1000], [10, 100, 1000]),
  color: '#000',
};

describe('export', () => {
  it('writes one CSV row per point with the provenance columns', () => {
    const csv = toCsv([view]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('array,search,10,10,9,11,0.1,5,8,5');
  });

  it('writes JSON with the fit (class, slope ± stderr, local slopes) beside the points', () => {
    const j = JSON.parse(toJson([view], { dataset: 'sorted' }));
    expect(j.dataset).toBe('sorted');
    expect(j.series[0].fit.best).toBe('O(n)');
    expect(j.series[0].fit.localSlopes).toHaveLength(2);
    expect(j.series[0].points).toHaveLength(3);
  });
});
