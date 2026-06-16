import * as Comlink from 'comlink';
import init, {
  ping,
  engine_version,
  ArrayF64,
  HashSetF64,
  BstF64,
  AvlF64,
  SortedArrayF64,
  LinkedListF64,
} from '../../bench-engine/pkg/bench_engine.js';
import {
  measureSweep,
  measureMutationFd,
  type MeasureOptions,
  type OpRunnerFactory,
  type StructureId,
  type SweepSeries,
} from './measure';

// Runs inside a Web Worker. We use wasm-pack's `web` target specifically so
// that this module has NO top-level await: `Comlink.expose` below therefore
// runs *synchronously* during module evaluation, attaching the worker's
// message listener before the event loop can process the main thread's first
// message.
//
// (With the `bundler` target the wasm import introduces top-level await, so
// `Comlink.expose` would run only after it resolves — and the main thread's
// first message can be dispatched-and-dropped during that await, hanging the
// app at "initializing…". See docs/PLAN.md risk R5.)
//
// `init()` is kicked off here but not awaited at module top level; each method
// awaits it before touching the WASM exports.
const ready: Promise<unknown> = init();

/**
 * The WASM search structures share one shape: build from a key buffer, accept a
 * stored probe workload, run a timed batch, and report the deterministic
 * op-count. Both `ArrayF64` and `HashSetF64` satisfy it structurally.
 */
interface SearchStruct {
  set_probes(probes: Float64Array): void;
  search_n(k: number): number;
  search_counted(): number;
  free(): void;
}
type SearchStructCtor = new (keys: Float64Array, n: number) => SearchStruct;

const PRESENT_PROBES = 64;
const ABSENT_PROBES = 64;

/**
 * Build the query workload for size `n`: a spread of keys that are present, plus
 * a block guaranteed absent (just past the max key). The ~50/50 present/absent
 * mix (docs/PLAN.md §6.3) keeps the array's linear-search cost a clean function
 * of `n` while the hash set stays flat.
 */
function buildProbes(keys: Float64Array, n: number): Float64Array {
  const present = Math.min(PRESENT_PROBES, n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];
  if (!Number.isFinite(max)) max = 0; // n === 0 guard
  const probes = new Float64Array(present + ABSENT_PROBES);
  for (let i = 0; i < present; i++) {
    probes[i] = keys[Math.floor((i * n) / present)];
  }
  for (let i = 0; i < ABSENT_PROBES; i++) {
    probes[present + i] = max + 1 + i;
  }
  return probes;
}

/** A measurement runner factory backed by a WASM structure, for `search`. */
function searchRunnerFactory(
  Ctor: SearchStructCtor,
  keys: Float64Array,
): OpRunnerFactory {
  return (n) => {
    const s = new Ctor(keys.subarray(0, n), n);
    const probes = buildProbes(keys, n);
    s.set_probes(probes);
    return {
      run: (k) => s.search_n(k),
      opCountPerOp: () => s.search_counted() / probes.length,
      dispose: () => s.free(),
    };
  };
}

/**
 * The WASM mutation surface (docs/PLAN.md §6.3): a churn-able instance plus the
 * static cumulative build/teardown primitives. Both `ArrayF64` and `HashSetF64`
 * satisfy it structurally.
 */
interface MutationStruct {
  set_churn_key(key: number): void;
  churn_n(k: number): number;
  churn_counted(): number;
  free(): void;
}
interface MutationStructStatics {
  /** Timed cumulative build to n (insert side of the finite-difference method). */
  build_insert_n(keys: Float64Array, n: number): number;
  /** Deterministic cumulative insert op-count to n. */
  build_insert_counted(keys: Float64Array, n: number): number;
  /** Timed cumulative build+teardown of n (delete side, build cancels on diff). */
  build_then_teardown_n(keys: Float64Array, n: number): number;
  /** Deterministic cumulative teardown op-count from n. */
  teardown_counted(keys: Float64Array, n: number): number;
}
type MutationStructCtor = (new (keys: Float64Array, n: number) => MutationStruct) &
  MutationStructStatics;

/** Largest of the first `n` keys (n > 0 assumed by callers), or 0 if none. */
function maxOfFirst(keys: Float64Array, n: number): number {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];
  return Number.isFinite(max) ? max : 0;
}

/**
 * Churn runner (docs/PLAN.md §6.3, primary): build to n once (untimed), set a
 * spare key guaranteed absent (max + 1), then time `k` insert+delete pairs that
 * hold size at n. `opCountPerOp` is the deterministic per-pair op-count.
 */
function churnRunnerFactory(Ctor: MutationStructCtor, keys: Float64Array): OpRunnerFactory {
  return (n) => {
    const s = new Ctor(keys.subarray(0, n), n);
    s.set_churn_key(maxOfFirst(keys, n) + 1);
    return {
      run: (k) => s.churn_n(k),
      opCountPerOp: () => s.churn_counted(),
      dispose: () => s.free(),
    };
  };
}

/** Build runner (insert side): `run(k)` does `k` builds-from-empty to size n. */
function buildRunnerFactory(Ctor: MutationStructCtor, keys: Float64Array): OpRunnerFactory {
  return (n) => {
    const view = keys.subarray(0, n);
    const cumulativeOps = Ctor.build_insert_counted(view, n);
    return {
      run: (k) => {
        let acc = 0;
        for (let i = 0; i < k; i++) acc += Ctor.build_insert_n(view, n);
        return acc;
      },
      opCountPerOp: () => cumulativeOps,
    };
  };
}

/**
 * Build+teardown runner (delete side): `run(k)` does `k` build-then-teardown
 * cycles of size n. {@link measureMutationFd} subtracts the build runner's time,
 * isolating the teardown — the same insert build path cancels.
 */
