import { describe, it, expect } from 'vitest';
// The committed corpus is loaded as a raw string via Vite's `?raw` (typed by vite/client) —
// no Node `fs`, matching the other conformance tests.
import corpusText from '../../conformance/corpus-rbt.txt?raw';
import { RbtF64, type RbtShape } from './rbt';

/**
 * Cross-language conformance for the red-black tree (docs/PLAN.md §8, §12, risk R1). The
 * committed `corpus-rbt.txt` is generated from the Rust bench impl (the source of truth,
 * docs/PLAN.md §2.1); this holds the TypeScript teaching twin to the same observable
 * behaviour on every dimension the corpus carries:
 *  - in-order and per-probe `(membership, ops)`;
 *  - **per-insert op-counts** during the build — the insert fix-up is where the scheme's
 *    rotations live;
 *  - **shape with colours** (pre-order, `.` for null, `r`/`b` per node) — the same shape
 *    with different colours behaves differently on the next operation;
 *  - a delete sequence with per-delete `(removed, ops)` and the shape afterwards;
 *  - the build's and the deletes' **rotation and recolour totals** (recolours are outside
 *    the shared op-count, but the methodology write-up reports them).
 *
 * Regenerated on the Rust side: `cargo test -- --ignored regen_corpus_rbt`.
 */

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  inserts: number[];
  order: number[];
  search: { found: boolean; ops: number }[];
  shape: string;
  deletes: number[];
  deleteResults: { removed: boolean; ops: number }[];
  shapeAfter: string;
  rotations: [number, number];
  recolours: [number, number];
}

function parseNums(rest: string): number[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
}

function parseFlagOps(rest: string): { flag: boolean; ops: number }[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const [flag, ops] = tok.split(':');
      return { flag: flag === '1', ops: Number(ops) };
    });
}

function pair(rest: string): [number, number] {
  const [a, b] = parseNums(rest);
  return [a, b];
}

/** Pre-order with `.` null markers and an `r`/`b` colour tag — the TS mirror of the Rust
 * corpus serialization. */
function preorderShape(root: RbtShape | null): string {
  const out: string[] = [];
  const walk = (n: RbtShape | null): void => {
    if (n === null) {
      out.push('.');
      return;
    }
    out.push(`${n.value}${n.red ? 'r' : 'b'}`);
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
      case 'rbt_insert':
        cur!.inserts = parseNums(rest);
        break;
      case 'rbt_order':
        cur!.order = parseNums(rest);
        break;
      case 'rbt_search':
        cur!.search = parseFlagOps(rest).map(({ flag, ops }) => ({ found: flag, ops }));
        break;
      case 'rbt_shape':
        cur!.shape = rest;
        break;
      case 'deletes':
        cur!.deletes = parseNums(rest);
        break;
      case 'rbt_delete':
        cur!.deleteResults = parseFlagOps(rest).map(({ flag, ops }) => ({ removed: flag, ops }));
        break;
      case 'rbt_shape_after':
        cur!.shapeAfter = rest;
        break;
      case 'rbt_rotations':
        cur!.rotations = pair(rest);
        break;
      case 'rbt_recolours':
        cur!.recolours = pair(rest);
        break;
      default:
        throw new Error(`unknown corpus tag: ${tag}`);
    }
  }
  if (cur) cases.push(cur as Case);
  return cases;
}

const corpus = parseCorpus(corpusText);

describe('cross-language conformance — TS RbtF64 vs the Rust corpus', () => {
  it('parsed a non-empty corpus covering every case the generator writes', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
    for (const c of corpus) expect(c.recolours).toBeDefined();
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('per-insert ops, in-order, per-probe (membership, ops), and shape+colour match Rust', () => {
      const t = new RbtF64();
      let rot = 0;
      let recol = 0;
      const inserts = c.keys.map((k) => {
        const r = t.insert(k);
        rot += r.rotations;
        recol += r.recolours;
        return r.ops;
      });
      expect(inserts).toEqual(c.inserts);
      expect([rot, recol]).toEqual([c.rotations[0], c.recolours[0]]);
      expect(t.keysInOrder()).toEqual(c.order);
      expect(c.probes.map((p) => t.search(p))).toEqual(c.search);
      expect(preorderShape(t.snapshot())).toEqual(c.shape);
      expect(t.checkInvariants()).toBe(true);
    });

    it('delete sequence (removed, ops), totals, and resulting shape+colour match Rust', () => {
      const t = RbtF64.fromKeys(c.keys);
      let rot = 0;
      let recol = 0;
      const results = c.deletes.map((d) => {
        const r = t.delete(d);
        rot += r.rotations;
        recol += r.recolours;
        return { removed: r.removed, ops: r.ops };
      });
      expect(results).toEqual(c.deleteResults);
      expect([rot, recol]).toEqual([c.rotations[1], c.recolours[1]]);
      expect(preorderShape(t.snapshot())).toEqual(c.shapeAfter);
      expect(t.checkInvariants()).toBe(true);
    });
  });
});
