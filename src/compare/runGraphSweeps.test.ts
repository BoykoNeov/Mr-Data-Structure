import { describe, it, expect } from 'vitest';
import type { BenchEngine } from '../bench/BenchEngine';
import type { GraphInput, GraphTraversalMeasure } from '../bench/graphBench';
import type { SweepPoint } from '../bench/measure';
import { parseEdgeList, type EdgeList } from '../data/edgeList';
import { GraphAdj } from '../structures/graph';
import {
  DEGREE_LADDER,
  DEGREE_SWEEP_VERTICES,
  EDGE_LIST_MAX_EDGES,
  GRAPH_OPTS,
  GRAPH_V_MAX,
  GRAPH_V_MIN,
  componentStats,
  degreeSweepGraphs,
  runGraphSweeps,
  toGraphView,
  vertexSweepGraphs,
  type GraphProof,
} from './runGraphSweeps';
import { generatePath } from '../data/graphs';

type Engine = Pick<BenchEngine, 'runGraphSweep'>;

function point(n: number, nanos: number, ops: number): SweepPoint {
  return { n, nanosPerOp: nanos, opCount: ops, batch: 1, reps: 3, stddevNanos: 0, minNanos: nanos, maxNanos: nanos };
}

/**
 * A fake engine that traverses each graph with the **TS twin** — so the op-counts are the
 * real `V' + 2E'` — and charges a wall-clock of `cost(ops, V)`. The default cost is the
 * honest one (time ∝ ops); a test can swap in an `O(V)` cost to show what the V-sweep alone
 * could never distinguish.
 */
function fakeEngine(
  log: string[],
  cost: (ops: number, v: number) => number = (ops) => ops,
  miscount = false,
): Engine {
  return {
    runGraphSweep: async (graphs: GraphInput[], opts) => {
      log.push(`graph:${graphs.length}:${opts?.baseBatch}`);
      return graphs.map(({ edges, numVertices }): GraphTraversalMeasure => {
        const g = GraphAdj.fromEdges(Array.from(edges), numVertices);
        const b = g.bfs(0);
        const d = g.dfs(0);
        // A miscounting engine reports the graph's *nominal* V + 2E — the trap-4 mistake.
        const nominal = numVertices + edges.length;
        const bOps = miscount ? nominal : b.ops;
        const dOps = miscount ? nominal : d.ops;
        return {
          bfs: point(numVertices, cost(b.ops, numVertices), bOps),
          dfs: point(numVertices, cost(d.ops, numVertices), dOps),
          bfsReached: b.reached,
          dfsReached: d.reached,
        };
      });
    },
  };
}

