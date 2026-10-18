import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-rbt.txt?raw';
import { RbtF64, type RbtShape } from '../structures/rbt';
import { AvlF64 } from '../structures/avl';
import { countCostEvents, type RbtEvent } from './events';
import { rbtModel, foldRbt, rbtShapeOf, type RbtModel } from './model';
import { RBT_SEED } from './VizPanel';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, risk R1) for the **red-black
 * tree**. Its metric is the AVL's — comparisons + rotations — so the cost events are
 * `rbt.compare` and `rbt.rotate`, and
 *
 *     countCostEvents(stream) === ops
 *
 * for search, insert AND delete. Recolours are the twin's *separate* counter, and an
 * `rbt.recolour` is emitted exactly where it ticks, so a stream's recolour events equal
 * its `recolours` — a second invariant, held apart from the first.
 *
 * **Everything is chained to the Rust corpus** (`conformance/corpus-rbt.txt`): a traced
 * build from empty with the drawing folded alongside, checked per insert against
 * `rbt_insert`, in total against `rbt_rotations[0]` / `rbt_recolours[0]`, and — the
 * drawing itself, colours included — against `rbt_shape`; then the probes against
 * `rbt_search`, and the traced delete sequence against `rbt_delete`, the `[1]` totals and
 * `rbt_shape_after`.
 */

interface Case {
  name: string;
  keys: number[];
  probes: number[];
  inserts: number[];
  search: { found: boolean; ops: number }[];
  shape: string;
  deletes: number[];
  del: { removed: boolean; ops: number }[];
  shapeAfter: string;
  rotations: [number, number];
  recolours: [number, number];
}

/** The corpus lines this file needs; the full parser lives in `conformance-rbt.test.ts`. */
function corpusCases(text: string): Case[] {
  const cases: Case[] = [];
  const tokens = (rest: string) => rest.split(/\s+/).filter((t) => t.length > 0);
  const nums = (rest: string) => tokens(rest).map(Number);
  const flagOps = (rest: string) =>
    tokens(rest).map((t) => {
      const [f, o] = t.split(':');
      return { flag: f === '1', ops: Number(o) };
    });
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    if (tag === 'case') {
      cases.push({ name: rest } as Case);
      continue;
    }
    const c = cases[cases.length - 1];
    switch (tag) {
      case 'keys': c.keys = nums(rest); break;
      case 'probes': c.probes = nums(rest); break;
      case 'rbt_insert': c.inserts = nums(rest); break;
      case 'rbt_search': c.search = flagOps(rest).map((x) => ({ found: x.flag, ops: x.ops })); break;
      case 'rbt_shape': c.shape = rest.trim(); break;
      case 'deletes': c.deletes = nums(rest); break;
      case 'rbt_delete': c.del = flagOps(rest).map((x) => ({ removed: x.flag, ops: x.ops })); break;
      case 'rbt_shape_after': c.shapeAfter = rest.trim(); break;
      case 'rbt_rotations': c.rotations = nums(rest) as [number, number]; break;
      case 'rbt_recolours': c.recolours = nums(rest) as [number, number]; break;
      default: break; // rbt_order: conformance-rbt.test.ts
    }
  }
  return cases;
}

