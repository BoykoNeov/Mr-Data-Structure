import { describe, it, expect } from 'vitest';
import type { BenchEngine } from '../bench/BenchEngine';
import type { RawMaxOpProfile } from '../bench/maxOp';
import type { StructureId } from '../bench/measure';
import { generateSorted, generateUniform, makeDataset, type Dataset } from '../data';
import {
  MAX_OP_CSV_HEADER,
  MAX_OP_SIGNAL,
  MAX_OP_WORKLOAD,
  ladderOf,
  maxOpCsv,
  maxOpFindings,
  maxOpJson,
  rowAt,
  runMaxOp,
  shapeMaxOp,
  topRows,
} from './maxOp';

const TREES: readonly StructureId[] = ['avl', 'rbt'];
const RESIZING: readonly StructureId[] = ['array', 'sarr', 'hashset', 'hashoa'];

/**
 * A fake profile with the real shape: `NaN` where a counter does not apply, exactly as the
 * Rust `MaxOpProfile` reports it. `avlDeleteRot` lets a test play the shuffled case (the AVL's
 * worst delete past 3) or the sorted one (it stays at 2).
 */
function raw(structure: StructureId, n: number, avlDeleteRot: number): RawMaxOpProfile {
  const tree = TREES.includes(structure);
  const resizing = RESIZING.includes(structure);
  const height = structure === 'avl' ? Math.ceil(1.2 * Math.log2(n)) : Math.ceil(1.6 * Math.log2(n));
  return {
    structure,
    n,
    stored: structure.startsWith('hash') ? n - 10 : n,
    height: tree ? height : NaN,
    insert_max_ops: structure === 'array' ? 0 : structure === 'rbt' ? height + 1 : 2 * Math.log2(n),
    insert_max_ops_at: structure === 'array' ? 1 : n,
    insert_mean_ops: structure === 'array' ? 0 : Math.log2(n),
    delete_max_ops: structure === 'rbt' ? height + 3 : structure === 'avl' ? height + avlDeleteRot : n,
    delete_max_ops_at: 2,
    delete_mean_ops: structure === 'array' ? n / 2 : Math.log2(n),
    deletes: n,
    delete_misses: structure.startsWith('hash') ? 10 : 0,
    insert_max_rotations: tree ? 2 : NaN,
    delete_max_rotations: structure === 'avl' ? avlDeleteRot : structure === 'rbt' ? 3 : NaN,
    insert_max_recolours: structure === 'rbt' ? 20 : NaN,
    delete_max_recolours: structure === 'rbt' ? 11 : NaN,
    insert_max_moved: resizing ? n / 2 : NaN,
    insert_max_moved_at: resizing ? n / 2 + 1 : NaN,
    resizes: resizing ? Math.log2(n) : NaN,
  };
}

function fakeEngine(avlDeleteRot: (n: number) => number, calls: unknown[] = []): Pick<BenchEngine, 'runMaxOpProfile'> {
  return {
    runMaxOpProfile: async (keys, sizes, structures) => {
      calls.push({ keys: keys.length, sizes, structures });
      return structures.flatMap((s) => sizes.map((n) => raw(s, n, avlDeleteRot(n))));
    },
  };
}

const SIZES = [250, 500, 1000, 2000, 4000];
const uniform: Dataset = generateUniform(5000, 0, 1_000_000, false, 3);

describe('runMaxOp (docs/PLAN.md §13): clock-free worst-single-operation profile', () => {
  it('hands the engine the numeric keys, the given ladder and the canonical structures, and keeps the order', async () => {
    const calls: unknown[] = [];
    const win: Record<string, unknown> = {};
    const r = await runMaxOp(fakeEngine(() => 10, calls), uniform, SIZES, undefined, win);
    expect(calls).toEqual([{ keys: 5000, sizes: SIZES, structures: r.structures }]);
    expect(r.clockFree).toBe(true);
    expect(r.workload).toBe(MAX_OP_WORKLOAD);
    expect(r.rows).toHaveLength(SIZES.length * r.structures.length);
    expect(topRows(r).map((x) => x.structure)).toEqual(r.structures);
    expect(ladderOf(r, 'avl').map((x) => x.n)).toEqual(SIZES);
    // The gate mirror: one row per structure at the top size.
    const proof = win.__maxOpProof as { structure: string; n: number }[];
    expect(proof.map((p) => p.structure)).toEqual(r.structures);
    expect(proof.every((p) => p.n === 4000)).toBe(true);
  });

  it('refuses text keys and an empty ladder rather than profiling nothing', async () => {
    const text: Dataset = makeDataset(['a', 'b'], 'string', { kind: 'as-loaded' });
    await expect(runMaxOp(fakeEngine(() => 2), text, SIZES, undefined, undefined)).rejects.toThrow(/numeric keys/);
    await expect(runMaxOp(fakeEngine(() => 2), uniform, [], undefined, undefined)).rejects.toThrow(/no sizes/);
  });

  it('turns "does not apply" (NaN) into null and keeps real zeros', () => {
    const a = shapeMaxOp(raw('array', 1000, 2));
    expect(a.insert.maxOps).toBe(0);
    expect(a.insert.maxRotations).toBeNull();
    expect(a.insert.maxRecolours).toBeNull();
    expect(a.height).toBeNull();
    expect(a.insert.maxMoved).toBe(500);
    const l = shapeMaxOp(raw('ll', 1000, 2));
    expect(l.insert.maxMoved).toBeNull();
    expect(l.insert.resizes).toBeNull();
    const t = shapeMaxOp(raw('rbt', 1000, 2));
    expect(t.insert.maxRotations).toBe(2);
    expect(t.delete.maxRotations).toBe(3);
    expect(t.insert.maxRecolours).toBe(20);
    // Recolours are their own field and never inside the op-count.
    expect(t.insert.maxOps).toBe(raw('rbt', 1000, 2).insert_max_ops);
  });
});

