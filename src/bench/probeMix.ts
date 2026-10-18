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
 * by either builder in the default miss form, at any mix, so "the same seed consumption"
 * holds trivially: the probe set is a pure function of the stored prefix and the mix. The
 * opt-in mid-range form ({@link midRangeAbsent}) shuffles its block with a *fixed* seed, so
 * it is a pure function of the same two inputs.
 *
 * **Every structure gets the same probe set at a given mix** — the shared-probes rule
 * (CLAUDE.md, the trie entry). The mix is one value for the whole run, threaded to every
 * search runner, and never chosen per structure: a chart on which each line got the mix
 * that suits it would stop being a comparison.
 */

import { mulberry32 } from '../data/rng';

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
  /**
   * Where the **numeric** absent probes sit ({@link MissForm}). Optional, and absent means
   * `'aboveMax'`: every mix built before the field existed — a persisted session, an old
   * export, the mount-time auto-run — names the form it always measured. String probes
   * ignore it (they are derived from stored keys either way, `./stringWorkload`).
   */
  readonly missForm?: MissForm;
}

/**
 * The two forms of numeric absent probe (docs/PLAN.md §13 probe-mix item (a);
 * docs/METHODOLOGY.md §4 hurdles 9 and 15):
 * - `'aboveMax'` — `max + 1 … max + a`, the calibrated default. Cheap for the skip list (it
 *   runs off the end of every lane) and, on a reverse-sorted BST, a one-node walk of the
 *   right spine;
 * - `'midRange'` — keys strictly *between* adjacent stored keys ({@link midRangeAbsent}), the
 *   textbook unsuccessful search: every comparison structure has to descend to the gap where
 *   the key would sit to rule it out. Opt-in; no gate band was calibrated on it.
 */
export type MissForm = 'aboveMax' | 'midRange';

/** The calibrated default miss form. */
export const DEFAULT_MISS_FORM: MissForm = 'aboveMax';

/** The miss forms the UI offers, default first. */
export const MISS_FORM_CHOICES: readonly MissForm[] = ['aboveMax', 'midRange'];

/** The miss form a mix asks for, reading a missing field as the default. */
export function missFormOf(mix: ProbeMix): MissForm {
  return mix.missForm === 'midRange' ? 'midRange' : DEFAULT_MISS_FORM;
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
  /**
   * Present **only** for the opt-in mid-range form. Leaving it out at the default keeps the
   * summary — and so `__compareMeta`, the JSON export and every caption — byte-identical to
   * the runs made before the form existed, and lets a reader treat "no field" as `max + 1 …`,
   * which is what those older runs measured.
   */
  readonly missForm?: 'midRange';
}

/** Summarise `mix` at sweep size `atN` (normally the largest size the search swept). */
export function summarizeMix(mix: ProbeMix, atN: number): ProbeMixSummary {
  return {
    presentFraction: clampFraction(mix.presentFraction),
    ...probeCounts(atN, mix),
    atN,
    ...(missFormOf(mix) === 'midRange' ? { missForm: 'midRange' as const } : {}),
  };
}

