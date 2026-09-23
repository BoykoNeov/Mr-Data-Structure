import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-skip.txt?raw';
import { SkipListF64 } from '../structures/skipList';
import { countCostEvents, type SkipListEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 honesty gate,
 * risk R1) for the **skip list**. Its cost metric is **node-visits** (docs/PLAN.md
 * §8): one comparison per node inspected on the walk. The one cost event is
 * `skip.inspect`, so
 *
 *     countCostEvents(stream) === op-count
 *
 * holds for **search, insert, AND delete**. Entering the head (`skip.enter`) and
 * dropping off the end of an express lane (`skip.laneEnd`) carry no comparison, and
 * neither do the structural events (`skip.insert` / `skip.remove`), exactly as the
 * Rust twin's `descend` counts them.
 *
 * **Search and delete are chained to the Rust source of truth.** They run the same
 * keys / probes / delete sequences as `conformance/corpus-skip.txt`, whose
 * `skip_search` / `skip_delete` op-counts are generated from the Rust bench twin and
 * already asserted by `conformance-skip.test.ts`. So `countCostEvents === ops` over
 * those probes ties the animation transitively to Rust, and — because the corpus test
 * runs the same ops *without* a tracer — also proves the tracer perturbs no counter.
 *
 * **Insert is deliberately weaker, and this comment is the record of it.** The corpus
 * has no insert column, so the insert block reuses the corpus keys but checks only
 * self-consistency (`countCostEvents === r.ops`) — the same call the trie's insert
 * gate makes (`trace.trie.test.ts`). Closing it means a `skip_insert` column.
 *
 * The hand-computed absolute totals at the bottom guard the one thing a
 * self-consistency gate cannot catch: a *symmetric* miscount dropped from the tracer
 * and the counter at once.
 */

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  deletes: number[];
}

/** The corpus lines this file needs (`keys` / `probes` / `deletes`); the full parser,
 * which checks every field, lives in `src/structures/conformance-skip.test.ts`. */
function corpusCases(text: string): Case[] {
  const cases: Case[] = [];
  const nums = (rest: string) => rest.split(/\s+/).filter((t) => t.length > 0).map(Number);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    if (tag === 'case') cases.push({ name: rest, keys: [], probes: [], deletes: [] });
    else if (tag === 'keys') cases[cases.length - 1].keys = nums(rest);
    else if (tag === 'probes') cases[cases.length - 1].probes = nums(rest);
    else if (tag === 'deletes') cases[cases.length - 1].deletes = nums(rest);
  }
  return cases;
}

const corpus = corpusCases(corpusText);

const trace = () => {
  const events: SkipListEvent[] = [];
  return { events, push: (e: SkipListEvent) => events.push(e) };
};

describe('skip list: cost-events == node-visits, over the Rust conformance corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('search: every probe’s stream carries exactly its op-count', () => {
      const s = SkipListF64.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = trace();
        const r = s.search(p, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(events[0]).toEqual({ kind: 'skip.enter', key: p, topLevel: s.topLevel - 1 });
        expect(events[events.length - 1]).toEqual({ kind: 'skip.result', found: r.found });
      }
    });

    // NOT chained to Rust — see the header. The corpus keys are reused as inputs, but
    // only self-consistency is checked (there is no `skip_insert` column).
    it('insert: every probe’s stream carries exactly its op-count', () => {
      const s = SkipListF64.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = trace();
        const r = s.insert(p, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(events[0]).toEqual({ kind: 'skip.enter', key: p, topLevel: expect.any(Number) });
        expect(events[events.length - 1]).toMatchObject({ kind: 'skip.insert', value: p });
      }
    });

    it('delete: the corpus’s own delete sequence, each stream matching its count', () => {
      // The corpus deletes each key in `deletes` in order from ONE list (its
      // `skip_delete` column), so later deletes see what earlier ones unlinked. Mirror it.
      const s = SkipListF64.fromKeys(c.keys);
      for (const d of c.deletes) {
        const { events, push } = trace();
        const r = s.delete(d, push);
        expect(countCostEvents(events)).toBe(r.ops);
        expect(events[events.length - 1]).toEqual({ kind: 'skip.result', found: r.removed });
      }
    });
  });
});