describe('maxOpFindings: sentences the data supports, never a claim about totals', () => {
  const NO_TOTALS = /fewer rotations|rotates less|less rotation/i;

  it('on an uneven tree: the AVL delete past the red-black limit, called a per-operation bound', async () => {
    const r = await runMaxOp(fakeEngine(() => 10), uniform, SIZES, undefined, undefined);
    const f = maxOpFindings(r).join(' ');
    expect(f).toMatch(/inside its guaranteed limit of 2 per insert and 3 per delete/);
    expect(f).toMatch(/one AVL delete needed 10 rotations/);
    expect(f).toMatch(/per-operation bound/);
    expect(f).toMatch(/says nothing about rotation totals/);
    expect(f).toMatch(/AVL insert never needs more than 2 either/);
    expect(f).not.toMatch(NO_TOTALS);
  });

  it('on sorted data: the two schemes level, and the deeper red-black tree’s worst delete dearer', async () => {
    const r = await runMaxOp(fakeEngine(() => 2), generateSorted(5000), SIZES, undefined, undefined);
    const f = maxOpFindings(r).join(' ');
    expect(f).toMatch(/stayed within the red-black limit too/);
    expect(f).not.toMatch(/one AVL delete needed/);
    expect(f).toMatch(/red-black tree’s worst delete .* costs more than the AVL’s/);
    expect(f).not.toMatch(NO_TOTALS);
  });

  it('flags a broken red-black bound instead of reporting it as held', async () => {
    const r = await runMaxOp(fakeEngine(() => 2), uniform, SIZES, undefined, undefined);
    const broken = {
      ...r,
      rows: r.rows.map((x) => (x.structure === 'rbt' ? { ...x, delete: { ...x.delete, maxRotations: 4 } } : x)),
    };
    expect(maxOpFindings(broken).join(' ')).toMatch(/PAST its guaranteed limit/);
  });

  it('names the grow-and-copy as work outside the op-count', async () => {
    const r = await runMaxOp(fakeEngine(() => 2), uniform, SIZES, undefined, undefined);
    const f = maxOpFindings(r).join(' ');
    expect(f).toMatch(/The unsorted array at n = 4000: its worst insert is 0 on its own op-count, yet its largest grow-and-copy re-placed 2000 keys at insert #2001/);
    expect(f).toMatch(/leaves out/);
    expect(f).toMatch(/amortised O\(1\)/);
  });
});

describe('max-op exports say they are counts, not timings', () => {
  it('CSV: one row per structure per size, each tagged clock-free, blanks for "does not apply"', async () => {
    const r = await runMaxOp(fakeEngine(() => 10), uniform, SIZES, undefined, undefined);
    const lines = maxOpCsv(r).trim().split('\n');
    expect(lines[0]).toBe(MAX_OP_CSV_HEADER);
    expect(lines).toHaveLength(1 + r.rows.length);
    expect(lines.slice(1).every((l) => l.includes(`"${MAX_OP_SIGNAL}"`))).toBe(true);
    expect(MAX_OP_SIGNAL).toMatch(/clock-free/);
    const arr = lines.find((l) => l.startsWith('array,250,'));
    // height, rotations, recolours: empty for an array.
    expect(arr?.split(',')[3]).toBe('');
    const header = MAX_OP_CSV_HEADER.split(',');
    expect(header).toContain('insert_max_keys_replaced');
    expect(header).toContain('delete_misses');
  });

  it('JSON: clockFree, the workload statement and the findings travel with the rows', async () => {
    const r = await runMaxOp(fakeEngine(() => 10), uniform, SIZES, undefined, undefined);
    const j = JSON.parse(maxOpJson(r, { dataset: 'uniform' })) as Record<string, unknown>;
    expect(j.clockFree).toBe(true);
    expect(j.signal).toBe(MAX_OP_SIGNAL);
    expect(j.workload).toBe(MAX_OP_WORKLOAD);
    expect(j.dataset).toBe('uniform');
    expect((j.findings as string[]).length).toBeGreaterThan(0);
    expect((j.rows as unknown[]).length).toBe(r.rows.length);
    expect(rowAt(r, 'avl', 4000)?.delete.maxRotations).toBe(10);
  });
});
