import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-graph.txt?raw';
import { GraphAdj } from './graph';

/**
 * Cross-language conformance for the graph (docs/PLAN.md §8, §12, risk R1). The committed
 * `corpus-graph.txt` is generated from the Rust bench impl (the source of truth, docs/PLAN.md
 * §2.1); this test holds the TypeScript teaching twin to the same observable behaviour across
 * the dimensions this structure needs and no earlier corpus carries:
 *
 *  - the **adjacency profile** — each vertex's neighbour list. A twin that pushed only one
 *    direction of an edge, or deduped parallel edges / dropped a self-loop's second entry,
 *    still reaches every vertex on a traversal; only this pin catches it.
 *  - **two traversal orders** — BFS (a queue) and DFS (an explicit stack, mark-on-push) visit
 *    the same vertices in different orders; the mark-on-push pop order is the drift-prone half.
 *  - **per-traversal `(reached : ops)`** — the vertex-visit + edge-visit count (`V + 2E` when
 *    the source's component is the whole graph), which pins the two counting rules and, on the
 *    disconnected case, that a traversal reaches only its source's component.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_graph`.
 */

interface Cost {
  reached: number;
  ops: number;
}

interface Case {
  name: string;
  vertices: number;
  edges: number[];
  adj: number[][];
  bfs: number[];
  bfsCost: Cost;
  dfs: number[];
  dfsCost: Cost;
}

function parseNums(rest: string): number[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
}

/** The adjacency profile: vertices separated by `|`, `-` for a graph with no vertices. */
function parseAdj(rest: string): number[][] {
  if (rest.trim() === '-') return [];
  return rest.split('|').map(parseNums);
}

/** A `<reached>:<ops>` cost token. */
function parseCost(rest: string): Cost {
  const [reached, ops] = rest.trim().split(':');
  return { reached: Number(reached), ops: Number(ops) };
}

function parseCorpus(text: string): Case[] {
  const cases: Case[] = [];
  let cur: Partial<Case> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    switch (tag) {
      case 'case':
        if (cur) cases.push(cur as Case);
        cur = { name: rest };
        break;
      case 'vertices':
        cur!.vertices = Number(rest);
        break;
      case 'edges':
        cur!.edges = parseNums(rest);
        break;
      case 'graph_adj':
        cur!.adj = parseAdj(rest);
        break;
      case 'graph_bfs':
        cur!.bfs = parseNums(rest);
        break;
      case 'graph_bfs_cost':
        cur!.bfsCost = parseCost(rest);
        break;
      case 'graph_dfs':
        cur!.dfs = parseNums(rest);
        break;
      case 'graph_dfs_cost':
        cur!.dfsCost = parseCost(rest);
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS GraphAdj vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('adjacency profile matches Rust', () => {
      const g = GraphAdj.fromEdges(c.edges, c.vertices);
      expect(g.adjacency()).toEqual(c.adj);
    });

    it('BFS order and (reached, ops) match Rust', () => {
      const g = GraphAdj.fromEdges(c.edges, c.vertices);
      const t = g.bfs(0);
      expect(t.order).toEqual(c.bfs);
      expect({ reached: t.reached, ops: t.ops }).toEqual(c.bfsCost);
    });

    it('DFS order and (reached, ops) match Rust', () => {
      const g = GraphAdj.fromEdges(c.edges, c.vertices);
      const t = g.dfs(0);
      expect(t.order).toEqual(c.dfs);
      expect({ reached: t.reached, ops: t.ops }).toEqual(c.dfsCost);
    });
  });
});
