import { mulberry32, randInt } from './rng';

/**
 * The graph's data (docs/PLAN.md §4.3, §8 "Specialized"; docs/METHODOLOGY.md §2.7). Every
 * other structure is fed the dataset's *keys*; a graph needs **edges**, which a list of keys
 * does not carry. So the graph has its own data: seeded synthetic generators, which drive the
 * two Compare sweeps and are labelled synthetic, and a user's own edge list (`./edgeList`).
 * What this module deliberately does **not** do is fabricate edges out of a key dataset
 * (linking key *i* to key *i+1*) — that would present a made-up structure as measured reality.
 *
 * A graph is held in the shape the bench twin's constructor takes (`GraphAdj::new` in
 * `bench-engine/src/structures/graph.rs`): a flat `[u0, v0, u1, v1, …]` buffer of **dense
 * integer** vertex ids `0..numVertices`, plus the vertex count. A `Uint32Array` makes the
 * "ids are integers" half of PLAN §10 trap 3 a property of the type: the TS twin indexes its
 * adjacency lists by id, and `adjLists[1.5]` would be `undefined`.
 *
 * Every generator here is a **multigraph-honest** builder: it never deduplicates. The random
 * one can draw a self-loop or a parallel edge, and both are kept — the project's "never
 * dedupe" rule, and what keeps the twins' `add_edge` O(1).
 */

/** Where a graph came from — carried with it so a chart can say *what* was measured. */
export type GraphOrigin =
  | {
      /** A random **connected** graph: a random spanning tree plus uniform extra edges. */
      readonly kind: 'random';
      readonly vertices: number;
      /** The requested average degree `2E / V` (clamped up to a tree's when lower). */
      readonly degree: number;
      readonly seed: number;
    }
  | { readonly kind: 'path'; readonly vertices: number }
  | { readonly kind: 'grid'; readonly rows: number; readonly cols: number }
  | {
      /** The first `edges` of a user's edge list (`./edgeList`), relabelled densely. */
      readonly kind: 'edge-list';
      readonly edges: number;
      readonly totalEdges: number;
    };

/** A graph in the bench twin's input shape, plus where it came from. */
export interface GraphData {
  /** Flat `[u0, v0, u1, v1, …]` pairs of dense vertex ids, each `< numVertices`. */
  readonly edges: Uint32Array;
  readonly numVertices: number;
  readonly origin: GraphOrigin;
}

/** Number of undirected edges in `g` (a self-loop counts once). */
export function edgeCount(g: GraphData): number {
  return g.edges.length >> 1;
}

/** Average degree `2E / V` (0 for an empty graph) — the quantity the degree-sweep grows. */
export function averageDegree(g: GraphData): number {
  return g.numVertices > 0 ? (2 * edgeCount(g)) / g.numVertices : 0;
}

/** Edges needed for average degree `degree` on `vertices` vertices, never fewer than a tree's. */
export function edgesForDegree(vertices: number, degree: number): number {
  if (vertices <= 0) return 0;
  return Math.max(vertices - 1, Math.round((degree * vertices) / 2));
}

