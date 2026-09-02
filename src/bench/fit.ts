/**
 * Complexity-class fitter (docs/PLAN.md §7.2, docs/METHODOLOGY.md §3) —
 * *secondary, honest*.
 *
 * The **log-log slope is the headline** the user reads (0 ≈ constant, 1 ≈
 * linear, 2 ≈ quadratic); the auto-label is a hint. We score each candidate
 * basis {O(1), log n, n, n·log n, n²} by how well it explains the measured
 * curve and pick the best, but we also report whether the result is empirically
 * ambiguous — because, per §7.2, constant / linear / quadratic separate
 * reliably while log n / n / n·log n often do not.
 *
 * **Goodness = squared cosine similarity** between the basis vector `f(nᵢ)` and
 * the measurement vector `yᵢ` — i.e. the R² of the best through-origin fit
 * `y ≈ a·f(n)`, `(Σfy)² / (Σf²·Σy²) ∈ [0,1]`. Unlike the usual mean-centered R²,
 * this lets **O(1) score ≈1 on a flat curve** (centered R² is undefined/zero
 * when there is no variance to explain) while still ranking rising curves by
 * shape. For O(1) the score reduces to `1 / (1 + CV²)` (CV = coefficient of
 * variation), so a flat series scores ~1 and a steep one scores low — exactly
 * the discrimination we want.
 *
 * **The slope carries an uncertainty.** A single slope number over-claims: the
 * points scatter, and a straight line may not even be the right model (a fixed
 * per-op overhead bends the low-n end flat; a logarithm bends the high-n end
 * flat). So the fit reports, alongside the headline slope:
 * - its OLS **standard error** and a 95% confidence interval (t-distribution,
 *   `m − 2` degrees of freedom) — "slope ≈ 0.98 ± 0.05" instead of "0.98";
 * - the **local slope** on every interval between consecutive sweep points,
 *   i.e. the empirical exponent `Δln y / Δln n` — a regime change (a cache cliff,
 *   the onset of the asymptotic term) shows up here long before it moves the
 *   overall slope;
 * - the **tail slope** (OLS over the upper half of the sweep), because
 *   complexity is a large-n statement and the small-n end is where constants
 *   dominate;
 * - the **trend** of the local slope with n: *falling* is the signature of
 *   O(log n) (`d ln(ln n) / d ln n = 1/ln n → 0`), *rising* means a fixed
 *   overhead is still masking the growth term (the true class is at least as
 *   steep as the tail slope), *steady* is a clean power law. This is the one
 *   thing that separates "flat-ish because O(log n)" from "flat-ish because
 *   O(1) + noise" or "flat-ish because overhead + O(n) at small n" — which the
 *   overall slope alone cannot do (risk R3).
 */

export type ComplexityClass = 'O(1)' | 'O(log n)' | 'O(n)' | 'O(n log n)' | 'O(n²)';

/** A candidate class and how well it fits (squared cosine similarity, [0,1]). */
export interface ClassScore {
  readonly cls: ComplexityClass;
  readonly r2: number;
}

/** How the local (interval) log-log slope moves as n grows. */
export type SlopeTrend = 'rising' | 'falling' | 'steady';

export interface FitResult {
  /** Best-fitting class by {@link ClassScore.r2}. */
  readonly best: ComplexityClass;
  /** The best class's fit score (squared cosine similarity, [0,1]). */
  readonly r2: number;
  /** Headline signal: slope of `ln(y)` vs `ln(n)` (0/1/2 ≈ const/linear/quadratic). */
  readonly logLogSlope: number;
  /** OLS standard error of {@link logLogSlope} (0 when fewer than 3 points). */
  readonly slopeStderr: number;
  /** 95% confidence interval on {@link logLogSlope} (t-distribution, m−2 d.o.f.). */
  readonly slopeCi: readonly [number, number];
  /**
   * The empirical exponent on each interval between consecutive sweep points,
   * `Δln y / Δln n` — one entry per interval (`m − 1` of them), positioned at
   * {@link localNs}. A regime change shows here first.
   */
  readonly localSlopes: readonly number[];
  /** Geometric-mean `n` of each interval in {@link localSlopes} (its natural x). */
  readonly localNs: readonly number[];
  /** OLS log-log slope over the upper half of the sweep — the large-n reading. */
  readonly tailSlope: number;
  /** Whether the local slope rises, falls, or holds as n grows (see module doc). */
  readonly trend: SlopeTrend;
  /** Every class scored, sorted best-first — for the side-by-side UI (§7.2). */
  readonly scores: readonly ClassScore[];
  /** True when the result sits in the empirically hard-to-separate band and the
   *  runner-up is within {@link AMBIGUOUS_DELTA}. */
  readonly ambiguous: boolean;
  /** Human-readable confidence note (honest UI copy, §7.2). */
  readonly note: string;
}

