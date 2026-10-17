import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-graph.txt?raw';
import { GraphAdj } from '../structures/graph';
import { countCostEvents, type GraphEvent, type GraphAlgo } from './events';
import { GRAPH_SEED } from './VizPanel';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty gate,
 * risk R1) for the **graph**. Its cost metric is **vertex-visits + edge-visits**
 * (docs/PLAN.md §8): one per vertex taken off the frontier, one per adjacency entry
 * examined. The two cost events are `graph.visit` and `graph.examine`, so
 *
 *     countCostEvents(stream) === op-count     (V + 2E on a connected graph)
 *
 * holds for **BFS and DFS**. Starting, marking and finishing are free.
 *
 * **Both traversals are chained to the Rust source of truth.** Every corpus case is
 * run traced, and the stream is held to the corpus's *own* numbers — its `ops`, its
 * `reached`, and its visit order — not merely to the TS twin's return value. The corpus
 * is generated from the Rust bench twin, so the animation is tied to Rust directly, and
 * the traced-vs-untraced comparison proves the tracer perturbs nothing. Unlike the trie
 * and the skip list there is no weaker half: a traversal is the graph's whole op set.
 *
 * The hand-computed totals on the shipped seed guard against a *symmetric* miscount (a
 * step dropped from the tracer and the counter together), which no self-consistency
 * check can catch.
 */

interface Case {
  name: string;
  vertices: number;
  edges: number[];
  bfs: number[];
  bfsReached: number;
  bfsOps: number;
  dfs: number[];
  dfsReached: number;
  dfsOps: number;
}

/** The corpus lines this file needs; the full parser (which also checks the adjacency
 * profile) lives in `src/structures/conformance-graph.test.ts`. */
function corpusCases(text: string): Case[] {
  const cases: Case[] = [];
  const nums = (rest: string) => rest.split(/\s+/).filter((t) => t.length > 0).map(Number);
  const cost = (rest: string) => rest.trim().split(':').map(Number);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    const cur = cases[cases.length - 1];
    if (tag === 'case') {
      cases.push({ name: rest, vertices: 0, edges: [], bfs: [], bfsReached: 0, bfsOps: 0, dfs: [], dfsReached: 0, dfsOps: 0 });
    } else if (tag === 'vertices') cur.vertices = Number(rest);
    else if (tag === 'edges') cur.edges = nums(rest);
    else if (tag === 'graph_bfs') cur.bfs = nums(rest);
    else if (tag === 'graph_dfs') cur.dfs = nums(rest);
    else if (tag === 'graph_bfs_cost') [cur.bfsReached, cur.bfsOps] = cost(rest);
    else if (tag === 'graph_dfs_cost') [cur.dfsReached, cur.dfsOps] = cost(rest);
  }
  return cases;
}

const corpus = corpusCases(corpusText);

const run = (g: GraphAdj, algo: GraphAlgo, source: number) => {
  const events: GraphEvent[] = [];
  const push = (e: GraphEvent) => events.push(e);
  const r = algo === 'bfs' ? g.bfs(source, push) : g.dfs(source, push);
  return { r, events };
};

const visits = (events: readonly GraphEvent[]) =>
  events.flatMap((e) => (e.kind === 'graph.visit' ? [e.vertex] : []));

/** Structural well-formedness of a stream, independent of any count: it opens with a
 * start and closes with a done; each visit is followed by exactly that vertex's whole
 * adjacency list, slot by slot, in order; and an examine is followed by a mark of its
 * neighbour iff it discovers. A tracer that skipped an entry, or marked on the wrong
 * step, would pass a bare count check only by luck — this catches it outright. */
function expectWellFormed(g: GraphAdj, events: readonly GraphEvent[]) {
  const adj = g.adjacency();
  expect(events[0].kind).toBe('graph.start');
  expect(events[events.length - 1].kind).toBe('graph.done');
  let i = 1;
  while (i < events.length - 1) {
    const v = events[i];
    expect(v.kind).toBe('graph.visit');
    if (v.kind !== 'graph.visit') return;
    i += 1;
    for (let slot = 0; slot < adj[v.vertex].length; slot++) {
      const x = events[i];
      expect(x).toMatchObject({ kind: 'graph.examine', from: v.vertex, slot, to: adj[v.vertex][slot] });
      i += 1;
      if (x.kind === 'graph.examine' && x.discovers) {
        expect(events[i]).toEqual({ kind: 'graph.mark', vertex: x.to });
        i += 1;
      } else {
        expect(events[i]?.kind).not.toBe('graph.mark');
      }
    }
  }
}

