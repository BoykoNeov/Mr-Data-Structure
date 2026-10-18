import { describe, it, expect } from 'vitest';
import corpusText from '../../conformance/corpus-btree.txt?raw';
import { BTreeF64, type BTreeEvents } from '../structures/btree';
import { countCostEvents, type BTreeEvent } from './events';
import { btreeModel, foldBTree, reduceBTree, btreeLevelsOf, btreeShapeOf, btreeNodeAtPath, type BTreeModel } from './model';
import { BTREE_SEED, BTREE_EXPLORE_T } from './VizPanel';

/**
 * The step-event ↔ op-count invariant (docs/PLAN.md §2.1, risk R1) for the **B-tree**.
 * Its metric is comparisons + splits/merges/borrows, so the cost events are the in-node
 * probes, the deferred equality check, a non-root split's median comparison, and the
 * three structural events, and
 *
 *     countCostEvents(stream) === ops
 *
 * for search, insert AND delete. A second invariant, held apart from the first: each
 * op's split / borrow / merge events, by kind, equal the deltas of the twin's own
 * `eventCounts()` — so the drawing shows exactly the restructuring the benchmark tallies.
 *
 * **Chained to the Rust corpus** (`conformance/corpus-btree.txt`, cases at t = 2, 3 and
 * 16): a traced build from empty with the drawing folded alongside, checked per insert
 * against `btree_build_ops` and — the drawing itself — against `btree_levels`; then the
 * probes against `btree_search`, and the traced delete sequence against `btree_delete` and
 * `btree_levels_after`. Each case is built with its own `t`, so the fold is proven not to
 * assume the Explore tab's.
 */

interface Case {
  name: string;
  t: number;
  keys: number[];
  probes: number[];
  build: number[];
  search: { found: boolean; ops: number }[];
  levels: string;
  deletes: number[];
  del: { removed: boolean; ops: number }[];
  levelsAfter: string;
}

/** The corpus lines this file needs; the full parser lives in `conformance-btree.test.ts`. */
function corpusCases(text: string): Case[] {
  const cases: Case[] = [];
  const tokens = (rest: string) => rest.split(/\s+/).filter((x) => x.length > 0);
  const nums = (rest: string) => tokens(rest).map(Number);
  const flagOps = (rest: string) =>
    tokens(rest).map((x) => {
      const [f, o] = x.split(':');
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
      case 't': c.t = Number(rest); break;
      case 'keys': c.keys = nums(rest); break;
      case 'probes': c.probes = nums(rest); break;
      case 'btree_build_ops': c.build = nums(rest); break;
      case 'btree_search': c.search = flagOps(rest).map((x) => ({ found: x.flag, ops: x.ops })); break;
      case 'btree_levels': c.levels = rest.trim(); break;
      case 'deletes': c.deletes = nums(rest); break;
      case 'btree_delete': c.del = flagOps(rest).map((x) => ({ removed: x.flag, ops: x.ops })); break;
      case 'btree_levels_after': c.levelsAfter = rest.trim(); break;
      default: break; // btree_order*: conformance-btree.test.ts
    }
  }
  return cases;
}

/** The corpus's level notation: levels `|`, nodes ` `, keys `,`, `-` for an empty tree. */
const fmt = (m: BTreeModel): string => {
  const lv = btreeLevelsOf(m);
  return lv.length === 0 ? '-' : lv.map((level) => level.map((n) => n.join(',')).join(' ')).join(' | ');
};

const STRUCTURAL: Record<keyof BTreeEvents, (e: BTreeEvent) => boolean> = {
  split: (e) => e.kind === 'btree.split',
  borrowLeft: (e) => e.kind === 'btree.borrow' && e.from === 'left',
  borrowRight: (e) => e.kind === 'btree.borrow' && e.from === 'right',
  mergeLeft: (e) => e.kind === 'btree.merge' && e.side === 'left',
  mergeRight: (e) => e.kind === 'btree.merge' && e.side === 'right',
};

/** Run one traced op; check both invariants; fold the drawing along. */
function traced(b: BTreeF64) {
  let model: BTreeModel = btreeModel(b.snapshot());
  const run = <R extends { ops: number },>(op: (tr: (e: BTreeEvent) => void) => R): { r: R; events: BTreeEvent[] } => {
    const before = b.eventCounts();
    const events: BTreeEvent[] = [];
    const r = op((e) => events.push(e));
    expect(countCostEvents(events)).toBe(r.ops);
    const after = b.eventCounts();
    for (const k of Object.keys(STRUCTURAL) as (keyof BTreeEvents)[]) {
      expect(events.filter(STRUCTURAL[k]).length).toBe(after[k] - before[k]);
    }
    model = foldBTree(model, events);
    // parentage too, not just the level listing: which child hangs from which node
    expect(btreeShapeOf(model)).toEqual(b.snapshot());
    return { r, events };
  };
  return { run, drawn: () => fmt(model), model: () => model };
}

