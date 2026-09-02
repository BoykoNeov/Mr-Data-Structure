import { describe, it, expect } from 'vitest';
import type { BenchEngine } from '../bench/BenchEngine';
import type { SweepPoint, SweepSeries, StructureId, SweepOp } from '../bench/measure';
import { generateSorted, generateUniform, generateStringCorpus, makeDataset } from '../data';
import { runAllSweeps, sizesFor, toProof, toView, MUT_MAX, SWEEP_MAX, SWEEP_MIN } from './runSweeps';
import { inputShapeOf, isMonotone } from './shape';

/**
 * The Compare pipeline is pure orchestration over the engine boundary, so it is
 * tested with a **fake engine** that returns synthetic cost shapes — proving the
 * dataset → sizes → engine → fit → proof plumbing with no WASM and no clock.
 */
function point(n: number, cost: number): SweepPoint {
  return { n, nanosPerOp: cost, opCount: cost, batch: 1, reps: 3, stddevNanos: 0, minNanos: cost, maxNanos: cost };
}
function series(structure: StructureId, op: SweepOp, sizes: number[], f: (n: number) => number): SweepSeries {
  return { structure, op, points: sizes.map((n) => point(n, f(n))) };
}

function fakeEngine(log: string[]): BenchEngine {
  const mutTrio = (st: StructureId, sizes: number[], f: (n: number) => number) => [
    series(st, 'churn', sizes, f),
    series(st, 'insert', sizes, () => 1),
    series(st, 'delete', sizes, f),
  ];
  return {
    ready: async () => {},
    version: async () => 'fake',
    ping: async (x) => x + 1,
    runSweep: async (keys, sizes) => {
      log.push(`search:${keys.length}:${sizes.length}`);
      return [
        series('array', 'search', sizes, (n) => n),
        series('ll', 'search', sizes, (n) => 2 * n),
        series('sarr', 'search', sizes, (n) => Math.log2(n)),
        series('hashset', 'search', sizes, () => 3),
      ];
    },
    runMutationSweep: async (_k, sizes) => {
      log.push(`mut:${sizes.length}`);
      return [...mutTrio('array', sizes, (n) => n), ...mutTrio('hashset', sizes, () => 2)];
    },
    runBstMutationSweep: async (_k, sizes) => {
      log.push(`bst:${sizes.length}`);
      return mutTrio('bst', sizes, (n) => Math.log2(n));
    },
    runAvlMutationSweep: async (_k, sizes) => {
      log.push(`avl:${sizes.length}`);
      return mutTrio('avl', sizes, (n) => Math.log2(n));
    },
    dispose: () => {},
  };
}

describe('runAllSweeps', () => {
  it('drives every sweep from one dataset and publishes the four proofs in order', async () => {
    const log: string[] = [];
    const statuses: string[] = [];
    const win: Record<string, unknown> = {};
    const dataset = generateUniform(50_000, 0, 50_000, true, 3);

    const r = await runAllSweeps(fakeEngine(log), dataset, (s) => statuses.push(s), win);

    expect(r.searchSizes[0]).toBe(SWEEP_MIN);
    expect(r.searchSizes[r.searchSizes.length - 1]).toBe(50_000); // capped by the dataset
    expect(r.mutationSizes[r.mutationSizes.length - 1]).toBe(MUT_MAX);
    expect(log[0]).toBe(`search:50000:${r.searchSizes.length}`);
    expect(statuses).toHaveLength(4);

    expect(r.search.map((v) => v.series.structure)).toEqual(['array', 'll', 'sarr', 'hashset']);
    expect(r.search[0].fit.best).toBe('O(n)');
    expect(r.search[3].fit.best).toBe('O(1)');
    expect(r.trees.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'bst.churn', 'bst.insert', 'bst.delete', 'avl.churn', 'avl.insert', 'avl.delete',
    ]);
    expect(r.shape).toBe('random');

    // The runtime gate's globals, with the AVL proof set last.
    expect(Object.keys(win)).toEqual([
      '__sweepProof', '__mutationProof', '__bstMutationProof', '__compareMeta', '__avlMutationProof',
    ]);
    const proof = win.__sweepProof as ReturnType<typeof toProof>;
    expect(proof[0]).toMatchObject({ structure: 'array', op: 'search', best: 'O(n)' });
    expect(Number.isFinite(proof[0].slopeStderr)).toBe(true);
  });

  it('reads a sorted dataset as the sorted shape (the BST worst case)', async () => {
    const win: Record<string, unknown> = {};
    const r = await runAllSweeps(fakeEngine([]), generateSorted(2_000), undefined, win);
    expect(r.shape).toBe('sorted');
    expect(r.searchSizes[r.searchSizes.length - 1]).toBe(2_000);
    expect((win.__compareMeta as { shape: string }).shape).toBe('sorted');
  });

  it('rejects string keys and too-small datasets with a clear message', async () => {
    await expect(runAllSweeps(fakeEngine([]), generateStringCorpus(100))).rejects.toThrow(/numeric keys/);
    await expect(runAllSweeps(fakeEngine([]), generateSorted(5))).rejects.toThrow(/at least 10 keys/);
  });
});

describe('helpers', () => {
  it('sizesFor caps the ladder at the dataset size', () => {
    const s = sizesFor(generateSorted(1234), 10, SWEEP_MAX);
    expect(s[s.length - 1]).toBe(1234);
    expect(s).toContain(1000);
  });

  it('toView fits the requested signal and colours by registry', () => {
    const v = toView(series('hashset', 'search', [10, 100, 1000], () => 5), 'opcount');
    expect(v.fit.best).toBe('O(1)');
    expect(v.color).toBe('#1f77b4');
  });

  it('inputShapeOf: generators by kind, loaded data by monotonicity', () => {
    expect(inputShapeOf(generateSorted(10))).toBe('sorted');
    expect(inputShapeOf(generateUniform(10))).toBe('random');
    expect(inputShapeOf(makeDataset([5, 4, 4, 1], 'number', { kind: 'as-loaded' }))).toBe('sorted');
    expect(inputShapeOf(makeDataset([1, 3, 2], 'number', { kind: 'as-loaded' }))).toBe('random');
    expect(inputShapeOf(makeDataset(['b', 'a'], 'string', { kind: 'as-loaded' }))).toBe('random');
    expect(isMonotone([1])).toBe(true);
  });
});