function checkCount(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got ${n})`);
}

/**
 * A random **connected** graph on `vertices` vertices at average degree `degree`
 * (docs/METHODOLOGY.md §2.7 — the generator the V-sweep and the degree-sweep run on).
 *
 * Built in two seeded stages: first a random spanning tree (vertex `i` links to a uniformly
 * chosen earlier vertex — a random recursive tree), which makes the graph connected, so a
 * traversal from vertex 0 reaches **every** vertex and costs exactly `V + 2E`; then uniform
 * random extra edges until `E = round(degree · V / 2)`. A requested degree below a tree's
 * (`2(V−1)/V`) is clamped up to the tree, since fewer edges cannot connect `V` vertices.
 *
 * **Nested by construction.** The tree consumes the same random draws whatever the degree,
 * and the extra edges are drawn in order, so for one `(vertices, seed)` a lower-degree graph's
 * edge list is an exact **prefix** of a higher-degree one's. The degree-sweep therefore adds
 * edges to *the same* graph rather than drawing a new one at each point: `V` is literally
 * fixed and only `E` grows — the `+E` term in isolation (pinned in `graphs.test.ts`).
 *
 * Extra edges are drawn independently, so a self-loop (probability `1/V` each) or a parallel
 * edge can occur; both are kept (never dedupe).
 */
export function generateConnectedRandom(vertices: number, degree: number, seed = 1): GraphData {
  checkCount('vertices', vertices);
  if (!Number.isFinite(degree) || degree < 0) {
    throw new Error(`degree must be a finite non-negative number (got ${degree})`);
  }
  const rng = mulberry32(seed);
  const e = edgesForDegree(vertices, degree);
  const edges = new Uint32Array(2 * e);
  let w = 0;
  for (let i = 1; i < vertices; i++) {
    edges[w++] = randInt(rng, 0, i - 1);
    edges[w++] = i;
  }
  while (w < edges.length) {
    edges[w++] = randInt(rng, 0, vertices - 1);
    edges[w++] = randInt(rng, 0, vertices - 1);
  }
  return { edges, numVertices: vertices, origin: { kind: 'random', vertices, degree, seed } };
}

/**
 * A path `0 – 1 – … – (V−1)`: connected, average degree just under 2, and the graph whose
 * depth-first traversal would overflow a recursive DFS — the reason the twins' DFS keeps an
 * explicit stack (docs/METHODOLOGY.md §2.7).
 */
export function generatePath(vertices: number): GraphData {
  checkCount('vertices', vertices);
  const e = Math.max(0, vertices - 1);
  const edges = new Uint32Array(2 * e);
  for (let i = 0; i < e; i++) {
    edges[2 * i] = i;
    edges[2 * i + 1] = i + 1;
  }
  return { edges, numVertices: vertices, origin: { kind: 'path', vertices } };
}

/**
 * A `rows × cols` grid, vertex `r·cols + c` linked to its right and lower neighbours:
 * connected, average degree just under 4, and a breadth-first frontier that grows as a
 * diagonal wavefront rather than a tree's fan-out.
 */
export function generateGrid(rows: number, cols: number): GraphData {
  checkCount('rows', rows);
  checkCount('cols', cols);
  const e = rows > 0 && cols > 0 ? rows * (cols - 1) + cols * (rows - 1) : 0;
  const edges = new Uint32Array(2 * e);
  let w = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = r * cols + c;
      if (c + 1 < cols) {
        edges[w++] = v;
        edges[w++] = v + 1;
      }
      if (r + 1 < rows) {
        edges[w++] = v;
        edges[w++] = v + cols;
      }
    }
  }
  return { edges, numVertices: rows * cols, origin: { kind: 'grid', rows, cols } };
}

/** A square-ish grid with about `vertices` vertices (`side = round(√V)`), for a V-sweep. */
export function generateGridNear(vertices: number): GraphData {
  checkCount('vertices', vertices);
  const side = Math.max(1, Math.round(Math.sqrt(vertices)));
  return generateGrid(side, side);
}

/** One-line human description of a graph's origin, for chart captions and the status line. */
export function describeGraph(g: GraphData): string {
  const o = g.origin;
  const size = `V = ${g.numVertices.toLocaleString()}, E = ${edgeCount(g).toLocaleString()}`;
  switch (o.kind) {
    case 'random':
      return `synthetic connected random graph, average degree ${o.degree} (seed ${o.seed}) — ${size}`;
    case 'path':
      return `synthetic path — ${size}`;
    case 'grid':
      return `synthetic ${o.rows} × ${o.cols} grid — ${size}`;
    case 'edge-list':
      return `your edge list, first ${o.edges.toLocaleString()} of ${o.totalEdges.toLocaleString()} edges — ${size}`;
  }
}
