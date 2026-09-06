import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-str.txt?raw';
import { TrieStr } from '../structures/trie';
import { countCostEvents, type TrieEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty
 * gate, risk R1) for the **trie**. Its cost metric is **char-steps**
 * (docs/PLAN.md §8): entering the root, plus one per key byte whose child lookup
 * is attempted. The cost events are `trie.enterRoot` and `trie.step`, so
 *
 *     countCostEvents(stream) === op-count
 *
 * holds for **search, insert, AND delete**. The structural events — creating a
 * node, flipping a terminal flag, pruning — carry no char-step, exactly as the
 * Rust twin's `insert_generic` / `remove_key` count them.
 *
 * **The search and delete gates are chained to the Rust source of truth.** Rather
 * than only a fresh hand-written case list, those blocks run the *same* keys and
 * probes as `conformance/corpus-str.txt`, whose `trie_search` / `trie_delete`
 * op-counts are generated from the Rust bench twin and already asserted by
 * `conformance-str.test.ts`. So `countCostEvents === ops` over those probes ties
 * the animation transitively to Rust, and — because the corpus test runs the same
 * ops *without* a tracer — also proves that passing a tracer perturbs no counter.
 *
 * **Insert is deliberately weaker, and this comment is the record of that.** The
 * corpus has no insert column, so the insert block below reuses the corpus keys but
 * compares against `1 + L` computed here — the formula restated, not a Rust-generated
 * number. It is forced by construction (an insert never falls off the tree, so it
 * always walks the whole key, exactly as `insert_generic::<true>` counts it), and
 * closing the gap properly means regenerating the corpus with a `trie_insert` column.
 * Don't describe this block as chained to Rust; it isn't.
 *
 * The hand-computed absolute totals below guard the one thing a self-consistency
 * gate cannot catch: a *symmetric* miscount, dropped from the tracer and the counter
 * at once.
 */

/** The corpus lines this file needs (`keys` / `probes`); the full parser lives in
 * `src/structures/conformance-str.test.ts`, which is the file that checks every
 * field. Duplicating three lines here is cheaper than exporting from a test. */
function corpusCases(text: string): { name: string; keys: string[]; probes: string[] }[] {
  const cases: { name: string; keys: string[]; probes: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = (sp === -1 ? '' : line.slice(sp + 1)).split(/\s+/).filter((t) => t.length > 0);
    if (tag === 'case') cases.push({ name: line.slice(sp + 1), keys: [], probes: [] });
    else if (tag === 'keys') cases[cases.length - 1].keys = rest;
    else if (tag === 'probes') cases[cases.length - 1].probes = rest;
  }
  return cases;
}

const corpus = corpusCases(corpusText);

const trace = () => {
  const events: TrieEvent[] = [];
  return { events, push: (e: TrieEvent) => events.push(e) };
};

describe('trie: cost-events == char-steps, over the Rust conformance corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('search: every probe’s stream carries exactly its op-count', () => {
      const t = TrieStr.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = trace();
        const r = t.search(p, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(events[0]).toEqual({ kind: 'trie.enterRoot', key: p });
        expect(events[events.length - 1]).toEqual({ kind: 'trie.result', found: r.found });
      }
    });

    // NOT chained to Rust — see the header. The corpus keys are reused as inputs,
    // but `1 + L` is the formula restated here, not a corpus column.
    it('insert: every probe’s stream carries exactly its op-count (1 + byte-length)', () => {
      const t = TrieStr.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = trace();
        const r = t.insert(p, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(r.ops).toBe(1 + new TextEncoder().encode(p).length);
      }
    });

    it('delete: the corpus’s own per-probe sequence, each stream matching its count', () => {
      // The corpus deletes each probe in order from ONE trie (its `trie_delete`
      // column), so later deletes see what earlier ones pruned. Mirror that.
      const t = TrieStr.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = trace();
        const r = t.delete(p, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(events[events.length - 1]).toEqual({ kind: 'trie.result', found: r.found });
      }
    });
  });
});

describe('trie: absolute char-step totals (anchored, not just self-consistent)', () => {
  // Hand-computed, so a symmetric miscount — a step dropped from both the tracer
  // and the counter — cannot slip past the invariant above.
  it('a stored key costs 1 + its byte length', () => {
    const t = TrieStr.fromKeys(['car']);
    const { events, push } = trace();
    const r = t.search('car', push);
    expect(r).toEqual({ found: true, ops: 4 }); // root + c + a + r
    expect(countCostEvents(events)).toBe(4);
  });

  it('an absent key stops where it falls off the tree', () => {
    const t = TrieStr.fromKeys(['car']);
    const { events, push } = trace();
    const r = t.search('cat', push);
    expect(r).toEqual({ found: false, ops: 4 }); // root + c + a + (t misses)
    expect(countCostEvents(events)).toBe(4);
    expect(events.filter((e) => e.kind === 'trie.step' && !e.hit)).toHaveLength(1);
  });

  it('an absent key sharing no prefix is the trie’s cheapest case', () => {
    const t = TrieStr.fromKeys(['car']);
    const { events, push } = trace();
    const r = t.search('zebra', push);
    expect(r).toEqual({ found: false, ops: 2 }); // root + (z misses)
    expect(countCostEvents(events)).toBe(2);
  });

  it('a multi-byte character costs one step per byte, not per character', () => {
    const { events, push } = trace();
    const t = new TrieStr();
    const r = t.insert('café', push); // c a f + é as C3 A9
    expect(r.ops).toBe(6);
    expect(countCostEvents(events)).toBe(6);
    expect(events.filter((e) => e.kind === 'trie.create')).toHaveLength(5);
    // The two bytes of `é` are two separate nodes on the path.
    expect(t.nodeCount()).toBe(6); // root + 5
  });

  it('a proper prefix of a stored key walks the full depth and still misses', () => {
    // The trie's own trap, and the reason the view draws a terminal ring at all.
    const t = TrieStr.fromKeys(['stack']);
    const { events, push } = trace();
    const r = t.search('stac', push);
    expect(r).toEqual({ found: false, ops: 5 });
    expect(countCostEvents(events)).toBe(5);
    expect(events.some((e) => e.kind === 'trie.step' && !e.hit)).toBe(false); // never fell off
  });

  it('a duplicate insert still walks, still costs, and stores nothing new', () => {
    const t = TrieStr.fromKeys(['car']);
    const { events, push } = trace();
    const r = t.insert('car', push);
    expect(r.ops).toBe(4);
    expect(countCostEvents(events)).toBe(4);
    expect(events.filter((e) => e.kind === 'trie.create')).toHaveLength(0);
    expect(events[events.length - 1]).toEqual({ kind: 'trie.markTerminal', path: [99, 97, 114], alreadyPresent: true });
    expect(t.size).toBe(1);
  });
});

