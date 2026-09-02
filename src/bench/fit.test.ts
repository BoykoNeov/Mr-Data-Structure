import { describe, it, expect } from 'vitest';
import { fitComplexity, olsSlope, tCritical95, type ComplexityClass } from './fit';

const SIZES = [10, 100, 1000, 10000, 100000];

/** Build a y-series from a cost function of n, with optional multiplicative noise. */
function series(f: (n: number) => number, noise = 0): number[] {
  // Deterministic pseudo-noise so tests don't flake.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return SIZES.map((n) => f(n) * (1 + noise * (rand() - 0.5)));
}

describe('fitComplexity — the reliably-separable classes (§7.2)', () => {
  it('labels a flat curve O(1) with high score and ~0 slope', () => {
    const r = fitComplexity(SIZES, series(() => 42));
    expect(r.best).toBe('O(1)');
    expect(r.r2).toBeGreaterThan(0.999);
    expect(r.logLogSlope).toBeCloseTo(0, 2);
    expect(r.ambiguous).toBe(false);
  });

  it('labels a linear curve O(n) with slope ~1', () => {
    const r = fitComplexity(SIZES, series((n) => 3 * n));
    expect(r.best).toBe('O(n)');
    expect(r.r2).toBeGreaterThan(0.999);
    expect(r.logLogSlope).toBeCloseTo(1, 1);
  });

  it('labels a quadratic curve O(n²) with slope ~2', () => {
    const r = fitComplexity(SIZES, series((n) => 0.5 * n * n));
    expect(r.best).toBe('O(n²)');
    expect(r.logLogSlope).toBeCloseTo(2, 1);
    expect(r.note).toMatch(/super-linear/);
  });
});

describe('fitComplexity — the soft band', () => {
  it('labels a log curve O(log n) with a small slope', () => {
    const r = fitComplexity(SIZES, series((n) => 5 * Math.log2(n)));
    expect(r.best).toBe('O(log n)');
    expect(r.logLogSlope).toBeLessThan(0.5);
  });

  it('labels an n·log n curve O(n log n) with slope just above 1', () => {
    const r = fitComplexity(SIZES, series((n) => n * Math.log2(n)));
    expect(r.best).toBe('O(n log n)');
    expect(r.logLogSlope).toBeGreaterThan(1);
    expect(r.logLogSlope).toBeLessThan(1.4);
  });

  it('flags ambiguity and recommends the slope when the band overlaps', () => {
    // Mild noise on a linear curve: O(n) should win but O(n log n)/O(log n) are
    // close enough that the honest answer is "trust the slope".
    const r = fitComplexity(SIZES, series((n) => n, 0.05));
    expect(r.best).toBe('O(n)');
    if (r.ambiguous) expect(r.note).toMatch(/trust the log-log slope/);
  });
});

describe('fitComplexity — the Phase 2 success criterion (§10)', () => {
  it('separates array-search O(n) from hashset-search O(1)', () => {
    // The shapes the real sweep must produce: array search ~ linear, hashset flat.
    const array = fitComplexity(SIZES, series((n) => 0.75 * n));
    const hashset = fitComplexity(SIZES, series(() => 1.2));
    expect(array.best).toBe('O(n)');
    expect(hashset.best).toBe('O(1)');
    expect(array.logLogSlope).toBeCloseTo(1, 1);
    expect(hashset.logLogSlope).toBeCloseTo(0, 1);
  });
});

describe('fitComplexity — guards', () => {
  it('returns a degenerate result for fewer than two points', () => {
    const r = fitComplexity([10], [5]);
    expect(r.best).toBe('O(1)');
    expect(r.note).toMatch(/Not enough/);
  });

  it('rejects mismatched input lengths', () => {
    expect(() => fitComplexity([1, 2], [1])).toThrow(/same length/);
  });

  it('scores are sorted best-first and cover all five classes', () => {
    const r = fitComplexity(SIZES, series((n) => 3 * n));
    expect(r.scores).toHaveLength(5);
    const classes = r.scores.map((s) => s.cls).sort();
    const expected: ComplexityClass[] = ['O(1)', 'O(log n)', 'O(n log n)', 'O(n)', 'O(n²)'].sort() as ComplexityClass[];
    expect(classes).toEqual(expected);
    for (let i = 1; i < r.scores.length; i++) {
      expect(r.scores[i - 1].r2).toBeGreaterThanOrEqual(r.scores[i].r2);
    }
  });
});

