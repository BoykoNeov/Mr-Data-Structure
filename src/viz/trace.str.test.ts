import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-str.txt?raw';
import { DynArrayStr } from '../structures/dynArrayStr';
import { HashSetStr } from '../structures/hashSetStr';
import { countCostEvents, type ArrayEvent, type HashSetEvent } from './events';
import { TEXT_SEED } from './VizPanel';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, risk R1) for the
 * **text-key array and hash set**. They run the numeric twins' algorithms on
 * strings and emit the numeric twins' own events, so their cost events are the same
 * kinds — `arr.compare` (one whole-key comparison), `hs.hash`, `hs.probe` (one
 * chain-step). Every block below is **chained to Rust**: it runs the keys and probes
 * of `conformance/corpus-str.txt` and checks both the twin's result against the
 * Rust-generated line and the stream's cost events against that same number.
 *
 *  - Array **search**: `countCostEvents === ops` (comparisons).
 *  - Array **delete**: `ops` is comparisons + shifts, and a shift is drawn as a move,
 *    not a cost event (`arr.shift` is not in `COST_EVENT_KINDS`, as for the numeric
 *    array). So the gate is `countCostEvents + shifts === ops`, with the cost events
 *    alone equal to the comparisons — never "add `arr.shift` to the cost kinds".
 *  - Array **insert**: an append — zero cost events, as Rust's build counts zero.
 *  - Hash set **search, insert and delete**: `countCostEvents === ops` (the hash +
 *    chain-steps). The rehash an insert triggers is drawn and uncounted, exactly as
 *    the Rust `insert_one_counted` leaves it out — the `hashset_insert` line pins the
 *    count and `hashset_after_insert` the redistribution.
 *
 * A comparison of two strings is ONE cost event however many bytes it reads (Rust's
 * `==` is length-first, then bytes); there is no per-byte cost event to count.
 */

interface Pair { found: boolean; ops: number }
interface StrCase {
  name: string;
  keys: string[];
  probes: string[];
  arraySearch: Pair[];
  arrayDelete: Pair[];
  hashsetSearch: Pair[];
  hashsetInsert: Pair[];
  hashsetDelete: Pair[];
}

const pairs = (rest: string[]): Pair[] =>
  rest.map((tok) => {
    const [f, ops] = tok.split(':');
    return { found: f === '1', ops: Number(ops) };
  });

/** The corpus lines this file needs; `conformance-str.test.ts` checks every field. */
function corpusCases(text: string): StrCase[] {
  const cases: StrCase[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = (sp === -1 ? '' : line.slice(sp + 1)).split(/\s+/).filter((t) => t.length > 0);
    const cur = cases[cases.length - 1];
    switch (tag) {
      case 'case':
        cases.push({ name: line.slice(sp + 1), keys: [], probes: [], arraySearch: [], arrayDelete: [], hashsetSearch: [], hashsetInsert: [], hashsetDelete: [] });
        break;
      case 'keys': cur.keys = rest; break;
      case 'probes': cur.probes = rest; break;
      case 'array_search': cur.arraySearch = pairs(rest); break;
      case 'array_delete': cur.arrayDelete = pairs(rest); break;
      case 'hashset_search': cur.hashsetSearch = pairs(rest); break;
      case 'hashset_insert': cur.hashsetInsert = pairs(rest); break;
      case 'hashset_delete': cur.hashsetDelete = pairs(rest); break;
      default: break; // orders and the trie's lines: checked elsewhere
    }
  }
  return cases;
}

const corpus = corpusCases(corpusText);

const arrTrace = () => {
  const events: ArrayEvent<string>[] = [];
  return { events, push: (e: ArrayEvent<string>) => events.push(e) };
};
const hsTrace = () => {
  const events: HashSetEvent<string>[] = [];
  return { events, push: (e: HashSetEvent<string>) => events.push(e) };
};

