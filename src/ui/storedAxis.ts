import type { SweepPoint, SweepSeries } from '../bench/measure';
import {
  buildNote,
  classifyTrend,
  CLASS_BASIS,
  fitComplexity,
  olsSlope,
  type ComplexityClass,
  type FitResult,
} from '../bench/fit';
import { toView } from '../compare/runSweeps';
import { REGISTRY } from '../registry';
import type { SeriesView, Signal } from './SweepChart';

/**
 * **The stored-n x-axis** (docs/PLAN.md §13, probe-mix item (b); docs/METHODOLOGY.md §4
 * hurdle 8). Every chart's x-axis is `n`, the number of *input* keys a point was built from;
 * `SweepPoint.storedN` is what the structure actually held, read back from its own `len()`.
 * This module is the opt-in alternative: plot — and **fit** — every line against the keys it
 * held instead.
 *
 * The fit is the point. A chart whose axis says "stored n" while its legend's slope was fitted
 * on input n would be a lie, so a stored view refits the class scores, the log-log slope ± SE,
 * the local slopes, the tail slope, the trend and the note, all on stored n; the chart then
 * draws the line and its theory twin at each point's own stored size. All of it happens here,
 * in the UI layer: `runSweeps` and the `window.__*Proof` mirrors the gate reads are never
 * touched — the gate's fits stay on input n.
 *
 * Three rules, each a decision rather than a default:
 * - **A series without stored counts stays on input n, and says so.** The finite-difference
 *   halves have no built instance to ask (hurdle 8), so they carry no `storedN`; a series
 *   missing it at *any* point is kept whole on input n and tagged ({@link axisTag}) wherever
 *   it is named — fit row, legend, PNG cross-check row — never silently mixed in.
 * - **A structure that holds every key keeps its input-n fit exactly.** Where `storedN === n`
 *   at every point the x values are the same numbers, so the view's fit *is* the input fit —
 *   toggling the axis never moves the array's slope by a rounding error.
 * - **Repeated and near-repeated stored sizes.** A de-duplicating structure's stored size
 *   levels off once the prefix holds every distinct key; prefixes are nested, so two points
 *   with one stored size hold the *same* set (the same table, too — the sets grow by load,
 *   not by `n`). Those points are kept in the fit as repeat measurements at one x: OLS and
 *   the class scores take replicates as they are. What they cannot take is a zero or tiny
 *   step in x — a local slope across stored sizes 1 % apart is noise divided by almost
 *   nothing. So a local slope is only read across a step of at least
 *   {@link MIN_LOCAL_RATIO} in stored size (a closer point is folded into the next interval),
 *   the tail slope is taken over the upper half of the *distinct* sizes, and a series whose
 *   points all share one stored size gets no slope at all ({@link noSpreadFit}).
 */

/** Which `n` the charts plot against: the input keys (default) or the keys each structure held. */
export type NAxis = 'input' | 'stored';

/** What one view's x values are, present only while the stored axis is selected. */
export interface XBasis {
  /** What this series is actually plotted and fitted against. `'input'` = the fallback. */
  readonly axis: NAxis;
  /** The x value of each point, in point order. */
  readonly values: readonly number[];
  /** The same series fitted on input n — kept so the export carries both readings. */
  readonly inputFit: FitResult;
  /** Points whose stored size equals an earlier point's (repeat measurements at one x). */
  readonly repeats: number;
  /** Local-slope intervals folded away because the stored step was under {@link MIN_LOCAL_RATIO}. */
  readonly foldedIntervals: number;
}

/** Smallest stored-size ratio a local slope is read across (10 %): see the module doc. */
export const MIN_LOCAL_RATIO = 1.1;

/** The x-axis label each axis shows, on the chart canvas (and therefore on the PNG). */
export const X_AXIS_LABEL: Readonly<Record<NAxis, string>> = {
  input: 'n (size)',
  stored: 'stored n (keys held, len())',
};

/** The local-slope panel's x label, on each axis. */
export const SLOPE_X_LABEL: Readonly<Record<NAxis, string>> = {
  input: 'n (interval midpoint)',
  stored: 'stored n (interval midpoint)',
};

/** True when every point reports how many keys its structure held. */
export function hasStoredCounts(points: readonly SweepPoint[]): boolean {
  return points.length > 0 && points.every((p) => p.storedN !== undefined);
}