describe('fitComplexity — slope uncertainty (docs/METHODOLOGY.md §3)', () => {
  it('reports a ~zero stderr and a tight CI for an exact power law', () => {
    const r = fitComplexity(SIZES, series((n) => 3 * n));
    expect(r.slopeStderr).toBeCloseTo(0, 6);
    expect(r.slopeCi[0]).toBeCloseTo(1, 4);
    expect(r.slopeCi[1]).toBeCloseTo(1, 4);
    expect(r.note).toMatch(/slope ≈ 1\.00\b/);
  });

  it('widens the CI under noise and brackets the true exponent', () => {
    const r = fitComplexity(SIZES, series((n) => 2 * n, 0.3));
    expect(r.slopeStderr).toBeGreaterThan(0);
    expect(r.slopeCi[0]).toBeLessThan(1);
    expect(r.slopeCi[1]).toBeGreaterThan(1);
    expect(r.note).toMatch(/±/); // the ± reading replaces the bare number
  });

  it('returns one local slope per interval, at the geometric-mean n', () => {
    const r = fitComplexity(SIZES, series((n) => n * n));
    expect(r.localSlopes).toHaveLength(SIZES.length - 1);
    expect(r.localNs).toHaveLength(SIZES.length - 1);
    for (const s of r.localSlopes) expect(s).toBeCloseTo(2, 6);
    expect(r.localNs[0]).toBeCloseTo(Math.sqrt(10 * 100), 6);
  });

  it('calls a clean power law steady and the tail slope matches the headline', () => {
    const r = fitComplexity(SIZES, series((n) => 7 * n));
    expect(r.trend).toBe('steady');
    expect(r.tailSlope).toBeCloseTo(1, 4);
  });

  it('sees a falling local slope on O(log n) — the logarithm signature', () => {
    const r = fitComplexity(SIZES, series((n) => 5 * Math.log2(n)));
    // d ln(ln n) / d ln n = 1/ln n: strictly decreasing across the sweep.
    for (let i = 1; i < r.localSlopes.length; i++) {
      expect(r.localSlopes[i]).toBeLessThan(r.localSlopes[i - 1]);
    }
    expect(r.trend).toBe('falling');
    expect(r.note).toMatch(/signature of O\(log n\)/);
  });

  it('sees a rising local slope when a fixed overhead masks a linear term', () => {
    // y = 2000 + n: flat at small n, linear at large n. The overall slope
    // under-reads (~0.6) but the tail slope and trend expose the linear term.
    const r = fitComplexity(SIZES, series((n) => 2000 + n));
    expect(r.trend).toBe('rising');
    expect(r.tailSlope).toBeGreaterThan(r.logLogSlope);
    expect(r.tailSlope).toBeGreaterThan(0.7);
    expect(r.note).toMatch(/overhead is masking/);
  });

  it('degrades gracefully with two points (no stderr, no trend)', () => {
    const r = fitComplexity([10, 100], [1, 10]);
    expect(r.logLogSlope).toBeCloseTo(1, 6);
    expect(r.slopeStderr).toBe(0);
    expect(r.slopeCi).toEqual([r.logLogSlope, r.logLogSlope]);
    expect(r.localSlopes).toHaveLength(1);
    expect(r.trend).toBe('steady');
  });
});

describe('olsSlope / tCritical95', () => {
  it('recovers slope and a residual-based stderr', () => {
    const { slope, stderr, df } = olsSlope([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(slope).toBeCloseTo(2, 9);
    expect(stderr).toBeCloseTo(0, 9);
    expect(df).toBe(2);
  });
  it('tabulates the two-sided 95% t critical values', () => {
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(3)).toBeCloseTo(3.182, 3);
    expect(tCritical95(1000)).toBeCloseTo(1.96, 3);
    expect(tCritical95(0)).toBe(Infinity);
  });
});
