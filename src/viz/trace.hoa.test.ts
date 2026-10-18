import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-hoa.txt?raw';
import { HashSetOaF64, type Slot } from '../structures/hashSetOa';
import { HashSetF64 } from '../structures/hashSet';
import { mixF64 } from '../structures/mix';
import { countCostEvents, type HashSetOaEvent } from './events';
import { oaModel, foldOa, oaSlotsOf, type OaModel } from './model';
import { OA_SEED } from './VizPanel';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, risk R1) for the
 * **open-addressing hash set**. Its cost metric is hashes + slot probes
 * (docs/METHODOLOGY.md §2.8), so the cost events are `hoa.hash` and `hoa.probe`, and
 *
 *     countCostEvents(stream) === op-count
 *
 * for **search, insert, AND delete**. The empty slot that stops a walk (`hoa.stop`) and
 * the rebuild's re-placement (`hoa.rehash`) are drawn but free, as both twins count them.
 *
 * **All three ops are chained to the Rust source of truth** — unlike the trie's and the
 * skip list's gates, because `conformance/corpus-hoa.txt` has an insert column. Each case
 * runs the corpus's own sequence (build, probe, delete, probe again, re-insert) on ONE
 * traced table and checks every stream's cost-event count against the corpus's Rust-made
 * op-count, and the **folded drawing** against the corpus's slot layouts at each stage —
 * so the picture, not just the twin, is tied to the layout dimension the corpus exists to
 * pin (which tombstone a re-insert reuses, which slots a rebuild leaves).
 *
 * The anchors below pin the seed's teaching numbers absolutely, which a self-consistency
 * gate cannot do (a probe dropped from the tracer and the counter at once would pass it).
 */

interface FlagOps {
  flag: boolean;
  ops: number;
}

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  search: FlagOps[];
  slots: Slot[];
  deletes: number[];
  del: FlagOps[];
  slotsAfter: Slot[];
  searchAfter: FlagOps[];
  reinserts: number[];
  ins: FlagOps[];
  slotsFinal: Slot[];
}

/** The corpus lines this file needs; the full parser, which checks every field, lives in
 * `src/structures/conformance-hoa.test.ts`. */
function corpusCases(text: string): Case[] {
  const cases: Case[] = [];
  const tokens = (rest: string) => rest.split(/\s+/).filter((t) => t.length > 0);
  const nums = (rest: string) => tokens(rest).map(Number);
  const flagOps = (rest: string): FlagOps[] =>
    tokens(rest).map((t) => {
      const [f, o] = t.split(':');
      return { flag: f === '1', ops: Number(o) };
    });
  const slots = (rest: string): Slot[] => tokens(rest).map((t) => (t === '.' || t === 'x' ? t : Number(t)));
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    if (tag === 'case') {
      cases.push({ name: rest } as Case);
      continue;
    }
    const c = cases[cases.length - 1];
    switch (tag) {
      case 'keys': c.keys = nums(rest); break;
      case 'probes': c.probes = nums(rest); break;
      case 'hoa_search': c.search = flagOps(rest); break;
      case 'hoa_slots': c.slots = slots(rest); break;
      case 'deletes': c.deletes = nums(rest); break;
      case 'hoa_delete': c.del = flagOps(rest); break;
      case 'hoa_slots_after': c.slotsAfter = slots(rest); break;
      case 'hoa_search_after': c.searchAfter = flagOps(rest); break;
      case 'reinserts': c.reinserts = nums(rest); break;
      case 'hoa_insert': c.ins = flagOps(rest); break;
      case 'hoa_slots_final': c.slotsFinal = slots(rest); break;
      default: break; // order / shape / churn lines: conformance-hoa.test.ts
    }
  }
  return cases;
}

const corpus = corpusCases(corpusText);

/** A traced table plus the drawing folded along with it, op by op. */
function traced(s: HashSetOaF64) {
  let model: OaModel = oaModel(s.slots());
  const run = <R,>(op: (t: (e: HashSetOaEvent) => void) => R): { r: R; events: HashSetOaEvent[] } => {
    const events: HashSetOaEvent[] = [];
    const r = op((e) => events.push(e));
    model = foldOa(model, events);
    return { r, events };
  };
  return { run, drawn: () => oaSlotsOf(model) };
}