const corpus = corpusCases(corpusText);

describe('B-tree: cost events == ops, structural events == eventCounts, over the Rust corpus', () => {
  it('parsed every case, at all three minimum degrees', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    expect(new Set(corpus.map((c) => c.t))).toEqual(new Set([2, 3, 16]));
  });

  describe.each(corpus)('case "$name" (t = $t)', (c) => {
    it('a traced build, the probes and the delete sequence match Rust — counts and the drawn levels', () => {
      const b = new BTreeF64(c.t);
      const t = traced(b);
      c.keys.forEach((k, i) => expect(t.run((tr) => b.insert(k, tr)).r.ops).toBe(c.build[i]));
      expect(t.drawn()).toBe(c.levels);
      c.probes.forEach((p, i) => {
        const { r, events } = t.run((tr) => b.search(p, tr));
        expect(r).toEqual(c.search[i]);
        expect(events[events.length - 1]).toMatchObject({ kind: 'btree.result', found: r.found });
      });
      c.deletes.forEach((d, i) => {
        const { r } = t.run((tr) => b.delete(d, tr));
        expect(r).toEqual(c.del[i]);
      });
      expect(t.drawn()).toBe(c.levelsAfter);
    });
  });
});

describe('B-tree: the seed’s teaching numbers (anchored, not just self-consistent)', () => {
  const seed = () => BTreeF64.fromKeys(BTREE_SEED, BTREE_EXPLORE_T);
  const kinds = (events: readonly BTreeEvent[]) => events.map((e) => e.kind);

  it('draws at most 5 keys a node: a root of 30, 60, 75 over four leaves, one full, one at the minimum', () => {
    expect(BTREE_EXPLORE_T).toBe(3);
    expect(seed().levels()).toEqual([[[30, 60, 75]], [[10, 15, 20, 25], [35, 40, 45, 50, 55], [65, 70], [80, 85, 90]]]);
  });

  it('search(60) finds 60 in the root and still walks on to a leaf: 5 comparisons in 2 nodes', () => {
    const events: BTreeEvent[] = [];
    expect(seed().profile(60, (e) => events.push(e))).toEqual({ found: true, ops: 5, nodeVisits: 2 });
    const descends = events.filter((e): e is Extract<BTreeEvent, { kind: 'btree.descend' }> => e.kind === 'btree.descend');
    expect(descends.map((d) => [d.leaf, d.candidate, d.fresh])).toEqual([
      [false, 60, true], // 60 is in the root — remembered, not returned
      [true, 60, false], // the leaf has nothing ≥ 60, so 60 is still the candidate
    ]);
    expect(events.filter((e) => e.kind === 'btree.check')).toEqual([{ kind: 'btree.check', target: 60, candidate: 60, found: true }]);
  });

  it('the candidate moves down: a search remembers the deepest key ≥ the target', () => {
    const events: BTreeEvent[] = [];
    seed().search(42, (e) => events.push(e)); // root: 60 is the first ≥ 42; the leaf offers 45
    const cands = events.flatMap((e) => (e.kind === 'btree.descend' ? [e.candidate] : []));
    expect(cands).toEqual([60, 45]);
  });

  it('a search above every key sees no candidate: absent with no equality test', () => {
    const events: BTreeEvent[] = [];
    const r = seed().search(99, (e) => events.push(e));
    expect(r.found).toBe(false);
    expect(events.some((e) => e.kind === 'btree.check')).toBe(false);
    expect(countCostEvents(events)).toBe(r.ops);
  });

  it('insert(33) splits the full leaf: one split + its median comparison', () => {
    const b = seed();
    const events: BTreeEvent[] = [];
    b.insert(33, (e) => events.push(e));
    expect(kinds(events).filter((k) => k === 'btree.split' || k === 'btree.medianCompare')).toEqual(['btree.split', 'btree.medianCompare']);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'btree.split', path: [], index: 1, median: 45 }));
  });

  it('a root split costs one op and has no median comparison of its own', () => {
    const b = BTreeF64.fromKeys([1, 2, 3, 4, 5], 3); // the root leaf is full
    const events: BTreeEvent[] = [];
    const r = b.insert(6, (e) => events.push(e));
    expect(kinds(events).slice(0, 2)).toEqual(['btree.growRoot', 'btree.split']);
    expect(events.some((e) => e.kind === 'btree.medianCompare')).toBe(false);
    expect(countCostEvents(events)).toBe(r.ops);
  });

  it('delete(70) borrows from the left sibling; then 85 and 90 end in a merge', () => {
    const b = seed();
    const first: BTreeEvent[] = [];
    b.delete(70, (e) => first.push(e));
    expect(first).toContainEqual({ kind: 'btree.borrow', path: [], child: 2, from: 'left' });
    b.delete(85);
    const last: BTreeEvent[] = [];
    b.delete(90, (e) => last.push(e));
    expect(last).toContainEqual({ kind: 'btree.merge', path: [], index: 2, side: 'left' });
  });

  it('the first insert into an empty tree costs nothing', () => {
    const events: BTreeEvent[] = [];
    expect(new BTreeF64(3).insert(7, (e) => events.push(e))).toEqual({ ops: 0 });
    expect(events).toEqual([{ kind: 'btree.insertKey', path: [], index: 0, value: 7 }]);
  });
});

