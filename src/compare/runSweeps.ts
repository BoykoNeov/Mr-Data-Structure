import type { BenchEngine } from '../bench/BenchEngine';
import { fitComplexity } from '../bench/fit';
import type { MeasureOptions, SweepSeries } from '../bench/measure';
import { geometricSweep } from '../bench/sweep';
import {
  marshalKeys,
  type Dataset,
  type NumberDataset,
  type StringDataset,
} from '../data';
import { REGISTRY, isCanonical, type InputShape } from '../registry';
import type { SeriesView, Signal } from '../ui/SweepChart';
import { inputShapeOf } from './shape';

/**
 * The Compare pipeline (docs/PLAN.md §6, §7, §10 Phase 5) as pure orchestration
 * over the {@link BenchEngine} boundary: one dataset in, every sweep out. It
 * owns the sweep bounds, the per-sweep measurement options, the fit of every
 * series, and the `window.__*Proof` mirrors the headless runtime gate reads
 * (`scripts/verify-browser.mjs`). The UI only renders what comes back.
 *
 * **One dataset drives every structure.** Each sweep point is an order-preserving
 * *prefix* of the dataset's keys (§6.1 — subsampling keeps the user's real
 * distribution and order), so the same input reaches the array, the lists, the
 * hash set and both trees. That is what makes "sorted data kills a naive BST"
 * a thing the user can *do* — pick the sorted generator (or load a sorted
 * column) and watch the BST churn leave the AVL's.
 */

/** Search sweeps go wide: the structures are size-preserving, so 100k is cheap. */
export const SWEEP_MAX = 100_000;
export const SWEEP_MIN = 10;
/**
 * Mutation sweeps stay small: the array's ordered delete and the sorted-input
 * BST make a full build+teardown O(n²), so a few thousand keys already reads
 * the slope (§6.3).
 */
export const MUT_MAX = 4_000;
export const MUT_MIN = 250;
/**
 * baseBatch 1 — the build/teardown runners do a *full* O(n²) cycle per `run(1)`,
 * so the default 1024 would fire a thousand of them just to clear the clamp.
 * Adaptive reps (docs/METHODOLOGY.md §2) then spend extra reps only on points
 * whose spread is wide.
 */
export const MUT_OPTS: MeasureOptions = {
  minBatchMillis: 1,
  warmupReps: 0,
  reps: 3,
  baseBatch: 1,
  targetRelStddev: 0.1,
  maxReps: 7,
};
export const SEARCH_OPTS: MeasureOptions = { targetRelStddev: 0.05, maxReps: 9 };
/**
 * The min-heap's mutation sweep, which needs a larger starting batch than the others.
 * `MUT_OPTS.baseBatch` is 1 because the array's build+teardown is a full O(n²) cycle per
 * `run(1)` — one is already plenty of work. A heap's build+teardown is only Θ(n log n),
 * cheaper by orders of magnitude, so starting at 1 makes the auto-grow spend a long
 * doubling ladder just to clear the clock clamp at the small end of the sweep. Starting
 * at 8 lands near the useful batch immediately; adaptive reps still handle noisy points.
 */
export const HEAP_OPTS: MeasureOptions = { ...MUT_OPTS, baseBatch: 8 };

/**
 * The **string** sweep's own bounds, deliberately not a reuse of the numeric ones. Every
 * operation here carries a second cost factor — the key length L — so the same n is more
 * work: a scan compares bytes rather than two doubles, and the array's ordered delete is
 * O(n²) of those comparisons *plus* a `String` move per shifted slot. These caps keep a
 * string run in the same wall-clock ballpark as a numeric one rather than the same n.
 */
export const STRING_SWEEP_MAX = 20_000;
export const STRING_MUT_MAX = 2_000;