describe('trie: a miss on an insert is not a miss on a search', () => {
  // Same `hit: false`, opposite meanings — the renderer tints one green and the
  // other red, and the caption calls only one of them absent.
  const steps = (events: readonly TrieEvent[]) =>
    events.filter((e): e is Extract<TrieEvent, { kind: 'trie.step' }> => e.kind === 'trie.step');

  it('an insert’s missing children are marked as about to be created', () => {
    const t = TrieStr.fromKeys(['car']);
    const { events, push } = trace();
    t.insert('cat', push);
    const missed = steps(events).filter((e) => !e.hit);
    expect(missed).toHaveLength(1); // the 't'
    expect(missed[0].creates).toBe(true);
    expect(steps(events).filter((e) => e.hit).every((e) => e.creates === false)).toBe(true);
  });

  it('a search’s and a delete’s missing children end the walk instead', () => {
    for (const op of ['search', 'delete'] as const) {
      const t = TrieStr.fromKeys(['car']);
      const { events, push } = trace();
      t[op]('cat', push);
      expect(steps(events).filter((e) => !e.hit).map((e) => e.creates)).toEqual([false]);
    }
  });
});

describe('trie: the prune stream the display reducer relies on', () => {
  const pruneEvents = (events: readonly TrieEvent[]) =>
    events.filter((e): e is Extract<TrieEvent, { kind: 'trie.prune' }> => e.kind === 'trie.prune');

  it('prunes deepest-first, one node at a time', () => {
    const t = TrieStr.fromKeys(['car', 'cat']);
    const { events, push } = trace();
    expect(t.delete('cart', push).found).toBe(false); // absent — nothing to prune
    expect(pruneEvents(events)).toHaveLength(0);

    const t2 = TrieStr.fromKeys(['dog']);
    const run = trace();
    expect(t2.delete('dog', run.push).found).toBe(true);
    const pruned = pruneEvents(run.events);
    expect(pruned.map((e) => e.path)).toEqual([[100, 111, 103], [100, 111], [100]]); // d-o-g, d-o, d
    // Strictly decreasing depth: each prune removes a node whose only child was
    // just removed, so it is a leaf at the moment it is emitted — the reducer
    // unlinks a child, never a subtree.
    const depths = pruned.map((e) => e.path.length);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
    expect(new Set(depths).size).toBe(depths.length);
  });

  it('prunes only what no other key needs (the shared-prefix case)', () => {
    const t = TrieStr.fromKeys(['car', 'cart', 'cat']);
    const { events, push } = trace();
    expect(t.delete('cart', push).found).toBe(true);
    expect(pruneEvents(events).map((e) => e.path)).toEqual([[99, 97, 114, 116]]); // just the 't'
    expect(events.some((e) => e.kind === 'trie.clearTerminal')).toBe(true);
  });

  it('a delete whose node stays terminal-free but keeps children prunes nothing', () => {
    // `car` is a proper prefix of `cart`: clearing its flag leaves a node that is
    // still a parent, so no prune follows.
    const t = TrieStr.fromKeys(['car', 'cart']);
    const { events, push } = trace();
    expect(t.delete('car', push).found).toBe(true);
    expect(pruneEvents(events)).toHaveLength(0);
    expect(t.search('cart').found).toBe(true);
  });
});

describe('trie: the tracer perturbs nothing', () => {
  const KEYS = ['car', 'cart', 'cat', 'café', 'dog', '日本'];
  const PROBES = ['car', 'ca', 'cart', 'café', 'caf', 'zebra', '日本', '日'];

  it('search results are identical with and without a tracer', () => {
    const quiet = TrieStr.fromKeys(KEYS);
    const loud = TrieStr.fromKeys(KEYS);
    for (const p of PROBES) {
      expect(loud.search(p, () => {})).toEqual(quiet.search(p));
    }
  });

  it('insert + delete leave identical structures with and without a tracer', () => {
    const quiet = TrieStr.fromKeys(KEYS);
    const loud = TrieStr.fromKeys(KEYS);
    for (const p of PROBES) {
      expect(loud.insert(p, () => {})).toEqual(quiet.insert(p));
      expect(loud.delete(p, () => {})).toEqual(quiet.delete(p));
    }
    expect(loud.keysInOrder()).toEqual(quiet.keysInOrder());
    expect(loud.nodeCount()).toBe(quiet.nodeCount());
  });
});
