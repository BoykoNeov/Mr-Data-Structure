import * as Comlink from 'comlink';
import type { BenchEngine } from './BenchEngine';
import type { BenchWorkerApi } from './engine.worker';
import type { MeasureOptions, SweepSeries } from './measure';

/**
 * Default {@link BenchEngine} implementation: a Web Worker that hosts the
 * Rust -> WASM bench engine, fronted by Comlink so calls look like plain async
 * methods. Running off the main thread keeps the UI responsive during long
 * sweeps (docs/PLAN.md §6.2).
 */
class WasmBenchEngine implements BenchEngine {
  private readonly worker: Worker;
  private readonly api: Comlink.Remote<BenchWorkerApi>;
  private readonly readyPromise: Promise<void>;

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.api = Comlink.wrap<BenchWorkerApi>(this.worker);
    // The worker handles messages only after its module (incl. WASM) finishes
    // loading, so a resolved version() doubles as the readiness signal.
    this.readyPromise = this.api.version().then(() => undefined);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  version(): Promise<string> {
    return this.api.version();
  }

  ping(x: number): Promise<number> {
    return this.api.ping(x);
  }

  runSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    // Transfer the key buffer rather than clone it (docs/PLAN.md risk R7); this
    // detaches `keys` on this thread, so the caller must not reuse it.
    return this.api.runSweep(Comlink.transfer(keys, [keys.buffer]), sizes, opts);
  }

  runMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    // Transfer the key buffer (docs/PLAN.md risk R7) — detaches `keys` here.
    return this.api.runMutationSweep(Comlink.transfer(keys, [keys.buffer]), sizes, opts);
  }

  runBstMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    // Transfer the key buffer (docs/PLAN.md risk R7) — detaches `keys` here.
    return this.api.runBstMutationSweep(Comlink.transfer(keys, [keys.buffer]), sizes, opts);
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export function createBenchEngine(): BenchEngine {
  return new WasmBenchEngine();
}
