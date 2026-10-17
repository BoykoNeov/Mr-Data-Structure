import type { SweepPoint } from '../bench/measure';
import { REGISTRY } from '../registry';
import type { SeriesView } from './SweepChart';

/**
 * **Stored size next to input size** (docs/PLAN.md §13; docs/METHODOLOGY.md §4 hurdle 8).
 *
 * Every chart's x-axis is `n`, the number of **input** keys in the prefix a point was built
 * from — and that stays the axis. A structure that de-duplicates (the hash sets, the trie)
 * holds fewer keys than that on data with repeats: on the default uniform dataset, whose
 * integers are drawn *with replacement* from `[0, n]`, the hash set at the top of the search
 * sweep holds only about 63 % of its input. The curve is still honest for that structure —
 * it is the cost of answering a query after being handed `n` keys — but a reader who takes
 * "n" to mean "keys stored" would misread where on the axis the structure really sits.
 *
 * So the stored count is *measured*, not declared: the worker reads each built structure's
 * own `len()` (`SweepPoint.storedN`), which means a structure added later reports it with no
 * registry flag to forget. These helpers decide where it is worth saying and how to say it;
 * the chart, the CSV/JSON export and the PNG caption all go through them.
 */

/** A point at which the structure held fewer keys than it was given. */
export interface DedupedPoint {
  readonly n: number;
  readonly storedN: number;
}

/** True when this point's structure holds fewer keys than its input size. */
export function isDeduped(p: SweepPoint): p is SweepPoint & { storedN: number } {
  return p.storedN !== undefined && p.storedN < p.n;
}

/**
 * The **largest-n** point of `v` at which the structure held fewer keys than its input, or
 * `null` when it held every key at every point (every multiset; any structure on distinct
 * data) or when the series carries no stored counts at all (the finite-difference halves).
 */
export function topDedupedPoint(v: SeriesView): DedupedPoint | null {
  let best: DedupedPoint | null = null;
  for (const p of v.series.points) {
    if (isDeduped(p) && (best === null || p.n > best.n)) best = { n: p.n, storedN: p.storedN };
  }
  return best;
}

const fmt = (x: number) => x.toLocaleString('en-US');

/** `63%` — the stored share, rounded, never shown as 100% while keys were actually dropped. */
export function storedShare(d: DedupedPoint): string {
  const pct = Math.round((100 * d.storedN) / d.n);
  return `${Math.min(pct, 99)}%`;
}

/**
 * The hover read-out for one point of a de-duplicating series: the y value, plus how many
 * keys the structure held there when that differs from `n`. `null` y ⇒ uPlot's own `--`.
 */
export function legendValue(y: number | null, p: SweepPoint | undefined): string {
  if (y === null || !Number.isFinite(y)) return '--';
  const base = Number(y.toPrecision(4)).toString();
  return p && isDeduped(p) ? `${base} (holds ${fmt(p.storedN)} of ${fmt(p.n)})` : base;
}

/**
 * One sentence per de-duplicating structure across `views`, naming the stored count at the
 * largest input size where it differs. Structures appear once even when several of their
 * series (search, churn) are passed; the largest-n reading wins. Empty when nothing on the
 * chart drops a key — which is the common case, and then nothing is said.
 */
export function storedSizeNotes(views: readonly SeriesView[]): string[] {
  const byStructure = new Map<string, DedupedPoint>();
  for (const v of views) {
    const d = topDedupedPoint(v);
    if (!d) continue;
    const prev = byStructure.get(v.series.structure);
    if (!prev || d.n > prev.n) byStructure.set(v.series.structure, d);
  }
  return [...byStructure.entries()].map(([id, d]) => {
    const label = REGISTRY[id as keyof typeof REGISTRY]?.label ?? id;
    return (
      `The ${label} keeps one copy of each repeated key: at n = ${fmt(d.n)} input keys it holds ` +
      `${fmt(d.storedN)} (${storedShare(d)}). The x-axis counts input keys, not stored ones.`
    );
  });
}
