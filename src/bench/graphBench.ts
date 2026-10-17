import { measurePoint, type Clock, type MeasureOptions, type SweepPoint } from './measure';

/**
 * The graph's timed measurement (docs/PLAN.md §6.2, §8 "Specialized"; docs/METHODOLOGY.md
 * §2.7) — the engine-side loop, kept here as a pure function so it is tested with a fake
 * graph and a virtual clock, exactly as `measure.ts` is, while the worker only supplies the
 * real `GraphAdj` constructor and `performance.now()`.
 *
 * The graph's one operation is a **whole traversal** from vertex 0, which is size-preserving
 * by nature, so there is no churn and no finite-difference split: each sweep point is one
 * graph, timed by `bfs_n(k)` / `dfs_n(k)` (`k` back-to-back traversals inside one WASM call,
 * `COUNT = false`) with the deterministic `bfs_counted` / `dfs_counted` op-count beside it.
 * Building the adjacency lists happens **before** timing; the traversals reuse the bench
 * twin's generation-stamped visited array and preallocated frontier, so nothing is allocated
 * inside the timed region (pinned in Rust by
 * `graph::tests::the_timed_traversals_never_grow_their_scratch`).
 */

/** One graph handed to the engine: flat dense-id edge pairs plus the vertex count. */
export interface GraphInput {
  /** `[u0, v0, u1, v1, …]`; the engine may transfer (detach) this buffer. */
  readonly edges: Uint32Array;
  readonly numVertices: number;
}

/**
 * What the engine measured on one graph: a timed BFS point and a timed DFS point, and how
 * many vertices each reached from vertex 0.
 *
 * Both points carry `n = numVertices` — the graph's **nominal** size, a placeholder. The
 * chart's x-coordinate is the *reached component's* `V' + 2E'`, which the orchestrator
 * computes independently from the edges and then checks the op-count against
 * (`src/compare/runGraphSweeps.ts`, PLAN §10 trap 4); the engine does not get to choose it.
 */
export interface GraphTraversalMeasure {
  readonly bfs: SweepPoint;
  readonly dfs: SweepPoint;
  readonly bfsReached: number;
  readonly dfsReached: number;
}

/**
 * The bench twin's timed surface, as `bench-engine/src/structures/graph.rs` exports it
 * through wasm-bindgen. `GraphAdj` satisfies it structurally.
 */
export interface TraversableGraph {
  /** `k` timed BFS traversals from 0; returns total vertices reached (defeats DCE). */
  bfs_n(k: number): number;
  /** `k` timed DFS traversals from 0; returns total vertices reached. */
  dfs_n(k: number): number;
  /** One counted BFS: vertex-visits + edge-visits. */
  bfs_counted(): number;
  /** One counted DFS: the same `V' + 2E'` total, a different order. */
  dfs_counted(): number;
  free(): void;
}

/** Builds the bench twin from one {@link GraphInput}. */
export type GraphFactory = (edges: Uint32Array, numVertices: number) => TraversableGraph;

/**
 * Measure BFS and DFS on every graph in order. One twin is built per graph (untimed), both
 * traversals are measured on it through {@link measurePoint} — so the graph gets the same
 * clamp-clearing auto-grow, warm-up, adaptive reps and spread as every other sweep — and it
 * is freed before the next graph is built.
 *
 * The per-point unit is **one traversal** (`nanosPerOp` = ns per whole BFS/DFS), which is
 * why the graph's options start the batch at 1 (`GRAPH_OPTS`): a 50k-vertex traversal is
 * already most of a millisecond.
 */
export function measureGraphs(
  graphs: readonly GraphInput[],
  build: GraphFactory,
  now: Clock,
  opts: MeasureOptions = {},
): GraphTraversalMeasure[] {
  return graphs.map(({ edges, numVertices }) => {
    const g = build(edges, numVertices);
    try {
      // Reachability once, outside any timed call: one traversal of each kind.
      const bfsReached = g.bfs_n(1);
      const dfsReached = g.dfs_n(1);
      const bfs = measurePoint(
        numVertices,
        () => ({ run: (k) => g.bfs_n(k), opCountPerOp: () => g.bfs_counted() }),
        now,
        opts,
      );
      const dfs = measurePoint(
        numVertices,
        () => ({ run: (k) => g.dfs_n(k), opCountPerOp: () => g.dfs_counted() }),
        now,
        opts,
      );
      return { bfs, dfs, bfsReached, dfsReached };
    } finally {
      g.free();
    }
  });
}