/** What one full Compare run produces. */
export interface CompareResult {
  /**
   * `search` on every wired structure, at the wide sweep — **including the min-heap**,
   * whose scan is measured on the same size ladder for point-for-point comparability
   * with the array's. Callers must split it: the heap is not on the canonical op set, so
   * it belongs in the heap's own section, not the shared search chart (risk R6). Use
   * {@link canonicalSearch} / {@link heapSearch} rather than filtering by hand.
   */
  readonly search: readonly SeriesView[];
  /**
   * churn + finite-difference insert/delete for the four **flat** structures — unsorted
   * array, hash set, sorted array, linked list. Twelve series: each structure's churn
   * primary plus its two finite-difference halves. The list's pair is the one that must
   * be read together rather than separately (METHODOLOGY §2.3 regime 7): its churn is
   * honestly O(1) and its delete-by-value honestly O(n).
   */
  readonly mutation: readonly SeriesView[];
  /** churn + finite-difference insert/delete for the BST and the AVL. */
  readonly trees: readonly SeriesView[];
  /**
   * churn + finite-difference insert/delete for the **skip list**. Its own field rather
   * than a member of {@link trees} because it is not a tree — it is a tower of linked
   * lists — but it lands on the *same* shared charts, since it does the same three
   * operations on the same key type. The separation is bookkeeping, not a risk-R6 split.
   */
  readonly skiplist: readonly SeriesView[];
  /**
   * churn + finite-difference insert/extract-min for the **min-heap**. Kept apart from
   * {@link trees} because the op set differs: `churn` here is insert + extract-min, so
   * these curves compare only against each other (docs/PLAN.md §4.1, §8, risk R6).
   */
  readonly heap: readonly SeriesView[];
  /** The dataset's input shape, for the theoretical overlay. */
  readonly shape: InputShape;
  /** Sweep sizes actually used (bounded by the dataset). */
  readonly searchSizes: readonly number[];
  readonly mutationSizes: readonly number[];
}

/**
 * The search series for the structures on the **canonical** op set — what the shared
 * search chart may show. Excludes the min-heap (risk R6); see {@link heapSearch}.
 */
export function canonicalSearch(r: CompareResult | null): readonly SeriesView[] {
  return (r?.search ?? []).filter((v) => isCanonical(v.series.structure));
}

/**
 * The min-heap's search series — its deliberate O(n) scan contrast, rendered in the
 * heap's own section next to the array's scan rather than on the shared chart.
 */
export function heapSearch(r: CompareResult | null): readonly SeriesView[] {
  return (r?.search ?? []).filter((v) => v.series.structure === 'heap');
}

/** Fit a series on the chosen signal and attach its registry colour. */
export function toView(series: SweepSeries, signal: Signal = 'nanos'): SeriesView {
  return {
    series,
    fit: fitComplexity(
      series.points.map((p) => p.n),
      series.points.map((p) => (signal === 'nanos' ? p.nanosPerOp : p.opCount)),
    ),
    color: REGISTRY[series.structure]?.color ?? '#888',
  };
}

/** Shape mirrored onto `window` for the headless runtime check (scripts/verify-browser.mjs). */
export interface SweepProof {
  structure: string;
  op: string;
  best: string;
  slope: number;
  slopeStderr: number;
  tailSlope: number;
  trend: string;
  r2: number;
  firstNanos: number;
  lastNanos: number;
}

export function toProof(views: readonly SeriesView[]): SweepProof[] {
  return views.map((v) => ({
    structure: v.series.structure,
    op: v.series.op,
    best: v.fit.best,
    slope: v.fit.logLogSlope,
    slopeStderr: v.fit.slopeStderr,
    tailSlope: v.fit.tailSlope,
    trend: v.fit.trend,
    r2: v.fit.r2,
    firstNanos: v.series.points[0].nanosPerOp,
    lastNanos: v.series.points[v.series.points.length - 1].nanosPerOp,
  }));
}

/** The `window` globals the runtime gate polls; `__heapMutationProof` is set last. */
interface ProofWindow {
  __sweepProof?: SweepProof[];
  __mutationProof?: SweepProof[];
  __bstMutationProof?: SweepProof[];
  __avlMutationProof?: SweepProof[];
  __skipMutationProof?: SweepProof[];
  __heapMutationProof?: SweepProof[];
  /** The string run's mirrors; `__stringMutationProof` is set last (see {@link runStringSweeps}). */
  __stringSweepProof?: SweepProof[];
  __stringMutationProof?: SweepProof[];
  __compareMeta?: {
    order: unknown;
    size: number;
    shape: InputShape;
    keyType: 'number' | 'string';
    /** Mean UTF-8 bytes per key — the string run's second cost axis, 0 for a numeric run. */
    meanKeyBytes: number;
  };
}

