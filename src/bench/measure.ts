/**
 * Per-operation measurement methodology (docs/PLAN.md §6.2–§6.3) — the pure,
 * engine-agnostic orchestration. It owns the parts that must be *correct and
 * testable* without a browser or WASM: choosing a batch size large enough to
 * swamp the clock clamp (risk R2), warming up, repeating, and summarizing
 * timing + variance per sweep point.
 *
 * The actual work is injected as an {@link OpRunner}: the WASM-backed worker
 * supplies a runner that builds a structure to size `n` (untimed) and performs
 * `k` operations inside one WASM call (docs/PLAN.md §6.2). Tests supply a stub
 * runner with a known cost shape and a virtual clock — so the auto-grow / reps /
 * median / stddev logic is validated deterministically, with no timing flake.
 *
 * Wall-clock fidelity (does the *real* browser clock yield clean O(n) vs O(1)
 * curves?) is proven separately in `scripts/verify-browser.mjs` — the faithful
 * home for risk R2, since that risk is about the browser clock specifically.
 */

/** Which structure a series was measured on (docs/PLAN.md §8). */
export type StructureId = 'array' | 'hashset' | 'bst' | 'avl';

/**
 * Which operation a series measured (docs/PLAN.md §4.1, §6.3).
 * - `search` — size-preserving, timed directly (the thin-slice headline).
 * - `churn` — insert+delete *pairs* at fixed n: the combined mutation cost, the
 *   §6.3 *primary* method for size-mutating ops.
 * - `insert` / `delete` — the separated per-op curves from the §6.3 *finite-
 *   difference* cross-check (build / teardown cumulative cost, differenced).
 */
export type SweepOp = 'search' | 'churn' | 'insert' | 'delete';

/** One measured point on a size sweep. */
export interface SweepPoint {
  /** Structure size at this point. */
  readonly n: number;
  /** Median wall-clock cost per operation, in nanoseconds. */
  readonly nanosPerOp: number;
  /** Deterministic op-count per operation — the cost-metric signal (§6.4). */
  readonly opCount: number;
  /** Batch size (`k`) the auto-grow settled on for this point. */
  readonly batch: number;
  /** Number of timed repetitions summarized into {@link nanosPerOp}. */
  readonly reps: number;
  /** Sample standard deviation of the per-op timing across reps, in ns. */
  readonly stddevNanos: number;
}

/** A full series: one structure × one operation across the size sweep. */
export interface SweepSeries {
  readonly structure: StructureId;
  readonly op: SweepOp;
  readonly points: readonly SweepPoint[];
}

/**
 * The injectable unit of work for one sweep point. Created already populated to
 * size `n` (building is untimed — search is size-preserving, §6.3).
 */
export interface OpRunner {
  /**
   * Perform exactly `k` operations and return a value derived from the work
   * (e.g. a hit count). Callers ignore the value; its only job is to stop the
   * optimizer eliding the work (docs/PLAN.md §6.2).
   */
  run(k: number): number;
  /** Deterministic op-count for a single operation — the §6.4 signal. */
  opCountPerOp(): number;
  /** Release any held resources (e.g. free the WASM structure). */
  dispose?(): void;
}

/** Builds an {@link OpRunner} for a structure populated to size `n`. */
export type OpRunnerFactory = (n: number) => OpRunner;

/** Tuning knobs for the measurement loop (docs/PLAN.md §6.2). */
export interface MeasureOptions {
  /** Grow the batch until one timed call lasts at least this long (ms). */
  readonly minBatchMillis?: number;
  /** Untimed repetitions before measuring, to warm caches/JIT. */
  readonly warmupReps?: number;
  /** Timed repetitions summarized per point. */
  readonly reps?: number;
  /** Starting batch size before auto-grow. */
  readonly baseBatch?: number;
  /** Ceiling on batch size, so tiny per-op costs can't loop forever. */
  readonly maxBatch?: number;
}

const DEFAULTS = {
  minBatchMillis: 2,
  warmupReps: 1,
  reps: 5,
  baseBatch: 1024,
  maxBatch: 1 << 26,
} as const;

/** A clock returning milliseconds (the `performance.now()` contract). */
export type Clock = () => number;

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function sampleStddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Measure one sweep point: build (untimed) → warm up → auto-grow the batch past
 * the clock clamp → take `reps` timed runs → summarize. `now` is injected so
 * tests can drive a deterministic virtual clock.
 */
export function measurePoint(
  n: number,
  makeRunner: OpRunnerFactory,
  now: Clock,
  opts: MeasureOptions = {},
): SweepPoint {
  const { minBatchMillis, warmupReps, reps, baseBatch, maxBatch } = {
    ...DEFAULTS,
    ...opts,
  };

  const runner = makeRunner(n);
  try {
    for (let w = 0; w < warmupReps; w++) runner.run(baseBatch);

    // Auto-grow the batch until a single timed call clears the clamp (R2).
    let batch = baseBatch;
    while (batch < maxBatch) {
      const t0 = now();
      runner.run(batch);
      if (now() - t0 >= minBatchMillis) break;
      batch = Math.min(batch * 2, maxBatch);
    }

    const perOpNanos: number[] = [];
    for (let r = 0; r < reps; r++) {
      const t0 = now();
      runner.run(batch);
      const elapsedMs = now() - t0;
      perOpNanos.push((elapsedMs * 1e6) / batch);
    }

    const mean = perOpNanos.reduce((a, b) => a + b, 0) / perOpNanos.length;
    const nanosPerOp = median([...perOpNanos].sort((a, b) => a - b));

    return {
      n,
      nanosPerOp,
      opCount: runner.opCountPerOp(),
      batch,
      reps,
      stddevNanos: sampleStddev(perOpNanos, mean),
    };
  } finally {
    runner.dispose?.();
  }
}

