import * as Comlink from 'comlink';
import init, {
  ping,
  engine_version,
  ArrayF64,
  HashSetF64,
} from '../../bench-engine/pkg/bench_engine.js';
import {
  measureSweep,
  type MeasureOptions,
  type OpRunnerFactory,
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
    const hashset = measureSweep(sizes, searchRunnerFactory(HashSetF64, keys), now, opts);
    return [
      { structure: 'array', op: 'search', points: array },
      { structure: 'hashset', op: 'search', points: hashset },
    ];
  },
};

export type BenchWorkerApi = typeof api;

Comlink.expose(api);
