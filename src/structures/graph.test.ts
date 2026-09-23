import { describe, it, expect } from 'vitest';
import { GraphAdj } from './graph';

/**
 * Unit tests for the graph teaching twin (docs/PLAN.md §8). The cross-language op-counts and
 * traversal orders are pinned by `conformance-graph.test.ts` against the Rust corpus; these
 * cover the twin's own API surface and the structural rules (undirected both-directions,
 * multigraph, self-loop-counts-twice, the `V + 2E` identity, and disconnected reachability).
 */

describe('GraphAdj — construction', () => {
  it('stores each undirected edge in both endpoints, in insertion order', () => {
    const g = new GraphAdj(3);
    g.addEdge(0, 1);
    g.addEdge(1, 2);
    expect(g.numVertices()).toBe(3);
    expect(g.numEdges()).toBe(2);
    expect(g.adjacency()).toEqual([[1], [0, 2], [1]]);
  });

  it('keeps parallel edges and doubles a self-loop', () => {
    const g = GraphAdj.fromEdges([0, 1, 0, 1, 2, 2], 3);
    expect(g.numEdges()).toBe(3);
    // Parallel 0–1 kept twice; the self-loop on 2 appears twice in adj[2].
    expect(g.adjacency()).toEqual([[1, 1], [0, 0], [2, 2]]);
  });

  it('ignores out-of-range endpoints', () => {
    const g = GraphAdj.fromEdges([0, 1, 0, 9, 5, 1], 2);
    expect(g.numEdges()).toBe(1);
    expect(g.adjacency()).toEqual([[1], [0]]);
  });
});

describe('GraphAdj — traversal', () => {
  it('BFS visits by distance, DFS (mark-on-push) dives via the last push', () => {
    // 0–1–3 and 0–2.
    const g = GraphAdj.fromEdges([0, 1, 0, 2, 1, 3], 4);
    expect(g.bfs(0).order).toEqual([0, 1, 2, 3]);
    expect(g.dfs(0).order).toEqual([0, 2, 1, 3]);
  });

  it('both traversals cost exactly V + 2E on a connected graph', () => {
    // Triangle: V = 3, E = 3 ⇒ 9.
    const tri = GraphAdj.fromEdges([0, 1, 1, 2, 2, 0], 3);
    expect(tri.bfs(0)).toEqual({ order: [0, 1, 2], reached: 3, ops: 9 });
    expect(tri.dfs(0).ops).toBe(9);

    // Path of 5: V = 5, E = 4 ⇒ 13.
    const path = GraphAdj.fromEdges([0, 1, 1, 2, 2, 3, 3, 4], 5);
    expect(path.bfs(0).ops).toBe(13);
    expect(path.dfs(0).ops).toBe(13);
  });

  it('one extra edge at fixed V adds exactly two edge-visits (the "+E" term)', () => {
    const sparse = GraphAdj.fromEdges([0, 1, 1, 2, 2, 3], 4); // E = 3
    const dense = GraphAdj.fromEdges([0, 1, 1, 2, 2, 3, 0, 3], 4); // E = 4
    expect(dense.bfs(0).ops - sparse.bfs(0).ops).toBe(2);
  });

  it('a traversal reaches only the source component of a disconnected graph', () => {
    // Two triangles, no edge between.
    const g = GraphAdj.fromEdges([0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3], 6);
    expect(g.bfs(0)).toEqual({ order: [0, 1, 2], reached: 3, ops: 9 });
    expect(g.dfs(3).reached).toBe(3);
  });

  it('handles empty, isolated, and out-of-range sources', () => {
    expect(new GraphAdj(0).bfs(0)).toEqual({ order: [], reached: 0, ops: 0 });
    // Isolated source: one vertex-visit, no edges.
    expect(GraphAdj.fromEdges([], 3).bfs(0)).toEqual({ order: [0], reached: 1, ops: 1 });
    expect(GraphAdj.fromEdges([0, 1], 2).bfs(5)).toEqual({ order: [], reached: 0, ops: 0 });
  });
});
