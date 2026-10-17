import { describe, it, expect } from 'vitest';
import {
  averageDegree,
  edgeCount,
  edgesForDegree,
  generateConnectedRandom,
  generateGrid,
  generateGridNear,
  generatePath,
  describeGraph,
  type GraphData,
} from './graphs';
import { GraphAdj } from '../structures/graph';

/** The TS teaching twin built from a generated graph (ids are integers by type). */
function twin(g: GraphData): GraphAdj {
  return GraphAdj.fromEdges(Array.from(g.edges), g.numVertices);
}

/**
 * The graph generators (docs/METHODOLOGY.md §2.7): seeded, connected where they claim to be,
 * never deduplicating, and — for the random one — nested across degrees, so the degree-sweep
 * really does hold `V` fixed and grow `E` alone.
 */
describe('graph generators', () => {
  it('builds a connected random graph at the requested average degree, deterministically', () => {
    const g = generateConnectedRandom(2_000, 6, 7);
    expect(g.numVertices).toBe(2_000);
    expect(edgeCount(g)).toBe(6_000);
    expect(averageDegree(g)).toBe(6);
    // Connected: a traversal from 0 reaches everything and costs exactly V + 2E.
    const t = twin(g);
    expect(t.bfs(0).reached).toBe(2_000);
    expect(t.bfs(0).ops).toBe(2_000 + 2 * 6_000);
    expect(t.dfs(0).ops).toBe(t.bfs(0).ops);
    // Same seed ⇒ same graph; another seed ⇒ another graph.
    expect(generateConnectedRandom(2_000, 6, 7).edges).toEqual(g.edges);
    expect(generateConnectedRandom(2_000, 6, 8).edges).not.toEqual(g.edges);
    // Every id is an integer in range — what the twins index their adjacency lists by.
    expect(g.edges.every((id) => Number.isInteger(id) && id < g.numVertices)).toBe(true);
  });

  it('nests across degrees: the degree-sweep adds edges to one graph at a fixed V', () => {
    // The property the degree-sweep's "+E in isolation" argument rests on: for one
    // (V, seed), a lower degree's edge list is an exact prefix of a higher degree's.
    const lo = generateConnectedRandom(1_000, 4, 3);
    const hi = generateConnectedRandom(1_000, 32, 3);
    expect(hi.numVertices).toBe(lo.numVertices);
    expect(Array.from(hi.edges.subarray(0, lo.edges.length))).toEqual(Array.from(lo.edges));
    // ...so the op-count moves by exactly 2 per added edge (METHODOLOGY §2.7).
    const d = twin(hi).bfs(0).ops - twin(lo).bfs(0).ops;
    expect(d).toBe(2 * (edgeCount(hi) - edgeCount(lo)));
  });

  it('clamps a degree below a tree’s up to the spanning tree, never disconnecting', () => {
    expect(edgesForDegree(500, 0)).toBe(499);
    expect(edgesForDegree(500, 1)).toBe(499);
    expect(edgesForDegree(0, 4)).toBe(0);
    const tree = generateConnectedRandom(500, 0, 1);
    expect(edgeCount(tree)).toBe(499);
    expect(twin(tree).bfs(0).reached).toBe(500);
  });

  it('keeps the self-loops and parallel edges a random draw produces (never dedupe)', () => {
    // A tiny vertex set at a high degree forces repeats; they must all survive.
    const g = generateConnectedRandom(3, 40, 1);
    expect(edgeCount(g)).toBe(60);
    const pairs = new Set<string>();
    let loops = 0;
    for (let i = 0; i < g.edges.length; i += 2) {
      const [u, v] = [g.edges[i], g.edges[i + 1]];
      if (u === v) loops += 1;
      pairs.add(`${Math.min(u, v)}-${Math.max(u, v)}`);
    }
    expect(loops).toBeGreaterThan(0);
    expect(pairs.size).toBeLessThan(60); // parallel edges present
    // And the twin counts every one of them: Σ deg = 2E, a self-loop twice in its own list.
    expect(twin(g).bfs(0).ops).toBe(3 + 2 * 60);
  });

  it('builds a path and a grid, connected, with the textbook edge counts', () => {
    const p = generatePath(100);
    expect(edgeCount(p)).toBe(99);
    expect(twin(p).dfs(0).ops).toBe(100 + 2 * 99);
    const g = generateGrid(4, 5);
    expect(g.numVertices).toBe(20);
    expect(edgeCount(g)).toBe(4 * 4 + 5 * 3);
    expect(twin(g).bfs(0).reached).toBe(20);
    const near = generateGridNear(1_000);
    expect(near.numVertices).toBe(32 * 32);
    expect(generatePath(0).numVertices).toBe(0);
    expect(edgeCount(generateGrid(1, 1))).toBe(0);
  });

  it('labels synthetic graphs as synthetic', () => {
    expect(describeGraph(generateConnectedRandom(10, 4, 1))).toMatch(/^synthetic connected random/);
    expect(describeGraph(generatePath(10))).toMatch(/^synthetic path/);
    expect(describeGraph(generateGrid(2, 3))).toMatch(/^synthetic 2 × 3 grid/);
  });

  it('rejects nonsense sizes', () => {
    expect(() => generateConnectedRandom(-1, 4)).toThrow(/non-negative integer/);
    expect(() => generateConnectedRandom(10, Number.NaN)).toThrow(/degree/);
    expect(() => generatePath(2.5)).toThrow(/non-negative integer/);
  });
});