describe('text-key array and hash set: cost events == ops, over the Rust corpus', () => {
  it('parsed the corpus, including its mutation lines', () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const c of corpus) {
      expect(c.arrayDelete).toHaveLength(c.probes.length);
      expect(c.hashsetInsert).toHaveLength(c.probes.length);
      expect(c.hashsetDelete).toHaveLength(c.probes.length);
    }
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('array search: each probe’s stream carries exactly the Rust comparison count', () => {
      const a = DynArrayStr.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const { events, push } = arrTrace();
        const r = a.search(p, push);
        expect(r).toEqual(c.arraySearch[i]);
        expect(countCostEvents(events)).toBe(c.arraySearch[i].ops);
        expect(events[events.length - 1]).toEqual({ kind: 'arr.result', found: r.found });
      });
    });

    it('array delete (the corpus sequence): cost events = comparisons, + shifts = the Rust ops', () => {
      const a = DynArrayStr.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const before = a.size;
        const { events, push } = arrTrace();
        const r = a.delete(p, push);
        expect({ found: r.removed, ops: r.ops }).toEqual(c.arrayDelete[i]);
        const shifts = events.filter((e) => e.kind === 'arr.shift').length;
        expect(countCostEvents(events) + shifts).toBe(c.arrayDelete[i].ops);
        // The cost events alone are the scan. An ordered shift-compact always touches
        // every key once: a hit at i compares i + 1 and shifts n − 1 − i, a miss
        // compares all n — so a delete's ops is n either way.
        const compares = events.filter((e) => e.kind === 'arr.compare').length;
        expect(countCostEvents(events)).toBe(compares);
        expect(compares + shifts).toBe(before);
      });
    });

    it('array insert: an append costs zero cost events', () => {
      const a = DynArrayStr.fromKeys(c.keys);
      for (const p of c.probes) {
        const { events, push } = arrTrace();
        a.insert(p, push);
        expect(countCostEvents(events)).toBe(0);
        expect(events).toEqual([{ kind: 'arr.append', value: p }]);
      }
    });

    it('hash-set search: each probe’s stream carries exactly the Rust hash + chain-steps', () => {
      const s = HashSetStr.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const { events, push } = hsTrace();
        const r = s.search(p, push);
        expect(r).toEqual(c.hashsetSearch[i]);
        expect(countCostEvents(events)).toBe(c.hashsetSearch[i].ops);
        expect(events[0].kind).toBe('hs.hash');
        expect(events[events.length - 1]).toEqual({ kind: 'hs.result', found: r.found });
      });
    });

    it('hash-set insert (the corpus sequence): cost events = the Rust count, rehash uncounted', () => {
      const s = HashSetStr.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const { events, push } = hsTrace();
        const r = s.insert(p, push);
        expect({ found: r.inserted, ops: r.ops }).toEqual(c.hashsetInsert[i]);
        expect(countCostEvents(events)).toBe(c.hashsetInsert[i].ops);
      });
    });

    it('hash-set delete (the corpus sequence): cost events = the Rust count', () => {
      const s = HashSetStr.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const { events, push } = hsTrace();
        const r = s.delete(p, push);
        expect({ found: r.removed, ops: r.ops }).toEqual(c.hashsetDelete[i]);
        expect(countCostEvents(events)).toBe(c.hashsetDelete[i].ops);
      });
    });
  });
});

describe('the Explore seed is the corpus’s `explore` case', () => {
  // So the numbers the two tabs' intros quote (pinned against the twins in
  // `VizPanel.test.ts`) are Rust-generated lines, not TypeScript restating itself.
  const explore = corpus.find((c) => c.name === 'explore');

  it('the corpus case holds exactly the tabs’ seed', () => {
    expect(explore?.keys).toEqual([...TEXT_SEED]);
  });

  it('pins the intro’s numbers in the Rust lines', () => {
    const at = (p: string) => explore!.probes.indexOf(p);
    expect(explore!.arraySearch[at('dog')]).toEqual({ found: true, ops: 5 });
    expect(explore!.arraySearch[at('cafe')]).toEqual({ found: false, ops: 6 });
    expect(explore!.arrayDelete[at('cart')]).toEqual({ found: true, ops: 6 }); // 2 comparisons + 4 shifts
    expect(explore!.hashsetSearch[at('dog')]).toEqual({ found: true, ops: 3 });
    expect(explore!.hashsetSearch[at('cafe')]).toEqual({ found: false, ops: 2 });
    expect(explore!.hashsetSearch[at('ca')]).toEqual({ found: false, ops: 1 });
    // owl is the first probe, so the insert sequence meets it on the seed itself
    expect(at('owl')).toBe(0);
    expect(explore!.hashsetInsert[0]).toEqual({ found: true, ops: 3 });
  });
});

describe('absolute counts (anchored, not just self-consistent)', () => {
  // Hand-computed, so a step dropped from both the tracer and the counter at once
  // cannot pass the invariant above.
  it('a comparison is one cost event whatever the key length', () => {
    const long = 'x'.repeat(200);
    const a = DynArrayStr.fromKeys([long, 'y']);
    const { events, push } = arrTrace();
    expect(a.search('y', push)).toEqual({ found: true, ops: 2 });
    expect(countCostEvents(events)).toBe(2);
  });

  it('a hash is one cost event whatever the key length', () => {
    const s = new HashSetStr();
    const { events, push } = hsTrace();
    expect(s.search('x'.repeat(200), push)).toEqual({ found: false, ops: 1 }); // empty table: just the hash
    expect(countCostEvents(events)).toBe(1);
  });
});