/** The fit for a series whose points all sit at one stored size: no slope exists to report. */
export function noSpreadFit(storedN: number): FitResult {
  return {
    ...fitComplexity([], []),
    note:
      `Every point held the same ${storedN.toLocaleString('en-US')} keys, so on the stored-size axis ` +
      'there is no spread to fit a slope against — switch the x-axis back to input keys to read this line.',
  };
}

/**
 * Fit a cost curve on an x-axis that may repeat values (stored n). Agrees with
 * {@link fitComplexity} on the class scores, the headline slope ± SE and its CI — those take
 * replicates as they are — and replaces the three readings a zero x-step would break: the
 * local slopes (read only across a {@link MIN_LOCAL_RATIO} step), the tail (upper half of
 * the distinct x values), and the trend and note built from them.
 *
 * `xs` must be positive. Points are taken in ascending x (a stable sort; stored n is already
 * non-decreasing along a prefix ladder, so in practice it is the point order).
 */
export function fitOnAxis(xs: readonly number[], ys: readonly number[]): { fit: FitResult; folded: number } {
  if (xs.length !== ys.length) {
    throw new Error(`xs (${xs.length}) and ys (${ys.length}) must be the same length`);
  }
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = order.map((i) => xs[i]);
  const sy = order.map((i) => ys[i]);
  const distinct = [...new Set(sx)];
  if (distinct.length < 2) return { fit: sx.length > 0 ? noSpreadFit(sx[0]) : fitComplexity([], []), folded: 0 };

  const base = fitComplexity(sx, sy);

  // The same (ln x, ln y) pairs fitComplexity regresses on.
  const lx: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < sx.length; i++) {
    if (sx[i] > 0 && sy[i] > 0) {
      lx.push(Math.log(sx[i]));
      ly.push(Math.log(sy[i]));
    }
  }

  // Local slopes, each from the last anchor to the first point at least MIN_LOCAL_RATIO on.
  const minStep = Math.log(MIN_LOCAL_RATIO);
  const localSlopes: number[] = [];
  const localNs: number[] = [];
  let folded = 0;
  let anchor = 0;
  for (let j = 1; j < lx.length; j++) {
    const dx = lx[j] - lx[anchor];
    if (dx < minStep) {
      // A point at the anchor's own x is a replicate, not an interval; only a real but
      // too-small step counts as folded.
      if (dx > 0) folded++;
      continue;
    }
    localSlopes.push((ly[j] - ly[anchor]) / dx);
    localNs.push(Math.exp((lx[j] + lx[anchor]) / 2));
    anchor = j;
  }

  // Tail: the points on the upper half of the distinct x values (≥ 3 of them when there are).
  const dLog = [...new Set(lx)];
  const keep = Math.min(dLog.length, Math.max(3, Math.ceil(dLog.length / 2)));
  const from = dLog[dLog.length - keep];
  const tl = lx.filter((x) => x >= from);
  const tly = ly.filter((_, i) => lx[i] >= from);
  const tailSlope = olsSlope(tl, tly).slope;
  const trend = classifyTrend(localSlopes, localNs);

  return {
    fit: {
      ...base,
      localSlopes,
      localNs,
      tailSlope,
      trend,
      note: buildNote(base.best, base.logLogSlope, base.slopeStderr, base.ambiguous, trend, tailSlope),
    },
    folded,
  };
}

const yOf = (signal: Signal) => (p: SweepPoint) => (signal === 'nanos' ? p.nanosPerOp : p.opCount);

/**
 * The view a chart shows for `series` on `axis`. On `'input'` this **is** `toView` — the same
 * object shape, no `x` field — so the default page, its fits and its exports are untouched.
 */
export function viewOnAxis(series: SweepSeries, signal: Signal, axis: NAxis): SeriesView {
  const input = toView(series, signal);
  if (axis === 'input') return input;

  const pts = series.points;
  const ns = pts.map((p) => p.n);
  if (!hasStoredCounts(pts)) {
    return { ...input, x: { axis: 'input', values: ns, inputFit: input.fit, repeats: 0, foldedIntervals: 0 } };
  }
  const stored = pts.map((p) => p.storedN as number);
  const repeats = stored.filter((s, i) => stored.indexOf(s) < i).length;
  if (stored.every((s, i) => s === ns[i])) {
    return { ...input, x: { axis: 'stored', values: stored, inputFit: input.fit, repeats, foldedIntervals: 0 } };
  }
  const { fit, folded } = fitOnAxis(stored, pts.map(yOf(signal)));
  return { ...input, fit, x: { axis: 'stored', values: stored, inputFit: input.fit, repeats, foldedIntervals: folded } };
}

