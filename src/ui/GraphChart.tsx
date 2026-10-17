import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { GraphComplexity } from '../registry';
import { GRAPH } from '../registry';
import type { GraphSeriesView, GraphSweepPoint } from '../compare/runGraphSweeps';
import type { Signal } from './SweepChart';

/**
 * The graph's cost chart (docs/PLAN.md §7.1; docs/METHODOLOGY.md §2.7). The same reading
 * rules as `SweepChart` — log-log axes, the rep spread as error bars, the textbook class as
 * a dashed twin scaled onto the points — with one difference that is the whole reason this is
 * its own component: the x-axis is **`V' + 2E'`**, the reached component's vertex-visits +
 * edge-visits, not a key count `n`. `SweepChart` is built around `n` and the key structures'
 * insert/search/delete theory, and the graph has neither.
 *
 * BFS is drawn solid and DFS dotted, in the graph's one registry hue: they are two operations
 * of one structure, and on the op-count signal the two lines lie exactly on top of each other
 * — same cost, different order, which is the point.
 */

interface GraphChartProps {
  readonly views: readonly GraphSeriesView[];
  readonly signal: Signal;
  readonly showTheory?: boolean;
  readonly showSpread?: boolean;
  /** Published as `data-chart`, like `SweepChart`'s, so the page can find the canvas. */
  readonly name?: string;
}

/** The textbook class as a function of the x-coordinate `V' + 2E'`. */
const THEORY_BASIS: Readonly<Record<GraphComplexity, (x: number) => number>> = {
  'O(1)': () => 1,
  // Linear in V + E, and so linear in V' + 2E': the two differ by a constant factor ≤ 2.
  'O(V + E)': (x) => x,
};

const yOf = (signal: Signal) => (p: GraphSweepPoint) => (signal === 'nanos' ? p.nanosPerOp : p.opCount);

function widthOf(host: HTMLElement): number {
  return Math.max(320, Math.min(760, host.clientWidth || 760));
}

/** Through-origin least-squares scale `a` in `y ≈ a·f(x)` — shape only, no magnitude claim. */
function scaleOnto(xs: readonly number[], ys: readonly number[], f: (x: number) => number): number {
  let fy = 0;
  let ff = 0;
  for (let i = 0; i < xs.length; i++) {
    fy += f(xs[i]) * ys[i];
    ff += f(xs[i]) * f(xs[i]);
  }
  return ff > 0 ? fy / ff : 0;
}

/** The fitter's class, restated in the graph's two size axes (its x is `V' + 2E'`). */
export function graphClassLabel(best: string): string {
  if (best === 'O(n)') return 'O(V + E)';
  if (best === 'O(1)') return 'O(1)';
  return `${best.replace(/n/g, 'X')} in X = V′+2E′`;
}

/** Legend text for one traversal: which one, its fitted class, and the slope ± stderr. */
export function graphSeriesLabel(v: GraphSeriesView): string {
  const se = v.fit.slopeStderr > 0 ? ` ± ${v.fit.slopeStderr.toFixed(2)}` : '';
  return `${v.series.traversal.toUpperCase()} — ${graphClassLabel(v.fit.best)} (slope ${v.fit.logLogSlope.toFixed(2)}${se})`;
}

export function GraphChart({ views, signal, showTheory = true, showSpread = true, name }: GraphChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || views.length === 0) return;

    // Every traversal of one sweep ran on the same graphs, so they share the x values. They
    // are non-decreasing even for an imported list's prefixes: adding edges can only grow
    // vertex 0's component, never shrink it.
    const xs = views[0].series.points.map((p) => p.n);
    const pick = yOf(signal);
    const measured = views.map((v) => v.series.points.map(pick));
    const f = THEORY_BASIS[GRAPH.ops.traversal];
    const theory = showTheory
      ? views.map((_, i) => {
          const a = scaleOnto(xs, measured[i], f);
          return xs.map((x) => a * f(x));
        })
      : [];

    const drawSpread = (u: uPlot) => {
      if (!showSpread || signal !== 'nanos') return;
      const ctx = u.ctx;
      ctx.save();
      const cap = 4 * devicePixelRatio;
      views.forEach((v, vi) => {
        if (!u.series[vi + 1].show) return;
        ctx.strokeStyle = v.color;
        ctx.lineWidth = 1 * devicePixelRatio;
        ctx.globalAlpha = 0.8;
        v.series.points.forEach((p, pi) => {
          if (!(p.minNanos > 0 && p.maxNanos > 0) || p.maxNanos === p.minNanos) return;
          const x = u.valToPos(xs[pi], 'x', true);
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
      title:
        signal === 'nanos'
          ? 'cost — ns per whole traversal (median of reps; bars = min→max)'
          : 'cost — vertex-visits + edge-visits per traversal',
      width: widthOf(host),
      height: 400,
      // `time: false`: uPlot otherwise renders the x values as UNIX timestamps.
      scales: { x: { distr: 3, time: false }, y: { distr: 3 } },
      axes: [
        { label: "V′ + 2E′ (vertices + 2 × edges reached from vertex 0)" },
        { label: signal === 'nanos' ? 'ns / traversal' : 'ops / traversal' },
      ],
      series: [
        { label: "V′+2E′" },
        ...views.map((v) => ({
          label: graphSeriesLabel(v),
          stroke: v.color,
          width: 2,
          dash: v.series.traversal === 'dfs' ? [2, 3] : undefined,
          points: { show: true, size: v.series.traversal === 'dfs' ? 8 : 5 },
        })),
        ...theory.map((_, i) => ({
          label: `${views[i].series.traversal.toUpperCase()} — theory ${GRAPH.ops.traversal}`,
          stroke: views[i].color,
          width: 1,
          dash: [8, 5],
          points: { show: false },
        })),
      ],
      hooks: { draw: [drawSpread] },
    };

    const plot = new uPlot(opts, [xs, ...measured, ...theory], host);
    const onResize = () => plot.setSize({ width: widthOf(host), height: 400 });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.destroy();
    };
  }, [views, signal, showTheory, showSpread]);

  return <div ref={hostRef} data-chart={name} />;
}
