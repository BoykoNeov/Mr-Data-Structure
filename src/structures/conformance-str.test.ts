import { describe, it, expect } from 'vitest';
// The committed string corpus is loaded as a raw string via Vite's `?raw`. The
// file is UTF-8, so multi-byte keys (café, 日本, 🍎) decode to the same JS
// strings the Rust side wrote — no Node `fs`, keeping the test in the project's
// browser-lib typing.
import corpusText from '../../conformance/corpus-str.txt?raw';
import { DynArrayStr } from './dynArrayStr';
import { HashSetStr } from './hashSetStr';
import type { SearchResult } from './dynArray';

/**
 * Cross-language conformance for the **string-key** structures (docs/PLAN.md
 * §12, risk R1) — the string sibling of `conformance.test.ts`. The committed
 * corpus is generated from the Rust bench impls (the source of truth); this test
 * holds the TypeScript teaching impls to the *same* observable results —
 * iteration order and per-probe `(membership, op-count)`. If the two languages'
 * algorithms (or the `mixStr` hash) drift, one side's corpus check fails.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_str`.
 */

interface Case {
  name: string;
  keys: string[];
  probes: string[];
  arrayOrder: string[];
  arraySearch: SearchResult[];
  hashsetOrder: string[];
  hashsetSearch: SearchResult[];
}

function parseStrs(rest: string): string[] {
  return rest.split(/\s+/).filter((t) => t.length > 0);
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
      case 'keys': cur!.keys = parseStrs(rest); break;
      case 'probes': cur!.probes = parseStrs(rest); break;
      case 'array_order': cur!.arrayOrder = parseStrs(rest); break;
      case 'array_search': cur!.arraySearch = parseSearch(rest); break;
      case 'hashset_order': cur!.hashsetOrder = parseStrs(rest); break;
      case 'hashset_search': cur!.hashsetSearch = parseSearch(rest); break;
      default: throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS string teaching impls vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('exercises multi-byte UTF-8 keys (byte-length ≠ char-length)', () => {
    const unicode = corpus.find((c) => c.name === 'unicode');
    expect(unicode?.keys).toContain('café');
    expect(unicode?.keys).toContain('日本');
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('array: iteration order and per-probe (membership, ops) match Rust', () => {
      const a = DynArrayStr.fromKeys(c.keys);
      expect(a.keysInOrder()).toEqual(c.arrayOrder);
      expect(c.probes.map((p) => a.search(p))).toEqual(c.arraySearch);
    });

    it('hash set: iteration order and per-probe (membership, ops) match Rust', () => {
      const s = HashSetStr.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.hashsetOrder);
      expect(c.probes.map((p) => s.search(p))).toEqual(c.hashsetSearch);
    });
  });
});
