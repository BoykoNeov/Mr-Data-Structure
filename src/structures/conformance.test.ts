import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, so the test stays in the project's browser-lib
// typing without pulling in @types/node.
import corpusText from '../../conformance/corpus.txt?raw';
import { DynArrayF64 } from './dynArray';
import { HashSetF64 } from './hashSet';
import type { SearchResult } from './dynArray';

/**
 * Cross-language conformance (docs/PLAN.md §12, risk R1). The committed corpus
 * is generated from the Rust bench impls (the source of truth, docs/PLAN.md
 * §2.1); this test holds the TypeScript teaching impls to the *same* observable
 * results — iteration order and per-probe `(membership, op-count)`. If the two
 * languages' algorithms drift, one side's corpus check fails.
 *
 * The corpus is regenerated on the Rust side: `cargo test -- --ignored regen_corpus`.
 */

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  arrayOrder: number[];
  arraySearch: SearchResult[];
  hashsetOrder: number[];
  hashsetSearch: SearchResult[];
}

function parseNums(rest: string): number[] {
  return rest.split(/\s+/).filter((t) => t.length > 0).map(Number);
}

function parseSearch(rest: string): SearchResult[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const [found, ops] = tok.split(':');
      return { found: found === '1', ops: Number(ops) };
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
      case 'keys': cur!.keys = parseNums(rest); break;
      case 'probes': cur!.probes = parseNums(rest); break;
      case 'array_order': cur!.arrayOrder = parseNums(rest); break;
      case 'array_search': cur!.arraySearch = parseSearch(rest); break;
      case 'hashset_order': cur!.hashsetOrder = parseNums(rest); break;
      case 'hashset_search': cur!.hashsetSearch = parseSearch(rest); break;
      default: throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS teaching impls vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('array: iteration order and per-probe (membership, ops) match Rust', () => {
      const a = DynArrayF64.fromKeys(c.keys);
      expect(a.keysInOrder()).toEqual(c.arrayOrder);
      expect(c.probes.map((p) => a.search(p))).toEqual(c.arraySearch);
    });

    it('hash set: iteration order and per-probe (membership, ops) match Rust', () => {
      const s = HashSetF64.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.hashsetOrder);
      expect(c.probes.map((p) => s.search(p))).toEqual(c.hashsetSearch);
    });
  });
});
