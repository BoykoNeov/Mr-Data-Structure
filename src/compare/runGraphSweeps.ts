import type { BenchEngine } from '../bench/BenchEngine';
import { fitComplexity, type FitResult } from '../bench/fit';
import type { GraphTraversalMeasure } from '../bench/graphBench';
import type { MeasureOptions, SweepPoint } from '../bench/measure';
import { geometricSweep } from '../bench/sweep';
import { edgeListSize, edgePrefix, type EdgeList } from '../data/edgeList';
import {
  edgeCount,
  generateConnectedRandom,
  generateGridNear,
  generatePath,
  type GraphData,
} from '../data/graphs';
import { GRAPH } from '../registry';
import { GraphAdj } from '../structures/graph';
import type { Signal } from '../ui/SweepChart';
import type { SweepProof } from './runSweeps';

/**
 * The graph's Compare pipeline (docs/PLAN.md §8 "Specialized", §10 Phase 6;
 * docs/METHODOLOGY.md §2.7) — pure orchestration over the engine boundary, like
 * `runSweeps.ts`, and tested the same way: with a fake engine and no clock.
 *
 * **Why two sweeps.** A traversal costs `V + 2E`, a function of *two* sizes. Growing `V` at a
 * fixed average degree `d` makes `E = dV/2`, so the cost is `(1 + d)V` — a straight line from
 * which the `+E` term cannot be read, because both terms grow together. So:
 *
 * - the **V-sweep** grows the graph at a fixed degree (or, for an imported list, takes ever
 *   longer prefixes of it) — it shows both traversals are linear and that BFS ≡ DFS in class;
 * - the **degree-sweep** holds `V` fixed and adds edges to *the same* graph — an `O(V)`
 *   algorithm would draw a flat line here, and the measured one rises: the `+E` made visible.
 *
 * **The x-axis is the reached component's `V' + 2E'`, never `n` and never the nominal size**
 * (PLAN §10 trap 4). A traversal from vertex 0 visits only 0's connected component, and a
 * user's graph — or a prefix of one — can be disconnected; plotting against the file's `V + E`
 * would put a traversal that touched 3 vertices at the x of 3,000. The orchestrator computes
 * `V'` and `E'` itself, from the edges, and then **checks** the engine's op-count against
 * them, so the identity "op-count = `V' + 2E'`" is tested on every sweep point of every run
 * rather than assumed. Reached / V is surfaced beside the chart.
 */

/** V-sweep bounds (synthetic families): a 1-2-5 ladder from 1k to 50k vertices. */
export const GRAPH_V_MIN = 1_000;
export const GRAPH_V_MAX = 50_000;
/** The V-sweep's fixed average degree for the random family (the UI may change it). */
export const GRAPH_DEFAULT_DEGREE = 4;
export const GRAPH_DEFAULT_SEED = 1;
/** The degree-sweep's fixed vertex count. */
export const DEGREE_SWEEP_VERTICES = 5_000;
/** The degree-sweep's average degrees: E grows 32× while V stays put. */
export const DEGREE_LADDER: readonly number[] = [2, 4, 8, 16, 32, 64];
/** An imported list's prefix ladder starts here, and needs at least this many edges. */
export const EDGE_PREFIX_MIN = 10;
export const EDGE_LIST_MIN_EDGES = 20;
/** Largest imported prefix measured; a bigger file is measured on its first this-many edges. */
export const EDGE_LIST_MAX_EDGES = 500_000;

/**
 * Measurement options for a traversal. **baseBatch 1**: one "op" here is a whole traversal —
 * at the top of the V-sweep most of a millisecond — so the default 1024 would spend seconds
 * just clearing the clock clamp. Adaptive reps as on the search sweep.
 */
export const GRAPH_OPTS: MeasureOptions = {
  minBatchMillis: 2,
  warmupReps: 1,
  reps: 5,
  baseBatch: 1,
  targetRelStddev: 0.05,
  maxReps: 9,
};

/** What the V-sweep runs on — a synthetic family, or the user's own edge list. */
export type GraphSourceChoice =
  | { readonly kind: 'random'; readonly degree: number; readonly seed: number }
  | { readonly kind: 'path' }
  | { readonly kind: 'grid' }
  | { readonly kind: 'edge-list'; readonly list: EdgeList };

export const DEFAULT_GRAPH_SOURCE: GraphSourceChoice = {
  kind: 'random',
  degree: GRAPH_DEFAULT_DEGREE,
  seed: GRAPH_DEFAULT_SEED,
};

export type GraphTraversal = 'bfs' | 'dfs';
export type GraphSweepKind = 'vertices' | 'degree';

