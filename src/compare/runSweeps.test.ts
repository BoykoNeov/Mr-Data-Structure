import { describe, it, expect } from 'vitest';
import type { BenchEngine } from '../bench/BenchEngine';
import type { SweepPoint, SweepSeries, StructureId, SweepOp } from '../bench/measure';
import { generateSorted, generateUniform, generateStringCorpus, makeDataset } from '../data';
import {
  runAllSweeps,
  runStringSweeps,
  sizesFor,
  toProof,
  toView,
  canonicalSearch,
  heapSearch,
  MUT_MAX,
  STRING_MUT_MAX,
  STRING_SWEEP_MAX,
  SWEEP_MAX,
  SWEEP_MIN,
} from './runSweeps';
import { REGISTRY } from '../registry';
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
  const mutTrio = (
    st: StructureId,
    sizes: number[],
    f: (n: number) => number,
    deleteF: (n: number) => number = f,
  ) => [
    series(st, 'churn', sizes, f),
    series(st, 'insert', sizes, () => 1),
    series(st, 'delete', sizes, deleteF),
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
        // The heap's scan is measured on the same ladder but is NOT a fifth competitor —
        // it is the O(n) contrast, split off by `canonicalSearch` / `heapSearch` (risk R6).
        series('heap', 'search', sizes, (n) => n),
      ];
    },
    runMutationSweep: async (_k, sizes) => {
      log.push(`mut:${sizes.length}`);
      return [
        ...mutTrio('array', sizes, (n) => n),
        ...mutTrio('hashset', sizes, () => 2),
        ...mutTrio('sarr', sizes, (n) => 2 * n),
        // The linked list's shape is the point of regime 7 (METHODOLOGY §2.3): its churn
        // is honestly O(1) — a head insert and a delete that hits the head — while the
        // canonical delete-by-value in the teardown is O(n). The two series disagree on
        // *class*, so the fake reproduces that here rather than a single cost shape.
        ...mutTrio('ll', sizes, () => 1, (n) => n),
      ];
    },
    runBstMutationSweep: async (_k, sizes) => {
      log.push(`bst:${sizes.length}`);
      return mutTrio('bst', sizes, (n) => Math.log2(n));
    },
    runAvlMutationSweep: async (_k, sizes) => {
      log.push(`avl:${sizes.length}`);
      return mutTrio('avl', sizes, (n) => Math.log2(n));
    },
    runHeapMutationSweep: async (_k, sizes) => {
      log.push(`heap:${sizes.length}`);
      return mutTrio('heap', sizes, (n) => Math.log2(n));
    },
    // The string twins run the same shapes as their numeric counterparts — the point of
    // the string run is the *constant* (bytes per key), which a fake clock cannot carry.
    runStringSweep: async (offsets, bytes, sizes) => {
      log.push(`strsearch:${offsets.length - 1}:${bytes.length}:${sizes.length}`);
      return [
        series('arraystr', 'search', sizes, (n) => n),
        series('hashsetstr', 'search', sizes, () => 3),
        series('triestr', 'search', sizes, () => 7),
      ];
    },
    runStringMutationSweep: async (_o, _b, sizes) => {
      log.push(`strmut:${sizes.length}`);
      return [
        ...mutTrio('arraystr', sizes, (n) => n),
        ...mutTrio('hashsetstr', sizes, () => 2),
        ...mutTrio('triestr', sizes, () => 6),
      ];
    },
    dispose: () => {},
  };
}

