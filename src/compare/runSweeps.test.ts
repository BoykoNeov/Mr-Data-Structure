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
        // The skip list shares the sorted array's O(log n) search class and, unlike it,
        // keeps a sub-linear add/remove — the pair the shared charts are meant to contrast.
        series('skiplist', 'search', sizes, (n) => Math.log2(n)),
        // The doubly list walks the singly list's path visit for visit (METHODOLOGY §2.11).
        series('dll', 'search', sizes, (n) => 2 * n),
        // The red-black tree: O(log n) like the AVL beside it.
        series('rbt', 'search', sizes, (n) => Math.log2(n)),
        // The B-tree makes the sorted array's ≈ log₂ n comparisons (METHODOLOGY §2.10).
        series('btree', 'search', sizes, (n) => Math.log2(n)),
        // The open-addressing hash set: flat like the chaining one, higher constant
        // (primary clustering) — the same class by a different collision strategy.
        series('hashoa', 'search', sizes, () => 5),
        // The BST and the AVL, measured last so the ten series above keep the conditions the
        // gate's bands were calibrated under. Shuffled data: both O(log n).
        series('bst', 'search', sizes, (n) => 1.4 * Math.log2(n)),
        series('avl', 'search', sizes, (n) => Math.log2(n)),
        // The backward-shift hash set, after all of them: on a delete-free build it is the
        // open-addressing set's table, so its search line is that one's (METHODOLOGY §2.8).
        series('hashbs', 'search', sizes, () => 5),
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
        // The doubly list inherits regime 7 unchanged: the second pointer buys nothing here.
        ...mutTrio('dll', sizes, () => 1, (n) => n),
        ...mutTrio('hashoa', sizes, () => 4),
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
    runSkipMutationSweep: async (_k, sizes) => {
      log.push(`skip:${sizes.length}`);
      return mutTrio('skiplist', sizes, (n) => Math.log2(n));
    },
    runRbtMutationSweep: async (_k, sizes) => {
      log.push(`rbt:${sizes.length}`);
      return mutTrio('rbt', sizes, (n) => Math.log2(n));
    },
    runBTreeMutationSweep: async (_k, sizes) => {
      log.push(`btree:${sizes.length}`);
      return mutTrio('btree', sizes, (n) => Math.log2(n));
    },
    runHeapMutationSweep: async (_k, sizes) => {
      log.push(`heap:${sizes.length}`);
      return mutTrio('heap', sizes, (n) => Math.log2(n));
    },
    runHashBsMutationSweep: async (_k, sizes) => {
      log.push(`hashbs:${sizes.length}`);
      return mutTrio('hashbs', sizes, () => 4);
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
    // The graph has its own data and its own orchestrator (runGraphSweeps.test.ts); the key
    // runs must never call it, so this stub records the call and fails loudly.
    runGraphSweep: async () => {
      log.push('graph');
      throw new Error('a key-dataset run must not measure the graph');
    },
    dispose: () => {},
  };
}

