/**
 * The **search probe mix** (docs/PLAN.md §6.3 "Mix of present/absent keys is configurable",
 * §13; docs/METHODOLOGY.md §2.2, §4 hurdle 9): what fraction of the lookups a search sweep
 * times are for keys the structure holds, and how both halves of that workload are built.
 *
 * It lives here, outside `engine.worker.ts`, for the reason `./stringWorkload` does: the
 * builders are pure and carry measurement decisions, and a worker module cannot be
 * unit-tested. The worker keeps the timing; this keeps the decisions.
 *
 * **The default is the workload the browser gate was calibrated on, exactly.** At
 * {@link DEFAULT_PROBE_MIX} the numeric and string builders return the same keys, in the same
 * order, as the fixed 64-present + 64-absent builders they replace (pinned byte-for-byte by
 * `probeMix.test.ts` against frozen copies of those builders). No random numbers are drawn
 * by either builder, at any mix, so "the same seed consumption" holds trivially: the probe
 * set is a pure function of the stored prefix and the mix.
 *
 * **Every structure gets the same probe set at a given mix** — the shared-probes rule
 * (CLAUDE.md, the trie entry). The mix is one value for the whole run, threaded to every
 * search runner, and never chosen per structure: a chart on which each line got the mix
 * that suits it would stop being a comparison.
 */

/** Probes per sweep point, summed over both halves — the size of today's 64 + 64 workload. */
export const PROBES_PER_POINT = 128;

/** The fraction of probes that are *present* keys in the calibrated default workload. */
export const DEFAULT_PRESENT_FRACTION = 0.5;

/**
 * One run's probe mix. A fraction in `[0, 1]`, not a pair of counts, so the request is the
 * same at every sweep size; {@link probeCounts} turns it into counts per point.
 */
export interface ProbeMix {
  /** Fraction of the {@link PROBES_PER_POINT} probes that are stored keys (the rest are absent). */
  readonly presentFraction: number;
}

/** The calibrated default: 64 present + 64 absent. */
export const DEFAULT_PROBE_MIX: ProbeMix = { presentFraction: DEFAULT_PRESENT_FRACTION };

/**
 * The mixes the UI offers. Discrete on purpose: each one is a workload a reader can name
 * ("hits only", "misses only"), and five points are enough to see a constant move without
 * inviting the belief that the mix can change a class (it cannot — METHODOLOGY §4.9).
 */
export const PROBE_MIX_CHOICES: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

/** How many present and absent probes one sweep point gets. */
export interface ProbeCounts {
  readonly present: number;
  readonly absent: number;
}

/** Clamp a requested fraction into `[0, 1]`; anything non-finite reads as the default. */
export function clampFraction(f: number): number {
  if (!Number.isFinite(f)) return DEFAULT_PRESENT_FRACTION;
  return Math.min(1, Math.max(0, f));
}

/**
 * Probe counts for a structure holding `n` input keys at the given mix.
 *
 * The **present** half is capped at `n` — there are only `n` stored keys to spread over —
 * exactly as the fixed builder capped its 64. The **absent** half is never capped, so at
 * small `n` the realised mix leans absent (at n = 10 the default is 10 present + 64 absent).
 * That is today's behaviour, kept rather than "fixed", because the default must not move.
 *
 * The one guard added: a present-only mix on an empty prefix would leave no probes at all
 * (and an op-count of 0 / 0), so it falls back to a single absent probe.
 */
export function probeCounts(n: number, mix: ProbeMix = DEFAULT_PROBE_MIX): ProbeCounts {
  const target = Math.round(PROBES_PER_POINT * clampFraction(mix.presentFraction));
  const present = Math.min(target, Math.max(0, n));
  const absent = PROBES_PER_POINT - target;
  if (present + absent === 0) return { present: 0, absent: 1 };
  return { present, absent };
}

/**
 * What a run's mix *was*, for provenance (captions, exports, `window.__compareMeta`): the
 * requested fraction plus the counts it produced at the top of the sweep, `atN`. The counts
 * are reported rather than implied because at small `n` the present half is capped
 * ({@link probeCounts}), so the fraction alone does not say what was measured there.
 */
export interface ProbeMixSummary {
  readonly presentFraction: number;
  readonly present: number;
  readonly absent: number;
  readonly atN: number;
}

/** Summarise `mix` at sweep size `atN` (normally the largest size the search swept). */
export function summarizeMix(mix: ProbeMix, atN: number): ProbeMixSummary {
  return { presentFraction: clampFraction(mix.presentFraction), ...probeCounts(atN, mix), atN };
}

/** "50% present / 50% absent (64 + 64 probes per point)" — the one-line provenance form. */
export function describeMix(s: ProbeMixSummary): string {
  const pct = Math.round(s.presentFraction * 100);
  return (
    `search probes: ${pct}% present / ${100 - pct}% absent ` +
    `(${s.present} + ${s.absent} per point at n = ${s.atN.toLocaleString('en-US')}` +
    `${s.presentFraction === DEFAULT_PRESENT_FRACTION ? ', the calibrated default' : ''})`
  );
}

/**
 * `count` keys spread evenly through the first `n` — `keys[⌊i·n / count⌋]` — the fixed
 * builder's present-probe formula, unchanged. Every result is a real stored key.
 */
export function spreadOf<T>(keys: ArrayLike<T>, n: number, count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(keys[Math.floor((i * n) / count)]);
  return out;
}

/**
 * The **numeric** probe workload for size `n`: a spread of present keys, then a block
 * guaranteed absent just past the maximum (`max + 1 … max + absent`). Untimed setup.
 *
 * The absent construction is deliberately the one the gate was calibrated on, not a new
 * one: above-max misses are the skip list's *cheapest* query (it runs off the end of every
 * lane, paying nothing for the null) and one of the sorted array's dearest, so raising the
 * absent share widens that known gap between the two lines without tilting either
 * (METHODOLOGY §4 hurdle 9). Mid-range absent keys would be a different workload with its
 * own calibration — a follow-up, not a default.
 */
export function buildNumericProbes(
  keys: Float64Array,
  n: number,
  mix: ProbeMix = DEFAULT_PROBE_MIX,
): Float64Array {
  const { present, absent } = probeCounts(n, mix);
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];
  if (!Number.isFinite(max)) max = 0; // n === 0 guard
  const probes = new Float64Array(present + absent);
  for (let i = 0; i < present; i++) {
    probes[i] = keys[Math.floor((i * n) / present)];
  }
  for (let i = 0; i < absent; i++) {
    probes[present + i] = max + 1 + i;
  }
  return probes;
}

/**
 * The **seeds** the string absent probes are derived from: `min(absent, n)` stored keys
 * spread evenly through the prefix, each absent probe taking seed `i mod seeds.length`.
 *
 * Not "the present block, cycled" — which is what the fixed builder did, and which agrees
 * with this rule *only* at the default (64 present, 64 absent, so the two spreads coincide;
 * pinned by the byte-identical test). At any other mix the old rule breaks the
 * derived-from-the-data constraint (CLAUDE.md): a misses-only run would have no present keys
 * to seed from and fall back to invented one-character strings, and a hits-heavy run would
 * seed every miss from the first third of the data. Spreading the seeds by the absent count
 * gives every absent probe its own stored key whenever the prefix has enough of them.
 */
export function absentSeedsOf(keys: readonly string[], absent: number): string[] {
  const n = keys.length;
  return spreadOf(keys, n, Math.min(absent, n));
}
