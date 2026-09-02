import type { SeriesView } from './SweepChart';

/**
 * Result export (docs/PLAN.md §7.1): the measured sweep as CSV / JSON, so a
 * result can leave the page — into a spreadsheet, a notebook, or a bug report.
 * Pure string builders; the download itself is a two-line Blob in the UI.
 * Every row carries the *provenance* a reader needs to trust it: the size, the
 * median with its spread, the batch and rep counts (§6.5 — the methodology is
 * inspectable), and the deterministic op-count beside the wall-clock.
 */

export const CSV_HEADER =
  'structure,op,n,nanos_per_op,min_nanos,max_nanos,stddev_nanos,op_count,batch,reps';

export function toCsv(views: readonly SeriesView[]): string {
  const rows = [CSV_HEADER];
  for (const v of views) {
    for (const p of v.series.points) {
      rows.push(
        [
          v.series.structure,
          v.series.op,
          p.n,
          p.nanosPerOp,
          p.minNanos,
          p.maxNanos,
          p.stddevNanos,
          p.opCount,
          p.batch,
          p.reps,
        ].join(','),
      );
    }
  }
  return rows.join('\n') + '\n';
}

/** JSON export: the raw series plus each fit (class, slope ± stderr, CI, local slopes). */
export function toJson(views: readonly SeriesView[], meta: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      ...meta,
      exportedAt: new Date().toISOString(),
      series: views.map((v) => ({
        structure: v.series.structure,
        op: v.series.op,
        fit: {
          best: v.fit.best,
          r2: v.fit.r2,
          logLogSlope: v.fit.logLogSlope,
          slopeStderr: v.fit.slopeStderr,
          slopeCi: v.fit.slopeCi,
          tailSlope: v.fit.tailSlope,
          trend: v.fit.trend,
          localNs: v.fit.localNs,
          localSlopes: v.fit.localSlopes,
        },
        points: v.series.points,
      })),
    },
    null,
    2,
  );
}

/** Trigger a browser download of `text` as `filename` (no-op outside a DOM). */
export function download(filename: string, text: string, type: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
