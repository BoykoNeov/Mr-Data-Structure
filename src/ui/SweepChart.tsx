import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SweepPoint, SweepSeries } from '../bench/measure';
import { CLASS_BASIS, type FitResult } from '../bench/fit';
import { REGISTRY, theoreticalClass, type InputShape } from '../registry';

/**
 * One overlaid line on the sweep chart: a measured series plus its fitted
 * complexity class (shown in the legend next to the structure name, §7.2).
 */
export interface SeriesView {
  readonly series: SweepSeries;
  readonly fit: FitResult;
  readonly color: string;
}

/** Which signal to plot: measured wall-clock, or the deterministic op-count (§7.1 toggle). */
export type Signal = 'nanos' | 'opcount';

interface SweepChartProps {
  readonly views: readonly SeriesView[];
  readonly signal: Signal;
  /**
   * Overlay each series' *theoretical* class (from the registry, §7.1) as a
   * dashed reference curve, least-squares scaled onto the measured points so
   * only the *shape* is compared. Divergence — the measured line peeling away
   * from its dashed twin — is the honest signal §7.2 asks for.
   */
  readonly showTheory?: boolean;
  /** Input order of the dataset, so a shape-sensitive structure overlays its worst case. */
  readonly shape?: InputShape;
  /** Draw the per-point rep spread (min→max across timed reps) as error bars (§6.5). */
  readonly showSpread?: boolean;
}

const yValue = (signal: Signal) => (p: SweepPoint) =>
  signal === 'nanos' ? p.nanosPerOp : p.opCount;

/** Least-squares scale `a` in `y ≈ a·f(n)` (through the origin) — shape only, no magnitude claim. */
function scaleOnto(ns: readonly number[], ys: readonly number[], f: (n: number) => number): number {
  let fy = 0;
  let ff = 0;
  for (let i = 0; i < ns.length; i++) {
    fy += f(ns[i]) * ys[i];
    ff += f(ns[i]) * f(ns[i]);
  }
  return ff > 0 ? fy / ff : 0;
}

/** Chart width from the host element, bounded so the axes stay legible. */
function widthOf(host: HTMLElement): number {
  return Math.max(320, Math.min(760, host.clientWidth || 760));
}

/** Legend text: structure label, op, fitted class, and the slope with its uncertainty. */
export function seriesLabel(v: SeriesView): string {
  const name = REGISTRY[v.series.structure]?.label ?? v.series.structure;
  const se = v.fit.slopeStderr > 0 ? ` ± ${v.fit.slopeStderr.toFixed(2)}` : '';
  return `${name} ${v.series.op} — ${v.fit.best} (slope ${v.fit.logLogSlope.toFixed(2)}${se})`;
}

/**
 * Comparison chart (docs/PLAN.md §7.1): per-op cost vs `n` for each structure,
 * overlaid on **log-log** axes (the default for reading complexity — a straight
 * line whose slope is the exponent). Each series is labelled with its operation
 * (search / churn / insert / delete) so the same chart serves every sweep.
 *
 * Two honesty layers sit on top of the raw lines (§2.3, §6.5, §7.2):
 * - **error bars** — the min→max spread of the timed reps at each point, drawn
 *   through a canvas hook (uPlot has no native error bars). Op-counts are
 *   deterministic, so the bars only appear on the wall-clock signal;
 * - **theoretical overlay** — a dashed curve in the same hue with the
 *   registry's textbook class, scaled onto the data. Same shape ⇒ the twin hugs
 *   the line; a different shape ⇒ it peels away, and the divergence is the story.
 *
 * uPlot is imperative, so the chart is (re)built whenever the data or options
 * change, torn down on unmount, and resized with the window.
 */
export function SweepChart({ views, signal, showTheory = true, shape = 'random', showSpread = true }: SweepChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || views.length === 0) return;

    const sizes = views[0].series.points.map((p) => p.n);
    const pick = yValue(signal);
    const measured = views.map((v) => v.series.points.map(pick));

    const theory = showTheory
      ? views.map((v, i) => {
          const cls = theoreticalClass(v.series.structure, v.series.op, shape);
          const f = CLASS_BASIS[cls];
          const a = scaleOnto(sizes, measured[i], f);
          return { cls, ys: sizes.map((n) => a * f(n)) };
        })
      : [];

    const data: uPlot.AlignedData = [sizes, ...measured, ...theory.map((t) => t.ys)];

    const drawSpread = (u: uPlot) => {
      if (!showSpread || signal !== 'nanos') return;
      const ctx = u.ctx;
      ctx.save();
      const cap = 4 * devicePixelRatio;
      views.forEach((v, vi) => {
        ctx.strokeStyle = v.color;
        ctx.lineWidth = 1 * devicePixelRatio;
        ctx.globalAlpha = 0.8;
        v.series.points.forEach((p, pi) => {
          if (!(p.minNanos > 0 && p.maxNanos > 0) || p.maxNanos === p.minNanos) return;
          // Guard against a hidden series (legend click) and out-of-view points.
          if (!u.series[vi + 1].show) return;
          const x = u.valToPos(sizes[pi], 'x', true);
          const y0 = u.valToPos(p.minNanos, 'y', true);
          const y1 = u.valToPos(p.maxNanos, 'y', true);
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
          ctx.moveTo(x - cap, y0);
          ctx.lineTo(x + cap, y0);
          ctx.moveTo(x - cap, y1);
          ctx.lineTo(x + cap, y1);
          ctx.stroke();
        });
      });
      ctx.restore();
    };

    const opts: uPlot.Options = {
      title: signal === 'nanos' ? 'cost — ns / op (median of reps; bars = min→max)' : 'cost — operations / op',
      width: widthOf(host),
      height: 440,
      scales: { x: { distr: 3 }, y: { distr: 3 } }, // 3 = logarithmic
      axes: [
        { label: 'n (size)' },
        { label: signal === 'nanos' ? 'ns / op' : 'ops / op' },
      ],
      series: [
        { label: 'n' },
        ...views.map((v) => ({
          label: seriesLabel(v),
          stroke: v.color,
          width: 2,
          points: { show: true, size: 6 },
        })),
        ...theory.map((t, i) => ({
          label: `${REGISTRY[views[i].series.structure]?.label ?? views[i].series.structure} — theory ${t.cls}`,
          stroke: views[i].color,
          width: 1,
          dash: [6, 4],
          points: { show: false },
        })),
      ],
      hooks: { draw: [drawSpread] },
    };

    const plot = new uPlot(opts, data, host);
    const onResize = () => plot.setSize({ width: widthOf(host), height: 440 });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.destroy();
    };
  }, [views, signal, showTheory, shape, showSpread]);

  return <div ref={hostRef} />;
}