/** Basis functions, in increasing growth order. `O(1)` is the constant 1. */
const BASES: ReadonlyArray<{ cls: ComplexityClass; f: (n: number) => number }> = [
  { cls: 'O(1)', f: () => 1 },
  { cls: 'O(log n)', f: (n) => Math.log2(n) },
  { cls: 'O(n)', f: (n) => n },
  { cls: 'O(n log n)', f: (n) => n * Math.log2(n) },
  { cls: 'O(n²)', f: (n) => n * n },
];

/** The log-log slope each class draws as — the theoretical reference the UI overlays. */
export const CLASS_BASIS: Readonly<Record<ComplexityClass, (n: number) => number>> = {
  'O(1)': BASES[0].f,
  'O(log n)': BASES[1].f,
  'O(n)': BASES[2].f,
  'O(n log n)': BASES[3].f,
  'O(n²)': BASES[4].f,
};

/** Classes that are empirically hard to tell apart (§7.2). */
const SOFT_BAND: ReadonlySet<ComplexityClass> = new Set(['O(log n)', 'O(n)', 'O(n log n)']);
/** Two scores closer than this are treated as a statistical tie. */
const AMBIGUOUS_DELTA = 0.02;
/** A local-slope drift across the sweep smaller than this is too small to matter. */
const TREND_MIN_DRIFT = 0.05;
/** |t| above which the local-slope drift is taken as real rather than scatter. */
const TREND_T = 2;

/** Squared cosine similarity between `f(nᵢ)` and `yᵢ` (uncentered R², [0,1]). */
function cosineR2(ns: readonly number[], ys: readonly number[], f: (n: number) => number): number {
  let dot = 0;
  let ff = 0;
  let yy = 0;
  for (let i = 0; i < ns.length; i++) {
    const fi = f(ns[i]);
    dot += fi * ys[i];
    ff += fi * fi;
    yy += ys[i] * ys[i];
  }
  if (ff === 0 || yy === 0) return 0;
  return (dot * dot) / (ff * yy);
}

/** The (ln n, ln y) pairs over points with positive `n` and `y`. */
function logPairs(ns: readonly number[], ys: readonly number[]): { lx: number[]; ly: number[] } {
  const lx: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < ns.length; i++) {
    if (ns[i] > 0 && ys[i] > 0) {
      lx.push(Math.log(ns[i]));
      ly.push(Math.log(ys[i]));
    }
  }
  return { lx, ly };
}

/**
 * Ordinary least squares of `y` on `x`: slope, plus its standard error from the
 * residual variance (`s² / Σ(x − x̄)²`, `s² = RSS / (m − 2)`). Returns zeros when
 * there are too few points, and a zero stderr for an exact fit or `m = 2`.
 */
export function olsSlope(
  xs: readonly number[],
  ys: readonly number[],
): { readonly slope: number; readonly stderr: number; readonly df: number } {
  const m = xs.length;
  if (m < 2) return { slope: 0, stderr: 0, df: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / m;
  const my = ys.reduce((a, b) => a + b, 0) / m;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < m; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) * (xs[i] - mx);
  }
  if (varx === 0) return { slope: 0, stderr: 0, df: Math.max(0, m - 2) };
  const slope = cov / varx;
  const intercept = my - slope * mx;
  const df = m - 2;
  if (df <= 0) return { slope, stderr: 0, df: 0 };
  let rss = 0;
  for (let i = 0; i < m; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  return { slope, stderr: Math.sqrt(rss / df / varx), df };
}

/** Two-sided 95% Student-t critical value for `df` degrees of freedom. */
export function tCritical95(df: number): number {
  const table: ReadonlyArray<[number, number]> = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447],
    [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131],
    [20, 2.086], [30, 2.042], [60, 2.0],
  ];
  if (df <= 0) return Infinity;
  for (const [d, t] of table) if (df <= d) return t;
  return 1.96;
}

/** The interval-wise empirical exponent `Δln y / Δln n`, and each interval's geometric-mean n. */
function localSlopes(lx: readonly number[], ly: readonly number[]): { slopes: number[]; ns: number[] } {
  const slopes: number[] = [];
  const ns: number[] = [];
  for (let i = 1; i < lx.length; i++) {
    const dx = lx[i] - lx[i - 1];
    if (dx === 0) continue;
    slopes.push((ly[i] - ly[i - 1]) / dx);
    ns.push(Math.exp((lx[i] + lx[i - 1]) / 2));
  }
  return { slopes, ns };
}

