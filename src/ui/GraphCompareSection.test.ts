import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BenchEngine } from '../bench/BenchEngine';
import type { GraphTraversalMeasure } from '../bench/graphBench';
import { parseEdgeList } from '../data/edgeList';
import { GraphAdj } from '../structures/graph';
import { runGraphSweeps } from '../compare/runGraphSweeps';
import {
  DegreeSweepNote,
  GraphCompareSection,
  SweepBlock,
  VertexSweepNote,
  WallClockCaveat,
} from './GraphCompareSection';
import { graphClassLabel } from './GraphChart';

/** A fake engine traversing with the TS twin, time ∝ ops. */
const engine: Pick<BenchEngine, 'runGraphSweep'> = {
  runGraphSweep: async (graphs) =>
    graphs.map(({ edges, numVertices }): GraphTraversalMeasure => {
      const g = GraphAdj.fromEdges(Array.from(edges), numVertices);
      const b = g.bfs(0);
      const d = g.dfs(0);
      const pt = (ops: number) => ({
        n: numVertices, nanosPerOp: ops, opCount: ops, batch: 1, reps: 3, stddevNanos: 0, minNanos: ops, maxNanos: ops,
      });
      return { bfs: pt(b.ops), dfs: pt(d.ops), bfsReached: b.reached, dfsReached: d.reached };
    }),
};

/**
 * Render-smoke + honesty guard for the graph section, in the spirit of `Explain.test.ts`:
 * the caveats that make its charts honest are pinned in the rendered copy, so a wording
 * edit cannot silently drop them.
 */
describe('GraphCompareSection', () => {
  it('renders its own picker and run button, and says it does not use the key dataset', () => {
    const html = renderToStaticMarkup(
      createElement(GraphCompareSection, {
        engineOf: () => null,
        busy: false,
        signal: 'nanos',
        showTheory: true,
        showSpread: true,
      }),
    );
    expect(html).toContain('measure the graph');
    expect(html).toContain('never touches the dataset');
    expect(html).toMatch(/inventing some would be measuring a made-up graph/);
    expect(html).toContain('O(V + E)');
    // The button must not be matched by the browser gate's /run the sweeps/ locator.
    expect(html).not.toMatch(/run the sweeps/i);
  });

  it('labels synthetic sweeps as generated and a partial reach as partial', async () => {
    const synthetic = await runGraphSweeps(engine, undefined, () => {}, undefined);
    const s = renderToStaticMarkup(
      createElement(SweepBlock, {
        title: 'V',
        result: synthetic.vertexSweep,
        views: [synthetic.vertexSweep.bfs, synthetic.vertexSweep.dfs],
        name: 'graph-vertices',
        signal: 'nanos',
        showTheory: true,
        showSpread: true,
      }),
    );
    expect(s).toContain('Generated graphs, not your data.');
    expect(s).toContain('Every traversal reached the whole graph.');
    expect(s).toContain('yes, exactly');
    expect(s).toContain('data-chart="graph-vertices"');

    const lines = Array.from({ length: 20 }, (_, i) => `a${i},a${i + 1}`);
    for (let i = 0; i < 20; i++) lines.push(`b${i},b${i + 1}`);
    const mine = await runGraphSweeps(engine, { kind: 'edge-list', list: parseEdgeList(lines.join('\n')) }, () => {}, undefined);
    const m = renderToStaticMarkup(
      createElement(SweepBlock, {
        title: 'V',
        result: mine.vertexSweep,
        views: [mine.vertexSweep.bfs, mine.vertexSweep.dfs],
        name: 'graph-vertices',
        signal: 'nanos',
        showTheory: true,
        showSpread: true,
      }),
    );
    expect(m).toContain('Your data.');
    expect(m).toContain('Not every vertex was reached.');
    expect(m).toMatch(/21 of 42/); // reached / V surfaced per point
  });

  it('keeps the two-sweep argument and the memory caveat in the copy', () => {
    // One sweep cannot separate O(V) from O(V + E) — the reason the section has two.
    expect(renderToStaticMarkup(createElement(VertexSweepNote))).toMatch(/ignored the links entirely would draw the very same straight line/);
    expect(renderToStaticMarkup(createElement(DegreeSweepNote))).toMatch(/this line would be flat/);
    const caveat = renderToStaticMarkup(createElement(WallClockCaveat));
    // The V-sweep's wall clock bends with the cache and can be labelled n log n; the copy
    // must say that is memory, not the walk, and point at the exact op-count.
    expect(caveat).toMatch(/reacting to memory/);
    expect(caveat).toMatch(/op-count/);
  });

  it('restates the fitter’s class in the graph’s own axes', () => {
    expect(graphClassLabel('O(n)')).toBe('O(V + E)');
    expect(graphClassLabel('O(1)')).toBe('O(1)');
    expect(graphClassLabel('O(n log n)')).toBe('O(X log X) in X = V′+2E′');
  });
});