/** Pre-order with `.` for NIL and an `r`/`b` colour tag — the corpus's shape notation. */
function preorder(root: RbtShape | null): string {
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

const count = (events: readonly RbtEvent[], kind: RbtEvent['kind']) => events.filter((e) => e.kind === kind).length;

const corpus = corpusCases(corpusText);

describe('red-black: cost events == comparisons + rotations, recolour events == recolours, over the Rust corpus', () => {
  it('parsed every case the generator writes', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(corpus)('case "$name"', (c) => {
    it('a traced build, the probes and the delete sequence match Rust — counts, totals and the drawn colours', () => {
      const t = new RbtF64();
      let model: RbtModel = rbtModel(null);
      const run = <R,>(op: (tr: (e: RbtEvent) => void) => R): { r: R; events: RbtEvent[] } => {
        const events: RbtEvent[] = [];
        const r = op((e) => events.push(e));
        model = foldRbt(model, events);
        return { r, events };
      };

      let rot = 0;
      let recol = 0;
      c.keys.forEach((k, i) => {
        const { r, events } = run((tr) => t.insert(k, tr));
        expect(r.ops).toBe(c.inserts[i]);
        expect(countCostEvents(events)).toBe(c.inserts[i]);
        expect(count(events, 'rbt.recolour')).toBe(r.recolours);
        expect(count(events, 'rbt.rotate')).toBe(r.rotations);
        rot += count(events, 'rbt.rotate');
        recol += count(events, 'rbt.recolour');
      });
      expect([rot, recol]).toEqual([c.rotations[0], c.recolours[0]]);
      expect(preorder(rbtShapeOf(model))).toBe(c.shape);

      c.probes.forEach((p, i) => {
        const { r, events } = run((tr) => t.search(p, tr));
        expect(r).toEqual(c.search[i]);
        expect(countCostEvents(events)).toBe(c.search[i].ops);
        expect(events[events.length - 1]).toEqual({ kind: 'rbt.result', found: c.search[i].found });
      });

      rot = 0;
      recol = 0;
      c.deletes.forEach((d, i) => {
        const { r, events } = run((tr) => t.delete(d, tr));
        expect({ removed: r.removed, ops: r.ops }).toEqual(c.del[i]);
        expect(countCostEvents(events)).toBe(c.del[i].ops);
        expect(count(events, 'rbt.recolour')).toBe(r.recolours);
        rot += count(events, 'rbt.rotate');
        recol += count(events, 'rbt.recolour');
      });
      expect([rot, recol]).toEqual([c.rotations[1], c.recolours[1]]);
      expect(preorder(rbtShapeOf(model))).toBe(c.shapeAfter);
    });
  });
});

describe('red-black: the seed’s teaching numbers (anchored, not just self-consistent)', () => {
  it('reuses the AVL tab’s keys; 50, 30, 70 black and the four leaves red', () => {
    expect(RBT_SEED).toEqual([50, 30, 70, 20, 40, 60, 80]);
    expect(preorder(RbtF64.fromKeys(RBT_SEED).snapshot())).toBe('50b 30b 20r . . 40r . . 70b 60r . . 80r . .');
  });

  it('insert 90, 95, 99: both trees pay 3, 5, 5 ops; the red-black tree also makes 10 recolours', () => {
    const rbt = RbtF64.fromKeys(RBT_SEED);
    const avl = AvlF64.fromKeys(RBT_SEED);
    const r = [90, 95, 99].map((k) => rbt.insert(k));
    expect(r.map((x) => x.ops)).toEqual([3, 5, 5]);
    expect([90, 95, 99].map((k) => avl.insert(k).ops)).toEqual([3, 5, 5]);
    expect(r.reduce((a, x) => a + x.recolours, 0)).toBe(10);
  });

  it('the first insert under the seed meets a red uncle: three recolours, no rotation', () => {
    const t = RbtF64.fromKeys(RBT_SEED);
    const events: RbtEvent[] = [];
    expect(t.insert(90, (e) => events.push(e))).toEqual({ ops: 3, comparisons: 3, rotations: 0, recolours: 3 });
    expect(events.filter((e) => e.kind === 'rbt.fixCase').map((e) => e.kind === 'rbt.fixCase' && e.case)).toEqual(['redUncle']);
  });

  it('delete 20, 40, then 30: the last removes a black leaf and repairs an empty (NIL) child', () => {
    const t = RbtF64.fromKeys(RBT_SEED);
    t.delete(20);
    t.delete(40);
    const events: RbtEvent[] = [];
    t.delete(30, (e) => events.push(e));
    expect(events).toContainEqual({ kind: 'rbt.remove', path: ['L'], value: 30, black: true });
    const cases = events.filter((e): e is Extract<RbtEvent, { kind: 'rbt.fixCase' }> => e.kind === 'rbt.fixCase');
    expect(cases.map((e) => e.case)).toEqual(['farNephewRed']);
    expect(cases[0]).toMatchObject({ op: 'delete', side: 'left', at: ['L'], nil: true, other: ['R'] });
    expect(preorder(t.snapshot())).toBe('70b 50b . 60r . . 80b . .');
  });

  it('the inner-child insert case rotates, then falls into the outer-child case — two markers', () => {
    const t = RbtF64.fromKeys([10, 30]);
    const events: RbtEvent[] = [];
    t.insert(20, (e) => events.push(e)); // 20 is 30's left child, 30 is 10's right: a zig-zag
    const cases = events.filter((e): e is Extract<RbtEvent, { kind: 'rbt.fixCase' }> => e.kind === 'rbt.fixCase');
    expect(cases.map((e) => e.case)).toEqual(['innerChild', 'outerChild']);
    expect(cases.every((e) => e.side === 'right')).toBe(true);
    expect(count(events, 'rbt.rotate')).toBe(2);
  });

  it('deleting the only key emits no fix-up at all', () => {
    const t = RbtF64.fromKeys([42]);
    const events: RbtEvent[] = [];
    t.delete(42, (e) => events.push(e));
    expect(events.some((e) => e.kind === 'rbt.fixCase' || e.kind === 'rbt.recolour')).toBe(false);
  });
});

describe('red-black: every delete fix-up case occurs, and the per-operation bound holds', () => {
  it('over a long random stream: ≤ 2 rotations per insert, ≤ 3 per delete, all eight cases seen', () => {
    const t = new RbtF64();
    let x = 99;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const events: RbtEvent[] = [];
      const k = Math.floor(rnd() * 200);
      if (rnd() < 0.55) {
        t.insert(k, (e) => events.push(e));
        expect(count(events, 'rbt.rotate')).toBeLessThanOrEqual(2);
      } else {
        t.delete(k, (e) => events.push(e));
        expect(count(events, 'rbt.rotate')).toBeLessThanOrEqual(3);
      }
      for (const e of events) if (e.kind === 'rbt.fixCase') seen.add(e.case);
    }
    expect([...seen].sort()).toEqual(
      ['blackNephews', 'farNephewRed', 'innerChild', 'nearNephewRed', 'outerChild', 'redSibling', 'redUncle', 'redX'],
    );
  });
});

describe('red-black: the tracer perturbs nothing', () => {
  it('a long mixed stream gives identical results and shapes with and without a tracer', () => {
    const quiet = new RbtF64();
    const loud = new RbtF64();
    let x = 5;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 1500; i++) {
      const k = Math.floor(rnd() * 80);
      const op = rnd();
      if (op < 0.45) expect(loud.insert(k, () => {})).toEqual(quiet.insert(k));
      else if (op < 0.8) expect(loud.delete(k, () => {})).toEqual(quiet.delete(k));
      else expect(loud.search(k, () => {})).toEqual(quiet.search(k));
    }
    expect(loud.snapshot()).toEqual(quiet.snapshot());
    expect(loud.checkInvariants()).toBe(true);
  });
});