describe('runGraphSweeps', () => {
  it('runs the V-sweep then the degree-sweep and publishes one proof, last', async () => {
    const log: string[] = [];
    const statuses: string[] = [];
    const win: { __graphProof?: GraphProof } = {};
    const r = await runGraphSweeps(fakeEngine(log), undefined, (s) => statuses.push(s), win);

    // Two engine calls, both with the graph's own options (a traversal per op, batch 1).
    expect(log).toEqual([`graph:6:${GRAPH_OPTS.baseBatch}`, `graph:6:${GRAPH_OPTS.baseBatch}`]);
    expect(GRAPH_OPTS.baseBatch).toBe(1);
    expect(statuses).toEqual([
      'running graph V-sweep (BFS + DFS)…',
      'running graph degree-sweep (BFS + DFS)…',
    ]);

    // V-sweep: V grows at a fixed degree, the graph stays connected, x = V + 2E exactly.
    const vs = r.vertexSweep.bfs.series.points;
    expect(vs.map((p) => p.vertices)).toEqual([1_000, 2_000, 5_000, 10_000, 20_000, 50_000]);
    expect(vs.every((p) => p.degree === 4)).toBe(true);
    expect(vs.every((p) => p.n === p.vertices + 2 * p.edges)).toBe(true);
    // Degree-sweep: V is fixed and only E grows.
    const ds = r.degreeSweep.dfs.series.points;
    expect(ds.every((p) => p.vertices === DEGREE_SWEEP_VERTICES)).toBe(true);
    expect(ds.map((p) => p.degree)).toEqual([...DEGREE_LADDER]);

    for (const s of [r.vertexSweep, r.degreeSweep]) {
      expect(s.countsMatchComponent).toBe(true);
      expect(s.bfsEqualsDfs).toBe(true);
      expect(s.allReached).toBe(true);
      expect(s.synthetic).toBe(true);
      expect(s.description).toMatch(/^synthetic/);
      // Time ∝ ops ⇒ both traversals are linear in V' + 2E' on both sweeps.
      expect(s.bfs.fit.logLogSlope).toBeCloseTo(1, 6);
      expect(s.dfs.fit.logLogSlope).toBeCloseTo(1, 6);
      expect(s.bfs.color).toBe('#7f7f7f');
    }

    const proof = win.__graphProof;
    expect(proof).toBeDefined();
    expect(proof?.vertexSweep.bfs).toMatchObject({ structure: 'graph', op: 'bfs' });
    expect(proof?.degreeSweep.dfs.op).toBe('dfs');
    expect(proof?.vertexSweep.points).toHaveLength(6);
    expect(proof?.degreeSweep.points[0].x).toBe(DEGREE_SWEEP_VERTICES + 2 * DEGREE_SWEEP_VERTICES);
    expect(proof?.degreeSweep.xRatio).toBeGreaterThan(15);
  });

  it('shows why one sweep is not enough: an O(V) cost is linear on the V-sweep, flat on the degree-sweep', async () => {
    // METHODOLOGY §2.7: at a fixed degree, V and V + 2E grow together, so a cost that
    // ignored the edges entirely would still draw a slope-1 line on the V-sweep. Only the
    // degree-sweep, which grows E alone, tells it apart from the real O(V + E).
    const r = await runGraphSweeps(fakeEngine([], (_ops, v) => v), undefined, () => {}, undefined);
    expect(r.vertexSweep.bfs.fit.logLogSlope).toBeCloseTo(1, 1);
    expect(Math.abs(r.degreeSweep.bfs.fit.logLogSlope)).toBeLessThan(0.01);
    // ...while the honest cost rises on both.
    const honest = await runGraphSweeps(fakeEngine([]), undefined, () => {}, undefined);
    expect(honest.degreeSweep.bfs.fit.logLogSlope).toBeCloseTo(1, 6);
  });

  it('plots a disconnected import against the reached component, and says so (trap 4)', async () => {
    // Two components that join only at the very end of the file: every prefix but the last
    // is disconnected, so a traversal from vertex 0 reaches only part of it.
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`a${i},a${i + 1}`);
    for (let i = 0; i < 30; i++) lines.push(`b${i},b${i + 1}`);
    lines.push('a30,b0');
    const list = parseEdgeList(lines.join('\n'));
    const win: { __graphProof?: GraphProof } = {};
    const r = await runGraphSweeps(fakeEngine([]), { kind: 'edge-list', list }, () => {}, win);

    const pts = r.vertexSweep.bfs.series.points;
    expect(pts.map((p) => p.edges)).toEqual([10, 20, 50, 61]);
    const p50 = pts[2];
    // 50 edges = the 30-edge a-path + 20 b-edges: vertex 0's component is the a-path.
    expect(p50.vertices).toBe(31 + 21);
    expect([p50.reachedVertices, p50.reachedEdges]).toEqual([31, 30]);
    expect(p50.n).toBe(31 + 2 * 30);
    expect(p50.n).toBeLessThan(p50.vertices + 2 * p50.edges);
    // The whole file is connected; the last point reaches everything.
    expect(pts[3].reachedVertices).toBe(62);
    expect(r.vertexSweep.allReached).toBe(false);
    expect(r.vertexSweep.countsMatchComponent).toBe(true);
    expect(r.vertexSweep.synthetic).toBe(false);
    expect(r.vertexSweep.description).toMatch(/^your edge list/);
    expect(r.vertexSweep.description).toContain('“a0”');
    expect(win.__graphProof?.vertexSweep.source).toBe('edge-list');
    // The degree-sweep stays synthetic whatever the V-sweep ran on.
    expect(r.degreeSweep.synthetic).toBe(true);
  });

  it('flags an engine whose op-count is not the reached component’s V′ + 2E′', async () => {
    // On a connected graph the nominal V + 2E *is* the component's, so the mistake only
    // shows on a disconnected one — which is exactly where it would mis-plot the curve.
    const lines = Array.from({ length: 20 }, (_, i) => `a${i},a${i + 1}`);
    for (let i = 0; i < 20; i++) lines.push(`b${i},b${i + 1}`);
    const list = parseEdgeList(lines.join('\n'));
    const honest = await runGraphSweeps(fakeEngine([]), { kind: 'edge-list', list }, () => {}, undefined);
    expect(honest.vertexSweep.countsMatchComponent).toBe(true);
    const r = await runGraphSweeps(fakeEngine([], undefined, true), { kind: 'edge-list', list }, () => {}, undefined);
    expect(r.vertexSweep.countsMatchComponent).toBe(false);
  });

  it('hands the engine one fresh buffer per graph (each is transferred)', async () => {
    const seen: ArrayBufferLike[] = [];
    const engine: Engine = {
      runGraphSweep: async (graphs) => {
        for (const g of graphs) seen.push(g.edges.buffer);
        return fakeEngine([]).runGraphSweep(graphs);
      },
    };
    const list = parseEdgeList(Array.from({ length: 40 }, (_, i) => `${i},${i + 1}`).join('\n'));
    await runGraphSweeps(engine, { kind: 'edge-list', list }, () => {}, undefined);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.includes(list.edges.buffer)).toBe(false);
  });

  it('refits on the op-count signal: exactly V′ + 2E′, slope 1', async () => {
    const r = await runGraphSweeps(fakeEngine([], () => 1), undefined, () => {}, undefined);
    expect(r.vertexSweep.bfs.fit.logLogSlope).toBeCloseTo(0, 6); // the flat fake clock
    const ops = toGraphView(r.vertexSweep.bfs.series, 'opcount');
    expect(ops.fit.logLogSlope).toBeCloseTo(1, 9);
    expect(ops.fit.best).toBe('O(n)');
  });
});

