import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-sarr.txt?raw';
import { SortedArrayF64 } from './sortedArray';

/**
 * Cross-language conformance for the sorted array (docs/PLAN.md §8 Linear, §12, risk
 * R1). The committed `corpus-sarr.txt` is generated from the Rust bench impl (the
 * source of truth, docs/PLAN.md §2.1); this test holds the TypeScript teaching twin to
 * the *same* observable behavior:
 *  - **iteration order** — the sorted multiset (a sorted array has no shape dimension), and
 *  - a **search** result per probe: `(found, ops)` where ops is the binary-search
 *    comparison count — the drift-prone half (R1: one comparison per midpoint, `==`
 *    short-circuit before `<`, half-open window), and
 *  - a **delete sequence** with per-delete `(removed, ops)` — where the cost metric's
 *    `+ shifts` term is exercised (front / back / middle deletes).
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_sarr`.
 */

interface SearchResult {
  found: boolean;
  ops: number;
}
interface DeleteResult {
  removed: boolean;
  ops: number;
}

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  order: number[];
  search: SearchResult[];
  deletes: number[];
  deleteResults: DeleteResult[];
  orderAfter: number[];
}

function parseNums(rest: string): number[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
}

/** Parse `<flag>:<ops>` tokens shared by the search and delete result lines. */
function parseFlagOps(rest: string): { flag: boolean; ops: number }[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const [flag, ops] = tok.split(':');
      return { flag: flag === '1', ops: Number(ops) };
    });
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
      case 'keys':
        cur!.keys = parseNums(rest);
        break;
      case 'probes':
        cur!.probes = parseNums(rest);
        break;
      case 'sarr_order':
        cur!.order = parseNums(rest);
        break;
      case 'sarr_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'sarr_delete':
        cur!.deleteResults = parseFlagOps(rest).map(({ flag, ops }) => ({ removed: flag, ops }));
        break;
      case 'sarr_order_after':
        cur!.orderAfter = parseNums(rest);
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS SortedArrayF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('iteration order and per-probe (membership, ops) match Rust', () => {
      const a = SortedArrayF64.fromKeys(c.keys);
      expect(a.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => a.search(p))).toEqual(c.search);
    });

    it('delete sequence (removed, ops) and resulting order match Rust', () => {
      const a = SortedArrayF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => a.delete(d))).toEqual(c.deleteResults);
      expect(a.keysInOrder()).toEqual(c.orderAfter);
    });
  });
});