describe('runAllSweeps', () => {
  it('drives every sweep from one dataset and publishes the nine proofs in order', async () => {
    const log: string[] = [];
    const statuses: string[] = [];
    const win: Record<string, unknown> = {};
    const dataset = generateUniform(50_000, 0, 50_000, true, 3);

    const r = await runAllSweeps(fakeEngine(log), dataset, (s) => statuses.push(s), win);

    expect(r.searchSizes[0]).toBe(SWEEP_MIN);
    expect(r.searchSizes[r.searchSizes.length - 1]).toBe(50_000); // capped by the dataset
    expect(r.mutationSizes[r.mutationSizes.length - 1]).toBe(MUT_MAX);
    expect(log[0]).toBe(`search:50000:${r.searchSizes.length}`);
    expect(statuses).toHaveLength(9);

    expect(r.search.map((v) => v.series.structure)).toEqual([
      'array', 'll', 'sarr', 'hashset', 'heap', 'skiplist', 'dll', 'rbt', 'btree', 'hashoa', 'bst', 'avl', 'hashbs',
    ]);
    expect(r.search[0].fit.best).toBe('O(n)');
    expect(r.search[3].fit.best).toBe('O(1)');
    // All six **flat** structures now carry a mutation trio, not just the Phase 2 pair.
    expect(r.mutation.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'array.churn', 'array.insert', 'array.delete',
      'hashset.churn', 'hashset.insert', 'hashset.delete',
      'sarr.churn', 'sarr.insert', 'sarr.delete',
      'll.churn', 'll.insert', 'll.delete',
      'dll.churn', 'dll.insert', 'dll.delete',
      'hashoa.churn', 'hashoa.insert', 'hashoa.delete',
    ]);
    // Regime 7 survives the pipeline: the list's churn and its delete land in different
    // classes, which is exactly what the UI has to show side by side.
    const byKey = (k: string) => r.mutation.find((v) => `${v.series.structure}.${v.series.op}` === k)!;
    expect(byKey('ll.churn').fit.best).toBe('O(1)');
    expect(byKey('ll.delete').fit.best).toBe('O(n)');
    expect(byKey('dll.churn').fit.best).toBe('O(1)');
    expect(byKey('dll.delete').fit.best).toBe('O(n)');
    expect(byKey('sarr.churn').fit.best).toBe('O(n)');
    // The open-addressing set rides the flat-structure bucket, so its churn lands on the
    // shared churn chart with no new engine call (docs/METHODOLOGY.md §2.8).
    expect(byKey('hashoa.churn').fit.best).toBe('O(1)');
    expect(r.trees.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'bst.churn', 'bst.insert', 'bst.delete', 'avl.churn', 'avl.insert', 'avl.delete',
      'rbt.churn', 'rbt.insert', 'rbt.delete',
    ]);
    // The red-black sweep must run *before* the heap's: the heap proof is the gate's
    // "all done" signal, so anything published after it would be read as missing.
    expect(log.indexOf(`rbt:${r.mutationSizes.length}`)).toBeLessThan(log.indexOf(`heap:${r.mutationSizes.length}`));
    // The skip list is not a tree, so it gets its own bucket — but unlike the heap that is
    // bookkeeping, not a risk-R6 split: it does the same three operations, so its series
    // land on the same shared charts as the trees'.
    expect(r.skiplist.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'skiplist.churn', 'skiplist.insert', 'skiplist.delete',
    ]);
    expect(r.skiplist[0].fit.best).toBe('O(log n)');
    // The B-tree gets its own bucket too (bookkeeping, so the BST/AVL pair's consumers did
    // not change), and lands on the same shared charts.
    expect(r.btree.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'btree.churn', 'btree.insert', 'btree.delete',
    ]);
    expect(r.btree[0].fit.best).toBe('O(log n)');
    expect(log).toContain(`btree:${r.mutationSizes.length}`);
    // Before the heap too, for the red-black sweep's reason (the heap proof is the gate's "done").
    expect(log.indexOf(`btree:${r.mutationSizes.length}`)).toBeLessThan(log.indexOf(`heap:${r.mutationSizes.length}`));
    // The heap is kept in its own bucket: its op set differs, so its churn (insert +
    // extract-min) is comparable only against its own split (docs/PLAN.md §8, risk R6).
    expect(r.heap.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'heap.churn', 'heap.insert', 'heap.delete',
    ]);
    // The backward-shift hash set: its own bucket and its own engine call, run *after* the
    // heap's so no existing series' conditions moved, yet published before the heap proof
    // (the gate's "done" signal) — see the globals' order below.
    expect(r.hashbs.map((v) => `${v.series.structure}.${v.series.op}`)).toEqual([
      'hashbs.churn', 'hashbs.insert', 'hashbs.delete',
    ]);
    expect(r.hashbs[0].fit.best).toBe('O(1)');
    expect(log.indexOf(`heap:${r.mutationSizes.length}`)).toBeLessThan(log.indexOf(`hashbs:${r.mutationSizes.length}`));
    expect(log[log.length - 1]).toBe(`hashbs:${r.mutationSizes.length}`);
    expect(r.shape).toBe('random');

    // Risk R6 at the seam: the shared search chart sees only canonical structures, and
    // the heap's scan is available separately for its own section.
    expect(canonicalSearch(r).map((v) => v.series.structure)).toEqual([
      'array', 'll', 'sarr', 'hashset', 'skiplist', 'dll', 'rbt', 'btree', 'hashoa', 'bst', 'avl', 'hashbs',
    ]);
    expect(heapSearch(r).map((v) => v.series.structure)).toEqual(['heap']);

    // The runtime gate's globals, with the heap proof set last.
    expect(Object.keys(win)).toEqual([
      '__sweepProof',
      '__mutationProof',
      '__bstMutationProof',
      '__avlMutationProof',
      '__skipMutationProof',
      '__rbtMutationProof',
      '__btreeMutationProof',
      '__hbsMutationProof',
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
    const every = [...r.search, ...r.mutation, ...r.trees, ...r.skiplist, ...r.btree, ...r.hashbs, ...r.heap];
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

describe('probe mix and stored size (docs/PLAN.md §6.3, §13)', () => {
  /** The fake engine, recording the mix each search call received. */
  function mixSpy(): { engine: BenchEngine; seen: unknown[] } {
    const seen: unknown[] = [];
    const base = fakeEngine([]);
    return {
      seen,
      engine: {
        ...base,
        runSweep: async (keys, sizes, opts, mix) => {
          seen.push(mix);
          return base.runSweep(keys, sizes, opts);
        },
        runStringSweep: async (o, b, sizes, opts, mix) => {
          seen.push(mix);
          return base.runStringSweep(o, b, sizes, opts);
        },
      },
    };
  }

  it('defaults to the calibrated 50/50 mix and reports it on the result and the gate meta', async () => {
    const { engine, seen } = mixSpy();
    const win: Record<string, unknown> = {};
    const r = await runAllSweeps(engine, generateUniform(5_000, 0, 5_000, true, 1), undefined, win);
    expect(seen).toEqual([{ presentFraction: 0.5 }]);
    expect(r.probeMix).toEqual({ presentFraction: 0.5, present: 64, absent: 64, atN: 5_000 });
    expect((win.__compareMeta as { probeMix: unknown }).probeMix).toEqual(r.probeMix);
  });

  it('forwards a chosen mix to the one search call every structure shares', async () => {
    const { engine, seen } = mixSpy();
    const r = await runAllSweeps(engine, generateUniform(5_000, 0, 5_000, true, 1), undefined, {}, { presentFraction: 1 });
    expect(seen).toEqual([{ presentFraction: 1 }]);
    expect(r.probeMix).toMatchObject({ present: 128, absent: 0 });
    const s = await runStringSweeps(engine, generateStringCorpus(500), undefined, {}, { presentFraction: 0 });
    expect(seen[1]).toEqual({ presentFraction: 0 });
    expect(s.probeMix).toMatchObject({ present: 0, absent: 128, atN: 500 });
  });

  it('carries the stored size at the top of the sweep into the gate proof', () => {
    const s = series('hashset', 'search', [10, 1000], () => 3);
    const deduped = { ...s, points: s.points.map((p) => ({ ...p, storedN: Math.round(p.n * 0.63) })) };
    const [withCount] = toProof([toView(deduped)]);
    expect(withCount).toMatchObject({ lastN: 1000, lastStoredN: 630 });
    const [without] = toProof([toView(series('array', 'insert', [10, 1000], (n) => n))]);
    expect(without).toMatchObject({ lastN: 1000, lastStoredN: null });
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
