import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { REGISTRY } from '../registry';
import type { SeriesView } from './SweepChart';
import { axisOf, axisTag, SLOPE_X_LABEL, storedSlopeLayout } from './storedAxis';

interface SlopeChartProps {
  readonly views: readonly SeriesView[];
}

/** Chart width from the host element, bounded so the axes stay legible. */
function widthOf(host: HTMLElement): number {
  return Math.max(320, Math.min(760, host.clientWidth || 760));
}

/**
 * The local-slope panel (docs/METHODOLOGY.md §3): for each series, the
 * empirical exponent `Δln(cost) / Δln(n)` on every interval between consecutive
 * sweep points, plotted against n (log x, *linear* y). A clean power law is a
 * horizontal line at its exponent; the dotted guides mark O(1) (0), O(n) (1)
 * and O(n²) (2). A logarithm slopes *down* toward 0; a fixed overhead hiding a
 * growth term slopes *up* toward the true exponent; a cache cliff is a bump.
 * This is what the overall slope in the legend averages away — the sweep's
 * regime structure, made visible.
 */
export function SlopeChart({ views }: SlopeChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || views.length === 0) return;
    const withSlopes = views.filter((v) => v.fit.localNs.length > 0);
    if (withSlopes.length === 0) return;

    // Every series in one chart shares the interval midpoints (same sweep sizes) — except on
    // the stored-n axis (./storedAxis), where each line's midpoints are its own stored sizes.
    const stored = axisOf(withSlopes) === 'stored' ? storedSlopeLayout(withSlopes) : null;
    const xs = stored ? stored.xs.slice() : withSlopes[0].fit.localNs.slice();
    const ys: (number | null)[][] = stored
      ? stored.ys.map((r) => r.slice())
      : withSlopes.map((v) => v.fit.localSlopes.slice());
    const guides = [0, 1, 2].map((g) => xs.map(() => g));

    const all = ys.flat().filter((y): y is number => y !== null);
    const lo = Math.min(-0.25, ...all) - 0.1;
    const hi = Math.max(2.1, ...all) + 0.1;

    const opts: uPlot.Options = {
      title: 'local log-log slope — the empirical exponent on each interval',
      width: widthOf(host),
      height: 260,
      // `time: false` for the same reason as SweepChart: without it uPlot renders the size
      // axis as dates, because its default x series is a UNIX timestamp.
      scales: { x: { distr: 3, time: false }, y: { range: [lo, hi] } },
      axes: [
        { label: stored ? SLOPE_X_LABEL.stored : 'n (interval midpoint)' },
        { label: stored ? 'Δln(cost) / Δln(stored n)' : 'Δln(cost) / Δln(n)' },
      ],
      series: [
        { label: 'n' },
        ...withSlopes.map((v) => ({
          label: `${REGISTRY[v.series.structure]?.label ?? v.series.structure} ${v.series.op}${axisTag(v)} (${v.fit.trend})`,
          stroke: v.color,
          width: 2,
          points: { show: true, size: 5 },
          ...(stored ? { spanGaps: true } : {}),
        })),
        ...['O(1)', 'O(n)', 'O(n²)'].map((label) => ({
          label,
          stroke: '#999',
          width: 1,
          dash: [2, 4],
          points: { show: false },
        })),
      ],
    };

    const plot = new uPlot(opts, [xs, ...ys, ...guides], host);
    const onResize = () => plot.setSize({ width: widthOf(host), height: 260 });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.destroy();
    };
  }, [views]);

  return <div ref={hostRef} />;
}
