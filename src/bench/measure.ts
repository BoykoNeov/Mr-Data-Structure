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
export type StructureId = 'array' | 'hashset';

/** Which operation was measured. Phase 2 thin slice measures `search` only. */
export type SweepOp = 'search';

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
