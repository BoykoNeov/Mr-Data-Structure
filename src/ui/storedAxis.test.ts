import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fitComplexity, olsSlope } from '../bench/fit';
import type { StructureId, SweepOp, SweepPoint, SweepSeries } from '../bench/measure';
import { toView } from '../compare/runSweeps';
import { CSV_HEADER, toCsv, toJson } from './export';
import { NAxisControl } from './NAxisControl';
import { storedSizeNotes } from './storedSize';
import { seriesLabel, SweepChart } from './SweepChart';
import {
  alignOnX,
  axisNotes,
  axisOf,
  axisTag,
  fitOnAxis,
  MIN_LOCAL_RATIO,
  STORED_CSV_COLUMNS,
  storedSlopeLayout,
  storedSweepLayout,
  viewOnAxis,
  X_AXIS_LABEL,
} from './storedAxis';

/** A series whose op-count is `ys` (and wall-clock 2·ys), with optional stored counts. */
const series = (
  structure: StructureId,
  ns: readonly number[],
  ys: readonly number[],
  stored?: readonly number[],
  op: SweepOp = 'search',
): SweepSeries => ({
  structure,
  op,
  points: ns.map(
    (n, i): SweepPoint => ({
      n, nanosPerOp: 2 * ys[i], opCount: ys[i], batch: 8, reps: 5, stddevNanos: 0.1,
      minNanos: 1.9 * ys[i], maxNanos: 2.1 * ys[i],
      ...(stored ? { storedN: stored[i] } : {}),
    }),
  ),
});

// The hand-computed case: input n spans four decades while the structure's holdings span
// two, and the cost is exactly proportional to what it holds. On stored n the log-log slope
// is ln(1e3/10) / ln(1e3/10) = 1; on input n it is ln(1e3/10) / ln(1e5/10) = 2/4 = 0.5.
const HAND = series('hashset', [10, 1e3, 1e5], [10, 1e2, 1e3], [10, 1e2, 1e3]);

describe('the stored-n x-axis: fits', () => {
  it('fits on stored n — a hand-computed slope of exactly 1, against 0.5 on input n', () => {
    const v = viewOnAxis(HAND, 'opcount', 'stored');
    expect(v.fit.logLogSlope).toBeCloseTo(1, 12);
    expect(v.fit.slopeStderr).toBeCloseTo(0, 12);
    expect(v.fit.best).toBe('O(n)');
    expect(v.fit.localSlopes).toEqual([expect.closeTo(1, 12), expect.closeTo(1, 12)]);
    // Local-slope midpoints are geometric means of the *stored* sizes.
    expect(v.fit.localNs[0]).toBeCloseTo(Math.sqrt(10 * 1e2), 9);
    expect(v.x?.axis).toBe('stored');
    expect(v.x?.values).toEqual([10, 1e2, 1e3]);
    // The input-n reading travels with it (for the export), and really is the other number.
    expect(v.x?.inputFit.logLogSlope).toBeCloseTo(0.5, 12);
    expect(viewOnAxis(HAND, 'opcount', 'input').fit.logLogSlope).toBeCloseTo(0.5, 12);
  });

  it('refits on the selected signal too (wall-clock here is 2× the op-count: same slope)', () => {
    expect(viewOnAxis(HAND, 'nanos', 'stored').fit.logLogSlope).toBeCloseTo(1, 12);
  });

  it('leaves a structure that holds every key with exactly its input-n fit', () => {
    const arr = series('array', [10, 100, 1000, 10_000], [5, 51, 498, 5003], [10, 100, 1000, 10_000]);
    const v = viewOnAxis(arr, 'opcount', 'stored');
    expect(v.fit).toEqual(toView(arr, 'opcount').fit);
    expect(v.x).toMatchObject({ axis: 'stored', repeats: 0, foldedIntervals: 0 });
  });

  it('keeps a series with no stored counts on input n, tagged — never silently mixed in', () => {
    // A finite-difference half: no built instance, so no storedN at any point.
    const fd = series('hashset', [250, 500, 1000], [3, 3, 3], undefined, 'insert');
    const v = viewOnAxis(fd, 'opcount', 'stored');
    expect(v.x?.axis).toBe('input');
    expect(v.x?.values).toEqual([250, 500, 1000]);
    expect(v.fit).toEqual(toView(fd, 'opcount').fit);
    expect(axisTag(v)).toMatch(/on input n/);
    expect(seriesLabel(v)).toMatch(/^hash set insert \[on input n — no stored count\] — /);
    expect(axisNotes([v])).toEqual([
      'No stored count was measured for hash set insert — the finite-difference insert / delete rows, which ' +
        'have no built structure to ask, so it stays on input n and is tagged “on input n” wherever named.',
    ]);
    // A series missing a count at even one point falls back whole.
    const partial: SweepSeries = { ...HAND, points: HAND.points.map((p, i) => (i === 1 ? { ...p, storedN: undefined } : p)) };
    expect(viewOnAxis(partial, 'opcount', 'stored').x?.axis).toBe('input');
  });

  it('counts fallen-back series past three rather than listing them', () => {
    const fds = (['array', 'hashset', 'sarr', 'll'] as const).map((s) =>
      viewOnAxis(series(s, [250, 500], [1, 2], undefined, 'delete'), 'opcount', 'stored'),
    );
    expect(axisNotes(fds)[0]).toMatch(/^No stored count was measured for 4 series — the finite-difference/);
  });
});

