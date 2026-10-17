import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by vite/client) —
// no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-btree.txt?raw';
import { BTreeF64 } from './btree';

/**
 * Cross-language conformance for the B-tree (docs/PLAN.md §8, §12, risk R1;
 * docs/METHODOLOGY.md §2.10). `corpus-btree.txt` is generated from the Rust bench impl (the
 * source of truth, docs/PLAN.md §2.1); this holds the TypeScript teaching twin to the same
 * observable behaviour, including three dimensions the in-order sequence cannot see:
 *
 *  - **`btree_build_ops`** — every build insert's op-count, so a split that fires at a
 *    different node (or is not counted) fails here even when the final tree agrees;
 *  - **`btree_levels`** — the shape, level by level. Splitting at the wrong key or borrowing
 *    from the wrong sibling keeps the in-order sequence intact; only the shape shows it;
 *  - a **delete sequence** with per-delete `(removed, ops)` and the shape after it — the
 *    repair order (borrow left, borrow right, merge left, merge right; predecessor taken
 *    from the leaf) is the drift-prone half.
 *
 * Each case names its own minimum degree `t`: most run at `t = 2`, where a few dozen keys
 * reach every repair path, and two at the shipped `t = 16`.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_btree`.
 */

interface FlagOps {
  flag: boolean;
  ops: number;
}

interface Case {
  name: string;
  t: number;
  keys: number[];
  probes: number[];
  buildOps: number[];
  order: number[];
  search: FlagOps[];
  levels: string;
  deletes: number[];
  deleteResults: FlagOps[];
  orderAfter: number[];
  levelsAfter: string;
}

function parseNums(rest: string): number[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
}

function parseFlagOps(rest: string): FlagOps[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const [flag, ops] = tok.split(':');
      return { flag: flag === '1', ops: Number(ops) };
    });
}

/** The TS mirror of the Rust corpus's `fmt_levels`. */
function fmtLevels(b: BTreeF64): string {
  const lv = b.levels();
  if (lv.length === 0) return '-';
  return lv.map((level) => level.map((node) => node.map(String).join(',')).join(' ')).join(' | ');
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
      case 't':
        cur!.t = Number(rest);
        break;
      case 'keys':
        cur!.keys = parseNums(rest);
        break;
      case 'probes':
        cur!.probes = parseNums(rest);
        break;
      case 'btree_build_ops':
        cur!.buildOps = parseNums(rest);
        break;
      case 'btree_order':
        cur!.order = parseNums(rest);
        break;
      case 'btree_search':
        cur!.search = parseFlagOps(rest);
        break;
      case 'btree_levels':
        cur!.levels = rest;
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'btree_delete':
        cur!.deleteResults = parseFlagOps(rest);
        break;
      case 'btree_order_after':
        cur!.orderAfter = parseNums(rest);
        break;
      case 'btree_levels_after':
        cur!.levelsAfter = rest;
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS BTreeF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus covering both degrees', () => {
    expect(corpus.length).toBeGreaterThan(0);
    expect(new Set(corpus.map((c) => c.t))).toEqual(new Set([2, 3, 16]));
  });

  describe.each(corpus)('case "$name" (t = $t)', (c) => {
    it('per-insert ops, in-order, per-probe (found, ops) and shape match Rust', () => {
      const b = new BTreeF64(c.t);
      expect(c.keys.map((k) => b.insert(k).ops)).toEqual(c.buildOps);
      expect(b.check()).toBeNull();
      expect(b.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => b.search(p))).toEqual(
        c.search.map(({ flag, ops }) => ({ found: flag, ops })),
      );
      expect(fmtLevels(b)).toBe(c.levels);
    });

    it('delete sequence (removed, ops), order and shape after match Rust', () => {
      const b = BTreeF64.fromKeys(c.keys, c.t);
      expect(c.deletes.map((d) => b.delete(d))).toEqual(
        c.deleteResults.map(({ flag, ops }) => ({ removed: flag, ops })),
      );
      expect(b.check()).toBeNull();
      expect(b.keysInOrder()).toEqual(c.orderAfter);
      expect(fmtLevels(b)).toBe(c.levelsAfter);
    });
  });
});