/** Sweep sizes for a dataset: the geometric ladder, capped by the dataset size. */
export function sizesFor(dataset: Dataset, min: number, max: number): number[] {
  return geometricSweep(min, Math.min(max, dataset.size));
}

function numericOrThrow(dataset: Dataset): NumberDataset {
  if (dataset.keyType !== 'number') {
    // Not a limitation any more — a routing error. String keys have their own sweep
    // ({@link runStringSweeps}) because they drive different structures.
    throw new Error('this sweep needs numeric keys; string keys run runStringSweeps');
  }
  if (dataset.size < SWEEP_MIN) {
    throw new Error(`need at least ${SWEEP_MIN} keys to sweep (got ${dataset.size})`);
  }
  return dataset;
}

function stringOrThrow(dataset: Dataset): StringDataset {
  if (dataset.keyType !== 'string') {
    throw new Error('this sweep needs string keys; numeric keys run runAllSweeps');
  }
  if (dataset.size < SWEEP_MIN) {
    throw new Error(`need at least ${SWEEP_MIN} keys to sweep (got ${dataset.size})`);
  }
  return dataset;
}

/** A fresh transferable key buffer — every engine call consumes (transfers) its own. */
function keyBuffer(dataset: NumberDataset): Float64Array {
  const m = marshalKeys(dataset);
  if (m.keyType !== 'number') throw new Error('expected numeric keys');
  return m.values;
}

/** A fresh transferable offsets+UTF-8 pair — likewise consumed by each engine call. */
function stringBuffers(dataset: StringDataset): { offsets: Uint32Array; bytes: Uint8Array } {
  const m = marshalKeys(dataset);
  if (m.keyType !== 'string') throw new Error('expected string keys');
  return { offsets: m.offsets, bytes: m.bytes };
}

/**
 * Mean UTF-8 bytes per key — the string run's **second cost axis**. Both structures are
 * O(1) or O(n) *in n*, and additionally O(L) in this number: it is what separates the
 * wall-clock curve from the op-count curve on the same run (docs/METHODOLOGY.md §2.5).
 *
 * Takes the *offsets* rather than the dataset on purpose: the caller already has a
 * marshalled buffer in hand, and re-marshalling a large corpus just to read its last
 * offset would be a full extra encode of every key. Read it before handing the buffer to
 * the engine — the engine transfers (detaches) it.
 */
export function meanKeyBytes(offsets: Uint32Array): number {
  const n = offsets.length - 1;
  return n > 0 ? offsets[n] / n : 0;
}

/**
 * Run every sweep on `dataset`, reporting progress through `onStatus`, and
 * mirror the results onto `window` for the runtime gate. Throws (after
 * `onStatus`) when the dataset can't be swept.
 */
export async function runAllSweeps(
  engine: BenchEngine,
  dataset: Dataset,
  onStatus: (s: string) => void = () => {},
  win: ProofWindow | undefined = typeof window === 'undefined' ? undefined : (window as ProofWindow),
): Promise<CompareResult> {
  const data = numericOrThrow(dataset);
  const shape = inputShapeOf(data);
  const searchSizes = sizesFor(data, SWEEP_MIN, SWEEP_MAX);
  const mutationSizes = sizesFor(data, Math.min(MUT_MIN, data.size), MUT_MAX);

  onStatus('running search sweep…');
  const search = (await engine.runSweep(keyBuffer(data), searchSizes, SEARCH_OPTS)).map((s) => toView(s));
  if (win) win.__sweepProof = toProof(search);

  onStatus('running mutation sweep (array, hash set, sorted array, linked list)…');
  const mutation = (await engine.runMutationSweep(keyBuffer(data), mutationSizes, MUT_OPTS)).map((s) => toView(s));
  if (win) win.__mutationProof = toProof(mutation);

  onStatus('running BST mutation sweep…');
  const bst = (await engine.runBstMutationSweep(keyBuffer(data), mutationSizes, MUT_OPTS)).map((s) => toView(s));
  if (win) win.__bstMutationProof = toProof(bst);

  onStatus('running AVL mutation sweep…');
  const avl = (await engine.runAvlMutationSweep(keyBuffer(data), mutationSizes, MUT_OPTS)).map((s) => toView(s));
  if (win) win.__avlMutationProof = toProof(avl);

  onStatus('running skip-list mutation sweep…');
  const skiplist = (await engine.runSkipMutationSweep(keyBuffer(data), mutationSizes, MUT_OPTS)).map((s) => toView(s));
  if (win) win.__skipMutationProof = toProof(skiplist);

  onStatus('running min-heap mutation sweep…');
  const heap = (await engine.runHeapMutationSweep(keyBuffer(data), mutationSizes, HEAP_OPTS)).map((s) => toView(s));
  if (win) {
    win.__compareMeta = {
      order: data.order,
      size: data.size,
      shape,
      keyType: 'number',
      meanKeyBytes: 0,
    };
    // Set last, so the runtime gate can poll this one global as the "all sweeps done" signal.
    win.__heapMutationProof = toProof(heap);
  }

  return {
    search,
    mutation,
    trees: [...bst, ...avl],
    skiplist,
    heap,
    shape,
    searchSizes,
    mutationSizes,
  };
}