describe('the stored-n x-axis: repeated and near-repeated stored sizes', () => {
  it('keeps repeats in the headline fit, but takes the tail over the distinct sizes', () => {
    // Stored size levels off at 60 for the top half of the ladder (a low-cardinality dataset).
    const ns = [10, 20, 50, 100, 200, 500];
    const stored = [10, 20, 50, 60, 60, 60];
    const ys = [10, 20, 50, 60, 61, 59];
    const { fit } = fitOnAxis(stored, ys);
    // Headline: exactly fitComplexity on the (stored, y) pairs, replicates and all.
    const plain = fitComplexity(stored, ys);
    expect(fit.logLogSlope).toBe(plain.logLogSlope);
    expect(fit.slopeStderr).toBe(plain.slopeStderr);
    expect(fit.scores).toEqual(plain.scores);
    // The naive tail (last three points, all at x = 60) has no x spread: OLS returns 0, "flat".
    expect(plain.tailSlope).toBe(0);
    // Ours: the upper three *distinct* sizes {20, 50, 60}, with all five points sitting on them.
    const tx = stored.slice(1).map(Math.log);
    const ty = ys.slice(1).map(Math.log);
    expect(fit.tailSlope).toBeCloseTo(olsSlope(tx, ty).slope, 12);
    expect(fit.tailSlope).toBeGreaterThan(0.9);
    // The view counts the two repeats, and the note says what was done with them.
    const v = viewOnAxis(series('hashset', ns, ys, stored), 'opcount', 'stored');
    expect(v.x?.repeats).toBe(2);
    expect(axisNotes([v])[0]).toMatch(/^The hash set held the same or nearly the same number of keys/);
    expect(axisNotes([v])[0]).toMatch(/less than 10% apart\.$/);
  });

  it('reads no local slope across a stored step under MIN_LOCAL_RATIO — it folds into the next', () => {
    expect(MIN_LOCAL_RATIO).toBe(1.1);
    const xs = [100, 200, 400, 405, 800];
    const ys = [1, 2, 4, 9, 8]; // the 400 → 405 step alone would read a local slope of ~65
    const { fit, folded } = fitOnAxis(xs, ys);
    expect(folded).toBe(1);
    expect(fit.localSlopes).toHaveLength(3);
    expect(fit.localSlopes[0]).toBeCloseTo(1, 12);
    expect(fit.localSlopes[1]).toBeCloseTo(1, 12);
    // 405 was folded: the last interval runs from the 400 anchor straight to 800.
    expect(fit.localSlopes[2]).toBeCloseTo(Math.log(8 / 4) / Math.log(800 / 400), 12);
    expect(fit.localNs[2]).toBeCloseTo(Math.sqrt(400 * 800), 9);
    expect(Math.max(...fit.localSlopes)).toBeLessThan(2);
  });

  it('gives a series whose points all hold one size no slope at all, and says why', () => {
    const v = viewOnAxis(series('hashset', [250, 500, 1000], [3, 4, 5], [7, 7, 7]), 'opcount', 'stored');
    expect(v.fit.logLogSlope).toBe(0);
    expect(v.fit.localSlopes).toEqual([]);
    expect(v.fit.note).toBe(
      'Every point held the same 7 keys, so on the stored-size axis there is no spread to fit a slope against — ' +
        'switch the x-axis back to input keys to read this line.',
    );
    // The placeholder class must not reach a legend (or the PNG's, which has no note) bare.
    expect(v.x?.noSpread).toBe(true);
    expect(seriesLabel(v)).toMatch(/^hash set search \[one stored size — no slope\] — /);
  });
});

