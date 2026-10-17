import { describe, it, expect } from 'vitest';
import { measureGraphs, type TraversableGraph } from './graphBench';
import { GraphAdj } from '../structures/graph';
import { generateConnectedRandom, generatePath } from '../data/graphs';

/**
 * The graph's measurement loop, driven with the **TS teaching twin** standing in for the
 * WASM bench twin and a virtual clock that charges 1 ns per counted op — so the plumbing
 * (one build per graph, both traversals measured, the op-count beside the time, every twin
 * freed) is proven with no WASM and no timing flake.
 */
function fakeFactory(log: string[], clock: { t: number }) {
  return (edges: Uint32Array, numVertices: number): TraversableGraph => {
    const g = GraphAdj.fromEdges(Array.from(edges), numVertices);
    log.push(`build:${numVertices}`);
    const run = (kind: 'bfs' | 'dfs') => (k: number) => {
      const t = kind === 'bfs' ? g.bfs(0) : g.dfs(0);
      clock.t += (k * t.ops) / 1e6; // 1 ns per op, in ms
      return k * t.reached;
    };
    return {
      bfs_n: run('bfs'),
      dfs_n: run('dfs'),
      bfs_counted: () => g.bfs(0).ops,
      dfs_counted: () => g.dfs(0).ops,
      free: () => log.push(`free:${numVertices}`),
    };
  };
}

describe('measureGraphs', () => {
  it('measures BFS and DFS per graph, with the op-count and reach beside the time', () => {
    const log: string[] = [];
    const clock = { t: 0 };
    const graphs = [generatePath(500), generateConnectedRandom(1_000, 4, 1)];
    const out = measureGraphs(graphs, fakeFactory(log, clock), () => clock.t, {
      baseBatch: 1,
      reps: 3,
      warmupReps: 0,
      minBatchMillis: 0.01,
    });
    expect(out).toHaveLength(2);
    // Path: V + 2E = 500 + 2·499; random connected: 1000 + 2·2000. BFS ≡ DFS in cost.
    expect(out[0].bfs.opCount).toBe(500 + 2 * 499);
    expect(out[0].dfs.opCount).toBe(out[0].bfs.opCount);
    expect(out[1].bfs.opCount).toBe(1_000 + 2 * 2_000);
    expect([out[0].bfsReached, out[0].dfsReached]).toEqual([500, 500]);
    // n is the nominal V — a placeholder the orchestrator re-keys to V' + 2E'.
    expect(out[1].bfs.n).toBe(1_000);
    // The virtual clock charged 1 ns per op, so ns per traversal equals the op-count.
    expect(out[1].bfs.nanosPerOp).toBeCloseTo(out[1].bfs.opCount, 6);
    // One build per graph, each freed before the next is built.
    expect(log).toEqual(['build:500', 'free:500', 'build:1000', 'free:1000']);
  });

  it('frees the twin even when a measurement throws', () => {
    const log: string[] = [];
    const factory = (): TraversableGraph => ({
      bfs_n: () => {
        throw new Error('boom');
      },
      dfs_n: () => 0,
      bfs_counted: () => 0,
      dfs_counted: () => 0,
      free: () => log.push('free'),
    });
    expect(() => measureGraphs([generatePath(3)], factory, () => 0)).toThrow('boom');
    expect(log).toEqual(['free']);
  });
});
