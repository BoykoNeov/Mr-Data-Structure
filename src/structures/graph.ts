/**
 * Teaching implementation of the undirected **graph** (docs/PLAN.md §8, "Specialized") —
 * the TypeScript twin of the Rust bench impl (`bench-engine/src/structures/graph.rs`), held
 * to it by `conformance/corpus-graph.txt` (docs/PLAN.md §12, risk R1).
 *
 * A graph is not a key container: its op set (docs/PLAN.md §4.1, §8) is **build (add edges)
 * + traverse**, not insert/search/delete of a key, so it is compared only within its own
 * group and never merged onto the canonical charts (risk R6).
 *
 * **Representation — an adjacency-list multigraph (never deduped).** `adj[u]` is `u`'s
 * neighbours in edge-insertion order. `addEdge(u, v)` pushes each endpoint onto the other's
 * list (undirected), so a self-loop `(u, u)` appears **twice** in `adj[u]` — the convention
 * that keeps `Σ deg = 2E`. Parallel edges are kept (docs/PLAN.md "never dedupe"), which is
 * also what keeps `addEdge` O(1).
 *
 * **Cost metric — vertex-visits + edge-visits, i.e. `V + 2E`** (docs/PLAN.md §8). One
 * vertex-visit per vertex taken off the frontier (dequeued in BFS, popped in DFS), and one
 * edge-visit per adjacency entry examined. On a connected graph both traversals cost exactly
 * `V + 2E`; the two counting rules must match `graph.rs` exactly or the corpus diverges.
 *
 * **BFS (a queue) and DFS (an explicit stack, mark-on-push — never recursion) cost the same
 * and visit in different orders** — the point of drawing both. The Rust module doc carries
 * the full reasoning, including why DFS is iterative (a long path would overflow the stack).
 *
 * **Tracing (docs/PLAN.md §5).** `bfs` / `dfs` take an optional {@link Tracer} that receives
 * the step-events the Explore animation replays. A `graph.visit` / `graph.examine` is emitted
 * exactly where the two counting rules increment `ops`, so the stream's cost-event count is the
 * op-count by construction (`src/viz/trace.graph.test.ts`, chained to the corpus). The tracer
 * only observes — it changes no control flow and no counter (pinned by the traced-vs-untraced
 * pair there).
 */

import type { Tracer, GraphEvent, GraphAlgo } from '../viz/events';

/** One traversal's result: the visit order, how many vertices it reached, and its op-count. */
export interface Traversal {
  /** Vertices in the order the traversal visited (dequeued / popped) them. */
  readonly order: number[];
  /** How many vertices were reached (the source's connected component). */
  readonly reached: number;
  /** Vertex-visits + edge-visits — `V + 2E` when the source's component is the whole graph. */
  readonly ops: number;
}

/**
 * An undirected graph over dense integer vertex ids `0..numVertices`, stored as an
 * adjacency-list multigraph (parallel edges and self-loops kept).
 */
export class GraphAdj {
  private readonly adjLists: number[][];
  private edgeCount = 0;

  /** An empty graph on `numVertices` isolated vertices. */
  constructor(numVertices: number) {
    this.adjLists = Array.from({ length: numVertices }, () => []);
  }

  /**
   * Build from a flat `[u0, v0, u1, v1, …]` edge buffer and a vertex count — the shape the
   * marshaller / corpus produce. Out-of-range pairs are skipped, matching the Rust twin.
   */
  static fromEdges(edges: readonly number[], numVertices: number): GraphAdj {
    const g = new GraphAdj(numVertices);
    for (let i = 0; i + 1 < edges.length; i += 2) {
      g.addEdge(edges[i], edges[i + 1]);
    }
    return g;
  }

  /** Number of vertices (`V`). */
  numVertices(): number {
    return this.adjLists.length;
  }

  /** Number of undirected edges (`E`); a self-loop counts once. */
  numEdges(): number {
    return this.edgeCount;
  }

  /**
   * Add an undirected edge `u–v`: push each endpoint onto the other's list. A self-loop
   * pushes `u` onto `adj[u]` **twice** (Σ deg = 2E). O(1), no dedup. Out-of-range endpoints
   * are ignored.
   */
  addEdge(u: number, v: number): void {
    const n = this.adjLists.length;
    if (u < 0 || v < 0 || u >= n || v >= n) return;
    this.adjLists[u].push(v);
    this.adjLists[v].push(u);
    this.edgeCount += 1;
  }

  /**
   * Breadth-first traversal from `source`, **mark-on-enqueue**. Counts one vertex-visit per
   * dequeue and one edge-visit per adjacency entry examined.
   */
  bfs(source: number, trace?: Tracer<GraphEvent>): Traversal {
    return this.traverse(source, false, trace);
  }

  /**
   * Depth-first traversal from `source`, **iterative, mark-on-push**. Same counting rules as
   * BFS, so the same `V + 2E` total in a different visitation order. Neighbours are pushed in
   * adjacency order, so they are popped last-to-first — the pinned DFS order.
   */
  dfs(source: number, trace?: Tracer<GraphEvent>): Traversal {
    return this.traverse(source, true, trace);
  }

  /**
   * Shared traversal body. `stack` selects DFS (LIFO pop) vs BFS (FIFO via a head cursor).
   * The frontier only grows and is read by cursor/pop, exactly as the Rust twin's reused
   * buffer — the visitation order and counts are identical.
   *
   * With a tracer, each counter increment emits its cost event at the same point, and the
   * mark + frontier push that follows a discovery emits a free `graph.mark`. An out-of-range
   * source emits nothing at all (0 events, `ops: 0`).
   */
  private traverse(source: number, stack: boolean, trace?: Tracer<GraphEvent>): Traversal {
    const order: number[] = [];
    if (source < 0 || source >= this.adjLists.length) {
      return { order, reached: 0, ops: 0 };
    }
    const algo: GraphAlgo = stack ? 'dfs' : 'bfs';
    const visited = new Uint8Array(this.adjLists.length);
    const frontier: number[] = [source];
    visited[source] = 1;
    trace?.({ kind: 'graph.start', algo, source });
    let ops = 0;
    let head = 0;
    for (;;) {
      let u: number;
      if (stack) {
        const popped = frontier.pop();
        if (popped === undefined) break;
        u = popped;
      } else {
        if (head >= frontier.length) break;
        u = frontier[head];
        head += 1;
      }
      ops += 1; // rule 1: a vertex is visited
      trace?.({ kind: 'graph.visit', algo, vertex: u });
      order.push(u);
      const nbrs = this.adjLists[u];
      for (let i = 0; i < nbrs.length; i += 1) {
        const w = nbrs[i];
        ops += 1; // rule 2: an adjacency entry is examined
        const discovers = !visited[w];
        trace?.({ kind: 'graph.examine', from: u, slot: i, to: w, discovers });
        if (discovers) {
          visited[w] = 1;
          frontier.push(w);
          trace?.({ kind: 'graph.mark', vertex: w });
        }
      }
    }
    trace?.({ kind: 'graph.done', reached: order.length });
    return { order, reached: order.length, ops };
  }

  /**
   * The adjacency lists, one per vertex, in edge-insertion order — the structure's observable
   * shape (a conformance dimension: catches a divergent edge build even when traversals still
   * reach every vertex).
   */
  adjacency(): number[][] {
    return this.adjLists.map((nbrs) => nbrs.slice());
  }
}