/** The axis a set of views is drawn on: stored when any of them was built for it. */
export function axisOf(views: readonly SeriesView[]): NAxis {
  return views.some((v) => v.x?.axis === 'stored') ? 'stored' : 'input';
}

/**
 * The tag a fallen-back series carries wherever it is named while the stored axis is on
 * (fit row, chart legend, PNG legend). Empty for every other view, including all of them on
 * the default axis.
 */
export function axisTag(v: SeriesView): string {
  return v.x?.axis === 'input' ? ' [on input n — no stored count]' : '';
}

const labelOf = (v: SeriesView) => REGISTRY[v.series.structure]?.label ?? v.series.structure;

/**
 * The sentences the stored axis owes the reader, beside the chart and on the PNG: which
 * lines could not move onto it, and where stored sizes repeated or crowded together. Empty
 * on the input axis, and empty when nothing on the chart needed a rule.
 */
export function axisNotes(views: readonly SeriesView[]): string[] {
  if (!views.some((v) => v.x)) return [];
  const notes: string[] = [];
  const fell = views.filter((v) => v.x?.axis === 'input');
  if (fell.length > 0) {
    const names = [...new Set(fell.map((v) => `${labelOf(v)} ${v.series.op}`))];
    // Named one by one while that stays readable; past three it is a count (a numeric run's
    // cross-check rows are two per flat structure, and a PNG caption is not a table).
    const which = names.length <= 3 ? names.join(', ') : `${names.length} series`;
    const why = fell.every((v) => v.series.op === 'insert' || v.series.op === 'delete')
      ? ' — the finite-difference insert / delete rows, which have no built structure to ask'
      : '';
    notes.push(
      `No stored count was measured for ${which}${why}, so ` +
        (names.length === 1 ? 'it stays on input n and is' : 'they stay on input n and are') +
        ' tagged “on input n” wherever named.',
    );
  }
  const repeated = new Map<string, number>();
  for (const v of views) {
    if (v.x?.axis === 'stored' && (v.x.repeats > 0 || v.x.foldedIntervals > 0)) {
      repeated.set(labelOf(v), Math.max(repeated.get(labelOf(v)) ?? 0, v.x.repeats));
    }
  }
  if (repeated.size > 0) {
    notes.push(
      `The ${[...repeated.keys()].join(', ')} held the same or nearly the same number of keys at more than ` +
        'one input size, so some of its points share an x. They stay in the fit as repeat measurements at ' +
        `that size, and no local slope is read across stored sizes less than ${Math.round((MIN_LOCAL_RATIO - 1) * 100)}% apart.`,
    );
  }
  return notes;
}

/**
 * A union x array for series whose x values differ (uPlot's data is aligned on one x).
 * Every distinct value appears as many times as the series that repeats it most, so a
 * replicate keeps its own slot instead of overwriting its twin; `slotOf[c][i]` is where
 * column `c`'s point `i` lands. Columns that share their values share their slots.
 */
export function alignOnX(columns: readonly (readonly number[])[]): { xs: number[]; slotOf: number[][] } {
  const mult = new Map<number, number>();
  for (const col of columns) {
    const seen = new Map<number, number>();
    for (const x of col) seen.set(x, (seen.get(x) ?? 0) + 1);
    for (const [x, c] of seen) mult.set(x, Math.max(mult.get(x) ?? 0, c));
  }
  const distinct = [...mult.keys()].sort((a, b) => a - b);
  const first = new Map<number, number>();
  const xs: number[] = [];
  for (const x of distinct) {
    first.set(x, xs.length);
    for (let k = 0; k < (mult.get(x) as number); k++) xs.push(x);
  }
  const slotOf = columns.map((col) => {
    const used = new Map<number, number>();
    return col.map((x) => {
      const k = used.get(x) ?? 0;
      used.set(x, k + 1);
      return (first.get(x) as number) + k;
    });
  });
  return { xs, slotOf };
}

/** Spread `values` into a row of `width` slots (null elsewhere). */
function toRow(width: number, slots: readonly number[], values: readonly number[]): (number | null)[] {
  const row: (number | null)[] = new Array<number | null>(width).fill(null);
  slots.forEach((s, i) => (row[s] = values[i]));
  return row;
}

