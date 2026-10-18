import type { SweepPoint, SweepSeries } from './measure';

/**
 * The open-addressing hash set's **load-factor control** (docs/PLAN.md §13, "a load-factor
 * control"; docs/METHODOLOGY.md §2.8): the rehash threshold `L` the Compare run builds that
 * set at, and the arithmetic the page needs to say honestly what a non-default `L` did.
 *
 * It lives outside `engine.worker.ts` for the reason `./probeMix` does: these are measurement
 * decisions in pure functions, and a worker module cannot be unit-tested.
 *
 * **The default is the comparison, not a starting value.** At 0.75 the open-addressing set
 * shares the chaining set's hash, start size, threshold and doubling, so the two tables have
 * the same capacity at every n and the gap between their lines is the collision strategy
 * alone. The chaining set never moves off 0.75, so any other `L` ends that like-for-like
 * pairing — which the page, the PNG sheet and both exports say whenever it happens.
 */

/** The open-addressing set's threshold on the default page — the chaining set's. */
export const DEFAULT_OA_MAX_LOAD = 0.75;

/** The chaining set's threshold. Fixed: the control moves only the open-addressing set. */
export const CHAINING_MAX_LOAD = 0.75;

/**
 * The thresholds the UI offers. Discrete, as the probe mix is, and each one nameable:
 * - **0.5** — linear probing's usual ceiling (Knuth's miss cost ½(1 + 1/(1−α)²) is 2.5 at
 *   the top of the sawtooth, against 8.5 at 0.75);
 * - **0.75** — the default, the chaining set's;
 * - **0.9** — a crowded table (a miss costs ~50 slot probes at the top). Honest as a
 *   threshold — tombstones count toward it, so `live + tombs` never passes 0.9 · slots and a
 *   miss always finds an empty slot — but the browser's size ladders sample the sawtooth at
 *   fixed points and reach α ≤ 0.78 on distinct keys, which is why the page reports the α
 *   each point actually sat at ({@link oaLoadReach}) rather than the threshold's name alone
 *   (`hash_set_oa::tests::the_browser_ladders_sample_the_sawtooth_at_fixed_points`).
 */
export const OA_MAX_LOAD_CHOICES: readonly number[] = [0.5, 0.75, 0.9];

/**
 * A threshold the engine will accept, or an error before the worker is called: the Rust set
 * rejects anything outside `[0.25, 1)` by trapping, which would take the worker down with it.
 */
export function checkOaMaxLoad(maxLoad: number): number {
  if (!(Number.isFinite(maxLoad) && maxLoad >= 0.25 && maxLoad < 1)) {
    throw new Error(`open-addressing max load ${maxLoad} is outside [0.25, 1)`);
  }
  return maxLoad;
}

/** Whether a run measured the open-addressing set at the default (like-for-like) threshold. */
export function isDefaultOaLoad(maxLoad: number): boolean {
  return maxLoad === DEFAULT_OA_MAX_LOAD;
}

/**
 * Slots in a table built by inserting `distinct` keys at threshold `maxLoad` — the growth rule
 * both twins share (start at 4, double while `distinct > L · slots`). A build with no deletes
 * depends only on the distinct count, which is what a search point's `storedN` is. Valid for
 * `L ≥ 0.25`, where one doubling per insert always suffices (`checkOaMaxLoad`).
 */
export function oaCapacity(distinct: number, maxLoad: number): number {
  let slots = 4;
  while (distinct > maxLoad * slots) slots *= 2;
  return slots;
}

/** The load factors one series' points sat at: lowest, highest, and the size of the highest. */
export interface OaLoadReach {
  readonly min: number;
  readonly max: number;
  /** Input size `n` of the (first) point at {@link max}. */
  readonly atN: number;
}

/**
 * The α = stored / slots each point of a **search** series sat at, summarised. Computed, not
 * measured: a search point's table was built by inserts alone, so its capacity is
 * {@link oaCapacity} of the stored count (falling back to `n` where a point carries none).
 * Not for churn points — priming can double that table (METHODOLOGY §2.8, rule 3) — and
 * `null` for an empty series.
 */
export function oaLoadReach(points: readonly SweepPoint[], maxLoad: number): OaLoadReach | null {
  let reach: OaLoadReach | null = null;
  for (const p of points) {
    const stored = p.storedN ?? p.n;
    const alpha = stored / oaCapacity(stored, maxLoad);
    if (reach === null) reach = { min: alpha, max: alpha, atN: p.n };
    else
      reach = {
        min: Math.min(reach.min, alpha),
        max: alpha > reach.max ? alpha : reach.max,
        atN: alpha > reach.max ? p.n : reach.atN,
      };
  }
  return reach;
}

/**
 * Stamp each hash set series with the threshold it was measured at (`SweepSeries.maxLoad`):
 * the open-addressing set's `oaMaxLoad`, the chaining set's fixed 0.75. Every other series is
 * returned untouched. The worker calls this on the two sweeps the open-addressing set is in.
 */
export function stampMaxLoad(series: readonly SweepSeries[], oaMaxLoad: number): SweepSeries[] {
  return series.map((s) =>
    s.structure === 'hashoa'
      ? { ...s, maxLoad: oaMaxLoad }
      : s.structure === 'hashset'
        ? { ...s, maxLoad: CHAINING_MAX_LOAD }
        : s,
  );
}
