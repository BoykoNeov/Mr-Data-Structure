import { describe, it, expect } from 'vitest';
import {
  measureSweep,
  measureMutationFd,
  type Clock,
  type OpRunnerFactory,
} from './measure';
import { fitComplexity } from './fit';

/**
 * Methodology self-test (docs/PLAN.md §6.3, §12, Phase 2 exit). The §6.3
 * size-mutating measurement has two methods that must agree:
 * - **churn** (primary) times insert+delete *pairs* at fixed n — the *combined*
 *   mutation cost.
 * - **finite differences** (cross-check) difference cumulative build (→ insert)
 *   and cumulative teardown (→ delete) — the *separated* per-op costs.
 *
 * The agreement claim is `churn_pair(n) ≈ insert_fd(n) + delete_fd(n)`, plus the
 * methods must infer the same complexity class. This is validated against known
 * cost shapes with a deterministic virtual clock, so the check is exact and
 * timing-flake-free (the real browser clock is too noisy for a numeric sum
 * tolerance — `scripts/verify-browser.mjs` checks only *class* agreement there).
 *
 * Cost shapes mirror the real structures (docs/PLAN.md §8):
 * - **array** — insert is append O(1); delete is ordered shift-compact O(n).
 * - **hash set** — both O(1) amortized.
 */

/** A deterministic virtual clock (ms), as in `measure.test.ts`. */
function virtualClock(): { now: Clock; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * Stub runner factories for one structure, driven by per-op cost functions of
 * the *current* size m. `churn` reports the per-pair cost at n; `build` and
 * `buildTeardown` report *cumulative* cost (and op-count) to n, exactly as the
 * WASM-backed runners do, so {@link measureMutationFd} differences them.
 */
function mutationStubs(
  clock: { advance: (ms: number) => void },
  insertCost: (m: number) => number,
  deleteCost: (m: number) => number,
): { churn: OpRunnerFactory; build: OpRunnerFactory; buildTeardown: OpRunnerFactory } {
  const buildCache = new Map<number, number>();
  const teardownCache = new Map<number, number>();
  const buildCum = (n: number): number => {
    let v = buildCache.get(n);
    if (v === undefined) {
      v = 0;
      for (let m = 0; m < n; m++) v += insertCost(m);
      buildCache.set(n, v);
    }
    return v;
  };
  const teardownCum = (n: number): number => {
    let v = teardownCache.get(n);
    if (v === undefined) {
      v = 0;
      for (let m = 1; m <= n; m++) v += deleteCost(m);
      teardownCache.set(n, v);
    }
    return v;
  };
  const churnPair = (n: number): number => insertCost(n) + deleteCost(n);

  return {
    churn: (n) => ({
      run: (k) => (clock.advance(k * churnPair(n)), k),
      opCountPerOp: () => churnPair(n),
    }),
    build: (n) => ({
      run: (k) => (clock.advance(k * buildCum(n)), k),
      opCountPerOp: () => buildCum(n),
    }),
    buildTeardown: (n) => ({
      run: (k) => (clock.advance(k * (buildCum(n) + teardownCum(n))), k),
      opCountPerOp: () => buildCum(n) + teardownCum(n),
    }),
  };
}

const CI = 1e-9; // array/hashset insert: constant per op
const CD = 1e-9; // array delete: per element of current size (=> O(n))

const arrayStubs = (clock: { advance: (ms: number) => void }) =>
  mutationStubs(clock, () => CI, (m) => CD * m);
const hashsetStubs = (clock: { advance: (ms: number) => void }) =>
  mutationStubs(clock, () => CI, () => CI);

describe('§6.3 methodology self-test — churn vs finite differences', () => {
  // Closely-spaced sizes keep the finite-difference estimate near the derivative
  // at nᵢ (not the interval midpoint), so the numeric sum agreement is tight.
  const NARROW = [5000, 5100, 5200, 5300, 5400, 5500];

  it('array: churn ≈ insert_fd + delete_fd at every size', () => {
    const clock = virtualClock();
    const s = arrayStubs(clock);
    const churn = measureSweep(NARROW, s.churn, clock.now);
    const fd = measureMutationFd('array', NARROW, s.build, s.buildTeardown, clock.now);

    // Skip i=0: the first FD point is an average from empty, not a derivative.
    for (let i = 1; i < NARROW.length; i++) {
      const churnNanos = churn[i].nanosPerOp;
      const sum = fd.insert.points[i].nanosPerOp + fd.delete.points[i].nanosPerOp;
      expect(Math.abs(churnNanos - sum) / churnNanos).toBeLessThan(0.02);
    }
  });

  it('hash set: churn ≈ insert_fd + delete_fd (exact for constant costs)', () => {
    const clock = virtualClock();
    const s = hashsetStubs(clock);
    const churn = measureSweep(NARROW, s.churn, clock.now);
    const fd = measureMutationFd('hashset', NARROW, s.build, s.buildTeardown, clock.now);

    for (let i = 1; i < NARROW.length; i++) {
      const sum = fd.insert.points[i].nanosPerOp + fd.delete.points[i].nanosPerOp;
      expect(sum).toBeCloseTo(churn[i].nanosPerOp, 9);
    }
  });

  // A wide geometric sweep so the log-log slope / class fit is well-conditioned.
  const WIDE = [1000, 2000, 5000, 10000, 20000];

  it('array: both methods infer O(n) mutation (insert O(1), delete O(n))', () => {
    const clock = virtualClock();
    const s = arrayStubs(clock);
    const churn = measureSweep(WIDE, s.churn, clock.now);
    const fd = measureMutationFd('array', WIDE, s.build, s.buildTeardown, clock.now);

    const cls = (pts: ReadonlyArray<{ n: number; nanosPerOp: number }>) =>
      fitComplexity(pts.map((p) => p.n), pts.map((p) => p.nanosPerOp)).best;

    expect(cls(churn)).toBe('O(n)'); // combined mutation, delete-dominated
    expect(cls(fd.insert.points)).toBe('O(1)');
    expect(cls(fd.delete.points)).toBe('O(n)');
  });

  it('hash set: both methods infer O(1) mutation (insert and delete O(1))', () => {
    const clock = virtualClock();
    const s = hashsetStubs(clock);
    const churn = measureSweep(WIDE, s.churn, clock.now);
    const fd = measureMutationFd('hashset', WIDE, s.build, s.buildTeardown, clock.now);

    const cls = (pts: ReadonlyArray<{ n: number; nanosPerOp: number }>) =>
      fitComplexity(pts.map((p) => p.n), pts.map((p) => p.nanosPerOp)).best;

    expect(cls(churn)).toBe('O(1)');
    expect(cls(fd.insert.points)).toBe('O(1)');
    expect(cls(fd.delete.points)).toBe('O(1)');
  });
});