/** What one full **string-key** Compare run produces (see {@link runStringSweeps}). */
export interface StringCompareResult {
  /** `search` on the string array, the string hash set and the trie. */
  readonly search: readonly SeriesView[];
  /** churn + finite-difference insert/delete for all three — nine series. */
  readonly mutation: readonly SeriesView[];
  readonly searchSizes: readonly number[];
  readonly mutationSizes: readonly number[];
  /** Mean UTF-8 bytes per key: the run's key-length axis (see {@link meanKeyBytes}). */
  readonly meanKeyBytes: number;
}

/**
 * Run every **string-key** sweep on `dataset` — the string twins of the array and the hash
 * set, plus the **trie** (docs/PLAN.md §4.2, §8; docs/METHODOLOGY.md §2.5) — reporting
 * progress through `onStatus` and mirroring the results onto `window` for the runtime gate.
 *
 * A deliberately separate entry point from {@link runAllSweeps}, not a branch inside it.
 * A string dataset cannot build an f64 structure, so there is no run in which both sets of
 * curves exist; and even side by side they would not be comparable, since a string
 * comparison walks bytes while an f64 comparison is one instruction. The two results are
 * therefore different types, and no chart takes both.
 *
 * What this run shows that the numeric one cannot: the classes are the same — O(n) scan,
 * O(1) hash, and now the trie's O(1)-without-a-hash — but they hold **in n only**. The same structures also pay O(L) in the key
 * length, which is why the run reports {@link StringCompareResult.meanKeyBytes} and why
 * the op-count and wall-clock signals separate here (the op-count curve is the numeric
 * twin's; the wall-clock one carries the bytes).
 */
export async function runStringSweeps(
  engine: BenchEngine,
  dataset: Dataset,
  onStatus: (s: string) => void = () => {},
  win: ProofWindow | undefined = typeof window === 'undefined' ? undefined : (window as ProofWindow),
): Promise<StringCompareResult> {
  const data = stringOrThrow(dataset);
  const searchSizes = sizesFor(data, SWEEP_MIN, STRING_SWEEP_MAX);
  const mutationSizes = sizesFor(data, Math.min(MUT_MIN, data.size), STRING_MUT_MAX);

  onStatus('running string-key search sweep…');
  const sb = stringBuffers(data);
  const search = (await engine.runStringSweep(sb.offsets, sb.bytes, searchSizes, SEARCH_OPTS)).map(
    (s) => toView(s),
  );
  if (win) win.__stringSweepProof = toProof(search);

  onStatus('running string-key mutation sweep…');
  const mb = stringBuffers(data);
  // Read the key-length axis off this buffer *before* the call transfers it away.
  const bytesPerKey = meanKeyBytes(mb.offsets);
  const mutation = (
    await engine.runStringMutationSweep(mb.offsets, mb.bytes, mutationSizes, MUT_OPTS)
  ).map((s) => toView(s));

  if (win) {
    win.__compareMeta = {
      order: data.order,
      size: data.size,
      // The overlay's shape flag is about *numeric* order degenerating a tree; neither
      // string structure is order-sensitive, so a string run is always the average case.
      shape: 'random',
      keyType: 'string',
      meanKeyBytes: bytesPerKey,
    };
    // Set last — the "string run done" signal for scripts/verify-browser.mjs.
    win.__stringMutationProof = toProof(mutation);
  }

  return { search, mutation, searchSizes, mutationSizes, meanKeyBytes: bytesPerKey };
}
