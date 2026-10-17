import { describe, it, expect } from 'vitest';
import { SkipListF64 } from '../structures/skipList';
import { GraphAdj } from '../structures/graph';
import { describeSkip, describeGraph, summarizeGraph, GRAPH_SEED } from './VizPanel';
import { graphModel, reduceGraph, type GraphModel } from './model';
import type { SkipListEvent, GraphEvent } from './events';

/**
 * The skip list's step caption reads the comparison direction from value-vs-target,
 * not from being told the op. The trap (advisor-flagged): an insert descends with `≤`,
 * so it *advances past an equal key* — and a caption that hard-codes "smaller" would
 * then narrate "compare 50 = 50 → smaller", which is wrong and is the first thing a
 * user sees, since the seed invites the duplicate 50. A render smoke can't catch a
 * wrong string, so this asserts the wording directly.
 */
describe('describeSkip: an advance on an equal key is not "smaller"', () => {
  const capture = (op: (s: SkipListF64, push: (e: SkipListEvent) => void) => void) => {
    const s = SkipListF64.fromKeys([10, 30, 40, 50, 50, 90, 220, 270]);
    const events: SkipListEvent[] = [];
    op(s, (e) => events.push(e));
    return events;
  };

  it('inserting a duplicate 50 narrates the equal steps as "equal", never "smaller"', () => {
    const events = capture((s, p) => s.insert(50, p));
    const equalAdvances = events.filter(
      (e): e is Extract<SkipListEvent, { kind: 'skip.inspect' }> =>
        e.kind === 'skip.inspect' && e.outcome === 'advance' && e.value === e.target,
    );
    // The seed has two 50s, both height 1, so the insert advances past them at level 0.
    expect(equalAdvances.length).toBeGreaterThan(0);
    for (const e of equalAdvances) {
      const caption = describeSkip(e);
      expect(caption).not.toContain('smaller');
      expect(caption).toContain('equal');
    }
  });

  it('a search still says "smaller" on a strictly-smaller step (the ordinary case)', () => {
    const events = capture((s, p) => s.search(100, p));
    const smallerAdvances = events.filter(
      (e): e is Extract<SkipListEvent, { kind: 'skip.inspect' }> =>
        e.kind === 'skip.inspect' && e.outcome === 'advance' && e.value < e.target,
    );
    expect(smallerAdvances.length).toBeGreaterThan(0);
    for (const e of smallerAdvances) expect(describeSkip(e)).toContain('smaller');
  });
});

/**
 * The graph's captions and summary line carry its two teaching claims in words, so
 * they are asserted directly: a DFS skip of a vertex that is only *marked* (still on
 * the stack) must not be narrated as "already visited" — that would describe textbook
 * recursion, not the mark-on-push rule both twins run — and the summary's
 * `V′ + 2E′` must be a check (E′ counted from the reached edges), not a relabel.
 */
describe('graph captions and summary', () => {
  const g = GraphAdj.fromEdges(GRAPH_SEED.edges, GRAPH_SEED.vertices);
  const base = graphModel(GRAPH_SEED.vertices, GRAPH_SEED.edges);

  /** Each event's caption, read against the model folded through that event — the
   * frame the panel shows it on. */
  const captions = (algo: 'bfs' | 'dfs') => {
    const events: GraphEvent[] = [];
    if (algo === 'bfs') g.bfs(0, (e) => events.push(e));
    else g.dfs(0, (e) => events.push(e));
    let m: GraphModel = base;
    return events.map((e) => {
      m = reduceGraph(m, e);
      return { e, text: describeGraph(e, m) };
    });
  };

  it('DFS narrates a marked-but-unvisited skip as "still waiting on the stack", never "visited"', () => {
    const waits = captions('dfs').filter(({ e }) => e.kind === 'graph.examine' && !e.discovers && (e.to === 3 || e.to === 1) && e.from === 2);
    expect(waits).toHaveLength(3); // 2 meets 3, 1, 1 (the parallel copy) — all on the stack
    for (const { text } of waits) {
      expect(text).toContain('still waiting on the stack');
      expect(text).not.toContain('already visited');
    }
    // …and the parallel copy says it is one of two.
    expect(waits.filter(({ text }) => text.includes('one of 2 parallel 2–1 edges'))).toHaveLength(2);
  });

  it('the self-loop is narrated as two entries of its own list', () => {
    const loops = captions('bfs').filter(({ e }) => e.kind === 'graph.examine' && e.from === 4 && e.to === 4);
    expect(loops).toHaveLength(2);
    for (const { text } of loops) expect(text).toContain('self-loop');
  });

  it('a DFS mark is narrated as happening on push, before the visit', () => {
    const marks = captions('dfs').filter(({ e }) => e.kind === 'graph.mark');
    expect(marks.length).toBeGreaterThan(0);
    for (const { text } of marks) expect(text).toContain('on push');
  });

  it('the end of a traversal from 0 names the unreached vertex as costing nothing', () => {
    const last = captions('bfs').at(-1);
    expect(last?.text).toContain('reached 7 of 8');
    expect(last?.text).toContain('cost nothing');
  });

  it('the summary states both orders, the split cost, and V′ + 2E′ for the reached component', () => {
    const s = summarizeGraph(g, base, 0, 'bfs');
    expect(s).toContain('BFS from 0 → 0 3 1 5 2 6 4');
    expect(s).toContain('DFS from 0 → 0 5 6 4 2 1 3');
    expect(s).toContain('the same 27 ops each (7 vertex-visits + 20 edge-visits = V′ + 2E′ = 7 + 2·10), in different orders');
    expect(s).toContain('Reached 7 of 8');
    expect(s).toContain('V + 2E = 28');
    // Run DFS first and the summary leads with DFS.
    expect(summarizeGraph(g, base, 0, 'dfs').startsWith('DFS from 0')).toBe(true);
  });

  it('on a connected graph the summary says it is the whole graph’s V + 2E', () => {
    const tri = GraphAdj.fromEdges([0, 1, 1, 2, 2, 0], 3);
    const s = summarizeGraph(tri, graphModel(3, [0, 1, 1, 2, 2, 0]), 0, 'bfs');
    expect(s).toContain('9 ops each (3 vertex-visits + 6 edge-visits = V + 2E = 3 + 2·3)');
    expect(s).toContain('whole graph');
  });
});
