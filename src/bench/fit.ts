/**
 * Complexity-class fitter (docs/PLAN.md §7.2) — *secondary, honest*.
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
 */

export type ComplexityClass = 'O(1)' | 'O(log n)' | 'O(n)' | 'O(n log n)' | 'O(n²)';

/** A candidate class and how well it fits (squared cosine similarity, [0,1]). */
export interface ClassScore {
  readonly cls: ComplexityClass;
  readonly r2: number;
}

export interface FitResult {
  /** Best-fitting class by {@link ClassScore.r2}. */
  readonly best: ComplexityClass;
  /** The best class's fit score (squared cosine similarity, [0,1]). */
  readonly r2: number;
  /** Headline signal: slope of `ln(y)` vs `ln(n)` (0/1/2 ≈ const/linear/quadratic). */
  readonly logLogSlope: number;
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

/** Classes that are empirically hard to tell apart (§7.2). */
const SOFT_BAND: ReadonlySet<ComplexityClass> = new Set(['O(log n)', 'O(n)', 'O(n log n)']);
/** Two scores closer than this are treated as a statistical tie. */
const AMBIGUOUS_DELTA = 0.02;

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

/** OLS slope of `ln(y)` against `ln(n)` over points with positive `n` and `y`. */
function logLogSlope(ns: readonly number[], ys: readonly number[]): number {
  const lx: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < ns.length; i++) {
    if (ns[i] > 0 && ys[i] > 0) {
      lx.push(Math.log(ns[i]));
      ly.push(Math.log(ys[i]));
    }
  }
  if (lx.length < 2) return 0;
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length;
  const my = ly.reduce((a, b) => a + b, 0) / ly.length;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < lx.length; i++) {
    cov += (lx[i] - mx) * (ly[i] - my);
    varx += (lx[i] - mx) * (lx[i] - mx);
  }
  return varx === 0 ? 0 : cov / varx;
}

function buildNote(best: ComplexityClass, slope: number, ambiguous: boolean): string {
  const s = `log-log slope ≈ ${slope.toFixed(2)}`;
  if (best === 'O(1)') return `Flat within noise — constant time (${s}).`;
  if (best === 'O(n²)') return `Clearly super-linear (${s}).`;
  if (ambiguous || SOFT_BAND.has(best)) {
    return `Best fit ${best}, but log n / n / n·log n are empirically hard to separate — trust the ${s}.`;
  }
  return `Best fit ${best} (${s}).`;
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
  const slope = logLogSlope(ns, ys);
  const ambiguous =
    SOFT_BAND.has(best.cls) &&
    SOFT_BAND.has(runnerUp.cls) &&
    best.r2 - runnerUp.r2 < AMBIGUOUS_DELTA;

  return {
    best: best.cls,
    r2: best.r2,
    logLogSlope: slope,
    scores,
    ambiguous,
    note: buildNote(best.cls, slope, ambiguous),
  };
}
