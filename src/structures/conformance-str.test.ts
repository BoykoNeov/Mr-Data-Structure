import { describe, it, expect } from 'vitest';
// The committed string corpus is loaded as a raw string via Vite's `?raw`. The
// file is UTF-8, so multi-byte keys (café, 日本, 🍎) decode to the same JS
// strings the Rust side wrote — no Node `fs`, keeping the test in the project's
// browser-lib typing.
import corpusText from '../../conformance/corpus-str.txt?raw';
import { DynArrayStr } from './dynArrayStr';
import { HashSetStr } from './hashSetStr';
import { TrieStr } from './trie';
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
  /** Per-probe delete on ONE fresh array, in order: `(removed, comparisons + shifts)`. */
  arrayDelete: SearchResult[];
  /** What that delete sequence leaves, in storage order. */
  arrayAfterDelete: string[];
  hashsetOrder: string[];
  hashsetSearch: SearchResult[];
  /** Per-probe insert on ONE fresh set, in order: `(inserted, hash + dedupe chain-steps)`. */
  hashsetInsert: SearchResult[];
  /** The bucket-walk order after that insert sequence — pins any rehash it triggered. */
  hashsetAfterInsert: string[];
  /** Per-probe delete on ONE fresh set, in order: `(removed, hash + chain-steps)`. */
  hashsetDelete: SearchResult[];
  hashsetAfterDelete: string[];
  /** Lexicographic-by-byte iteration — an order only the trie has. */
  trieOrder: string[];
  trieSearch: SearchResult[];
  /** Per-probe delete on a fresh trie, in order — the prune is the drift-prone part. */
  trieDelete: SearchResult[];
  /** What survives that delete sequence, again in byte order. */
  trieAfterDelete: string[];
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
      case 'array_delete': cur!.arrayDelete = parseSearch(rest); break;
      case 'array_after_delete': cur!.arrayAfterDelete = parseStrs(rest); break;
      case 'hashset_order': cur!.hashsetOrder = parseStrs(rest); break;
      case 'hashset_search': cur!.hashsetSearch = parseSearch(rest); break;
      case 'hashset_insert': cur!.hashsetInsert = parseSearch(rest); break;
      case 'hashset_after_insert': cur!.hashsetAfterInsert = parseStrs(rest); break;
      case 'hashset_delete': cur!.hashsetDelete = parseSearch(rest); break;
      case 'hashset_after_delete': cur!.hashsetAfterDelete = parseStrs(rest); break;
      case 'trie_order': cur!.trieOrder = parseStrs(rest); break;
      case 'trie_search': cur!.trieSearch = parseSearch(rest); break;
      case 'trie_delete': cur!.trieDelete = parseSearch(rest); break;
      case 'trie_after_delete': cur!.trieAfterDelete = parseStrs(rest); break;
      default: throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

/** An insert's `inserted` / a delete's `removed` in the corpus's `<0|1>:<ops>` shape. */
const toPair = (r: { readonly ops: number } & ({ readonly inserted: boolean } | { readonly removed: boolean })): SearchResult => ({
  found: 'inserted' in r ? r.inserted : r.removed,
  ops: r.ops,
});

describe('cross-language conformance — TS string teaching impls vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('exercises a key that is a prefix of another (the trie’s own edge)', () => {
    const prefixes = corpus.find((c) => c.name === 'prefixes');
    expect(prefixes?.keys).toEqual(['car', 'cart', 'cat', 'dog']);
    // "ca" is on a stored path but is not itself stored — the one miss a scan or a
    // hash cannot have, and the trie's most drift-prone answer.
    expect(prefixes?.trieSearch[prefixes.probes.indexOf('ca')].found).toBe(false);
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

    it('array: the delete sequence (comparisons + shifts) and what it leaves match Rust', () => {
      const a = DynArrayStr.fromKeys(c.keys);
      expect(c.probes.map((p) => toPair(a.delete(p)))).toEqual(c.arrayDelete);
      expect(a.keysInOrder()).toEqual(c.arrayAfterDelete);
    });

    it('hash set: the insert sequence (dedupe walk, rehash uncounted) and the order it leaves match Rust', () => {
      // The order after pins the rehash's redistribution, which the per-insert
      // counts deliberately leave out.
      const s = HashSetStr.fromKeys(c.keys);
      expect(c.probes.map((p) => toPair(s.insert(p)))).toEqual(c.hashsetInsert);
      expect(s.keysInOrder()).toEqual(c.hashsetAfterInsert);
    });

    it('hash set: the delete sequence and what it leaves match Rust', () => {
      const s = HashSetStr.fromKeys(c.keys);
      expect(c.probes.map((p) => toPair(s.delete(p)))).toEqual(c.hashsetDelete);
      expect(s.keysInOrder()).toEqual(c.hashsetAfterDelete);
    });

    it('trie: byte order and per-probe (membership, char-steps) match Rust', () => {
      const t = TrieStr.fromKeys(c.keys);
      expect(t.keysInOrder()).toEqual(c.trieOrder);
      expect(c.probes.map((p) => t.search(p))).toEqual(c.trieSearch);
    });

    it('trie: the delete sequence and what it prunes match Rust', () => {
      // Delete is where two trie implementations drift: clearing the terminal flag
      // is easy, deciding which nodes may then be unlinked is not. The corpus pins
      // both halves — each delete's (removed, char-steps) and the keys left behind.
      const t = TrieStr.fromKeys(c.keys);
      expect(c.probes.map((p) => t.delete(p))).toEqual(c.trieDelete);
      expect(t.keysInOrder()).toEqual(c.trieAfterDelete);
    });
  });
});
