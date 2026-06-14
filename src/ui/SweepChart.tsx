import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SweepSeries } from '../bench/measure';
import type { FitResult } from '../bench/fit';

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
}

const yValue = (signal: Signal) => (p: { nanosPerOp: number; opCount: number }) =>
  signal === 'nanos' ? p.nanosPerOp : p.opCount;

/**
 * Comparison chart (docs/PLAN.md §7.1): per-op search cost vs `n` for each
 * structure, overlaid on **log-log** axes (the default for reading complexity —
 * a straight line whose slope is the exponent). uPlot is imperative, so the
 * chart is (re)built whenever the data or signal changes and torn down on
 * unmount.
 */
export function SweepChart({ views, signal }: SweepChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || views.length === 0) return;

    const sizes = views[0].series.points.map((p) => p.n);
    const pick = yValue(signal);
    const data: uPlot.AlignedData = [
      sizes,
      ...views.map((v) => v.series.points.map(pick)),
    ];

    const opts: uPlot.Options = {
      title: signal === 'nanos' ? 'search cost — ns / op' : 'search cost — operations / op',
      width: 760,
      height: 440,
      scales: { x: { distr: 3 }, y: { distr: 3 } }, // 3 = logarithmic
      axes: [
        { label: 'n (size)' },
        { label: signal === 'nanos' ? 'ns / op' : 'ops / op' },
      ],
      series: [
        { label: 'n' },
        ...views.map((v) => ({
          label: `${v.series.structure} search — ${v.fit.best} (slope ${v.fit.logLogSlope.toFixed(2)})`,
          stroke: v.color,
          width: 2,
          points: { show: true, size: 6 },
        })),
      ],
    };

    const plot = new uPlot(opts, data, host);
    return () => plot.destroy();
  }, [views, signal]);

  return <div ref={hostRef} />;
}