describe('open addressing: cost-events == hashes + slot probes, over the Rust corpus', () => {
  it('parsed every case, including the purge and cluster ones', () => {
    expect(corpus.map((c) => c.name)).toEqual(expect.arrayContaining(['empty', 'rehash', 'cluster', 'purge']));
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('build, probe, delete, probe, re-insert — every stream matches Rust’s count, every stage Rust’s layout', () => {
      const s = new HashSetOaF64();
      const t = traced(s);

      // Build by traced inserts from empty: the drawing must reach Rust's layout too.
      for (const k of c.keys) {
        const { r, events } = t.run((tr) => s.insert(k, tr));
        expect(countCostEvents(events)).toBe(r.ops);
      }
      expect(t.drawn()).toEqual(c.slots);

      c.probes.forEach((p, i) => {
        const { r, events } = t.run((tr) => s.search(p, tr));
        expect({ flag: r.found, ops: r.ops }).toEqual(c.search[i]);
        expect(countCostEvents(events)).toBe(c.search[i].ops);
        expect(events[events.length - 1]).toEqual({ kind: 'hoa.result', found: c.search[i].flag });
      });

      c.deletes.forEach((d, i) => {
        const { r, events } = t.run((tr) => s.delete(d, tr));
        expect({ flag: r.removed, ops: r.ops }).toEqual(c.del[i]);
        expect(countCostEvents(events)).toBe(c.del[i].ops);
      });
      expect(t.drawn()).toEqual(c.slotsAfter);

      c.probes.forEach((p, i) => {
        const { events } = t.run((tr) => s.search(p, tr));
        expect(countCostEvents(events)).toBe(c.searchAfter[i].ops);
      });

      c.reinserts.forEach((k, i) => {
        const { r, events } = t.run((tr) => s.insert(k, tr));
        expect({ flag: r.inserted, ops: r.ops }).toEqual(c.ins[i]);
        expect(countCostEvents(events)).toBe(c.ins[i].ops);
      });
      expect(t.drawn()).toEqual(c.slotsFinal);
    });
  });
});

