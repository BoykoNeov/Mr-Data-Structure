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
   * Measure the size-mutating ops across a size sweep for the four **flat**
   * structures — unsorted array, hash set, sorted array, linked list
   * (docs/PLAN.md §6.3): returns three {@link SweepSeries} per structure —
   * `churn` (the combined insert+delete primary), plus `insert` and `delete`
   * from the finite-difference cross-check. As with {@link runSweep}, the engine
   * may transfer (consume) the `keys` buffer, so callers must not reuse it.
   * Keep `sizes` modest — three of the four have an O(n²) build or teardown (the
   * array's ordered delete, the sorted array's shifting insert and delete, the
   * linked list's walk-to-the-tail teardown).
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

  /**
   * Measure the size-mutating ops for the **AVL** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 trees) — three {@link SweepSeries} (`churn`, `insert`,
   * `delete`) tagged `'avl'`. A separate call from {@link runBstMutationSweep} not
   * because the AVL is data-shape-sensitive (it is *not* — it balances regardless of
   * input order, which is the whole point), but for per-structure series tagging and an
   * independent input choice. As with the other sweeps, the engine may transfer
   * (consume) the `keys` buffer.
   */
  runAvlMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops for the **min-heap** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 trees/heaps) — three {@link SweepSeries} (`churn`, `insert`,
   * `delete`) tagged `'heap'`. Separate from the tree sweeps because the heap's **op set
   * is different** (docs/PLAN.md §4.1): `churn` is insert + **extract-min**, and the
   * `delete` series is the marginal extract-min, so these curves are meaningful only
   * against each other and never against the canonical insert/search/delete structures
   * (risk R6). Input order is safe in either direction — a heap cannot degenerate — though
   * the *build* half is order-sensitive (ascending is its best case, descending its worst),
   * which moves the `insert` series but not `churn`. As with the other sweeps, the engine
   * may transfer (consume) the `keys` buffer.
   */
  runHeapMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure `search` across a size sweep on **string keys** (docs/PLAN.md §4.2, §8) —
   * two {@link SweepSeries}, tagged `'arraystr'` and `'hashsetstr'`. `offsets`/`bytes`
   * are the marshalled offsets+UTF-8 key buffer, and the engine may transfer (consume)
   * both, so callers must not reuse them.
   *
   * A separate call from {@link runSweep} for a reason stronger than tagging: a string
   * dataset cannot build an f64 structure at all, and the two runs' curves are not
   * comparable even when both are on the chart — one comparison walks bytes, the other
   * compares two doubles (docs/METHODOLOGY.md §2.5).
   */
  runStringSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops across a size sweep on **string keys** — six
   * {@link SweepSeries} (`churn`, `insert`, `delete` for each of `'arraystr'` and
   * `'hashsetstr'`). Keep `sizes` modest: the string array's ordered delete gives it an
   * O(n²) teardown, with a byte-wise comparison at every step. As with the other sweeps,
   * the engine may transfer (consume) both buffers.
   */
  runStringMutationSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /** Release the worker / underlying resources. */
  dispose(): void;
}