/**
 * Classify the drift of the local slope with `ln n`: regress the interval
 * slopes on the interval's `ln n` and call the drift real only when it is both
 * statistically significant (|t| > {@link TREND_T}, so scatter alone can't
 * trigger it) and material (more than {@link TREND_MIN_DRIFT} across the whole
 * sweep). Needs ≥ 3 intervals (4 points) to say anything but `steady`.
 */
function classifyTrend(slopes: readonly number[], ns: readonly number[]): SlopeTrend {
  if (slopes.length < 3) return 'steady';
  const lx = ns.map((n) => Math.log(n));
  const { slope, stderr } = olsSlope(lx, slopes);
  const span = lx[lx.length - 1] - lx[0];
  const drift = slope * span;
  if (Math.abs(drift) < TREND_MIN_DRIFT) return 'steady';
  // An exact (zero-residual) trend has stderr 0: significant by construction.
  const t = stderr === 0 ? Infinity : Math.abs(slope) / stderr;
  if (t < TREND_T) return 'steady';
  return drift > 0 ? 'rising' : 'falling';
}

function fmtSlope(slope: number, stderr: number): string {
  return stderr > 0 ? `${slope.toFixed(2)} ± ${stderr.toFixed(2)}` : slope.toFixed(2);
}

function buildNote(
  best: ComplexityClass,
  slope: number,
  stderr: number,
  ambiguous: boolean,
  trend: SlopeTrend,
  tailSlope: number,
): string {
  const s = `log-log slope ≈ ${fmtSlope(slope, stderr)}`;
  let head: string;
  if (best === 'O(1)') head = `Flat within noise — constant time (${s}).`;
  else if (best === 'O(n²)') head = `Clearly super-linear (${s}).`;
  else if (ambiguous || SOFT_BAND.has(best)) {
    head = `Best fit ${best}, but log n / n / n·log n are empirically hard to separate — trust the ${s}.`;
  } else head = `Best fit ${best} (${s}).`;

  if (trend === 'falling' && slope > 0.05 && slope < 0.7) {
    return `${head} The rise flattens as n grows (local slope falling) — the signature of O(log n), not a power law.`;
  }
  if (trend === 'rising') {
    return `${head} The local slope is still climbing at the largest n (tail ≈ ${tailSlope.toFixed(2)}) — a fixed per-op overhead is masking the growth at small n, so the true class is at least that steep.`;
  }
  return head;
}

/**
 * Fit a measured cost curve to a complexity class. `ns` are sweep sizes and
 * `ys` the matching per-op costs (wall-clock ns or op-count). Needs ≥2 points.
 */
export function fitComplexity(ns: readonly number[], ys: readonly number[]): FitResult {
  if (ns.length !== ys.length) {
    throw new Error(`ns (${ns.length}) and ys (${ys.length}) must be the same length`);
  }

  if (ns.length < 2) {
    return {
      best: 'O(1)',
      r2: 0,
      logLogSlope: 0,
      slopeStderr: 0,
      slopeCi: [0, 0],
      localSlopes: [],
      localNs: [],
      tailSlope: 0,
      trend: 'steady',
      scores: BASES.map((b) => ({ cls: b.cls, r2: 0 })),
      ambiguous: false,
      note: 'Not enough sweep points to fit a complexity class.',
    };
  }

  const scores: ClassScore[] = BASES.map((b) => ({
    cls: b.cls,
    r2: cosineR2(ns, ys, b.f),
  })).sort((a, b) => b.r2 - a.r2);

  const best = scores[0];
  const runnerUp = scores[1];
  const ambiguous =
    SOFT_BAND.has(best.cls) &&
    SOFT_BAND.has(runnerUp.cls) &&
    best.r2 - runnerUp.r2 < AMBIGUOUS_DELTA;

  const { lx, ly } = logPairs(ns, ys);
  const ols = olsSlope(lx, ly);
  const halfWidth = ols.df > 0 ? tCritical95(ols.df) * ols.stderr : 0;
  const local = localSlopes(lx, ly);
  const tailStart = Math.max(0, lx.length - Math.max(3, Math.ceil(lx.length / 2)));
  const tail = olsSlope(lx.slice(tailStart), ly.slice(tailStart));
  const trend = classifyTrend(local.slopes, local.ns);

  return {
    best: best.cls,
    r2: best.r2,
    logLogSlope: ols.slope,
    slopeStderr: ols.stderr,
    slopeCi: [ols.slope - halfWidth, ols.slope + halfWidth],
    localSlopes: local.slopes,
    localNs: local.ns,
    tailSlope: tail.slope,
    trend,
    scores,
    ambiguous,
    note: buildNote(best.cls, ols.slope, ols.stderr, ambiguous, trend, tail.slope),
  };
}
