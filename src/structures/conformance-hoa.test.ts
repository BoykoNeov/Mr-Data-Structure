import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-hoa.txt?raw';
import { HashSetOaF64, type Slot } from './hashSetOa';

/**
 * Cross-language conformance for the open-addressing hash set (docs/PLAN.md §8, §12, risk
 * R1). The committed `corpus-hoa.txt` is generated from the Rust bench impl (the source of
 * truth, docs/PLAN.md §2.1; generator in `bench-engine/src/structures/hash_set_oa.rs`).
 *
 * The dimension this structure needs is the **slot layout** — every key's slot and every
 * tombstone — before deletes, after them, and after re-inserts. Membership and per-probe
 * counts alone would pass a twin with a different tombstone rule (never reusing, reusing the
 * last tombstone, emptying a slot whose successor is empty, backward-shift deletion), since
 * each answers every query correctly; only the layout, and the counts that follow from it on
 * the next operation, separate them. The churn lines pin the priming rule and the churn
 * block, which is what makes the measured churn curve drift-free (docs/METHODOLOGY.md §2.8).
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_hoa`.
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
  slotsAfter: Slot[];
  searchAfter: FlagOps[];
  reinserts: number[];
  ins: FlagOps[];
  slotsFinal: Slot[];
  shapeFinal: number[];
  churnKey: number;
  churnKeys: number[];
  slotsChurn: Slot[];
  churn: number;
}

const tokens = (rest: string): string[] => rest.split(/\s+/).filter((t) => t.length > 0);
const parseNums = (rest: string): number[] => tokens(rest).map(Number);
const parseFlagOps = (rest: string): FlagOps[] =>
  tokens(rest).map((tok) => {
    const [flag, ops] = tok.split(':');
    return { flag: flag === '1', ops: Number(ops) };
  });
const parseSlots = (rest: string): Slot[] =>
  tokens(rest).map((t) => (t === '.' || t === 'x' ? t : Number(t)));

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
      case 'hoa_order': c.order = parseNums(rest); break;
      case 'hoa_search': c.search = parseFlagOps(rest); break;
      case 'hoa_slots': c.slots = parseSlots(rest); break;
      case 'hoa_shape': c.shape = parseNums(rest); break;
      case 'deletes': c.deletes = parseNums(rest); break;
      case 'hoa_delete': c.del = parseFlagOps(rest); break;
      case 'hoa_slots_after': c.slotsAfter = parseSlots(rest); break;
      case 'hoa_search_after': c.searchAfter = parseFlagOps(rest); break;
      case 'reinserts': c.reinserts = parseNums(rest); break;
      case 'hoa_insert': c.ins = parseFlagOps(rest); break;
      case 'hoa_slots_final': c.slotsFinal = parseSlots(rest); break;
      case 'hoa_shape_final': c.shapeFinal = parseNums(rest); break;
      case 'churn_key': c.churnKey = Number(rest); break;
      case 'hoa_churn_keys': c.churnKeys = parseNums(rest); break;
      case 'hoa_slots_churn': c.slotsChurn = parseSlots(rest); break;
      case 'hoa_churn': c.churn = Number(rest); break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const shapeOf = (s: HashSetOaF64): number[] => [s.capacity, s.size, s.tombstones];
const asSearch = (r: { found: boolean; ops: number }): FlagOps => ({ flag: r.found, ops: r.ops });

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS HashSetOaF64 vs the Rust corpus', () => {
  it('parsed every case, including the purge, cluster and churn-block ones', () => {
    expect(corpus.map((c) => c.name)).toEqual(
      expect.arrayContaining(['empty', 'rehash', 'cluster', 'purge', 'block']),
    );
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('order, per-probe (membership, ops) and the slot layout match Rust', () => {
      const s = HashSetOaF64.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => asSearch(s.search(p)))).toEqual(c.search);
      expect(s.slots()).toEqual(c.slots);
      expect(shapeOf(s)).toEqual(c.shape);
    });

    it('deletes leave the same tombstones, which later searches and re-inserts walk the same way', () => {
      const s = HashSetOaF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => s.delete(d)).map((r) => ({ flag: r.removed, ops: r.ops }))).toEqual(c.del);
      expect(s.slots()).toEqual(c.slotsAfter);
      expect(c.probes.map((p) => asSearch(s.search(p)))).toEqual(c.searchAfter);
      expect(c.reinserts.map((r) => s.insert(r)).map((r) => ({ flag: r.inserted, ops: r.ops }))).toEqual(c.ins);
      expect(s.slots()).toEqual(c.slotsFinal);
      expect(shapeOf(s)).toEqual(c.shapeFinal);
    });

    it('the churn block, its primed layout and the per-pair churn op-count match Rust', () => {
      const s = HashSetOaF64.fromKeys(c.keys);
      s.setChurnKey(c.churnKey);
      expect(s.churnBlockKeys()).toEqual(c.churnKeys);
      expect(s.slots()).toEqual(c.slotsChurn);
      expect(s.churnCounted()).toBe(c.churn);
      // A counted pair restores the table, so the layout is still the primed one.
      expect(s.slots()).toEqual(c.slotsChurn);
    });
  });
});