describe('graph sweep inputs', () => {
  it('ladders the synthetic families over the V bounds', () => {
    for (const kind of ['path', 'grid'] as const) {
      const gs = vertexSweepGraphs({ kind });
      expect(gs).toHaveLength(6);
      expect(gs[0].numVertices).toBeGreaterThanOrEqual(GRAPH_V_MIN - 50);
      expect(gs[gs.length - 1].numVertices).toBeLessThanOrEqual(GRAPH_V_MAX + 500);
    }
    const ds = degreeSweepGraphs(1);
    expect(ds.map((g) => g.numVertices)).toEqual(DEGREE_LADDER.map(() => DEGREE_SWEEP_VERTICES));
  });

  it('refuses an edge list too small to sweep, and caps a huge one', () => {
    const tiny = parseEdgeList('a,b\nb,c\n');
    expect(() => vertexSweepGraphs({ kind: 'edge-list', list: tiny })).toThrow(/at least 20 edges/);
    const n = EDGE_LIST_MAX_EDGES + 1_000;
    const edges = new Uint32Array(2 * n);
    for (let i = 0; i < n; i++) {
      edges[2 * i] = i;
      edges[2 * i + 1] = i + 1;
    }
    const huge: EdgeList = {
      edges,
      labels: Array.from({ length: n + 1 }, (_, i) => String(i)),
      skippedLines: 0,
      extraColumnLines: 0,
      selfLoops: 0,
    };
    const gs = vertexSweepGraphs({ kind: 'edge-list', list: huge });
    expect(gs[gs.length - 1].edges.length / 2).toBe(EDGE_LIST_MAX_EDGES);
  });

  it('computes the component from the edges: V′ and E′ with self-loops counted once', () => {
    expect(componentStats(generatePath(10))).toEqual({ reachedVertices: 10, reachedEdges: 9 });
    const list = parseEdgeList('a,b\na,a\nc,d\nb,a\n');
    // a–b twice (parallel) and a loop on a: V' = 2, E' = 3; c–d is another component.
    expect(componentStats({ edges: list.edges, numVertices: 4, origin: { kind: 'edge-list', edges: 4, totalEdges: 4 } })).toEqual({
      reachedVertices: 2,
      reachedEdges: 3,
    });
  });
});
