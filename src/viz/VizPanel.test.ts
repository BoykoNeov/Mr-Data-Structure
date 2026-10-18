import { describe, it, expect } from 'vitest';
import { SkipListF64 } from '../structures/skipList';
import { GraphAdj } from '../structures/graph';
import { DoublyLinkedListF64 } from '../structures/linkedList';
import { HashSetOaF64 } from '../structures/hashSetOa';
import { describeSkip, describeGraph, summarizeGraph, describeDoubly, DOUBLY_INTRO, GRAPH_SEED, describeOa, OA_SEED } from './VizPanel';
import { graphModel, reduceGraph, doublyModel, foldDoublyList, oaModel, foldOa, type GraphModel } from './model';
import type { SkipListEvent, GraphEvent, DoublyListEvent, HashSetOaEvent } from './events';

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

/**
 * The doubly list's honesty is in its wording (docs/METHODOLOGY.md §2.11): a back
 * pointer must never read as making delete cheaper. Every pointer write says it is free
 * and not a node-visit, every visit says it is the singly list's walk, and the intro says
 * the counts are equal. A render smoke can't catch a wrong string.
 */
describe('doubly-list captions: the back link is free and buys no visits', () => {
  const captions = (keys: number[], op: (l: DoublyLinkedListF64, p: (e: DoublyListEvent) => void) => void) => {
    const l = DoublyLinkedListF64.fromKeys(keys);
    const before = doublyModel(l.snapshot());
    const events: DoublyListEvent[] = [];
    op(l, (e) => events.push(e));
    return events.map((e, i) => ({ e, text: describeDoubly(e, foldDoublyList(before, events.slice(0, i + 1))) }));
  };

  it('every pointer write is narrated as free, not a node-visit', () => {
    const all = [
      ...captions([10, 20, 30, 40], (l, p) => l.delete(30, p)),
      ...captions([10, 20], (l, p) => l.insert(5, p)),
      ...captions([], (l, p) => l.insert(5, p)),
      ...captions([7], (l, p) => l.delete(7, p)),
    ];
    const writes = all.filter(({ e }) => e.kind === 'dll.relink');
    expect(writes.length).toBe(2 + 3 + 3 + 2);
    for (const { text } of writes) expect(text).toContain('free, not a node-visit');
  });

  it("a delete's bypass names the node it steps past, and its handles by name", () => {
    const [n, p] = captions([10, 20, 30, 40], (l, push) => l.delete(30, push)).filter(({ e }) => e.kind === 'dll.relink');
    expect(n.text).toContain('node [0] (40).next → node [2] (20), stepping past node [1] (30)');
    expect(p.text).toContain('node [2] (20).prev → node [0] (40), stepping past node [1] (30)');
    const [h, t] = captions([7], (l, push) => l.delete(7, push)).filter(({ e }) => e.kind === 'dll.relink');
    expect(h.text).toMatch(/^head → ∅, stepping past node \[0\] \(7\)/);
    expect(t.text).toMatch(/^tail → ∅, stepping past node \[0\] \(7\)/);
  });

  it('visits are the singly walk, and the unlink credits prev with no saved visit', () => {
    const cs = captions([10, 20, 30, 40], (l, p) => l.delete(30, p));
    for (const { e, text } of cs) if (e.kind === 'll.visit') expect(text).toContain('the same walk a singly list makes');
    const unlink = cs.find(({ e }) => e.kind === 'll.unlink')!;
    expect(unlink.text).toContain('exactly the visits a singly list takes');
    expect(unlink.text).not.toMatch(/cheaper|faster|fewer/);
  });

  it('the intro says the counts are equal and the back link costs writes', () => {
    expect(DOUBLY_INTRO).toContain('exactly the singly list’s node-visits');
    expect(DOUBLY_INTRO).toContain('extra pointer write on every insert and delete');
  });
});

describe('open-addressing captions: a tombstone keeps the walk going, the empty stop is free', () => {
  /** Each event of one op on `s`, captioned against the model folded up to and including it. */
  const captions = (s: HashSetOaF64, op: (t: (e: HashSetOaEvent) => void) => void) => {
    const before = oaModel(s.slots());
    const events: HashSetOaEvent[] = [];
    op((e) => events.push(e));
    return events.map((e, i) => ({ e, text: describeOa(e, foldOa(before, events.slice(0, i + 1))) }));
  };

  it('stepping over a tombstone is "keep walking, still one probe"', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    s.delete(40); // tombstone at slot 5
    const tomb = captions(s, (t) => s.search(60, t)).find(({ e }) => e.kind === 'hoa.probe' && e.state === 'tomb');
    expect(tomb?.text).toContain('tombstone');
    expect(tomb?.text).toContain('keep walking, still one probe');
  });

  it('the empty slot that ends a walk is called free, on a miss and on an insert', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const miss = captions(s, (t) => s.search(55, t)).find(({ e }) => e.kind === 'hoa.stop');
    expect(miss?.text).toContain('free');
    expect(miss?.text).not.toContain('one probe');
    // an insert homed at 40's tombstone: its stop proves absence (free) and sends it back
    s.delete(40);
    let k = 61;
    while (s.search(k).ops !== 5 || s.slots().indexOf(k) !== -1) k++; // walks 5 (tomb), 6, 7, 0
    const ins = captions(s, (t) => s.insert(k, t));
    const stop = ins.find(({ e }) => e.kind === 'hoa.stop');
    expect(stop?.text).toContain('free');
    expect(stop?.text).toContain('remembered at [5]');
    expect(ins.find(({ e }) => e.kind === 'hoa.place')?.text).toContain('reusing the tombstone');
  });

  it('a probe at the last slot says the walk wraps to slot 0', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const atLast = captions(s, (t) => s.search(60, t)).find(({ e }) => e.kind === 'hoa.probe' && e.slot === 7);
    expect(atLast?.text).toContain('wraps round to [0]');
  });

  it('a rebuild names doubling vs purging, and says re-placing is not counted', () => {
    const grow = HashSetOaF64.fromKeys(OA_SEED);
    const doubled = captions(grow, (t) => grow.insert(70, t)).find(({ e }) => e.kind === 'hoa.rehash');
    expect(doubled?.text).toContain('double to 16 slots');
    expect(doubled?.text).toContain('not counted');
    const purge = HashSetOaF64.fromKeys(OA_SEED);
    for (const d of [10, 20, 30, 40]) purge.delete(d);
    const purged = captions(purge, (t) => purge.insert(80, t)).find(({ e }) => e.kind === 'hoa.rehash');
    expect(purged?.text).toContain('same size');
    expect(purged?.text).toContain('not counted');
  });

  it('no caption claims a run holds keys in insertion order', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const all = [
      ...captions(s, (t) => s.search(60, t)),
      ...captions(s, (t) => s.insert(70, t)),
      ...captions(s, (t) => s.delete(30, t)),
    ];
    for (const { text } of all) expect(text).not.toMatch(/insertion order|inserted (first|earlier|later)/);
  });
});