/** Least-squares scale `a` in `y ≈ a·f(x)` (through the origin) — SweepChart's `scaleOnto`. */
function scaleOnto(xs: readonly number[], ys: readonly number[], f: (n: number) => number): number {
  let fy = 0;
  let ff = 0;
  for (let i = 0; i < xs.length; i++) {
    fy += f(xs[i]) * ys[i];
    ff += f(xs[i]) * f(xs[i]);
  }
  return ff > 0 ? fy / ff : 0;
}

/** Everything the sweep chart draws on the stored axis, worked out without a canvas. */
export interface StoredSweepLayout {
  /** The union x array (ascending, replicates repeated). */
  readonly xs: readonly number[];
  /** Per view: its measured y in its own slots, null elsewhere. */
  readonly measured: readonly (readonly (number | null)[])[];
  /** Per view (only when the overlay is on): its theory class, scaled on its own x. */
  readonly theory: readonly { readonly cls: ComplexityClass; readonly ys: readonly (number | null)[] }[];
  /** Per view, per point: the x it is drawn at (the error bars' x). */
  readonly xOfPoint: readonly (readonly number[])[];
  /** Per view, per slot: the index of the point in that slot, or undefined (the hover map). */
  readonly pointAt: readonly (readonly (number | undefined)[])[];
}

/**
 * Lay the sweep chart out on stored n: each view on its own x values, its theory twin scaled
 * onto *those* points, and the maps the error bars and the hover read-out need now that a
 * slot is no longer a point index. `theoryOf` is null when the overlay is off.
 */
export function storedSweepLayout(
  views: readonly SeriesView[],
  signal: Signal,
  theoryOf: ((v: SeriesView) => ComplexityClass) | null,
): StoredSweepLayout {
  const xOfPoint = views.map((v) => (v.x ? v.x.values : v.series.points.map((p) => p.n)));
  const { xs, slotOf } = alignOnX(xOfPoint);
  const pick = yOf(signal);
  const ys = views.map((v) => v.series.points.map(pick));
  const measured = views.map((_, i) => toRow(xs.length, slotOf[i], ys[i]));
  const theory = theoryOf
    ? views.map((v, i) => {
        const cls = theoryOf(v);
        const f = CLASS_BASIS[cls];
        const a = scaleOnto(xOfPoint[i], ys[i], f);
        return { cls, ys: toRow(xs.length, slotOf[i], xOfPoint[i].map((x) => a * f(x))) };
      })
    : [];
  const pointAt = views.map((_, i) => {
    const row: (number | undefined)[] = new Array<number | undefined>(xs.length).fill(undefined);
    slotOf[i].forEach((s, pi) => (row[s] = pi));
    return row;
  });
  return { xs, measured, theory, xOfPoint, pointAt };
}

/** The local-slope panel on stored n: each view's interval midpoints, aligned into one x. */
export function storedSlopeLayout(views: readonly SeriesView[]): {
  xs: readonly number[];
  ys: readonly (readonly (number | null)[])[];
} {
  const { xs, slotOf } = alignOnX(views.map((v) => v.fit.localNs));
  return { xs, ys: views.map((v, i) => toRow(xs.length, slotOf[i], v.fit.localSlopes)) };
}

/** Columns the CSV gains while the stored axis is on: which x each row was plotted at, and the value. */
export const STORED_CSV_COLUMNS = ',x_axis,x';

/** The two trailing CSV cells for point `i` of a view in a stored-axis export (empty for a view without an x basis). */
export function storedCsvCells(v: SeriesView, i: number): string[] {
  return v.x ? [v.x.axis === 'stored' ? 'stored_n' : 'n', String(v.x.values[i])] : ['', ''];
}

/** The JSON fields a stored-axis series gains: its axis, its x values, and the input-n fit beside the stored one. */
export function storedJsonFields(v: SeriesView): Record<string, unknown> {
  if (!v.x) return {};
  const f = v.x.inputFit;
  return {
    xAxis: v.x.axis === 'stored' ? 'storedN' : 'n',
    xs: v.x.values,
    inputNFit: {
      best: f.best,
      r2: f.r2,
      logLogSlope: f.logLogSlope,
      slopeStderr: f.slopeStderr,
      slopeCi: f.slopeCi,
      tailSlope: f.tailSlope,
      trend: f.trend,
      localNs: f.localNs,
      localSlopes: f.localSlopes,
    },
  };
}
