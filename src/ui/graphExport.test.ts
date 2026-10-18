import { describe, it, expect } from 'vitest';
import type { BenchEngine } from '../bench/BenchEngine';
import type { GraphTraversalMeasure } from '../bench/graphBench';
import { parseEdgeList } from '../data/edgeList';
import { GraphAdj } from '../structures/graph';
import { CSV_HEADER } from './export';
import { runGraphSweeps, toGraphView } from '../compare/runGraphSweeps';
import { GRAPH_CSV_HEADER, graphSheetCaption, graphToCsv, graphToJson } from './graphExport';

/** A fake engine traversing with the TS twin, time ∝ ops (as GraphCompareSection.test.ts). */
const engine: Pick<BenchEngine, 'runGraphSweep'> = {
  runGraphSweep: async (graphs) =>
    graphs.map(({ edges, numVertices }): GraphTraversalMeasure => {
      const g = GraphAdj.fromEdges(Array.from(edges), numVertices);
      const b = g.bfs(0);
      const d = g.dfs(0);
      const pt = (ops: number) => ({
        n: numVertices, nanosPerOp: ops * 3, opCount: ops, batch: 1, reps: 3, stddevNanos: 0, minNanos: ops, maxNanos: ops * 4,
      });
      return { bfs: pt(b.ops), dfs: pt(d.ops), bfsReached: b.reached, dfsReached: d.reached };
    }),
};

const synthetic = () => runGraphSweeps(engine, undefined, () => {}, undefined);
/** Two disjoint 20-edge paths: the traversal from the first label reaches only half. */
const partial = () => {
  const lines = Array.from({ length: 20 }, (_, i) => `a${i},a${i + 1}`);
  for (let i = 0; i < 20; i++) lines.push(`b${i},b${i + 1}`);
  return runGraphSweeps(engine, { kind: 'edge-list', list: parseEdgeList(lines.join('\n')) }, () => {}, undefined);
};

describe('graph CSV', () => {
  it('writes one row per sweep × traversal × point, x = the reached V′ + 2E′', async () => {
    const r = await synthetic();
    const lines = graphToCsv(r).trim().split('\n');
    expect(lines[0]).toBe(GRAPH_CSV_HEADER);
    const points = r.vertexSweep.bfs.series.points.length + r.degreeSweep.bfs.series.points.length;
    expect(lines).toHaveLength(1 + 2 * points);
    const col = (name: string) => GRAPH_CSV_HEADER.split(',').indexOf(name);
    const first = lines[1].split(',');
    const p = r.vertexSweep.bfs.series.points[0];
    expect(first.slice(0, 2)).toEqual(['vertices', 'bfs']);
    expect(Number(first[col('x')])).toBe(p.reachedVertices + 2 * p.reachedEdges);
    expect(Number(first[col('op_count')])).toBe(p.opCount);
    expect(Number(first[col('max_nanos')])).toBe(p.maxNanos);
    expect(lines.some((l) => l.startsWith('degree,dfs,'))).toBe(true);
  });

  it('shows a partial reach on its own rows, without the page', async () => {
    // The whole file: 42 vertices in two paths, of which a traversal from the first reaches 21.
    const row = graphToCsv(await partial()).split('\n').find((l) => l.startsWith('vertices,bfs,42,'));
    expect(row).toBeDefined();
    const col = (name: string) => GRAPH_CSV_HEADER.split(',').indexOf(name);
    expect(row!.split(',')[col('reached_vertices')]).toBe('21');
  });

  it('leaves the key runs’ CSV header exactly as it was', () => {
    expect(CSV_HEADER).toBe('structure,op,n,nanos_per_op,min_nanos,max_nanos,stddev_nanos,op_count,batch,reps,stored_n,max_load');
  });
});

describe('graph JSON', () => {
  it('carries the identity checks, the description and the on-screen fit beside the points', async () => {
    const r = await synthetic();
    const vertices = [toGraphView(r.vertexSweep.bfs.series, 'opcount'), toGraphView(r.vertexSweep.dfs.series, 'opcount')];
    const degree = [toGraphView(r.degreeSweep.bfs.series, 'opcount'), toGraphView(r.degreeSweep.dfs.series, 'opcount')];
    const j = JSON.parse(graphToJson(r, { vertices, degree }, { signal: 'opcount', engine: 'test' }));
    expect(j.signal).toBe('opcount');
    expect(j.engine).toBe('test');
    expect(j.theory).toBe('O(V + E)');
    expect(j.vertexSweep).toMatchObject({ sweep: 'vertices', synthetic: true, countsMatchComponent: true, bfsEqualsDfs: true, allReached: true });
    expect(j.vertexSweep.description).toBe(r.vertexSweep.description);
    expect(j.degreeSweep.traversals.map((t: { traversal: string }) => t.traversal)).toEqual(['bfs', 'dfs']);
    // The op-count fit of an exactly linear count is slope 1 — the fit on screen, not the result's wall-clock one.
    expect(j.vertexSweep.traversals[0].fit.logLogSlope).toBeCloseTo(1, 6);
    expect(j.vertexSweep.traversals[0].points[0]).toMatchObject({ reachedVertices: expect.any(Number), n: expect.any(Number) });
  });
});

describe('graph PNG caption', () => {
  it('always carries the memory caveat, the x-axis and both identity checks', async () => {
    const r = await synthetic();
    for (const signal of ['nanos', 'opcount'] as const) {
      const caption = graphSheetCaption(r, { signal, version: 'v', when: new Date('2026-10-18T00:00:00Z') }).join('\n');
      expect(caption).toMatch(/Memory caveat/);
      expect(caption).toMatch(/fitter reacting to memory, not a claim about the walk/);
      expect(caption).toMatch(/V′ \+ 2E′ — the vertices plus twice the edges reached from vertex 0/);
      expect(caption).toMatch(/Counted work = V′ \+ 2E′ at every point: yes, exactly/);
      expect(caption).toMatch(/BFS and DFS the same work: yes, at every point/);
      expect(caption).toMatch(/Generated graphs, not your data\./);
      expect(caption).toContain('2026-10-18T00:00:00.000Z');
    }
    const nanos = graphSheetCaption(r, { signal: 'nanos', version: 'v' }).join('\n');
    expect(nanos).toMatch(/specific to this machine/);
    expect(graphSheetCaption(r, { signal: 'opcount', version: 'v' }).join('\n')).not.toMatch(/specific to this machine/);
  });

  it('says so when a traversal reached only part of the graph, and that the data is yours', async () => {
    const caption = graphSheetCaption(await partial(), { signal: 'nanos', version: 'v' }).join('\n');
    expect(caption).toMatch(/Not every vertex was reached/);
    expect(caption).toMatch(/Your data\./);
  });
});