/** "50% present / 50% absent (64 + 64 probes per point)" — the one-line provenance form. */
export function describeMix(s: ProbeMixSummary): string {
  const pct = Math.round(s.presentFraction * 100);
  return (
    `search probes: ${pct}% present / ${100 - pct}% absent ` +
    `(${s.present} + ${s.absent} per point at n = ${s.atN.toLocaleString('en-US')}` +
    // A 50/50 mid-range run is not the calibrated workload, so it does not get the label.
    `${s.presentFraction === DEFAULT_PRESENT_FRACTION && s.missForm !== 'midRange' ? ', the calibrated default' : ''})` +
    // Appended, never inserted: the default line stays exactly what it was.
    (s.missForm === 'midRange' ? '; misses fall between stored keys (mid-range), not past the largest' : '')
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
 * (METHODOLOGY §4 hurdle 9). Mid-range absent keys are a different workload with no
 * calibration of their own, so they are opt-in: `mix.missForm === 'midRange'` swaps the
 * absent block for {@link midRangeAbsent}'s, same count, and leaves the present block alone.
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
  if (missFormOf(mix) === 'midRange') {
    probes.set(midRangeAbsent(keys, n, absent, max), present);
    return probes;
  }
  for (let i = 0; i < absent; i++) {
    probes[present + i] = max + 1 + i;
  }
  return probes;
}

/**
 * The fixed seed {@link midRangeAbsent} shuffles its block with. A constant, not a run
 * option: the order only has to be the same every time and unrelated to the key order.
 */
export const MID_RANGE_ORDER_SEED = 0x6d1d5eed;

/**
 * The **mid-range** absent block: `count` keys, each strictly between two *adjacent distinct*
 * stored keys of the prefix — the textbook unsuccessful search (Knuth's model counts each gap
 * between neighbouring keys as one equally likely place for a missing key to fall).
 *
 * The rule, every step a measurement decision:
 * - **Gaps, by rank.** Sort the first `n` keys (a copy — stored keys are never touched,
 *   reordered or de-duplicated in the structures), and take each pair of neighbours `a < b`,
 *   both finite, as one *interior gap*. Repeated keys give no gap; the two open ends (below
 *   the min, above the max) are not interior and are not used.
 * - **Spread over the gaps, not over the values.** Probe `i` goes to gap
 *   `⌊(2i + 1)·G / (2·count)⌋` of the `G` gaps — evenly by rank, centred, so the misses are
 *   spread through the key range the way the keys are, and a skewed (Zipfian, Gaussian)
 *   dataset does not pile them into its sparse tail. With `count ≤ G`, every probe has its
 *   own gap.
 * - **Halfway, or evenly inside.** The `c` probes a gap receives sit at
 *   `a + (b − a)·j/(c + 1)`, j = 1 … c — the midpoint when c = 1. On integer keys with no
 *   room between neighbours (a dense `0 … n − 1` permutation) that is a half-integer: keys
 *   are f64, so `k + 0.5` is a real key, and a fair one for every structure here — the
 *   comparison structures order it between `k` and `k + 1`, and the hash sets hash its bits
 *   like any other double, as they do `max + 1`.
 * - **Absent by construction.** Strictly between two neighbours of the sorted prefix, no
 *   stored key can equal it. A placement that rounds onto `a` or `b` (neighbours a few ulps
 *   apart) is dropped rather than kept.
 * - **Fallback, only when the data has no room.** A prefix with fewer than two distinct
 *   finite keys has no interior gap at all (n ≤ 1, or every key equal); any probe that could
 *   not be placed takes the default form's `max + 1 + k` instead, so the count is always
 *   `count` and every probe is still absent.
 * - **Shuffled, with a fixed seed.** The block comes out in rank order, so consecutive
 *   misses would walk nearly the same tree path and read cache-warm. A fixed-seed shuffle
 *   ({@link MID_RANGE_ORDER_SEED}) breaks that without making the set depend on anything
 *   but `(keys, n, count)`.
 *
 * Untimed setup: one O(n log n) sort per sweep point, paid only in this opt-in form.
 */
export function midRangeAbsent(keys: Float64Array, n: number, count: number, max: number): Float64Array {
  const out = new Float64Array(count);
  if (count <= 0) return out;
  const sorted = Float64Array.from(keys.subarray(0, Math.max(0, n))).sort();
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a < b && Number.isFinite(a) && Number.isFinite(b)) {
      lo.push(a);
      hi.push(b);
    }
  }
  const gaps = lo.length;
  const placed: boolean[] = new Array<boolean>(count).fill(false);
  if (gaps > 0) {
    const gapOf = (i: number) => Math.floor(((2 * i + 1) * gaps) / (2 * count));
    // gapOf is non-decreasing in i, so each gap's probes are one consecutive run.
    for (let start = 0; start < count; ) {
      const g = gapOf(start);
      let end = start;
      while (end < count && gapOf(end) === g) end++;
      const c = end - start;
      const a = lo[g];
      const b = hi[g];
      const width = b - a;
      let prev = a;
      for (let j = 1; j <= c; j++) {
        const t = j / (c + 1);
        // `b − a` can overflow for neighbours at opposite ends of the double range.
        const x = Number.isFinite(width) ? a + width * t : a * (1 - t) + b * t;
        if (x > prev && x < b) {
          out[start + j - 1] = x;
          placed[start + j - 1] = true;
          prev = x;
        }
      }
      start = end;
    }
  }
  let spare = 0;
  for (let i = 0; i < count; i++) if (!placed[i]) out[i] = max + 1 + spare++;
  // Fisher–Yates with a fixed seed: the order is fixed, and unrelated to rank.
  const rng = mulberry32(MID_RANGE_ORDER_SEED);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
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
