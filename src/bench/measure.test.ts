import { describe, it, expect } from 'vitest';
import {
  measurePoint,
  measureSweep,
  type Clock,
  type OpRunnerFactory,
} from './measure';

/**
 * A deterministic virtual clock: time only advances when a runner says work
 * happened. This makes the auto-grow / reps / median / stddev logic testable
 * with zero timing flake (docs/PLAN.md §6.2). `advance` is in milliseconds, the
 * `performance.now()` contract the real worker uses.
 */
function virtualClock(): { now: Clock; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * Stub runner factory whose per-op cost (ms) is a function of `n`, advancing the
 * shared virtual clock by `k * cost`. With a deterministic clock the reported
 * nanosPerOp collapses to exactly `cost(n) * 1e6`.
 */
function costShape(
  clock: { advance: (ms: number) => void },
  perOpMillis: (n: number) => number,
  opCount: (n: number) => number = () => 1,
): OpRunnerFactory {
  return (n) => ({
    run: (k) => {
      clock.advance(k * perOpMillis(n));
      return k;
    },
    opCountPerOp: () => opCount(n),
  });
}

const SIZES = [10, 100, 1000, 10000];

describe('measureSweep', () => {
  it('reports a rising per-op curve for an O(n) cost shape', () => {
    const clock = virtualClock();
    // O(n): per-op cost proportional to n.
    const points = measureSweep(
      SIZES,
      costShape(clock, (n) => n * 1e-6, (n) => n),
      clock.now,
    );

    // nanosPerOp == cost(n) * 1e6 == n (deterministic clock).
    for (let i = 0; i < points.length; i++) {
      expect(points[i].n).toBe(SIZES[i]);
      expect(points[i].nanosPerOp).toBeCloseTo(SIZES[i], 6);
      expect(points[i].opCount).toBe(SIZES[i]);
      expect(points[i].stddevNanos).toBeCloseTo(0, 9); // deterministic clock
    }
    // Strictly rising — the O(n) signature.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].nanosPerOp).toBeGreaterThan(points[i - 1].nanosPerOp);
    }
  });

  it('reports a flat per-op curve for an O(1) cost shape', () => {
    const clock = virtualClock();
    const points = measureSweep(SIZES, costShape(clock, () => 1e-6), clock.now);

    for (const p of points) {
      expect(p.nanosPerOp).toBeCloseTo(1, 6); // constant regardless of n
    }
    const first = points[0].nanosPerOp;
    for (const p of points) expect(p.nanosPerOp).toBeCloseTo(first, 9);
  });

  it('grows the batch until a timed call clears the clamp', () => {
    const clock = virtualClock();
    // Tiny per-op cost forces many doublings to reach minBatchMillis.
    const [point] = measureSweep([1], costShape(clock, () => 1e-7), clock.now, {
      minBatchMillis: 2,
      baseBatch: 1024,
    });
    // Need batch * 1e-7 >= 2  =>  batch >= 2e7. Doubling from 1024 (=2^10), the
    // first power of two past 2e7 is 2^25 = 33,554,432.
    expect(point.batch).toBe(1 << 25);
    expect(point.batch * 1e-7).toBeGreaterThanOrEqual(2);
  });

  it('respects the maxBatch ceiling for sub-clamp costs', () => {
    const clock = virtualClock();
    const [point] = measureSweep([1], costShape(clock, () => 0), clock.now, {
      minBatchMillis: 2,
      baseBatch: 1024,
      maxBatch: 1 << 16,
    });
    // Zero cost never clears the clamp; batch must stop at the ceiling.
    expect(point.batch).toBe(1 << 16);
  });
});

describe('measurePoint variance', () => {
  it('takes the median and a non-zero stddev when reps jitter', () => {
    const clock = virtualClock();
    // Cycle per-call multipliers so the 5 reps see costs 1,2,3,4,5 (×base).
    const multipliers = [1, 2, 3, 4, 5];
    let call = 0;
    const base = 1e-6;
    const factory: OpRunnerFactory = () => ({
      run: (k) => {
        // Warmup (1) + auto-grow (>=1) happen first; reps start after. We only
        // care that the 5 *timed* reps span a range, so cycle on every call.
        const m = multipliers[call % multipliers.length];
        call++;
        clock.advance(k * base * m);
        return k;
      },
      opCountPerOp: () => 1,
    });

    const point = measurePoint(1, factory, clock.now, {
      minBatchMillis: 0, // skip auto-grow churn; baseBatch is enough
      warmupReps: 0,
      reps: 5,
      baseBatch: 1000,
    });

    // With minBatchMillis 0 the grow loop times one call (multiplier index 0),
    // then 5 reps see multipliers index 1..5 -> costs 2..5,1 (×base) over k.
    // Median of {2,3,4,5,1} = 3 -> nanosPerOp == 3 * base * 1e6 == 3.
    expect(point.nanosPerOp).toBeCloseTo(3, 6);
    expect(point.stddevNanos).toBeGreaterThan(0);
  });
});
