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

  /**
   * Measure the size-mutating ops across a size sweep for both Phase 2 structures
   * (docs/PLAN.md §6.3): returns three {@link SweepSeries} per structure —
   * `churn` (the combined insert+delete primary), plus `insert` and `delete`
   * from the finite-difference cross-check. As with {@link runSweep}, the engine
   * may transfer (consume) the `keys` buffer, so callers must not reuse it.
   * Keep `sizes` modest — the array's ordered delete makes teardown O(n²).
   */
  runMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops for the **BST** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 trees) — three {@link SweepSeries} (`churn`, `insert`,
   * `delete`) tagged `'bst'`. Separate from {@link runMutationSweep} because a tree
   * is data-shape-sensitive: feed a **balanced (shuffled)** dataset at modest n, as
   * **sorted** input degenerates to an O(n) chain with an O(n²) build. As with the
   * other sweeps, the engine may transfer (consume) the `keys` buffer.
   */
  runBstMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /** Release the worker / underlying resources. */
  dispose(): void;
}