/**
 * One measured graph. `n` — the x-coordinate every chart and fit reads — is the **reached
 * component's** `V' + 2E'`; the rest says which graph it was and how much of it was reached.
 */
export interface GraphSweepPoint extends SweepPoint {
  /** The graph's nominal vertex count `V`. */
  readonly vertices: number;
  /** The graph's nominal edge count `E`. */
  readonly edges: number;
  /** `V'` — vertices in vertex 0's component (what a traversal from 0 reaches). */
  readonly reachedVertices: number;
  /** `E'` — edges in that component (a self-loop counts once). */
  readonly reachedEdges: number;
  /** Nominal average degree `2E / V`. */
  readonly degree: number;
}

/** One traversal across one sweep — the graph's counterpart of a `SweepSeries`. */
export interface GraphSeries {
  readonly structure: 'graph';
  readonly traversal: GraphTraversal;
  readonly sweep: GraphSweepKind;
  readonly points: readonly GraphSweepPoint[];
}

/** A fitted graph series, ready to draw (`ui/GraphChart`). */
export interface GraphSeriesView {
  readonly series: GraphSeries;
  readonly fit: FitResult;
  readonly color: string;
}

/** One sweep's outcome: both traversals, what was measured, and the identity checks. */
export interface GraphSweepResult {
  readonly sweep: GraphSweepKind;
  /** Plain-language description of the graphs measured (synthetic ones say so). */
  readonly description: string;
  /** False only for the user's own edge list. */
  readonly synthetic: boolean;
  readonly bfs: GraphSeriesView;
  readonly dfs: GraphSeriesView;
  /**
   * At every point, both op-counts equal the independently computed `V' + 2E'` and both
   * traversals reached exactly `V'` vertices — the cost identity, checked on this run's data.
   */
  readonly countsMatchComponent: boolean;
  /** At every point, BFS and DFS cost the same number of ops (different orders, same cost). */
  readonly bfsEqualsDfs: boolean;
  /** Every point's traversal reached its whole graph (`V' = V`). */
  readonly allReached: boolean;
}

/** A full graph Compare run: the V-sweep, then the degree-sweep. */
export interface GraphCompareResult {
  readonly vertexSweep: GraphSweepResult;
  readonly degreeSweep: GraphSweepResult;
}

/** The V-sweep's graphs for a source. Throws for an edge list too small to sweep. */
export function vertexSweepGraphs(source: GraphSourceChoice): GraphData[] {
  switch (source.kind) {
    case 'random':
      return geometricSweep(GRAPH_V_MIN, GRAPH_V_MAX).map((v) =>
        generateConnectedRandom(v, source.degree, source.seed),
      );
    case 'path':
      return geometricSweep(GRAPH_V_MIN, GRAPH_V_MAX).map((v) => generatePath(v));
    case 'grid':
      return geometricSweep(GRAPH_V_MIN, GRAPH_V_MAX).map((v) => generateGridNear(v));
    case 'edge-list': {
      const total = edgeListSize(source.list);
      if (total < EDGE_LIST_MIN_EDGES) {
        throw new Error(`need at least ${EDGE_LIST_MIN_EDGES} edges to sweep (got ${total})`);
      }
      return geometricSweep(EDGE_PREFIX_MIN, Math.min(total, EDGE_LIST_MAX_EDGES)).map((m) =>
        edgePrefix(source.list, m),
      );
    }
  }
}

/**
 * The degree-sweep's graphs: one random connected graph on {@link DEGREE_SWEEP_VERTICES}
 * vertices at each degree of {@link DEGREE_LADDER}, all from one seed — so each is the
 * previous one *plus edges* (`generateConnectedRandom` is nested across degrees). Always
 * synthetic, whatever the V-sweep ran on: holding `V` fixed while growing `E` alone is a
 * controlled experiment a given file cannot be made to perform.
 */
export function degreeSweepGraphs(seed: number = GRAPH_DEFAULT_SEED): GraphData[] {
  return DEGREE_LADDER.map((d) => generateConnectedRandom(DEGREE_SWEEP_VERTICES, d, seed));
}

/**
 * `V'` and `E'` — the size of vertex 0's connected component — computed from the edges,
 * independently of the engine's op-count. Reachability comes from the TS teaching twin's
 * BFS (the conformance-pinned twin of the bench one); `E'` is then a plain count of edges
 * with an endpoint in the reached set, which for an undirected edge means both.
 */