describe('B-tree: a long random stream folds op by op and reaches every structural case', () => {
  it('fold == levels() after every op; at most one borrow per delete, and it is the last structural event', () => {
    const b = new BTreeF64(2);
    let x = 11;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const seen = new Set<string>();
    let model: BTreeModel = btreeModel(b.snapshot());
    for (let i = 0; i < 4000; i++) {
      const growing = Math.floor(i / 60) % 2 === 0;
      const k = Math.floor(rnd() * 40); // a narrow range: duplicates are common
      const events: BTreeEvent[] = [];
      const tr = (e: BTreeEvent) => events.push(e);
      const op = rnd();
      // shrink phases delete keys that are actually stored, so the tree drains to empty
      const stored = b.keysInOrder();
      const victim = !growing && stored.length > 0 ? stored[Math.floor(rnd() * stored.length)] : k;
      if (op < (growing ? 0.7 : 0.1)) b.insert(k, tr);
      else if (op < 0.9) {
        const r = b.delete(victim, tr);
        if (r.removed && events.some((e) => e.kind === 'btree.replaceWithPred')) seen.add('predecessor');
        const structural = events.filter((e) => e.kind === 'btree.borrow' || e.kind === 'btree.merge');
        const borrows = structural.filter((e) => e.kind === 'btree.borrow');
        expect(borrows.length).toBeLessThanOrEqual(1);
        if (borrows.length === 1) expect(structural[structural.length - 1].kind).toBe('btree.borrow');
      } else b.search(k, tr);
      for (const [j, e] of events.entries()) {
        // a root split is the split right after the new root grows above the full one
        if (e.kind === 'btree.split') seen.add(events[j - 1]?.kind === 'btree.growRoot' ? 'rootSplit' : 'split');
        // an internal repair moves child pointers — the case a level listing cannot check
        const internal = (path: readonly number[]) => (btreeNodeAtPath(model, path)?.kids ?? null) !== null;
        if (e.kind === 'btree.borrow') {
          seen.add(`borrow-${e.from}`);
          if (internal([...e.path, e.child])) seen.add('borrow-internal');
        }
        if (e.kind === 'btree.merge') {
          seen.add(`merge-${e.side}`);
          if (internal([...e.path, e.index])) seen.add('merge-internal');
        }
        model = reduceBTree(model, e);
      }
      if (events.some((e) => e.kind === 'btree.collapseRoot')) seen.add(model.root === null ? 'collapseEmpty' : 'collapseChild');
      expect(btreeLevelsOf(model)).toEqual(b.levels());
      expect(btreeShapeOf(model)).toEqual(b.snapshot());
      if (b.keysInOrder().length !== new Set(b.keysInOrder()).size) seen.add('duplicates');
    }
    expect([...seen].sort()).toEqual(
      [
        'borrow-internal', 'borrow-left', 'borrow-right', 'collapseChild', 'collapseEmpty', 'duplicates',
        'merge-internal', 'merge-left', 'merge-right', 'predecessor', 'rootSplit', 'split',
      ],
    );
  });
});

describe('B-tree: the tracer perturbs nothing', () => {
  it('a long mixed stream gives identical results and shapes with and without a tracer', () => {
    const quiet = new BTreeF64(2);
    const loud = new BTreeF64(2);
    let x = 21;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 1500; i++) {
      const k = Math.floor(rnd() * 60);
      const op = rnd();
      if (op < 0.45) expect(loud.insert(k, () => {})).toEqual(quiet.insert(k));
      else if (op < 0.8) expect(loud.delete(k, () => {})).toEqual(quiet.delete(k));
      else expect(loud.profile(k, () => {})).toEqual(quiet.profile(k));
    }
    expect(loud.levels()).toEqual(quiet.levels());
    expect(loud.eventCounts()).toEqual(quiet.eventCounts());
    expect(loud.check()).toBeNull();
  });
});