describe('graph: cost-events == vertex-visits + edge-visits, over the Rust conformance corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('BFS: the stream carries exactly the corpus op-count, visits in the corpus order', () => {
      const g = GraphAdj.fromEdges(c.edges, c.vertices);
      const { r, events } = run(g, 'bfs', 0);
      expect(countCostEvents(events)).toBe(c.bfsOps);
      expect(visits(events)).toEqual(c.bfs);
      expect(visits(events)).toHaveLength(c.bfsReached);
      expect(events.filter((e) => e.kind === 'graph.examine')).toHaveLength(c.bfsOps - c.bfsReached);
      expect(r).toEqual(g.bfs(0)); // the tracer perturbs nothing
      if (c.vertices > 0) {
        expectWellFormed(g, events);
        expect(events[events.length - 1]).toEqual({ kind: 'graph.done', reached: c.bfsReached });
      }
    });

    it('DFS: the stream carries exactly the corpus op-count, visits in the corpus order', () => {
      const g = GraphAdj.fromEdges(c.edges, c.vertices);
      const { r, events } = run(g, 'dfs', 0);
      expect(countCostEvents(events)).toBe(c.dfsOps);
      expect(visits(events)).toEqual(c.dfs);
      expect(visits(events)).toHaveLength(c.dfsReached);
      expect(events.filter((e) => e.kind === 'graph.examine')).toHaveLength(c.dfsOps - c.dfsReached);
      expect(r).toEqual(g.dfs(0));
      if (c.vertices > 0) {
        expectWellFormed(g, events);
        expect(events[events.length - 1]).toEqual({ kind: 'graph.done', reached: c.dfsReached });
      }
    });
  });

  it('an empty graph (or any out-of-range source) emits nothing and costs nothing', () => {
    const empty = GraphAdj.fromEdges([], 0);
    expect(run(empty, 'bfs', 0).events).toEqual([]);
    const g = GraphAdj.fromEdges([0, 1], 2);
    for (const algo of ['bfs', 'dfs'] as const) {
      const { r, events } = run(g, algo, 5);
      expect(events).toEqual([]);
      expect(r).toEqual({ order: [], reached: 0, ops: 0 });
    }
  });
});

/** Textbook recursive DFS — the version the animation must NOT be showing. */
function recursiveDfsOrder(adj: readonly (readonly number[])[], source: number): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  const go = (u: number) => {
    seen.add(u);
    order.push(u);
    for (const w of adj[u]) if (!seen.has(w)) go(w);
  };
  go(source);
  return order;
}

describe('graph: the shipped seed, hand-counted (anchored, not just self-consistent)', () => {
  // GRAPH_SEED (VizPanel.tsx): V = 8, E = 10 — a parallel 1–2 pair and a self-loop on 4
  // included — and vertex 7 isolated. 0's component is the other 7 vertices and all 10
  // edges, so a traversal from 0 costs V′ + 2E′ = 7 + 20 = 27, not the whole graph's
  // V + 2E = 28: the unreachable vertex costs nothing.
  const g = GraphAdj.fromEdges(GRAPH_SEED.edges, GRAPH_SEED.vertices);

  it('is the graph the comments describe', () => {
    expect(g.numVertices()).toBe(8);
    expect(g.numEdges()).toBe(10);
    expect(g.adjacency()).toEqual([
      [3, 1, 5],
      [0, 2, 2], // the parallel 1–2 edge: two entries
      [3, 1, 4, 1],
      [0, 2],
      [2, 6, 4, 4], // the self-loop: 4 appears twice in its own list
      [0, 6],
      [5, 4],
      [], // isolated
    ]);
  });

  it('BFS and DFS cost the same 27 = 7 vertex-visits + 20 edge-visits, in different orders', () => {
    const bfs = run(g, 'bfs', 0);
    const dfs = run(g, 'dfs', 0);
    expect(bfs.r).toEqual({ order: [0, 3, 1, 5, 2, 6, 4], reached: 7, ops: 27 });
    expect(dfs.r).toEqual({ order: [0, 5, 6, 4, 2, 1, 3], reached: 7, ops: 27 });
    for (const { events } of [bfs, dfs]) {
      expect(countCostEvents(events)).toBe(27);
      expect(events.filter((e) => e.kind === 'graph.visit')).toHaveLength(7);
      expect(events.filter((e) => e.kind === 'graph.examine')).toHaveLength(20); // 2E′, E′ = 10
    }
    expect(bfs.r.order).not.toEqual(dfs.r.order);
  });

  it('the DFS shown is mark-on-push, not textbook recursion — and the seed tells them apart', () => {
    // Recursion would go 0 → 3 → 2 → 1 → 4 → 6 → 5. The animated rule does not.
    expect(recursiveDfsOrder(g.adjacency(), 0)).toEqual([0, 3, 2, 1, 4, 6, 5]);
    expect(recursiveDfsOrder(g.adjacency(), 0)).not.toEqual(g.dfs(0).order);
  });

  it('DFS skips an edge to a vertex that is marked but not yet visited — the frame mark-on-push exists for', () => {
    const { events } = run(g, 'dfs', 0);
    const visited = new Set<number>();
    const skippedWhileWaiting: number[] = [];
    for (const e of events) {
      if (e.kind === 'graph.visit') visited.add(e.vertex);
      if (e.kind === 'graph.examine' && !e.discovers && !visited.has(e.to)) skippedWhileWaiting.push(e.to);
    }
    // When 2 is popped it sees 3 and 1 (twice — the parallel edge), all still on the stack.
    expect(skippedWhileWaiting).toEqual([3, 1, 1]);
  });

  it('the self-loop costs two edge-visits from its one vertex, and discovers nothing', () => {
    const { events } = run(g, 'bfs', 0);
    const loops = events.filter((e) => e.kind === 'graph.examine' && e.from === 4 && e.to === 4);
    expect(loops).toHaveLength(2);
    expect(loops.every((e) => e.kind === 'graph.examine' && !e.discovers)).toBe(true);
  });

  it('a traversal from the isolated vertex costs exactly its one visit', () => {
    for (const algo of ['bfs', 'dfs'] as const) {
      const { r, events } = run(g, algo, 7);
      expect(r).toEqual({ order: [7], reached: 1, ops: 1 });
      expect(countCostEvents(events)).toBe(1);
    }
  });
});