/** Measure {@link measurePoint} across every size in the sweep. */
export function measureSweep(
  sizes: readonly number[],
  makeRunner: OpRunnerFactory,
  now: Clock,
  opts: MeasureOptions = {},
): SweepPoint[] {
  return sizes.map((n) => measurePoint(n, makeRunner, now, opts));
}

// ── Finite-difference cross-check for size-mutating ops (docs/PLAN.md §6.3) ──

/**
 * Per-op cost near each sweep size by finite differences of a *cumulative* curve
 * (docs/PLAN.md §6.3, cross-check method). Given cumulative cost `C(nᵢ)` (e.g.
 * total time to build a structure to size n, or to tear one down), the marginal
 * per-op cost near `nᵢ` ≈ `(C(nᵢ) − C(nᵢ₋₁)) / (nᵢ − nᵢ₋₁)`. The first point has
 * no predecessor, so it falls back to the average `C(n₀)/n₀`.
 *
 * Tiny *negative* differences are clamped to zero: they only arise from
 * measurement noise when two cumulative wall-clock curves are subtracted to
 * isolate teardown (build cancels), and a negative per-op cost is meaningless.
 */
export function finiteDifference(
  ns: readonly number[],
  cumulative: readonly number[],
): number[] {
  return ns.map((n, i) => {
    if (i === 0) return n > 0 ? Math.max(0, cumulative[0] / n) : 0;
    const dn = ns[i] - ns[i - 1];
    const dc = cumulative[i] - cumulative[i - 1];
    return dn > 0 ? Math.max(0, dc / dn) : 0;
  });
}

/** The separated insert/delete curves produced by the finite-difference method. */
export interface MutationFdSeries {
  readonly insert: SweepSeries;
  readonly delete: SweepSeries;
}

/**
 * Measure per-insert and per-delete cost via the §6.3 finite-difference method.
 *
 * Two cumulative passes are timed (each via {@link measureSweep}, so each gets
 * its own clamp-clearing auto-grow — a single build/teardown is sub-clamp at
 * small n, so `run(k)` repeats it `k` times on fresh structures):
 * - `build` — `run(k)` does `k` builds-from-empty to size n; `opCountPerOp()`
 *   returns the *cumulative* insert op-count to n. Differencing → **insert**.
 * - `buildTeardown` — `run(k)` does `k` build+teardown cycles of size n;
 *   `opCountPerOp()` returns the cumulative (insert+teardown) op-count.
 *   Subtracting the build pass isolates teardown; differencing → **delete**.
 *
 * Build cancels in the subtraction, so only the teardown remains — the per-op
 * delete cost, free of build contamination. All I/O is injected (`now`, the two
 * runner factories), so the methodology self-test drives this with stub cost
 * shapes and a virtual clock (docs/PLAN.md §12).
 */
export function measureMutationFd(
  structure: StructureId,
  sizes: readonly number[],
  build: OpRunnerFactory,
  buildTeardown: OpRunnerFactory,
  now: Clock,
  opts: MeasureOptions = {},
): MutationFdSeries {
  const buildPts = measureSweep(sizes, build, now, opts);
  const btPts = measureSweep(sizes, buildTeardown, now, opts);

  // Cumulative build cost (= insert) and the isolated teardown cost (= bt − build).
  const buildNanos = buildPts.map((p) => p.nanosPerOp);
  const buildOps = buildPts.map((p) => p.opCount);
  const teardownNanos = btPts.map((p, i) => Math.max(0, p.nanosPerOp - buildNanos[i]));
  const teardownOps = btPts.map((p, i) => Math.max(0, p.opCount - buildOps[i]));

  const insertNanos = finiteDifference(sizes, buildNanos);
  const insertOps = finiteDifference(sizes, buildOps);
  const deleteNanos = finiteDifference(sizes, teardownNanos);
  const deleteOps = finiteDifference(sizes, teardownOps);

  const series = (
    op: SweepOp,
    nanos: number[],
    ops: number[],
    cum: SweepPoint[],
  ): SweepSeries => ({
    structure,
    op,
    points: sizes.map((n, i) => ({
      n,
      nanosPerOp: nanos[i],
      opCount: ops[i],
      batch: cum[i].batch,
      reps: cum[i].reps,
      stddevNanos: cum[i].stddevNanos,
    })),
  });

  return {
    insert: series('insert', insertNanos, insertOps, buildPts),
    delete: series('delete', deleteNanos, deleteOps, btPts),
  };
}
