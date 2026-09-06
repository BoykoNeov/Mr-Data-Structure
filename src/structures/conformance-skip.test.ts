import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-skip.txt?raw';
import { SkipListF64 } from './skipList';

/**
 * Cross-language conformance for the skip list (docs/PLAN.md §8, §12, risk R1). The
 * committed `corpus-skip.txt` is generated from the Rust bench impl (the source of truth,
 * docs/PLAN.md §2.1); this test holds the TypeScript teaching twin to the same observable
 * behaviour across the dimension this structure needs and no earlier corpus carries:
 *
 *  - the **express-lane profile** — the keys at each level. Level 0 alone is a sorted
 *    linked list, so a skip list whose upper levels are mis-linked or never built still
 *    answers every membership query correctly and returns a plausible op-count; it is
 *    simply O(n). Order plus op-count would pass it. This is the counterpart to the BST
 *    corpus's pre-order shape, and it subsumes a height histogram (a key's tower height is
 *    the number of levels it appears in).
 *  - a **delete sequence**, because unlinking has to fix every level the victim occupied —
 *    the drift-prone half, exactly as Hibbard delete is for the BST.
 *
 * That the two languages agree at all rests on the height rule being a pure function of
 * the key (`splitMix64(toBits(key) ^ salt)`), which is why this structure has no RNG.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_skip`.
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
  levels: number[][];
  deletes: number[];
  deleteResults: DeleteResult[];
  orderAfter: number[];
  levelsAfter: number[][];
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

/** The express-lane profile: levels separated by `|`, `-` for a list with no levels. */
function parseLevels(rest: string): number[][] {
  if (rest.trim() === '-') return [];
  return rest.split('|').map(parseNums);
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
      case 'skip_order':
        cur!.order = parseNums(rest);
        break;
      case 'skip_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'skip_levels':
        cur!.levels = parseLevels(rest);
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'skip_delete':
        cur!.deleteResults = parseFlagOps(rest).map(({ flag, ops }) => ({ removed: flag, ops }));
        break;
      case 'skip_order_after':
        cur!.orderAfter = parseNums(rest);
        break;
      case 'skip_levels_after':
        cur!.levelsAfter = parseLevels(rest);
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS SkipListF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('order, per-probe (membership, ops), and the express lanes match Rust', () => {
      const s = SkipListF64.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => s.search(p))).toEqual(c.search);
      expect(s.levelKeys()).toEqual(c.levels);
    });

    it('delete sequence (removed, ops) and the surviving express lanes match Rust', () => {
      const s = SkipListF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => s.delete(d))).toEqual(c.deleteResults);
      expect(s.keysInOrder()).toEqual(c.orderAfter);
      expect(s.levelKeys()).toEqual(c.levelsAfter);
    });
  });
});
