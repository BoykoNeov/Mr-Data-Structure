import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the numeric/string conformance tests.
import corpusText from '../../conformance/corpus-bst.txt?raw';
import { BstF64 } from './bst';
import type { BstShape } from './bst';

/**
 * Cross-language conformance for the BST (docs/PLAN.md §8, §12, risk R1). The
 * committed `corpus-bst.txt` is generated from the Rust bench impl (the source of
 * truth, docs/PLAN.md §2.1); this test holds the TypeScript teaching twin to the
 * *same* observable behavior across two dimensions the linear/hash corpus doesn't
 * carry:
 *  - **shape** — the pre-order with explicit null markers (in-order alone can't
 *    distinguish a balanced tree from a degenerate chain), and
 *  - a **delete sequence** with per-delete `(removed, ops)` — where the Hibbard
 *    cost-metric contract lives (the in-order-successor walk is not a comparison).
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_bst`.
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
  shape: string;
  deletes: number[];
  deleteResults: DeleteResult[];
  shapeAfter: string;
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

/** Pre-order traversal with `.` null markers — the TS mirror of the Rust
 * `BstF64::preorder` serialization the corpus pins. Recursive: conformance trees
 * are tiny (the teaching impl is small-n by design), so depth is bounded. */
function preorderShape(root: BstShape | null): string {
  const out: string[] = [];
  const walk = (n: BstShape | null): void => {
    if (n === null) {
      out.push('.');
      return;
    }
    out.push(String(n.value));
    walk(n.left);
    walk(n.right);
  };
  walk(root);
  return out.join(' ');
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
      case 'bst_order':
        cur!.order = parseNums(rest);
        break;
      case 'bst_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'bst_shape':
        cur!.shape = rest;
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'bst_delete':
        cur!.deleteResults = parseFlagOps(rest).map(({ flag, ops }) => ({ removed: flag, ops }));
        break;
      case 'bst_shape_after':
        cur!.shapeAfter = rest;
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS BstF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('in-order, per-probe (membership, ops), and tree shape match Rust', () => {
      const t = BstF64.fromKeys(c.keys);
      expect(t.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => t.search(p))).toEqual(c.search);
      expect(preorderShape(t.snapshot())).toEqual(c.shape);
    });

    it('delete sequence (removed, ops) and resulting shape match Rust', () => {
      const t = BstF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => t.delete(d))).toEqual(c.deleteResults);
      expect(preorderShape(t.snapshot())).toEqual(c.shapeAfter);
    });
  });
});
