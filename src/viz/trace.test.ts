import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus.txt?raw';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { countCostEvents, type ArrayEvent, type HashSetEvent } from './events';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, the Phase 3 advisor
 * gate). The animation must show *exactly* the comparisons the benchmark counts,
 * or the teaching tool lies about cost. We enforce that structurally: the events
 * tagged as cost-bearing (`arr.compare`, `hs.hash`, `hs.probe`) are emitted at
 * the same points the op-counter ticks, so for every op
 *
 *     countCostEvents(stream) === op-count.
 *
 * We assert it against the cross-language conformance corpus (the Rust source of
 * truth, docs/PLAN.md §12), so the same numbers already pinned across languages
 * are now also pinned to the animation. If a future refactor drifts the tracer
 * from the counter, this fails — alongside `conformance.test.ts`.
 */

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  arraySearch: { found: boolean; ops: number }[];
  hashsetSearch: { found: boolean; ops: number }[];
}

function parseNums(rest: string): number[] {
  return rest.split(/\s+/).filter((t) => t.length > 0).map(Number);
}

function parseSearch(rest: string): { found: boolean; ops: number }[] {
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
      case 'array_search': cur!.arraySearch = parseSearch(rest); break;
      case 'hashset_search': cur!.hashsetSearch = parseSearch(rest); break;
      // order tags are exercised by conformance.test.ts; ignore here.
      case 'array_order':
      case 'hashset_order':
        break;
      default: throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('step-event ↔ op-count invariant (vs the Rust corpus)', () => {
  it('parsed a non-empty corpus', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('array search: cost-event count equals the op-count for every probe', () => {
      const a = DynArrayF64.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const events: ArrayEvent[] = [];
        const result = a.search(p, (e) => events.push(e));
        expect(result.found).toBe(c.arraySearch[i].found);
        expect(result.ops).toBe(c.arraySearch[i].ops);
        // the structural guarantee: the stream carries exactly `ops` cost events.
        expect(countCostEvents(events)).toBe(c.arraySearch[i].ops);
        // and the terminal marker agrees with membership.
        const last = events[events.length - 1];
        expect(last).toEqual({ kind: 'arr.result', found: c.arraySearch[i].found });
      });
    });

    it('hash-set search: cost-event count equals the op-count for every probe', () => {
      const s = HashSetF64.fromKeys(c.keys);
      c.probes.forEach((p, i) => {
        const events: HashSetEvent[] = [];
        const result = s.search(p, (e) => events.push(e));
        expect(result.found).toBe(c.hashsetSearch[i].found);
        expect(result.ops).toBe(c.hashsetSearch[i].ops);
        expect(countCostEvents(events)).toBe(c.hashsetSearch[i].ops);
        const last = events[events.length - 1];
        expect(last).toEqual({ kind: 'hs.result', found: c.hashsetSearch[i].found });
      });
    });
  });
});