export function componentStats(g: GraphData): { reachedVertices: number; reachedEdges: number } {
  if (g.numVertices === 0) return { reachedVertices: 0, reachedEdges: 0 };
  const twin = GraphAdj.fromEdges(Array.from(g.edges), g.numVertices);
  const reached = new Uint8Array(g.numVertices);
  const { order } = twin.bfs(0);
  for (const v of order) reached[v] = 1;
  let reachedEdges = 0;
  for (let i = 0; i < g.edges.length; i += 2) if (reached[g.edges[i]]) reachedEdges += 1;
  return { reachedVertices: order.length, reachedEdges };
}

/** Plain-language description of a sweep's graphs. */
function describeVertexSweep(source: GraphSourceChoice, graphs: readonly GraphData[]): string {
  const range = (xs: readonly number[]) =>
    `${xs[0].toLocaleString()} … ${xs[xs.length - 1].toLocaleString()}`;
  const vs = graphs.map((g) => g.numVertices);
  switch (source.kind) {
    case 'random':
      return `synthetic connected random graphs at average degree ${source.degree} (seed ${source.seed}), V = ${range(vs)}`;
    case 'path':
      return `synthetic paths, V = ${range(vs)}`;
    case 'grid':
      return `synthetic square grids, V = ${range(vs)}`;
    case 'edge-list': {
      const total = edgeListSize(source.list);
      const es = graphs.map(edgeCount);
      const capped =
        total > EDGE_LIST_MAX_EDGES
          ? ` (the file has ${total.toLocaleString()}; only the first ${EDGE_LIST_MAX_EDGES.toLocaleString()} are measured)`
          : '';
      return `your edge list — its first ${range(es)} edges${capped}; traversals start at “${source.list.labels[0]}”, the first label in the file`;
    }
  }
}

/** Assemble one traversal's series from the graphs and the engine's measures. */
function seriesOf(
  sweep: GraphSweepKind,
  traversal: GraphTraversal,
  graphs: readonly GraphData[],
  stats: ReadonlyArray<{ reachedVertices: number; reachedEdges: number }>,
  measures: readonly GraphTraversalMeasure[],
): GraphSeries {
  return {
    structure: 'graph',
    traversal,
    sweep,
    points: graphs.map((g, i) => {
      const m = measures[i][traversal];
      const { reachedVertices, reachedEdges } = stats[i];
      return {
        ...m,
        n: reachedVertices + 2 * reachedEdges,
        vertices: g.numVertices,
        edges: edgeCount(g),
        reachedVertices,
        reachedEdges,
        degree: g.numVertices > 0 ? (2 * edgeCount(g)) / g.numVertices : 0,
      };
    }),
  };
}

/** Fit a graph series on the chosen signal against `V' + 2E'`, in the graph's colour. */
export function toGraphView(series: GraphSeries, signal: Signal = 'nanos'): GraphSeriesView {
  return {
    series,
    fit: fitComplexity(
      series.points.map((p) => p.n),
      series.points.map((p) => (signal === 'nanos' ? p.nanosPerOp : p.opCount)),
    ),
    color: GRAPH.color,
  };
}

/** Measure one sweep's graphs and check the cost identity on every point. */
async function runOneSweep(
  engine: Pick<BenchEngine, 'runGraphSweep'>,
  sweep: GraphSweepKind,
  graphs: readonly GraphData[],
  description: string,
  synthetic: boolean,
): Promise<GraphSweepResult> {
  // Stats first: the engine transfers (detaches) the edge buffers it is handed.
  const stats = graphs.map(componentStats);
  const measures = await engine.runGraphSweep(
    graphs.map((g) => ({ edges: g.edges.slice(), numVertices: g.numVertices })),
    GRAPH_OPTS,
  );
  if (measures.length !== graphs.length) {
    throw new Error(`engine measured ${measures.length} graphs, expected ${graphs.length}`);
  }
  const bfs = toGraphView(seriesOf(sweep, 'bfs', graphs, stats, measures));
  const dfs = toGraphView(seriesOf(sweep, 'dfs', graphs, stats, measures));
  const countsMatchComponent = measures.every((m, i) => {
    const x = stats[i].reachedVertices + 2 * stats[i].reachedEdges;
    const v = stats[i].reachedVertices;
    return m.bfs.opCount === x && m.dfs.opCount === x && m.bfsReached === v && m.dfsReached === v;
  });
  return {
    sweep,
    description,
    synthetic,
    bfs,
    dfs,
    countsMatchComponent,
    bfsEqualsDfs: measures.every((m) => m.bfs.opCount === m.dfs.opCount),
    allReached: graphs.every((g, i) => stats[i].reachedVertices === g.numVertices),
  };
}

