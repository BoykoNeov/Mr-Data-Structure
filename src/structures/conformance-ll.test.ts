import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by
// vite/client) — no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-ll.txt?raw';
import { SinglyLinkedListF64, DoublyLinkedListF64, type LinkedListF64 } from './linkedList';

/**
 * Cross-language conformance for the linked list (docs/PLAN.md §8 Linear, §12, risk R1).
 * The committed `corpus-ll.txt` is generated from the Rust bench impl (the source of truth,
 * docs/PLAN.md §2.1); this test holds the TypeScript teaching twins to the *same* observable
 * behavior:
 *  - **iteration order** — head→tail, the reverse of insertion order (a list's order *is* its
 *    structure; no separate shape dimension), and
 *  - a **search** result per probe: `(found, ops)` where ops is the node-visit count — the
 *    drift-prone half (R1: one visit per node from the head, short-circuit on match), and
 *  - a **delete sequence** with per-delete `(removed, ops)` — head / middle / tail / absent.
 *
 * Crucially the *same* corpus pins **both** twins: singly and doubly are bench-identical under
 * the node-visit metric (the back-pointers are a viz-only distinction), so each must reproduce
 * it byte-for-byte. The Rust bench has a single `LinkedListF64` for the same reason.
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_ll`.
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
      case 'll_order':
        cur!.order = parseNums(rest);
        break;
      case 'll_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'll_delete':
        cur!.deleteResults = parseFlagOps(rest).map(({ flag, ops }) => ({ removed: flag, ops }));
        break;
      case 'll_order_after':
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

// Both teaching twins share one algorithm; both must reproduce the single Rust corpus.
const twins: ReadonlyArray<[string, (keys: readonly number[]) => LinkedListF64]> = [
  ['SinglyLinkedListF64', (keys) => SinglyLinkedListF64.fromKeys(keys)],
  ['DoublyLinkedListF64', (keys) => DoublyLinkedListF64.fromKeys(keys)],
];

describe('cross-language conformance — TS linked lists vs the Rust corpus', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(twins)('%s', (_name, build) => {
    describe.each(corpus)('case "$name"', (c) => {
      it('iteration order and per-probe (membership, ops) match Rust', () => {
        const l = build(c.keys);
        expect(l.keysInOrder()).toEqual(c.order);
        expect(c.probes.map((p) => l.search(p))).toEqual(c.search);
      });

      it('delete sequence (removed, ops) and resulting order match Rust', () => {
        const l = build(c.keys);
        expect(c.deletes.map((d) => l.delete(d))).toEqual(c.deleteResults);
        expect(l.keysInOrder()).toEqual(c.orderAfter);
      });
    });
  });
});
