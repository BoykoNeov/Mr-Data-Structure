import type { MeasureOptions, SweepSeries } from './measure';
import type { GraphInput, GraphTraversalMeasure } from './graphBench';
import type { ProbeMix } from './probeMix';
import type { RawMaxOpProfile } from './maxOp';
import type { StructureId } from './measure';

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
   * Measure `search` cost across a size sweep for every numeric-key structure
   * (docs/PLAN.md §6.3). `keys` is the marshalled numeric key buffer; the engine
   * may consume (transfer) its backing `ArrayBuffer`, so callers must not reuse
   * it afterwards. Returns one {@link SweepSeries} per structure.
   *
   * `mix` is the present/absent probe split (docs/PLAN.md §6.3, `./probeMix`) — one value
   * applied to **every** structure in the run; omitted ⇒ the calibrated 64 + 64 default.
   *
   * `oaMaxLoad` is the **open-addressing hash set's** rehash threshold (docs/PLAN.md §13,
   * `./oaLoad`) and nothing else's — the chaining set stays at 0.75; omitted ⇒ 0.75, the
   * like-for-like pairing. Both hash set series come back with `maxLoad` stamped.
   */
  runSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
    mix?: ProbeMix,
    oaMaxLoad?: number,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops across a size sweep for the six **flat**
   * structures — unsorted array, hash set, sorted array, linked list, doubly linked
   * list, open-addressing hash set (docs/PLAN.md §6.3): returns three {@link SweepSeries}
   * per structure — `churn` (the combined insert+delete primary), plus `insert` and `delete`
   * from the finite-difference cross-check. As with {@link runSweep}, the engine
   * may transfer (consume) the `keys` buffer, so callers must not reuse it.
   * Keep `sizes` modest — four of the six have an O(n²) build or teardown (the
   * array's ordered delete, the sorted array's shifting insert and delete, both
   * linked lists' walk-to-the-tail teardown).
   *
   * `oaMaxLoad` is the open-addressing set's threshold, as in {@link runSweep}: it reaches that
   * set's churn and both of its finite-difference halves.
   */
  runMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
    oaMaxLoad?: number,
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
   * Measure the size-mutating ops for the **skip list** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 "Specialized") — three {@link SweepSeries} (`churn`, `insert`,
   * `delete`) tagged `'skiplist'`. Separate from {@link runMutationSweep} because it needs
   * the **two-key** churn recipe the trees use, not the single-key one; *not* because its
   * input is delicate. A skip list cannot degenerate on input order at all: a node's height
   * comes from its key's hash, so the same key set builds the same structure however the
   * keys arrive — which is the finding this sweep exists to draw, against the BST's chain
   * on the very same data. As with the other sweeps, the engine may transfer (consume) the
   * `keys` buffer.
   */
  runSkipMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops for the **B-tree** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 trees; docs/METHODOLOGY.md §2.10) — three {@link SweepSeries}
   * (`churn`, `insert`, `delete`) tagged `'btree'`, on the trees' **two-key** churn recipe.
   * A B-tree is balanced by construction (it only grows at the root), so no input order
   * degenerates it. As with the other sweeps, the engine may transfer (consume) `keys`.
   */
  runBTreeMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops for the **backward-shift hash set** across a size sweep
   * (docs/PLAN.md §6.3, §13; docs/METHODOLOGY.md §2.8, regime NEW) — three
   * {@link SweepSeries} (`churn`, `insert`, `delete`) tagged `'hashbs'`, on the flat
   * structures' single-key runner with the open-addressing set's churn block. A separate call
   * only so it can run after every existing mutation sweep. As with the other sweeps, the
   * engine may transfer (consume) `keys`.
   */
  runHashBsMutationSweep(
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
   * three {@link SweepSeries}, tagged `'arraystr'`, `'hashsetstr'` and `'triestr'`.
   * `offsets`/`bytes` are the marshalled offsets+UTF-8 key buffer, and the engine may
   * transfer (consume) both, so callers must not reuse them.
   *
   * A separate call from {@link runSweep} for a reason stronger than tagging: a string
   * dataset cannot build an f64 structure at all, and the two runs' curves are not
   * comparable even when both are on the chart — one comparison walks bytes, the other
   * compares two doubles (docs/METHODOLOGY.md §2.5).
   *
   * The **trie** is the third line and the reason the chart says something the numeric
   * run cannot: it is flat in n like the hash set but reaches flat by a different route
   * — one branch per key byte and no hash — so "constant" and "cheap" come apart on one
   * picture. All three are probed with the *same* derived key set, which for a trie is
   * its deepest absent case; retuning the probes per structure would end the comparison.
   * `mix` sets the present/absent split for all three alike, as in {@link runSweep}.
   */
  runStringSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
    mix?: ProbeMix,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops across a size sweep on **string keys** — nine
   * {@link SweepSeries} (`churn`, `insert`, `delete` for each of `'arraystr'`,
   * `'hashsetstr'` and `'triestr'`). Keep `sizes` modest: the string array's ordered
   * delete gives it an O(n²) teardown, with a byte-wise comparison at every step. The
   * trie's teardown is only Θ(n·L) — it is the one string structure with no quadratic
   * half. As with the other sweeps, the engine may transfer (consume) both buffers.
   */
  runStringMutationSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure the size-mutating ops for the **red-black tree** bench twin across a size sweep
   * (docs/PLAN.md §6.3, §8 trees, §13) — three {@link SweepSeries} (`churn`, `insert`,
   * `delete`) tagged `'rbt'`. The AVL's recipe exactly — the two-key churn and the
   * alternating teardown (docs/METHODOLOGY.md §4.1) — so the two balanced trees' curves are
   * comparable unit for unit. Like the AVL it is safe on sorted input: it rebalances
   * whatever order the keys arrive in. As with the other sweeps, the engine may transfer
   * (consume) the `keys` buffer.
   */
  runRbtMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]>;

  /**
   * Measure a whole-graph **traversal** — BFS and DFS from vertex 0 — on each graph in
   * `graphs` (docs/PLAN.md §8 "Specialized"; docs/METHODOLOGY.md §2.7). The graph is not a
   * key structure: it has its own data (edges, not the dataset's keys), its own op set
   * (add-edge + traverse) and two size axes, so it gets its own call rather than a slot in
   * the key sweeps. One {@link GraphTraversalMeasure} per graph, in order; each point's `n`
   * is the nominal `V`, and the caller re-keys it to the reached component's `V' + 2E'`
   * (`src/compare/runGraphSweeps.ts`). The engine may transfer (consume) every `edges`
   * buffer, so callers must not reuse them — and must not hand in two views of one buffer.
   */
  runGraphSweep(
    graphs: GraphInput[],
    opts?: MeasureOptions,
  ): Promise<GraphTraversalMeasure[]>;

  /**
   * Profile the **most expensive single operation** of each structure in `structures` at each
   * size in `sizes` (docs/PLAN.md §13, docs/METHODOLOGY.md §4 hurdle 13) — one
   * {@link RawMaxOpProfile} per structure per size, structure-major. **Clock-free**: no batch,
   * no timer; each figure is the largest per-call count of the twin's own counted path over a
   * fixed workload (build from the prefix in dataset order, then delete it ends-first —
   * `bench-engine/src/structures/maxop.rs`). Run on request, after the timed sweeps, so it
   * cannot disturb them. The engine may transfer (consume) `keys`.
   */
  runMaxOpProfile(
    keys: Float64Array,
    sizes: number[],
    structures: readonly StructureId[],
  ): Promise<RawMaxOpProfile[]>;

  /** Release the worker / underlying resources. */
  dispose(): void;
}