function buildTeardownRunnerFactory(
  Ctor: MutationStructCtor,
  keys: Float64Array,
): OpRunnerFactory {
  return (n) => {
    const view = keys.subarray(0, n);
    const cumulativeOps =
      Ctor.build_insert_counted(view, n) + Ctor.teardown_counted(view, n);
    return {
      run: (k) => {
        let acc = 0;
        for (let i = 0; i < k; i++) acc += Ctor.build_then_teardown_n(view, n);
        return acc;
      },
      opCountPerOp: () => cumulativeOps,
    };
  };
}

const api = {
  async ping(x: number): Promise<number> {
    await ready;
    return ping(x);
  },
  async version(): Promise<string> {
    await ready;
    return engine_version();
  },
  /**
   * Run the §6.3 search measurement for both Phase 2 structures across `sizes`,
   * timing each point against the worker's `performance.now()` (docs/PLAN.md §6).
   * `keys` is the marshalled numeric key buffer (transferred in by the caller).
   */
  async runSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const array = measureSweep(sizes, searchRunnerFactory(ArrayF64, keys), now, opts);
    const ll = measureSweep(sizes, searchRunnerFactory(LinkedListF64, keys), now, opts);
    const sarr = measureSweep(sizes, searchRunnerFactory(SortedArrayF64, keys), now, opts);
    const hashset = measureSweep(sizes, searchRunnerFactory(HashSetF64, keys), now, opts);
    // Array → linked list → sorted array → hash set: the spread of search cost,
    // O(n) scan → O(n) pointer-walk → O(log n) → O(1) (docs/PLAN.md §8). The array and
    // the linked list share the *same* O(n) shape via different mechanisms — the §2.2
    // op-count-vs-mechanism contrast — then the sorted array's binary search is the
    // "missing middle" and the hash set is flat. All four satisfy the same SearchStruct
    // interface, so each drops straight into the existing runner.
    return [
      { structure: 'array', op: 'search', points: array },
      { structure: 'll', op: 'search', points: ll },
      { structure: 'sarr', op: 'search', points: sarr },
      { structure: 'hashset', op: 'search', points: hashset },
    ];
  },
  /**
   * Run the §6.3 size-mutating measurement for both Phase 2 structures across
   * `sizes`: the **churn** primary (combined insert+delete cost at fixed n) plus
   * the **finite-difference** cross-check that separates per-insert (cumulative
   * build) from per-delete (cumulative teardown). Returns three series per
   * structure: `churn`, `insert`, `delete`. `keys` is transferred in by the
   * caller. Keep `sizes` modest — the array's ordered delete makes teardown O(n²).
   */
  async runMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const structures: ReadonlyArray<[StructureId, MutationStructCtor]> = [
      ['array', ArrayF64 as unknown as MutationStructCtor],
      ['hashset', HashSetF64 as unknown as MutationStructCtor],
    ];
    const out: SweepSeries[] = [];
    for (const [structure, Ctor] of structures) {
      const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys), now, opts);
      out.push({ structure, op: 'churn', points: churn });
      const fd = measureMutationFd(
        structure,
        sizes,
        buildRunnerFactory(Ctor, keys),
        buildTeardownRunnerFactory(Ctor, keys),
        now,
        opts,
      );
      out.push(fd.insert, fd.delete);
    }
    return out;
  },
  /**
   * Run the §6.3 size-mutating measurement for the **BST** (the first tree bench
   * twin) across `sizes`: the churn primary plus the finite-difference split, as
   * three series (`churn`, `insert`, `delete`) tagged `'bst'`. Kept a *separate*
   * call from {@link runMutationSweep} because a tree's cost is data-shape-sensitive
   * in a way the array/hash set are not — on **sorted** input it degenerates to an
   * O(n) chain whose build is O(n²), so the caller must feed a *balanced* (shuffled)
   * dataset at modest n. The BST satisfies the same churn/build/teardown surface, so
   * this reuses the exact runner factories the array/hash set use. The open question
   * this slice owns — whether `churn ≈ insert_fd + delete_fd` holds for a tree — is
   * proven clock-free in Rust (`structures::methodology`); here it runs on the real
   * browser clock. `keys` is transferred in by the caller.
   */
  async runBstMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = BstF64 as unknown as MutationStructCtor;
    const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys), now, opts);
    const fd = measureMutationFd(
      'bst',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'bst', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the §6.3 size-mutating measurement for the **AVL** (the balanced tree bench
   * twin) across `sizes`: the churn primary plus the finite-difference split, as three
   * series (`churn`, `insert`, `delete`) tagged `'avl'`. A separate call from
   * {@link runBstMutationSweep} for per-structure tagging and an independent input
   * choice — **not** because the AVL is data-shape-sensitive: it rebalances regardless
   * of input order, so unlike the BST it is safe on sorted input too. The AVL satisfies
   * the same churn/build/teardown surface, so this reuses the exact runner factories the
   * array/hash set/BST use. On the real browser clock the headline is that AVL mutation
   * stays **sub-linear** (O(log n)) — the balanced contrast to the array's O(n). The
   * deterministic op-count finding (AVL stays O(log n) where the BST degenerates on
   * sorted input; churn ≈ the finite-difference sum) is proven clock-free in Rust
   * (`structures::methodology`). `keys` is transferred in by the caller.
   */
  async runAvlMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = AvlF64 as unknown as MutationStructCtor;
    const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys), now, opts);
    const fd = measureMutationFd(
      'avl',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'avl', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
};

export type BenchWorkerApi = typeof api;

Comlink.expose(api);
