import type { MeasureOptions, SweepSeries } from './measure';

/**
 * The benchmark engine boundary.
 *
 * Phase 0 defined the lifecycle plus a round-trip probe; Phase 2 adds the sweep
 * API (`runSweep` — the §6.3 measurement methodology + op-count signal, see
 * docs/PLAN.md §6/§10). Keeping the engine behind this interface is deliberate:
 * it lets a pure-TS implementation stand in if the WASM + Worker toolchain ever
 * proves too heavy (docs/PLAN.md risk R5), without the rest of the app caring
 * which implementation it talks to.
 */
export interface BenchEngine {
  /** Resolves once the underlying engine (WASM module) is loaded and usable. */
  ready(): Promise<void>;

  /** Build identifier; a successful call proves real WASM loaded, not a fallback. */
  version(): Promise<string>;

  /** Round-trip probe: returns `x + 1`, computed inside the engine. */
  ping(x: number): Promise<number>;

  /**
   * Measure `search` cost across a size sweep for both Phase 2 structures
   * (docs/PLAN.md §6.3). `keys` is the marshalled numeric key buffer; the engine
   * may consume (transfer) its backing `ArrayBuffer`, so callers must not reuse
   * it afterwards. Returns one {@link SweepSeries} per structure.
   */
  runSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /** Release the worker / underlying resources. */
  dispose(): void;
}
