import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-hbs.txt?raw';
import { HashSetBsF64, type Slot } from './hashSetBs';

/**
 * Cross-language conformance for the backward-shift hash set (docs/PLAN.md §8, §12, risk R1).
 * The committed `corpus-hbs.txt` is generated from the Rust bench impl (the source of truth,
 * docs/PLAN.md §2.1; generator in `bench-engine/src/structures/hash_set_bs.rs`).
 *
 * The dimension is the **slot layout** before deletes, after them and after re-inserts —
 * which a twin with a different move rule (moving a key homed past the hole, or failing to
 * move one across the end of the table) cannot reproduce even when every membership answer
 * is right — plus the **shift split** of each delete, which pins the counting rule for the
 * backward-shift scan (a probe and a hash per occupied slot). The `wrap` case shifts a key
 * back across the end of the table; the `threshold` case's churn doubles in the settle pass.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_hbs`.
 */

interface FlagOps {
  flag: boolean;
  ops: number;
}

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  order: number[];
  search: FlagOps[];
  slots: Slot[];
  shape: number[];
  deletes: number[];
  del: FlagOps[];
  shift: number[];
  slotsAfter: Slot[];
  searchAfter: FlagOps[];
  reinserts: number[];
  ins: FlagOps[];
  slotsFinal: Slot[];
  shapeFinal: number[];
  churnKey: number;
  churnKeys: number[];
  slotsChurn: Slot[];
  shapeChurn: number[];
  churn: number;
}

const tokens = (rest: string): string[] => rest.split(/\s+/).filter((t) => t.length > 0);
const parseNums = (rest: string): number[] => tokens(rest).map(Number);
const parseFlagOps = (rest: string): FlagOps[] =>
  tokens(rest).map((tok) => {
    const [flag, ops] = tok.split(':');
    return { flag: flag === '1', ops: Number(ops) };
  });
const parseSlots = (rest: string): Slot[] => tokens(rest).map((t) => (t === '.' ? t : Number(t)));

function parseCorpus(text: string): Case[] {
  const cases: Case[] = [];
  let cur: Partial<Case> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    if (tag === 'case') {
      if (cur) cases.push(cur as Case);
      cur = { name: rest };
      continue;
    }
    const c = cur!;
    switch (tag) {
      case 'keys': c.keys = parseNums(rest); break;
      case 'probes': c.probes = parseNums(rest); break;
      case 'hbs_order': c.order = parseNums(rest); break;
      case 'hbs_search': c.search = parseFlagOps(rest); break;
      case 'hbs_slots': c.slots = parseSlots(rest); break;
      case 'hbs_shape': c.shape = parseNums(rest); break;
      case 'deletes': c.deletes = parseNums(rest); break;
      case 'hbs_delete': c.del = parseFlagOps(rest); break;
      case 'hbs_shift': c.shift = parseNums(rest); break;
      case 'hbs_slots_after': c.slotsAfter = parseSlots(rest); break;
      case 'hbs_search_after': c.searchAfter = parseFlagOps(rest); break;
      case 'reinserts': c.reinserts = parseNums(rest); break;
      case 'hbs_insert': c.ins = parseFlagOps(rest); break;
      case 'hbs_slots_final': c.slotsFinal = parseSlots(rest); break;
      case 'hbs_shape_final': c.shapeFinal = parseNums(rest); break;
      case 'churn_key': c.churnKey = Number(rest); break;
      case 'hbs_churn_keys': c.churnKeys = parseNums(rest); break;
      case 'hbs_slots_churn': c.slotsChurn = parseSlots(rest); break;
      case 'hbs_shape_churn': c.shapeChurn = parseNums(rest); break;
      case 'hbs_churn': c.churn = Number(rest); break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const shapeOf = (s: HashSetBsF64): number[] => [s.capacity, s.size];
const asSearch = (r: { found: boolean; ops: number }): FlagOps => ({ flag: r.found, ops: r.ops });

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS HashSetBsF64 vs the Rust corpus', () => {
  it('parsed every case, including the cluster, wrap, threshold and churn-block ones', () => {
    expect(corpus.map((c) => c.name)).toEqual(
      expect.arrayContaining(['empty', 'rehash', 'cluster', 'wrap', 'threshold', 'block']),
    );
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('order, per-probe (membership, ops) and the slot layout match Rust', () => {
      const s = HashSetBsF64.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => asSearch(s.search(p)))).toEqual(c.search);
      expect(s.slots()).toEqual(c.slots);
      expect(shapeOf(s)).toEqual(c.shape);
    });

    it('deletes shift the same keys back, at the same split cost, and later walks agree', () => {
      const s = HashSetBsF64.fromKeys(c.keys);
      const split = c.deletes.map((d) => s.deleteSplit(d));
      expect(split.map((r) => ({ flag: r.removed, ops: r.find + r.shift }))).toEqual(c.del);
      expect(split.map((r) => r.shift)).toEqual(c.shift);
      expect(s.slots()).toEqual(c.slotsAfter);
      expect(c.probes.map((p) => asSearch(s.search(p)))).toEqual(c.searchAfter);
      expect(c.reinserts.map((r) => s.insert(r)).map((r) => ({ flag: r.inserted, ops: r.ops }))).toEqual(c.ins);
      expect(s.slots()).toEqual(c.slotsFinal);
      expect(shapeOf(s)).toEqual(c.shapeFinal);
    });

    it('the churn block, its settled layout and the per-pair churn op-count match Rust', () => {
      const s = HashSetBsF64.fromKeys(c.keys);
      s.setChurnKey(c.churnKey);
      expect(s.churnBlockKeys()).toEqual(c.churnKeys);
      expect(s.slots()).toEqual(c.slotsChurn);
      expect(shapeOf(s)).toEqual(c.shapeChurn);
      expect(s.churnCounted()).toBe(c.churn);
      // A counted pair restores the table, so the layout is still the settled one.
      expect(s.slots()).toEqual(c.slotsChurn);
    });
  });
});