describe('open addressing: the seed’s teaching numbers (anchored, not just self-consistent)', () => {
  const home8 = (k: number) => Number(mixF64(k) & 7n);
  const probesOf = (events: readonly HashSetOaEvent[]) =>
    events.filter((e): e is Extract<HashSetOaEvent, { kind: 'hoa.probe' }> => e.kind === 'hoa.probe');

  it('is the hash set tab’s seed, in the same 8 slots, and four keys share home slot 5', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    expect(s.capacity).toBe(8);
    expect(OA_SEED.filter((k) => home8(k) === 5)).toEqual([30, 40, 50, 60]);
    // the run fills 5, 6, 7 and wraps round to slot 0
    expect(s.slots()).toEqual([60, '.', 10, 20, '.', 40, 30, 50]);
  });

  it('search(60) walks 5 → 6 → 7 → wraps to 0: 5 ops; search(80) lands on an empty slot: 1', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const events: HashSetOaEvent[] = [];
    expect(s.search(60, (e) => events.push(e))).toEqual({ found: true, ops: 5 });
    expect(probesOf(events).map((e) => e.slot)).toEqual([5, 6, 7, 0]);
    expect(s.search(80)).toEqual({ found: false, ops: 1 });
  });

  it('primary clustering: a miss homed at 6 pays 4, where the chaining table pays 1', () => {
    expect(home8(55)).toBe(6);
    const events: HashSetOaEvent[] = [];
    expect(HashSetOaF64.fromKeys(OA_SEED).search(55, (e) => events.push(e))).toEqual({ found: false, ops: 4 });
    // the empty slot that stops it is drawn but free
    expect(events.filter((e) => e.kind === 'hoa.stop')).toEqual([{ kind: 'hoa.stop', home: 6, slot: 1, reuse: null }]);
    expect(countCostEvents(events)).toBe(4);
    expect(HashSetF64.fromKeys(OA_SEED).search(55).ops).toBe(1);
  });

  it('delete(40) leaves a tombstone; search(60) steps over it and still pays 5', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const del: HashSetOaEvent[] = [];
    s.delete(40, (e) => del.push(e));
    expect(del).toContainEqual({ kind: 'hoa.tombstone', slot: 5 });
    expect(s.slots()[5]).toBe('x');
    const events: HashSetOaEvent[] = [];
    expect(s.search(60, (e) => events.push(e))).toEqual({ found: true, ops: 5 });
    expect(probesOf(events)[0]).toMatchObject({ slot: 5, state: 'tomb', value: null, matched: false });
  });

  it('an insert walks past the first tombstone to an empty slot, then goes back and reuses it', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    s.delete(40); // tombstone at 5
    let k = 61;
    while (home8(k) !== 5) k++;
    const events: HashSetOaEvent[] = [];
    const r = s.insert(k, (e) => events.push(e));
    // hash + 5 (tomb) + 6 + 7 + 0, then the free stop at 1
    expect(r).toEqual({ inserted: true, ops: 5 });
    expect(countCostEvents(events)).toBe(5);
    const probes = probesOf(events);
    expect(probes.map((e) => e.reuse)).toEqual([5, 5, 5, 5]);
    expect(events).toContainEqual({ kind: 'hoa.stop', home: 5, slot: 1, reuse: 5 });
    expect(events).toContainEqual({ kind: 'hoa.place', slot: 5, value: k, reused: true });
    expect(s.tombstones).toBe(0);
  });

  it('a 7th distinct key doubles the table to 16 — the chaining tab’s rehash point', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const events: HashSetOaEvent[] = [];
    s.insert(70, (e) => events.push(e));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'hoa.rehash', oldCap: 8, newCap: 16, live: 7, tombs: 0 }));
    const chained = HashSetF64.fromKeys(OA_SEED);
    const ch: { kind: string }[] = [];
    chained.insert(70, (e) => ch.push(e));
    expect(ch).toContainEqual(expect.objectContaining({ kind: 'hs.rehash', oldCap: 8, newCap: 16 }));
  });

  it('enough tombstones make the next insert purge in place instead of doubling', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    for (const d of [10, 20, 30, 40]) s.delete(d); // 2 live + 4 tombstones
    expect(home8(80)).toBe(4); // lands on an empty slot before any tombstone
    const events: HashSetOaEvent[] = [];
    const r = s.insert(80, (e) => events.push(e));
    expect(r).toEqual({ inserted: true, ops: 1 });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'hoa.rehash', oldCap: 8, newCap: 8, live: 3, tombs: 4 }));
    expect(s.tombstones).toBe(0);
    // the rebuild is drawn but free: the insert's count stopped at its own walk
    expect(countCostEvents(events)).toBe(1);
  });

  it('a duplicate insert stops at the match and stores nothing', () => {
    const s = HashSetOaF64.fromKeys(OA_SEED);
    const events: HashSetOaEvent[] = [];
    expect(s.insert(50, (e) => events.push(e))).toEqual({ inserted: false, ops: 4 });
    expect(events[events.length - 1]).toEqual({ kind: 'hoa.duplicate', slot: 7 });
    expect(events.some((e) => e.kind === 'hoa.place')).toBe(false);
  });
});

describe('open addressing: the tracer perturbs nothing', () => {
  it('a long mixed stream gives identical results and layouts with and without a tracer', () => {
    const quiet = new HashSetOaF64();
    const loud = new HashSetOaF64();
    let x = 12345;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 1500; i++) {
      const k = Math.floor(rnd() * 60);
      const op = rnd();
      if (op < 0.45) expect(loud.insert(k, () => {})).toEqual(quiet.insert(k));
      else if (op < 0.8) expect(loud.delete(k, () => {})).toEqual(quiet.delete(k));
      else expect(loud.search(k, () => {})).toEqual(quiet.search(k));
    }
    expect(loud.slots()).toEqual(quiet.slots());
  });
});
