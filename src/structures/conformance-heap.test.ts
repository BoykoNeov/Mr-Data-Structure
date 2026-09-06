import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-heap.txt?raw';
import { MinHeapF64 } from './heap';

/**
 * Cross-language conformance for the min-heap (docs/PLAN.md §8 Trees/heaps, §12, risk
 * R1). The committed `corpus-heap.txt` is generated from the Rust bench impl (the source
 * of truth, docs/PLAN.md §2.1); this test holds the TypeScript teaching twin to the
 * *same* observable behavior:
 *  - the **array layout** — a heap's `toArray()` is the backing complete tree in heap
 *    order, and the stored multiset does **not** determine it. Insertion order and the
 *    sift tie-breaks do, so this is the line that catches a divergent tie-break: the
 *    extracted *values* come out ascending whatever the tie-break does, and would pass
 *    on their own;
 *  - a **search** result per probe: `(found, ops)` for the deliberate O(n) scan contrast,
 *    whose cost is position-dependent *in the layout* — itself the point the contrast
 *    makes (a heap gives no lookup shortcut); and
 *  - an **extract sequence** with per-extract `(present, ops)`, the values removed, and
 *    the layout that remains. This is where all six counting rules of `heap.rs` show up
 *    at once — the child-vs-child comparison only when a right child exists, equal
 *    children breaking left, the failing comparison that ends the sift, the uncounted
 *    `heap[0] = last` refill, and the 0-op extract from a heap the pop empties. Cases
 *    extract deliberately past empty, so the `undefined` edge is pinned too.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_heap`.
 */

interface SearchResult {
  found: boolean;
  ops: number;
}
interface ExtractResult {
  present: boolean;
  ops: number;
}

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  order: number[];
  search: SearchResult[];
  extracts: number;
  extractResults: ExtractResult[];
  extracted: number[];
  orderAfter: number[];
}

function parseNums(rest: string): number[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
}

/** Parse `<flag>:<ops>` tokens shared by the search and extract result lines. */
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
      case 'heap_order':
        cur!.order = parseNums(rest);
        break;
      case 'heap_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'extracts':
        cur!.extracts = Number(rest);
        break;
      case 'heap_extract':
        cur!.extractResults = parseFlagOps(rest).map(({ flag, ops }) => ({ present: flag, ops }));
        break;
      case 'heap_extracted':
        cur!.extracted = parseNums(rest);
        break;
      case 'heap_order_after':
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

describe('cross-language conformance — TS MinHeapF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('array layout and per-probe (membership, ops) match Rust', () => {
      const h = MinHeapF64.fromKeys(c.keys);
      // The layout, not a sort: this is what a divergent sift tie-break would break.
      expect(h.toArray()).toEqual(c.order);
      expect(c.probes.map((p) => h.search(p))).toEqual(c.search);
    });

    it('extract-min sequence (present, ops, values) and remaining layout match Rust', () => {
      const h = MinHeapF64.fromKeys(c.keys);
      const results: ExtractResult[] = [];
      const values: number[] = [];
      for (let i = 0; i < c.extracts; i++) {
        const { min, ops } = h.extractMin();
        results.push({ present: min !== undefined, ops });
        if (min !== undefined) values.push(min);
      }
      expect(results).toEqual(c.extractResults);
      expect(values).toEqual(c.extracted);
      expect(h.toArray()).toEqual(c.orderAfter);
    });

    it('extracted values come out ascending — true whatever the tie-break, so not a shape proof', () => {
      const sorted = [...c.extracted].sort((a, b) => a - b);
      expect(c.extracted).toEqual(sorted);
    });
  });
});