/** One sweep's proof, mirrored onto `window` for `scripts/verify-browser.mjs`. */
export interface GraphSweepProof {
  readonly sweep: GraphSweepKind;
  readonly source: string;
  readonly synthetic: boolean;
  readonly bfs: SweepProof;
  readonly dfs: SweepProof;
  readonly points: ReadonlyArray<{
    vertices: number;
    edges: number;
    reachedVertices: number;
    reachedEdges: number;
    x: number;
    bfsOps: number;
    dfsOps: number;
    bfsNanos: number;
    dfsNanos: number;
  }>;
  readonly countsMatchComponent: boolean;
  readonly bfsEqualsDfs: boolean;
  readonly allReached: boolean;
  /** Last x over first x — how far the sweep moved along `V' + 2E'`. */
  readonly xRatio: number;
}

/** The whole graph run's proof; `__graphProof` is set once, after both sweeps. */
export interface GraphProof {
  readonly vertexSweep: GraphSweepProof;
  readonly degreeSweep: GraphSweepProof;
}

function sweepProofOf(v: GraphSeriesView): SweepProof {
  const pts = v.series.points;
  return {
    structure: v.series.structure,
    op: v.series.traversal,
    best: v.fit.best,
    slope: v.fit.logLogSlope,
    slopeStderr: v.fit.slopeStderr,
    tailSlope: v.fit.tailSlope,
    trend: v.fit.trend,
    r2: v.fit.r2,
    firstNanos: pts[0].nanosPerOp,
    lastNanos: pts[pts.length - 1].nanosPerOp,
  };
}

export function toGraphSweepProof(r: GraphSweepResult, source: string): GraphSweepProof {
  const b = r.bfs.series.points;
  const d = r.dfs.series.points;
  return {
    sweep: r.sweep,
    source,
    synthetic: r.synthetic,
    bfs: sweepProofOf(r.bfs),
    dfs: sweepProofOf(r.dfs),
    points: b.map((p, i) => ({
      vertices: p.vertices,
      edges: p.edges,
      reachedVertices: p.reachedVertices,
      reachedEdges: p.reachedEdges,
      x: p.n,
      bfsOps: p.opCount,
      dfsOps: d[i].opCount,
      bfsNanos: p.nanosPerOp,
      dfsNanos: d[i].nanosPerOp,
    })),
    countsMatchComponent: r.countsMatchComponent,
    bfsEqualsDfs: r.bfsEqualsDfs,
    allReached: r.allReached,
    xRatio: b.length > 0 && b[0].n > 0 ? b[b.length - 1].n / b[0].n : 0,
  };
}

/** The `window` global the runtime gate polls for the graph pass. */
interface GraphProofWindow {
  __graphProof?: GraphProof;
}

/**
 * Run the graph's two sweeps — the V-sweep on `source`, then the synthetic degree-sweep —
 * reporting progress through `onStatus` and mirroring the result onto `window.__graphProof`
 * (set **last**, as the "graph run done" signal). Independent of the key-dataset runs: it
 * takes no `Dataset` and sets none of their globals.
 */
export async function runGraphSweeps(
  engine: Pick<BenchEngine, 'runGraphSweep'>,
  source: GraphSourceChoice = DEFAULT_GRAPH_SOURCE,
  onStatus: (s: string) => void = () => {},
  win: GraphProofWindow | undefined = typeof window === 'undefined'
    ? undefined
    : (window as GraphProofWindow),
): Promise<GraphCompareResult> {
  const vGraphs = vertexSweepGraphs(source);
  onStatus('running graph V-sweep (BFS + DFS)…');
  const vertexSweep = await runOneSweep(
    engine,
    'vertices',
    vGraphs,
    describeVertexSweep(source, vGraphs),
    source.kind !== 'edge-list',
  );

  onStatus('running graph degree-sweep (BFS + DFS)…');
  const seed = source.kind === 'random' ? source.seed : GRAPH_DEFAULT_SEED;
  const dGraphs = degreeSweepGraphs(seed);
  const degreeSweep = await runOneSweep(
    engine,
    'degree',
    dGraphs,
    `synthetic connected random graph, V = ${DEGREE_SWEEP_VERTICES.toLocaleString()} fixed, average degree ${DEGREE_LADDER[0]} … ${DEGREE_LADDER[DEGREE_LADDER.length - 1]} — each point is the previous graph plus edges (seed ${seed})`,
    true,
  );

  if (win) {
    win.__graphProof = {
      vertexSweep: toGraphSweepProof(vertexSweep, source.kind),
      degreeSweep: toGraphSweepProof(degreeSweep, 'random'),
    };
  }
  return { vertexSweep, degreeSweep };
}
