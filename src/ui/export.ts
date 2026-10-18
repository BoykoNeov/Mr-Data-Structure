import type { SeriesView } from './SweepChart';
import { STORED_CSV_COLUMNS, storedCsvCells, storedJsonFields } from './storedAxis';

/**
 * Result export (docs/PLAN.md §7.1): the measured sweep as CSV / JSON, so a
 * result can leave the page — into a spreadsheet, a notebook, or a bug report.
 * Pure string builders; the download itself is a two-line Blob in the UI.
 * Every row carries the *provenance* a reader needs to trust it: the size, the
 * median with its spread, the batch and rep counts (§6.5 — the methodology is
 * inspectable), and the deterministic op-count beside the wall-clock.
 */

/**
 * `n` is the number of **input** keys a point was built from; `stored_n` is how many the
 * structure actually held (its own `len()`), smaller only for a de-duplicating structure on
 * data with repeats, and empty where the series has no built instance (the
 * finite-difference halves). Appended last so existing column positions do not move
 * (docs/METHODOLOGY.md §4 hurdle 8).
 */
export const CSV_HEADER =
  'structure,op,n,nanos_per_op,min_nanos,max_nanos,stddev_nanos,op_count,batch,reps,stored_n';

/**
 * While the stored-n x-axis is selected (./storedAxis) every row gains two trailing cells,
 * `x_axis,x`: which size that row was plotted and fitted at (`stored_n`, or `n` for a series
 * with no stored count) and its value. On the default axis the file is unchanged.
 */
export function toCsv(views: readonly SeriesView[]): string {
  const stored = views.some((v) => v.x);
  const rows = [stored ? CSV_HEADER + STORED_CSV_COLUMNS : CSV_HEADER];
  for (const v of views) {
    for (const [i, p] of v.series.points.entries()) {
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
          p.storedN ?? '',
          ...(stored ? storedCsvCells(v, i) : []),
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
        // Stored-n axis only: the x values, and the input-n fit beside the stored-n `fit`.
        ...storedJsonFields(v),
      })),
    },
    null,
    2,
  );
}

/** Trigger a browser download of `text` as `filename` (no-op outside a DOM). */
export function download(filename: string, text: string, type: string): void {
  if (typeof document === 'undefined') return;
  downloadBlob(filename, new Blob([text], { type }));
}

/**
 * Trigger a browser download of an already-built {@link Blob} — the binary path, for the
 * PNG sheet (`./png`), which has no text form to hand to {@link download}.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
