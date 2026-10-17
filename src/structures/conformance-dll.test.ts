import { describe, it, expect } from 'vitest';
// Loaded as a raw string via Vite's `?raw`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-dll.txt?raw';
import { DoublyLinkedListF64, SinglyLinkedListF64 } from './linkedList';

/**
 * Cross-language conformance for the **doubly** linked list (docs/PLAN.md §8 Linear, §12,
 * risk R1; docs/METHODOLOGY.md §2.11). `corpus-dll.txt` is generated from the Rust bench twin
 * (`doubly_linked_list.rs`, which carries real `prev` links); this test holds the TypeScript
 * teaching twin to the same observable behaviour:
 *  - head→tail order **and tail→head order** (the `prev` walk — the dimension the singly
 *    corpus cannot carry), before and after a delete sequence and a mixed stream;
 *  - per-probe `(found, node-visits)` and per-delete `(removed, node-visits)`;
 *  - a **mixed** insert/delete stream with per-op results (`+k` → `1:0`).
 *
 * The singly teaching twin is run over the same corpus's forward dimensions too, and must
 * reproduce every result: the TS-side face of "the second pointer buys nothing" — the bench
 * equality itself is pinned in Rust (`structures::methodology`, and per op by the proptest).
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_dll`.
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
  orderRev: number[];
  search: FlagOps[];
  deletes: number[];
  deleteResults: FlagOps[];
  orderAfter: number[];
  orderRevAfter: number[];
  mixed: { del: boolean; key: number }[];
  mixedResults: FlagOps[];
  orderMixed: number[];
  orderRevMixed: number[];
}

const nums = (rest: string): number[] =>
  rest.split(/\s+/).filter((t) => t.length > 0).map(Number);

const flagOps = (rest: string): FlagOps[] =>
  rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const [flag, ops] = tok.split(':');
      return { flag: flag === '1', ops: Number(ops) };
    });

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
      case 'keys': c.keys = nums(rest); break;
      case 'probes': c.probes = nums(rest); break;
      case 'dll_order': c.order = nums(rest); break;
      case 'dll_order_rev': c.orderRev = nums(rest); break;
      case 'dll_search': c.search = flagOps(rest); break;
      case 'deletes': c.deletes = nums(rest); break;
      case 'dll_delete': c.deleteResults = flagOps(rest); break;
      case 'dll_order_after': c.orderAfter = nums(rest); break;
      case 'dll_order_rev_after': c.orderRevAfter = nums(rest); break;
      case 'mixed':
        c.mixed = rest
          .split(/\s+/)
          .filter((t) => t.length > 0)
          .map((t) => ({ del: t[0] === '-', key: Number(t.slice(1)) }));
        break;
      case 'dll_mixed': c.mixedResults = flagOps(rest); break;
      case 'dll_order_mixed': c.orderMixed = nums(rest); break;
      case 'dll_order_rev_mixed': c.orderRevMixed = nums(rest); break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

/** Run a case's mixed stream, returning per-op `(flag, ops)` in the corpus's encoding. */
function runMixed(l: SinglyLinkedListF64 | DoublyLinkedListF64, c: Case): FlagOps[] {
  return c.mixed.map(({ del, key }) => {
    if (del) {
      const r = l.delete(key);
      return { flag: r.removed, ops: r.ops };
    }
    l.insert(key);
    return { flag: true, ops: 0 };
  });
}

describe('cross-language conformance — TS doubly linked list vs the Rust dll corpus', () => {
  it('parsed every case, including the mixed-stream and backward-order dimensions', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(5);
    for (const c of corpus) {
      expect(c.orderRev).toBeDefined();
      expect(c.mixed.length).toBe(c.mixedResults.length);
    }
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('forward and backward order, and per-probe (found, ops), match Rust', () => {
      const l = DoublyLinkedListF64.fromKeys(c.keys);
      expect(l.keysInOrder()).toEqual(c.order);
      expect(l.keysReversed()).toEqual(c.orderRev);
      expect(c.probes.map((p) => l.search(p)).map((r) => ({ flag: r.found, ops: r.ops }))).toEqual(c.search);
    });

    it('delete sequence (removed, ops) and both resulting orders match Rust', () => {
      const l = DoublyLinkedListF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => l.delete(d)).map((r) => ({ flag: r.removed, ops: r.ops }))).toEqual(
        c.deleteResults,
      );
      expect(l.keysInOrder()).toEqual(c.orderAfter);
      expect(l.keysReversed()).toEqual(c.orderRevAfter);
    });

    it('mixed insert/delete stream matches Rust op for op, in both directions', () => {
      const l = DoublyLinkedListF64.fromKeys(c.keys);
      expect(runMixed(l, c)).toEqual(c.mixedResults);
      expect(l.keysInOrder()).toEqual(c.orderMixed);
      expect(l.keysReversed()).toEqual(c.orderRevMixed);
    });

    it('the singly twin reproduces every forward result — the second pointer changes no count', () => {
      const s = SinglyLinkedListF64.fromKeys(c.keys);
      expect(s.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => s.search(p)).map((r) => ({ flag: r.found, ops: r.ops }))).toEqual(c.search);
      const sd = SinglyLinkedListF64.fromKeys(c.keys);
      expect(c.deletes.map((d) => sd.delete(d)).map((r) => ({ flag: r.removed, ops: r.ops }))).toEqual(
        c.deleteResults,
      );
      const sm = SinglyLinkedListF64.fromKeys(c.keys);
      expect(runMixed(sm, c)).toEqual(c.mixedResults);
      expect(sm.keysInOrder()).toEqual(c.orderMixed);
    });
  });
});