describe('runAllSweeps', () => {
  it('drives every sweep from one dataset and publishes the five proofs in order', async () => {
    const log: string[] = [];
    const statuses: string[] = [];
    const win: Record<string, unknown> = {};
    const dataset = generateUniform(50_000, 0, 50_000, true, 3);

    const r = await runAllSweeps(fakeEngine(log), dataset, (s) => statuses.push(s), win);

    expect(r.searchSizes[0]).toBe(SWEEP_MIN);
    expect(r.searchSizes[r.searchSizes.length - 1]).toBe(50_000); // capped by the dataset
    expect(r.mutationSizes[r.mutationSizes.length - 1]).toBe(MUT_MAX);
    expect(log[0]).toBe(`search:50000:${r.searchSizes.length}`);
    expect(statuses).toHaveLength(5);

    expect(r.search.map((v) => v.series.structure)).toEqual(['array', 'll', 'sarr', 'hashset', 'heap']);
    expect(r.search[0].fit.best).toBe('O(n)');
    expect(r.search[3].fit.best).toBe('O(1)');
    // All four **flat** structures now carry a mutation trio, not just the Phase 2 pair.
    expect(r.mutation.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'array.churn', 'array.insert', 'array.delete',
      'hashset.churn', 'hashset.insert', 'hashset.delete',
      'sarr.churn', 'sarr.insert', 'sarr.delete',
      'll.churn', 'll.insert', 'll.delete',
    ]);
    // Regime 7 survives the pipeline: the list's churn and its delete land in different
    // classes, which is exactly what the UI has to show side by side.
    const byKey = (k: string) => r.mutation.find((v) => `${v.series.structure}.${v.series.op}` === k)!;
    expect(byKey('ll.churn').fit.best).toBe('O(1)');
    expect(byKey('ll.delete').fit.best).toBe('O(n)');
    expect(byKey('sarr.churn').fit.best).toBe('O(n)');
    expect(r.trees.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'bst.churn', 'bst.insert', 'bst.delete', 'avl.churn', 'avl.insert', 'avl.delete',
    ]);
    // The heap is kept in its own bucket: its op set differs, so its churn (insert +
    // extract-min) is comparable only against its own split (docs/PLAN.md §8, risk R6).
    expect(r.heap.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'heap.churn', 'heap.insert', 'heap.delete',
    ]);
    expect(r.shape).toBe('random');

    // Risk R6 at the seam: the shared search chart sees only canonical structures, and
    // the heap's scan is available separately for its own section.
    expect(canonicalSearch(r).map((v) => v.series.structure)).toEqual(['array', 'll', 'sarr', 'hashset']);
    expect(heapSearch(r).map((v) => v.series.structure)).toEqual(['heap']);

    // The runtime gate's globals, with the heap proof set last.
    expect(Object.keys(win)).toEqual([
      '__sweepProof',
      '__mutationProof',
      '__bstMutationProof',
      '__avlMutationProof',
      '__compareMeta',
      '__heapMutationProof',
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

  it('routes string keys to the other entry point, and rejects too-small datasets', async () => {
    await expect(runAllSweeps(fakeEngine([]), generateStringCorpus(100))).rejects.toThrow(/numeric keys/);
    await expect(runAllSweeps(fakeEngine([]), generateSorted(5))).rejects.toThrow(/at least 10 keys/);
    await expect(runStringSweeps(fakeEngine([]), generateSorted(100))).rejects.toThrow(/string keys/);
    await expect(runStringSweeps(fakeEngine([]), generateStringCorpus(5))).rejects.toThrow(/at least 10 keys/);
  });

  it('never puts a string-keyed structure in a numeric result (docs/METHODOLOGY.md §2.5)', async () => {
    const r = await runAllSweeps(fakeEngine([]), generateUniform(5_000, 0, 5_000, true, 1));
    const every = [...r.search, ...r.mutation, ...r.trees, ...r.heap];
    // Sharing a chart takes the same op set *and* the same key type. The two runs produce
    // different result objects precisely so no chart can be handed a mixture.
    expect(every.every((v) => REGISTRY[v.series.structure].keyType === 'number')).toBe(true);
  });
});

describe('runStringSweeps', () => {
  it('drives both string sweeps on its own bounds and publishes its own proofs', async () => {
    const log: string[] = [];
    const statuses: string[] = [];
    const win: Record<string, unknown> = {};
    const dataset = generateStringCorpus(50_000, 4, 4, 'abcdefgh', 3);

    const r = await runStringSweeps(fakeEngine(log), dataset, (s) => statuses.push(s), win);

    // The string caps, not the numeric ones: every op here carries the key length too.
    expect(r.searchSizes[r.searchSizes.length - 1]).toBe(STRING_SWEEP_MAX);
    expect(r.mutationSizes[r.mutationSizes.length - 1]).toBe(STRING_MUT_MAX);
    expect(statuses).toHaveLength(2);
    // Each engine call gets its own freshly marshalled (transferable) buffer pair.
    expect(log).toEqual([
      `strsearch:50000:200000:${r.searchSizes.length}`,
      `strmut:${r.mutationSizes.length}`,
    ]);

    expect(r.search.map((v) => v.series.structure)).toEqual([
      'arraystr',
      'hashsetstr',
      'triestr',
    ]);
    expect(r.search[0].fit.best).toBe('O(n)');
    // Two flat lines and one rising one: the hash set and the trie are both O(1) in the
    // number of keys, by unrelated mechanisms (docs/METHODOLOGY.md §2.5).
    expect(r.search[1].fit.best).toBe('O(1)');
    expect(r.search[2].fit.best).toBe('O(1)');
    expect(r.mutation.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'arraystr.churn', 'arraystr.insert', 'arraystr.delete',
      'hashsetstr.churn', 'hashsetstr.insert', 'hashsetstr.delete',
      'triestr.churn', 'triestr.insert', 'triestr.delete',
    ]);
    // The second cost axis, reported alongside the classes: 4 chars ⇒ 4 UTF-8 bytes.
    expect(r.meanKeyBytes).toBe(4);

    expect(Object.keys(win)).toEqual([
      '__stringSweepProof',
      '__compareMeta',
      '__stringMutationProof',
    ]);
    expect(win.__compareMeta).toMatchObject({ keyType: 'string', shape: 'random', meanKeyBytes: 4 });
    // The numeric gate globals stay untouched, so a string run can never be mistaken for
    // a numeric one that happens to be missing sweeps.
    expect(win.__sweepProof).toBeUndefined();
    expect(win.__heapMutationProof).toBeUndefined();
  });

  it('colours each string twin as its numeric twin, and fits per signal', () => {
    const v = toView(series('arraystr', 'search', [10, 100, 1000], (n) => n), 'opcount');
    expect(v.fit.best).toBe('O(n)');
    expect(v.color).toBe(REGISTRY.array.color);
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
