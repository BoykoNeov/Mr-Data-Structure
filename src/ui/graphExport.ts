import type { GraphCompareResult, GraphSeriesView, GraphSweepResult } from '../compare/runGraphSweeps';
import { GRAPH } from '../registry';
import type { Signal } from './SweepChart';

/**
 * The graph section's exports (docs/PLAN.md §7.1, §10 Phase 6; docs/METHODOLOGY.md §2.7) —
 * CSV / JSON / PNG caption, the graph's counterpart of `./export` and the key runs' sheet
 * notes. Its own builders rather than rows in `toCsv`: a graph point has no `n` of keys, no
 * stored size and no rehash threshold, and it has five columns a key row has not (which
 * graph, how much of it was reached). Folding the two into one file would put two different
 * x-axes under one header. Pure string builders, so every caveat is a unit test.
 */

/**
 * One row per (sweep, traversal, point). `x` is the reached component's `V′ + 2E′` — the
 * x-coordinate every graph chart and fit reads — beside the nominal `vertices` / `edges` of
 * the graph that point measured, so a reader can see a partial reach without the page.
 */
export const GRAPH_CSV_HEADER =
  'sweep,traversal,vertices,edges,avg_degree,reached_vertices,reached_edges,x,' +
  'nanos_per_traversal,min_nanos,max_nanos,stddev_nanos,op_count,batch,reps';

const sweepsOf = (r: GraphCompareResult): readonly GraphSweepResult[] => [r.vertexSweep, r.degreeSweep];

/** CSV export of both sweeps, both traversals. */
export function graphToCsv(result: GraphCompareResult): string {
  const rows = [GRAPH_CSV_HEADER];
  for (const s of sweepsOf(result)) {
    for (const v of [s.bfs, s.dfs]) {
      for (const p of v.series.points) {
        rows.push(
          [
            s.sweep,
            v.series.traversal,
            p.vertices,
            p.edges,
            p.degree,
            p.reachedVertices,
            p.reachedEdges,
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
  }
  return rows.join('\n') + '\n';
}

function fitOf(v: GraphSeriesView) {
  return {
    best: v.fit.best,
    r2: v.fit.r2,
    logLogSlope: v.fit.logLogSlope,
    slopeStderr: v.fit.slopeStderr,
    slopeCi: v.fit.slopeCi,
    tailSlope: v.fit.tailSlope,
    trend: v.fit.trend,
    localNs: v.fit.localNs,
    localSlopes: v.fit.localSlopes,
  };
}

/**
 * JSON export: per sweep, what was measured, the three identity checks the page prints, and
 * each traversal's fit (on the `views`' signal) beside its points. `views` are the on-screen
 * fits — the result's own are always wall-clock (`toGraphView`'s default).
 */
export function graphToJson(
  result: GraphCompareResult,
  views: { readonly vertices: readonly GraphSeriesView[]; readonly degree: readonly GraphSeriesView[] },
  meta: Record<string, unknown> = {},
): string {
  const sweep = (s: GraphSweepResult, vs: readonly GraphSeriesView[]) => ({
    sweep: s.sweep,
    description: s.description,
    synthetic: s.synthetic,
    countsMatchComponent: s.countsMatchComponent,
    bfsEqualsDfs: s.bfsEqualsDfs,
    allReached: s.allReached,
    traversals: vs.map((v) => ({ traversal: v.series.traversal, fit: fitOf(v), points: v.series.points })),
  });
  return JSON.stringify(
    {
      ...meta,
      exportedAt: new Date().toISOString(),
      x: "V′ + 2E′ — vertices + 2 × edges in vertex 0's connected component (points[].n)",
      theory: GRAPH.ops.traversal,
      vertexSweep: sweep(result.vertexSweep, views.vertices),
      degreeSweep: sweep(result.degreeSweep, views.degree),
    },
    null,
    2,
  );
}

/** The two identity checks of one sweep, as one caption line. */
function checksLine(label: string, s: GraphSweepResult): string {
  return (
    `${label}: ${s.description}. ` +
    `Counted work = V′ + 2E′ at every point: ${s.countsMatchComponent ? 'yes, exactly' : 'NO — treat this run as suspect'}; ` +
    `BFS and DFS the same work: ${s.bfsEqualsDfs ? 'yes, at every point' : 'NO'}.` +
    (s.allReached
      ? ''
      : ' Not every vertex was reached: each point is plotted at the size of vertex 0’s component, not of the whole graph.')
  );
}

/**
 * The PNG sheet's caption for the graph section, provenance first. The **memory caveat** is
 * always on it (docs/PLAN.md §10 Phase 6): the V-sweep's wall-clock slope can sit well above 1
 * and be labelled n log n, and on the page the box saying "that is memory, not the walk" does
 * not travel with an exported image — so the sentence has to.
 */
export function graphSheetCaption(
  result: GraphCompareResult,
  opts: { readonly signal: Signal; readonly version: string; readonly when?: Date },
): string[] {
  const when = (opts.when ?? new Date()).toISOString();
  const lines = [
    `Mr Data Structure — graph traversals (BFS and DFS, ${GRAPH.ops.traversal})`,
    `signal: ${opts.signal === 'nanos' ? 'wall-clock ns per traversal (this machine)' : 'op-count (hardware-free)'}` +
      ` · engine: ${opts.version || '—'} · ${when}`,
    'x-axis: V′ + 2E′ — the vertices plus twice the edges reached from vertex 0, not the size of the whole graph.',
    checksLine('Experiment 1 (more points)', result.vertexSweep) +
      (result.vertexSweep.synthetic ? ' Generated graphs, not your data.' : ' Your data.'),
    checksLine('Experiment 2 (same points, more links)', result.degreeSweep) + ' Generated graphs.',
    'Experiment 1 alone cannot show the + E: its links grow in step with its points. Experiment 2 holds the points ' +
      'fixed, so its rise is the links’ cost.',
    'Memory caveat: the counted work is exactly linear, but in experiment 1 the graph outgrows the processor’s caches, ' +
      'so each visit gets slower as it grows and the wall-clock slope can sit well above 1. A fitted n log n there is ' +
      'the fitter reacting to memory, not a claim about the walk — read the op-count signal (METHODOLOGY §2.7).',
  ];
  if (opts.signal === 'nanos') {
    lines.push(
      'Wall-clock costs are specific to this machine and this run — compare the shapes, not the absolute nanoseconds.',
    );
  }
  return lines;
}