describe('the stored-n x-axis: chart layout', () => {
  it('aligns differing x columns into one x array, giving each replicate its own slot', () => {
    expect(alignOnX([[1, 2, 3], [1, 2, 2, 4]])).toEqual({ xs: [1, 2, 2, 3, 4], slotOf: [[0, 1, 3], [0, 1, 2, 4]] });
    // Identical columns share their slots: no nulls are introduced for them.
    expect(alignOnX([[10, 100], [10, 100]])).toEqual({ xs: [10, 100], slotOf: [[0, 1], [0, 1]] });
  });

  it('draws each line, its theory twin and its error bars at its own stored sizes', () => {
    const arr = viewOnAxis(series('array', [10, 100, 1000], [10, 100, 1000], [10, 100, 1000]), 'opcount', 'stored');
    const hs = viewOnAxis(series('hashset', [10, 100, 1000], [3, 3, 3], [10, 95, 632]), 'opcount', 'stored');
    const lay = storedSweepLayout([arr, hs], 'opcount', () => 'O(n)');
    expect(lay.xs).toEqual([10, 95, 100, 632, 1000]);
    expect(lay.measured).toEqual([
      [10, null, 100, null, 1000],
      [3, 3, null, 3, null],
    ]);
    // The array's O(n) twin is exact on y = x; the hash set's is scaled onto *its* x values.
    expect(lay.theory[0].ys).toEqual([10, null, 100, null, 1000]);
    const a = (3 * (10 + 95 + 632)) / (10 * 10 + 95 * 95 + 632 * 632);
    expect(lay.theory[1].ys).toEqual([a * 10, a * 95, null, a * 632, null]);
    expect(lay.xOfPoint).toEqual([[10, 100, 1000], [10, 95, 632]]);
    // The hover map: slot → point index, undefined where the line has no point.
    expect(lay.pointAt).toEqual([[0, undefined, 1, undefined, 2], [0, 1, undefined, 2, undefined]]);
    expect(storedSweepLayout([arr, hs], 'opcount', null).theory).toEqual([]);
  });

  it('aligns the local-slope panel on each line’s own stored midpoints', () => {
    const arr = viewOnAxis(series('array', [10, 1000], [10, 1000], [10, 1000]), 'opcount', 'stored');
    const lay = storedSlopeLayout([arr, viewOnAxis(HAND, 'opcount', 'stored')]);
    expect(lay.xs).toEqual([expect.closeTo(Math.sqrt(10 * 100), 9), expect.closeTo(100, 9), expect.closeTo(Math.sqrt(100 * 1000), 9)]);
    expect(lay.ys[0]).toEqual([null, expect.closeTo(1, 12), null]);
  });
});

describe('the stored-n x-axis: the default is untouched', () => {
  const plainViews = [series('array', [10, 100], [10, 100], [10, 100]), HAND].map((s) => toView(s, 'nanos'));
  const inputViews = [series('array', [10, 100], [10, 100], [10, 100]), HAND].map((s) => viewOnAxis(s, 'nanos', 'input'));

  it('the input axis is exactly toView — same fit, no x field', () => {
    expect(inputViews).toEqual(plainViews);
    for (const v of inputViews) expect('x' in v).toBe(false);
    expect(axisOf(inputViews)).toBe('input');
    expect(inputViews.map(axisTag)).toEqual(['', '']);
    expect(axisNotes(inputViews)).toEqual([]);
  });

  it('exports byte-identical CSV and JSON on the input axis', () => {
    expect(toCsv(inputViews)).toBe(toCsv(plainViews));
    expect(toCsv(inputViews).split('\n')[0]).toBe(CSV_HEADER);
    const strip = (s: string) => s.replace(/"exportedAt": "[^"]*"/, '');
    expect(strip(toJson(inputViews, { a: 1 }))).toBe(strip(toJson(plainViews, { a: 1 })));
  });

  it('keeps the stored-size note’s wording unless the stored axis is asked for', () => {
    const notes = storedSizeNotes(inputViews);
    expect(notes).toEqual(storedSizeNotes(inputViews, 'input'));
    expect(notes[0]).toMatch(/The x-axis counts input keys, not stored ones\.$/);
    expect(storedSizeNotes(inputViews, 'stored')[0]).toMatch(
      /The x-axis here counts stored keys, so its line is drawn, and fitted, at the sizes it held\.$/,
    );
  });
});