describe('skip list: absolute node-visit totals (anchored, not just self-consistent)', () => {
  // The seed the Explore panel ships, whose level structure is fixed by the keys'
  // hashes: 220 is a height-4 tower, 40 height-3, {30,90,270} height-2, {10,50,50}
  // height-1. Hand-walking the descent gives the counts below; a symmetric miscount
  // (a step dropped from both the tracer and the counter) cannot reproduce them.
  const SEED = [10, 30, 40, 50, 50, 90, 220, 270];

  it('a hit pays for the descent plus one equality test on the same node', () => {
    const s = SkipListF64.fromKeys(SEED);
    const { events, push } = trace();
    const r = s.search(270, push); // 220 (L3), 270 (L1 stop), 270 (L0 stop), 270 (= test)
    expect(r).toEqual({ found: true, ops: 4 });
    expect(countCostEvents(events)).toBe(4);
    // The level-0 double comparison: the `stop` and the `found` inspect the SAME node.
    const inspects = events.filter((e): e is Extract<SkipListEvent, { kind: 'skip.inspect' }> => e.kind === 'skip.inspect');
    const found = inspects[inspects.length - 1];
    const prev = inspects[inspects.length - 2];
    expect(found.outcome).toBe('found');
    expect(prev.outcome).toBe('stop');
    expect(found.index).toBe(prev.index); // one node, two honest comparisons
    expect(found.level).toBe(0);
  });

  it('an above-max miss is the cheapest query — it pays nothing for lane ends', () => {
    // The caveat this panel exists to show (docs/METHODOLOGY.md §4 hurdle 9): a probe
    // past the largest key rides the top staircase and runs off each lane for free.
    const s = SkipListF64.fromKeys(SEED);
    const { events, push } = trace();
    const r = s.search(999, push); // 220 (L3), 270 (L1) — both advance, then lanes end
    expect(r).toEqual({ found: false, ops: 2 });
    expect(countCostEvents(events)).toBe(2);
    expect(events.some((e) => e.kind === 'skip.laneEnd')).toBe(true);
  });

  it('a mid-range miss is far dearer — one comparison per level on the way down', () => {
    const s = SkipListF64.fromKeys(SEED);
    const mid = s.search(100); // between 90 and 220
    const hi = s.search(999); // above the max
    expect(mid).toEqual({ found: false, ops: 7 });
    expect(hi.ops).toBeLessThan(mid.ops); // the asymmetry the caveat names
  });

  it('an empty list is walked with no comparison at all', () => {
    const s = new SkipListF64();
    const { events, push } = trace();
    const r = s.search(42, push);
    expect(r).toEqual({ found: false, ops: 0 });
    expect(countCostEvents(events)).toBe(0);
    expect(events[0]).toEqual({ kind: 'skip.enter', key: 42, topLevel: -1 });
    expect(events).toHaveLength(2); // enter, result — nothing to inspect
  });

  it('insert into an empty list costs nothing and splices at index 0', () => {
    const s = new SkipListF64();
    const { events, push } = trace();
    const r = s.insert(7, push);
    expect(r.ops).toBe(0);
    expect(countCostEvents(events)).toBe(0);
    expect(events[0]).toEqual({ kind: 'skip.enter', key: 7, topLevel: -1 });
    expect(events[events.length - 1]).toMatchObject({ kind: 'skip.insert', index: 0, value: 7 });
  });
});

describe('skip list: the tracer perturbs nothing', () => {
  const KEYS = [10, 30, 40, 50, 50, 90, 220, 270];
  const PROBES = [10, 50, 100, 220, 270, 999, 5];

  it('search results are identical with and without a tracer', () => {
    const quiet = SkipListF64.fromKeys(KEYS);
    const loud = SkipListF64.fromKeys(KEYS);
    for (const p of PROBES) expect(loud.search(p, () => {})).toEqual(quiet.search(p));
  });

  it('insert + delete leave identical structures with and without a tracer', () => {
    const quiet = SkipListF64.fromKeys(KEYS);
    const loud = SkipListF64.fromKeys(KEYS);
    for (const p of PROBES) {
      expect(loud.insert(p, () => {})).toEqual(quiet.insert(p));
      expect(loud.delete(p, () => {})).toEqual(quiet.delete(p));
    }
    expect(loud.keysInOrder()).toEqual(quiet.keysInOrder());
    expect(loud.levelKeys()).toEqual(quiet.levelKeys());
  });
});