describe('the stored-n x-axis: exports', () => {
  it('appends x_axis,x to every CSV row and keeps both n columns', () => {
    const vs = [
      viewOnAxis(HAND, 'opcount', 'stored'),
      viewOnAxis(series('array', [250, 500], [1, 2], undefined, 'delete'), 'opcount', 'stored'),
    ];
    const lines = toCsv(vs).trim().split('\n');
    expect(STORED_CSV_COLUMNS).toBe(',x_axis,x');
    expect(lines[0]).toBe(CSV_HEADER + ',x_axis,x');
    // n (input) and stored_n both present; the row says which one it was plotted at.
    expect(lines[3].split(',')).toEqual(['hashset', 'search', '100000', '2000', '1900', '2100', '0.1', '1000', '8', '5', '1000', 'stored_n', '1000']);
    // The fallen-back finite-difference row: no stored_n, plotted at input n.
    expect(lines[4].split(',').slice(-4)).toEqual(['5', '', 'n', '250']);
  });

  it('gives each JSON series its axis, its x values, and the input-n fit beside the stored one', () => {
    const j = JSON.parse(toJson([viewOnAxis(HAND, 'opcount', 'stored')]));
    const s = j.series[0];
    expect(s.xAxis).toBe('storedN');
    expect(s.xs).toEqual([10, 100, 1000]);
    expect(s.fit.logLogSlope).toBeCloseTo(1, 12);
    expect(s.inputNFit.logLogSlope).toBeCloseTo(0.5, 12);
    expect(s.points[2]).toMatchObject({ n: 1e5, storedN: 1000 });
  });
});

describe('the stored-n x-axis: what the page shows', () => {
  it('labels the axis by which n it plots', () => {
    expect(X_AXIS_LABEL.input).toBe('n (size)'); // the default chart's label, unchanged
    expect(X_AXIS_LABEL.stored).toBe('stored n (keys held, len())');
  });

  it('marks the chart host and says which n the axis counts, only on the stored axis', () => {
    const stored = renderToStaticMarkup(
      createElement(SweepChart, { views: [viewOnAxis(HAND, 'opcount', 'stored')], signal: 'opcount', name: 'search' }),
    );
    expect(stored).toContain('data-chart="search" data-x-axis="stored"');
    expect(stored).toContain('The x-axis here counts stored keys');
    const input = renderToStaticMarkup(
      createElement(SweepChart, { views: [viewOnAxis(HAND, 'opcount', 'input')], signal: 'opcount', name: 'search' }),
    );
    expect(input).not.toContain('data-x-axis');
    expect(input).toContain('The x-axis counts input keys, not stored ones.');
    expect(input).not.toContain('data-x-axis-note');
  });

  it('shows the axis note when a rule fired', () => {
    const v = viewOnAxis(series('hashset', [10, 20, 50, 100], [1, 2, 3, 3], [10, 20, 40, 40]), 'opcount', 'stored');
    const html = renderToStaticMarkup(createElement(SweepChart, { views: [v], signal: 'opcount', name: 'search' }));
    expect(html).toContain('data-x-axis-note');
    expect(html).toContain('Stored-size axis.');
  });

  it('offers the axis as two radios after the dataset panel, never a select', () => {
    const html = renderToStaticMarkup(createElement(NAxisControl, { value: 'input', onChange: () => {} }));
    expect(html).not.toContain('<select');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('<input type="radio" name="n-axis" checked="" value="input"/>');
    expect(html).toContain('value="stored"');
  });
});
