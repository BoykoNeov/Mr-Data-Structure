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
  MinHeapF64,
  SkipListF64,
  HashSetOaF64,
  HashSetBsF64,
  ArrayStr,
  HashSetStr,
  TrieStr,
  DoublyLinkedListF64,
  RbtF64,
  GraphAdj,
  BTreeF64,
} from '../../bench-engine/pkg/bench_engine.js';
import { measureGraphs, type GraphInput, type GraphTraversalMeasure } from './graphBench';
import { encodeStringKeys } from '../data/marshal';
import {
  buildStringProbes,
  churnKeyFor,
  decodeStringKeys,
  prefixOf,
} from './stringWorkload';
import { buildNumericProbes, DEFAULT_PROBE_MIX, type ProbeMix } from './probeMix';
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
  /** Keys held after the build — fewer than `n` for a de-duplicating structure. */
  len(): number;
  free(): void;
}
type SearchStructCtor = new (keys: Float64Array, n: number) => SearchStruct;

/**
 * A measurement runner factory backed by a WASM structure, for `search`. The query workload
 * for size `n` — a spread of present keys plus a block guaranteed absent just past the max
 * key — is built by `buildNumericProbes` (./probeMix) at the run's `mix`. Its default is the
 * calibrated 64 + 64 workload (docs/PLAN.md §6.3), which keeps the array's linear-search
 * cost a clean function of `n` while the hash set stays flat.
 *
 * `mix` is **required**, not defaulted, on purpose: every structure in one run must get the
 * same probe set (the shared-probes rule), so a structure added to `runSweep` without the
 * run's mix fails to compile rather than silently measuring the default.
 */
function searchRunnerFactory(
  Ctor: SearchStructCtor,
  keys: Float64Array,
  mix: ProbeMix,
): OpRunnerFactory {
  return (n) => {
    const s = new Ctor(keys.subarray(0, n), n);
    const probes = buildNumericProbes(keys, n, mix);
    s.set_probes(probes);
    const stored = s.len();
    return {
      run: (k) => s.search_n(k),
      opCountPerOp: () => s.search_counted() / probes.length,
      storedSize: () => stored,
      dispose: () => s.free(),
    };
  };
}

/**
 * Keys a built structure holds, if it can say (docs/METHODOLOGY.md §4 hurdle 8). Every bench
 * twin exports `len()`, but the mutation constructors are reached through `as unknown as`
 * casts the compiler cannot check, so this asks rather than assumes.
 */
function storedSizeOf(s: { len?: () => number }): number | undefined {
  return typeof s.len === 'function' ? s.len() : undefined;
}

// ── String keys (docs/PLAN.md §4.2, §8; docs/METHODOLOGY.md §2.5) ──────────────
//
// The string twins run the same algorithms on a different key type, and they need one
// thing the numeric side gets for free: a key **guaranteed absent** from the stored
// prefix. For f64 keys that is `max + 1`. Strings have no such arithmetic, so the workload
// is *derived from the data* — see `absentLike` in ./stringWorkload for why the derivation
// is not merely "make it long". The derivation lives there, and is unit-tested there,
// because it is a measurement decision rather than plumbing; this file keeps the timing.

/**
 * The string search surface — the offsets+UTF-8 mirror of {@link SearchStruct}.
 * `ArrayStr`, `HashSetStr` and `TrieStr` satisfy it structurally.
 */
interface StringSearchStruct {
  set_probes(offsets: Uint32Array, bytes: Uint8Array): void;
  search_n(k: number): number;
  search_counted(): number;
  /** Keys held after the build — fewer than `n` for the hash set and the trie on repeats. */
  len(): number;
  free(): void;
}
type StringSearchStructCtor = new (
  offsets: Uint32Array,
  bytes: Uint8Array,
  n: number,
) => StringSearchStruct;

/** The string mutation surface — the offsets+UTF-8 mirror of {@link MutationStruct}. */
interface StringMutationStruct {
  set_churn_key(key: string): void;
  churn_n(k: number): number;
  churn_counted(): number;
  len?(): number;
  free(): void;
}
interface StringMutationStatics {
  build_insert_n(offsets: Uint32Array, bytes: Uint8Array, n: number): number;
  build_insert_counted(offsets: Uint32Array, bytes: Uint8Array, n: number): number;
  build_then_teardown_n(offsets: Uint32Array, bytes: Uint8Array, n: number): number;
  teardown_counted(offsets: Uint32Array, bytes: Uint8Array, n: number): number;
}
type StringMutationStructCtor = (new (
  offsets: Uint32Array,
  bytes: Uint8Array,
  n: number,
) => StringMutationStruct) &
  StringMutationStatics;

/**
 * A string search runner (docs/PLAN.md §6.3), the mirror of {@link searchRunnerFactory} —
 * and, like it, `mix` is required so all three string structures share one probe set.
 */
function stringSearchRunnerFactory(
  Ctor: StringSearchStructCtor,
  offsets: Uint32Array,
  bytes: Uint8Array,
  mix: ProbeMix,
): OpRunnerFactory {
  return (n) => {
    const prefix = prefixOf(offsets, bytes, n);
    const s = new Ctor(prefix.offsets, prefix.bytes, n);
    const probes = buildStringProbes(decodeStringKeys(offsets, bytes, n), mix);
    const encoded = encodeStringKeys(probes);
    s.set_probes(encoded.offsets, encoded.bytes);
    const stored = s.len();
    return {
      run: (k) => s.search_n(k),
      opCountPerOp: () => s.search_counted() / probes.length,
      storedSize: () => stored,
      dispose: () => s.free(),
    };
  };
}

/**
 * String churn runner: build to n once (untimed), set one derived absent key, then time
 * `k` insert+delete pairs that hold size at n — the mirror of {@link churnRunnerFactory}.
 *
 * There is no {@link ChurnKeyPicker} seam here because there is nothing to pick between:
 * both string structures are position-uniform (the array appends and then scans for the
 * key; the hash set hashes to a bucket wherever the key sits), exactly as their numeric
 * twins are, and neither keeps its keys in sorted order. What *does* matter is that the
 * key looks like the corpus rather than like a sentinel, and that its *length* is typical
 * of the corpus rather than inherited from whichever row happened to arrive first — both
 * of which are `churnKeyFor`'s job (./stringWorkload).
 */
function stringChurnRunnerFactory(
  Ctor: StringMutationStructCtor,
  offsets: Uint32Array,
  bytes: Uint8Array,
): OpRunnerFactory {
  return (n) => {
    const prefix = prefixOf(offsets, bytes, n);
    const s = new Ctor(prefix.offsets, prefix.bytes, n);
    s.set_churn_key(churnKeyFor(decodeStringKeys(offsets, bytes, n)));
    const stored = storedSizeOf(s);
    return {
      run: (k) => s.churn_n(k),
      opCountPerOp: () => s.churn_counted(),
      ...(stored === undefined ? {} : { storedSize: () => stored }),
      dispose: () => s.free(),
    };
  };
}

/** String build runner (insert side) — the mirror of {@link buildRunnerFactory}. */
function stringBuildRunnerFactory(
  Ctor: StringMutationStatics,
  offsets: Uint32Array,
  bytes: Uint8Array,
): OpRunnerFactory {
  return (n) => {
    const { offsets: off, bytes: byt } = prefixOf(offsets, bytes, n);
    const cumulativeOps = Ctor.build_insert_counted(off, byt, n);
    return {
      run: (k) => {
        let acc = 0;
        for (let i = 0; i < k; i++) acc += Ctor.build_insert_n(off, byt, n);
        return acc;
      },
      opCountPerOp: () => cumulativeOps,
    };
  };
}

/** String build+teardown runner (delete side) — mirror of {@link buildTeardownRunnerFactory}. */
function stringBuildTeardownRunnerFactory(
  Ctor: StringMutationStatics,
  offsets: Uint32Array,
  bytes: Uint8Array,
): OpRunnerFactory {
  return (n) => {
    const { offsets: off, bytes: byt } = prefixOf(offsets, bytes, n);
    const cumulativeOps =
      Ctor.build_insert_counted(off, byt, n) + Ctor.teardown_counted(off, byt, n);
    return {
      run: (k) => {
        let acc = 0;
        for (let i = 0; i < k; i++) acc += Ctor.build_then_teardown_n(off, byt, n);
        return acc;
      },
      opCountPerOp: () => cumulativeOps,
    };
  };
}

/**
 * The WASM mutation surface (docs/PLAN.md §6.3): a churn-able instance plus the
 * static cumulative build/teardown primitives. `ArrayF64`, `HashSetF64`,
 * `SortedArrayF64`, `LinkedListF64` and `MinHeapF64` all satisfy it structurally —
 * only the trees differ, taking two churn keys instead of one
 * (see {@link TreeMutationStruct}).
 */
interface MutationStruct {
  set_churn_key(key: number): void;
  churn_n(k: number): number;
  churn_counted(): number;
  /** Keys held (see {@link storedSizeOf}); optional because the ctor casts cannot check it. */
  len?(): number;
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

/**
 * The **tree** mutation surface. Identical to {@link MutationStruct} except that churn
 * takes *two* spare keys instead of one: a tree's mutation cost depends on which end of
 * the key range the churn key lands in, so a single key can report the wrong complexity
 * class (docs/METHODOLOGY.md §4.1). `BstF64`, `AvlF64` and `SkipListF64` satisfy it
 * structurally — the skip list because its curve has to stay comparable with the trees',
 * not because either of its ends would mislabel it.
 */
interface TreeMutationStruct {
  set_churn_keys(lo: number, hi: number): void;
  churn_n(k: number): number;
  churn_counted(): number;
  len?(): number;
  free(): void;
}
type TreeMutationStructCtor = (new (
  keys: Float64Array,
  n: number,
) => TreeMutationStruct) &
  MutationStructStatics;

/** Largest of the first `n` keys (n > 0 assumed by callers), or 0 if none. */
function maxOfFirst(keys: Float64Array, n: number): number {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];
  return Number.isFinite(max) ? max : 0;
}

/** Smallest of the first `n` keys (n > 0 assumed by callers), or 0 if none. */
function minOfFirst(keys: Float64Array, n: number): number {
  let min = Infinity;
  for (let i = 0; i < n; i++) if (keys[i] < min) min = keys[i];
  return Number.isFinite(min) ? min : 0;
}

/**
 * Picks the spare churn key for a structure, given the first `n` keys. The *position* of
 * that key is a per-structure measurement decision, not a detail — it can set the
 * complexity class the churn curve reports (docs/METHODOLOGY.md §2.3, §4.1):
 *
 * - {@link aboveMax} (`max + 1`) — the default. The unsorted array appends and pops it
 *   with zero shifts; the linked list puts it at the head.
 * - {@link belowMin} (`min − 1`) — the **sorted array**, where a tail key would
 *   append/pop with no shifts and mislabel O(n) mutation as O(log n); and the
 *   **min-heap**, where it is the only mechanically valid choice at all (a higher key
 *   makes the pair's extract-min remove a *real* key, draining the heap).
 *
 * The trees take neither: they alternate *both* ends, via {@link treeChurnRunnerFactory}.
 */
export type ChurnKeyPicker = (keys: Float64Array, n: number) => number;

/** `max + 1` — absent above every stored key (the default for the flat structures). */
export const aboveMax: ChurnKeyPicker = (keys, n) => maxOfFirst(keys, n) + 1;

/** `min − 1` — absent below every stored key (the sorted array's front, the heap's root). */
export const belowMin: ChurnKeyPicker = (keys, n) => minOfFirst(keys, n) - 1;

/**
 * Churn runner (docs/PLAN.md §6.3, primary): build to n once (untimed), set a spare key
 * guaranteed absent (chosen by `pickKey`, default `max + 1`), then time `k` insert+delete
 * pairs that hold size at n. `opCountPerOp` is the deterministic per-pair op-count.
 *
 * The key is picked **once**, before the timed loop, which is safe for every structure
 * here: each pair restores the stored contents, so neither the minimum nor the maximum
 * moves under churn.
 */
function churnRunnerFactory(
  Ctor: MutationStructCtor,
  keys: Float64Array,
  pickKey: ChurnKeyPicker = aboveMax,
): OpRunnerFactory {
  return (n) => {
    const s = new Ctor(keys.subarray(0, n), n);
    s.set_churn_key(pickKey(keys, n));
    const stored = storedSizeOf(s);
    return {
      run: (k) => s.churn_n(k),
      opCountPerOp: () => s.churn_counted(),
      ...(stored === undefined ? {} : { storedSize: () => stored }),
      dispose: () => s.free(),
    };
  };
}

/**
 * Tree churn runner (docs/PLAN.md §6.3 primary, docs/METHODOLOGY.md §4.1): as
 * {@link churnRunnerFactory}, but sets **two** spare keys — `min − 1` and `max + 1` — and
 * the engine alternates them pair by pair.
 *
 * Why trees need this and the flat structures do not: a one-keyed churn at `max + 1` only
 * ever walks the tree's *right* spine. On **reverse-sorted** input a naive BST is a left
 * chain whose right spine is a single node, so its mutation measured O(1) while its search
 * measured O(n) — a wrong complexity *class* on the chart. Alternating both ends means
 * whichever way a degenerate input leans, one of the two keys walks the whole chain. The
 * array / sorted array / linked list keep the single-key runner: their churn-key position
 * is a deliberate, documented choice (the sorted array's *front*, the list's *head*).
 */
function treeChurnRunnerFactory(
  Ctor: TreeMutationStructCtor,
  keys: Float64Array,
): OpRunnerFactory {
  return (n) => {
    const s = new Ctor(keys.subarray(0, n), n);
    s.set_churn_keys(minOfFirst(keys, n) - 1, maxOfFirst(keys, n) + 1);
    const stored = storedSizeOf(s);
    return {
      run: (k) => s.churn_n(k),
      opCountPerOp: () => s.churn_counted(),
      ...(stored === undefined ? {} : { storedSize: () => stored }),
      dispose: () => s.free(),
    };
  };
}

/** Build runner (insert side): `run(k)` does `k` builds-from-empty to size n. */
function buildRunnerFactory(Ctor: MutationStructStatics, keys: Float64Array): OpRunnerFactory {
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
  Ctor: MutationStructStatics,
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
   * `keys` is the marshalled numeric key buffer (transferred in by the caller). `mix` is
   * the run's present/absent probe split (./probeMix), one value for every structure.
   */
  async runSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
    mix: ProbeMix = DEFAULT_PROBE_MIX,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const array = measureSweep(sizes, searchRunnerFactory(ArrayF64, keys, mix), now, opts);
    const ll = measureSweep(sizes, searchRunnerFactory(LinkedListF64, keys, mix), now, opts);
    const sarr = measureSweep(sizes, searchRunnerFactory(SortedArrayF64, keys, mix), now, opts);
    const hashset = measureSweep(sizes, searchRunnerFactory(HashSetF64, keys, mix), now, opts);
    const heap = measureSweep(sizes, searchRunnerFactory(MinHeapF64, keys, mix), now, opts);
    const skiplist = measureSweep(sizes, searchRunnerFactory(SkipListF64, keys, mix), now, opts);
    // The doubly linked list walks exactly the singly list's path — its `prev` link has
    // nothing to offer a search — so its op-count line lands *on* the singly list's, and its
    // wall-clock line should differ by a constant, not a slope: a 24-byte node against a
    // 16-byte one (docs/METHODOLOGY.md §2.11; no ratio between the two is asserted anywhere).
    // Same probes, same runner: a different workload would end the comparison the line is
    // there to make.
    const dll = measureSweep(sizes, searchRunnerFactory(DoublyLinkedListF64, keys, mix), now, opts);
    const rbt = measureSweep(sizes, searchRunnerFactory(RbtF64, keys, mix), now, opts);
    const btree = measureSweep(sizes, searchRunnerFactory(BTreeF64, keys, mix), now, opts);
    // The **open-addressing hash set** (docs/METHODOLOGY.md §2.8) shares the chaining set's
    // hash, start size, threshold and doubling, so at every n the two tables have the same
    // capacity and load factor and only the collision strategy differs. It probes more —
    // primary clustering — and its probe count saws with α more loudly than chaining's,
    // with no trend in n. Its misses are its dear query (Knuth: ½(1 + 1/(1−α)²)), so a
    // misses-heavy mix raises its constant more than the chaining set's.
    const hashoa = measureSweep(sizes, searchRunnerFactory(HashSetOaF64, keys, mix), now, opts);
    // The **BST** and the **AVL** come after the ten series the runtime gate's search
    // bands were calibrated on (only the backward-shift hash set, below, follows them), so adding them moved none of those conditions. They are the
    // pair the mutation chart already draws, now on the search chart too: one descent from the
    // root, so each line reads its tree's depth. On shuffled input the two nearly coincide; on
    // sorted input the BST is a chain and its search is O(n) while the AVL's stays O(log n) —
    // "sorted data kills a naive BST" on the read side, not only the write side. That is also
    // why the BST's sorted-input run is slow to *build* (Θ(n²) comparisons to reach 100 k, about
    // 15 s): the cost of drawing the very curve this line is here for, and not a timed cost.
    //
    // One bias, the shared probe set's and not the tree's: the absent probes are `max + 1 …`,
    // which for a BST is a walk down its *right* spine only. On reverse-sorted input that spine
    // is one node, so a miss costs one comparison at every n — at the default mix the present
    // half still carries the O(n) slope, but a **misses-only** run reads flat for an O(n)
    // chain. Pinned in Rust (`bst::tests::above_max_misses_cost_one_comparison_on_a_left_chain`)
    // and labelled beside the chart (`src/ui/BstNotes.tsx`); the probes stay shared
    // (docs/METHODOLOGY.md §4 hurdle 15).
    const bst = measureSweep(sizes, searchRunnerFactory(BstF64, keys, mix), now, opts);
    const avl = measureSweep(sizes, searchRunnerFactory(AvlF64, keys, mix), now, opts);
    // The **backward-shift hash set** comes after all of them, so adding it moved no
    // existing series' conditions. A search sweep never deletes, and a delete-free build of
    // this set is the open-addressing set's table slot for slot (same hash, probe step,
    // doubling and re-placement order — `structures::methodology_hbs::
    // a_delete_free_build_is_the_tombstone_sets_table_slot_for_slot`), so on the op-count
    // signal this line lies exactly on the light-blue one. That coincidence is the control:
    // whatever separates the two on the churn chart is the delete policy and nothing else.
    // No wall-clock ratio between them is asserted anywhere.
    const hashbs = measureSweep(sizes, searchRunnerFactory(HashSetBsF64, keys, mix), now, opts);
    // Array → linked list → sorted array → hash set: the spread of search cost,
    // O(n) scan → O(n) pointer-walk → O(log n) → O(1) (docs/PLAN.md §8). The array and
    // the linked list share the *same* O(n) shape via different mechanisms — the §2.2
    // op-count-vs-mechanism contrast — then the sorted array's binary search is the
    // "missing middle" and the hash set is flat. All four satisfy the same SearchStruct
    // interface, so each drops straight into the existing runner.
    //
    // The **skip list** is the second O(log n) search on the chart, and the pair is the
    // point: the sorted array gets there by halving an interval it can only maintain by
    // shifting (cheap to read, expensive to write), while the skip list gets there by
    // dropping through express lanes it can splice in O(1) — the same class, opposite
    // mutation costs, both visible on the churn chart below (docs/PLAN.md §8).
    //
    // One bias to read that pair with, and it is the shared probe set's, not the skip
    // list's: `buildNumericProbes` puts its absent probes (64 at the default mix, all 128
    // on a misses-only run) at `max + 1 …`, which for the skip
    // list is the *cheapest* query it has — the rightmost staircase runs out of forward
    // links, and a null costs no comparison, where a mid-range absent key fails one per
    // level. So the absent share of this series' workload (half, by default) is its best case and its constant reads low
    // against the sorted array's, for which the same probes are the worst case. The slope
    // is unaffected (a fixed per-level saving, not a function of n), and the probes stay
    // shared anyway — retuning them per structure is what would end the comparison
    // (docs/METHODOLOGY.md §4 hurdle 9, the same call hurdle 11 makes for the trie).
    //
    // The **min-heap** is measured on the same size ladder by the same runner, but it is
    // NOT a fifth competitor: a heap has no search shortcut, so this is the deliberate
    // O(n)-scan *contrast* (docs/PLAN.md §8, risk R6). Measuring it here buys
    // point-for-point comparability with the array's scan; keeping it off the shared
    // chart is the UI's job (`src/ui/CompareSection.tsx` filters on the registry's
    // canonical list and renders the heap in its own section).
    //
    // The **red-black tree**'s search is a plain BST descent, so its line reads the tree's
    // depth: O(log n), with a constant set by how loosely the scheme balances. Against the AVL
    // — now beside it on this chart — the clock-free op-counts say that constant is the same on
    // shuffled input and a few percent higher on sorted (`structures::methodology::
    // rbt_pays_its_looser_bound_in_comparisons_on_sorted_input`, docs/METHODOLOGY.md §2.9).
    return [
      { structure: 'array', op: 'search', points: array },
      { structure: 'll', op: 'search', points: ll },
      { structure: 'sarr', op: 'search', points: sarr },
      { structure: 'hashset', op: 'search', points: hashset },
      { structure: 'heap', op: 'search', points: heap },
      { structure: 'skiplist', op: 'search', points: skiplist },
      { structure: 'dll', op: 'search', points: dll },
      { structure: 'rbt', op: 'search', points: rbt },
      // The **B-tree** (docs/METHODOLOGY.md §2.10): the first tree on this chart, and the
      // sorted array's nearest neighbour on it — both make ≈ log₂ n comparisons per lookup
      // (pinned clock-free in `structures::methodology_btree`), so on the op-count signal
      // the two lines should nearly coincide. What differs is *where* the comparisons
      // happen: a B-tree search is one dependent hop per level (3–4 levels at these sizes)
      // with a short binary search inside a contiguous 31-key node, where the sorted
      // array's early probes are each a jump across the whole array. Whether the clock
      // separates the two is a measurement, not a claim this code makes. The shared absent
      // probes (`max + 1 …`) cost a B-tree within one comparison of a present key — every
      // search walks to a leaf; an above-max probe only skips the final equality test — so,
      // unlike the skip list, this line carries no probe-set bias at any mix.
      { structure: 'btree', op: 'search', points: btree },
      { structure: 'hashoa', op: 'search', points: hashoa },
      { structure: 'bst', op: 'search', points: bst },
      { structure: 'avl', op: 'search', points: avl },
      { structure: 'hashbs', op: 'search', points: hashbs },
    ];
  },
  /**
   * Run the §6.3 size-mutating measurement for the six **flat** structures across
   * `sizes` — unsorted array, hash set, sorted array, linked list, doubly linked list,
   * open-addressing hash set: the **churn**
   * primary (combined insert+delete cost at fixed n) plus the **finite-difference**
   * cross-check that separates per-insert (cumulative build) from per-delete
   * (cumulative teardown). Returns three series per structure: `churn`, `insert`,
   * `delete`. `keys` is transferred in by the caller. Keep `sizes` modest — four of
   * the six have an O(n²) build or teardown (the array's ordered delete, the sorted
   * array's shifting insert *and* delete, both linked lists' walk-to-the-tail teardown).
   *
   * Each structure names its own {@link ChurnKeyPicker}, because where the spare key
   * lands is a measurement decision that can set the reported class (§2.3, §4.1):
   *
   * - **array** / **hash set** — `max + 1`. Position-uniform: the array appends and pops
   *   with no shifts either way, the hash set hashes to a bucket wherever the key sits.
   * - **sorted array** — `min − 1`, deliberately the **front**. A tail key would
   *   append/pop with zero shifts and report O(log n) mutation for a structure whose
   *   insert and delete are honestly O(n) — the key position, not the structure, would
   *   have set the class.
   * - **linked list** — `max + 1`, which a head-insert puts at the head, so the paired
   *   delete finds it in one visit. Churn is therefore **honestly O(1)**, and that is a
   *   *finding*, not a fast structure: there is no size-preserving same-key churn on a
   *   head-inserting list that costs O(n). The canonical O(n) delete-by-value shows up
   *   in this structure's finite-difference `delete` series instead, which is why the
   *   two series must be read together (METHODOLOGY §2.3, regime 7).
   */
  async runMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const structures: ReadonlyArray<[StructureId, MutationStructCtor, ChurnKeyPicker]> = [
      ['array', ArrayF64 as unknown as MutationStructCtor, aboveMax],
      ['hashset', HashSetF64 as unknown as MutationStructCtor, aboveMax],
      ['sarr', SortedArrayF64 as unknown as MutationStructCtor, belowMin],
      ['ll', LinkedListF64 as unknown as MutationStructCtor, aboveMax],
      // The doubly list takes the singly list's key, `max + 1`, so the two curves are the same
      // experiment. That is a comparability choice, not a rescue: head insert puts *any* churn
      // key at the head, so every key is one visit and none recovers the O(n) delete-by-value
      // (`doubly_linked_list::tests::no_churn_key_recovers_the_linear_delete`). Its flat churn
      // is the singly list's regime-7 finding, and its teardown deletes the tail *by value* —
      // never through the tail handle, which would read O(1) and erase the disagreement.
      ['dll', DoublyLinkedListF64 as unknown as MutationStructCtor, aboveMax],
      // Open addressing: `max + 1` as for the chaining set — a hash structure has no key
      // position to bias. But `set_churn_key` expands it into a primed *block* of
      // `max + 1 …` keys (docs/METHODOLOGY.md §2.8): one key under linear probing samples
      // one cluster, and that alone made the curve jump several-fold between sweep points.
      ['hashoa', HashSetOaF64 as unknown as MutationStructCtor, aboveMax],
    ];
    const out: SweepSeries[] = [];
    for (const [structure, Ctor, pickKey] of structures) {
      const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys, pickKey), now, opts);
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
   * browser clock. Churn uses the **two-key** runner (docs/METHODOLOGY.md §4.1) so a
   * left-leaning chain cannot report a flat mutation curve. `keys` is transferred in by
   * the caller.
   */
  async runBstMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = BstF64 as unknown as TreeMutationStructCtor;
    const churn = measureSweep(sizes, treeChurnRunnerFactory(Ctor, keys), now, opts);
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
   * stays **sub-linear** (O(log n)) — the balanced contrast to the array's O(n). It shares
   * the BST's **two-key** churn runner: balance already bounds both spines, so this is not
   * a correctness fix for the AVL, but one measurement recipe keeps the two tree curves
   * comparable (docs/METHODOLOGY.md §4.1). The
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
    const Ctor = AvlF64 as unknown as TreeMutationStructCtor;
    const churn = measureSweep(sizes, treeChurnRunnerFactory(Ctor, keys), now, opts);
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
  /**
   * Run the §6.3 size-mutating measurement for the **skip list** across `sizes`: the churn
   * primary plus the finite-difference split, as three series (`churn`, `insert`, `delete`)
   * tagged `'skiplist'`. A separate call from {@link runMutationSweep} for the same reason
   * the trees get one — it needs the **two-key** churn runner, not the single-key one — and
   * *not* because its input is delicate: unlike the BST it cannot degenerate, since a
   * node's height comes from its key's hash rather than from the order the keys arrived in
   * (`bench-engine/src/structures/skip_list.rs`).
   *
   * Both churn ends are honest here, which was checked rather than assumed
   * (`skip_list::tests::neither_churn_end_changes_the_reported_class`): `min − 1` fails one
   * comparison per level, `max + 1` runs off the end of each level and pays nothing for
   * doing so — a constant apart, both O(log n). Neither could mislabel the class the way a
   * tail key would for the sorted array. The two-key recipe is kept because it is what
   * makes this curve *comparable* with the BST's and the AVL's, which are measured that way
   * for a reason that does bite them.
   *
   * The headline this sweep is here to draw: **sub-linear add/remove on any input order,
   * with no rebalancing** — the AVL's outcome by the opposite mechanism, and the contrast
   * to the sorted array, whose search shares this one's class while its mutation is O(n).
   * `keys` is transferred in by the caller.
   */
  async runSkipMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = SkipListF64 as unknown as TreeMutationStructCtor;
    const churn = measureSweep(sizes, treeChurnRunnerFactory(Ctor, keys), now, opts);
    const fd = measureMutationFd(
      'skiplist',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'skiplist', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the §6.3 size-mutating measurement for the **B-tree** across `sizes`: churn primary
   * plus the finite-difference split, three series tagged `'btree'`, on the trees'
   * **two-key** churn runner (docs/METHODOLOGY.md §4.1) so its curve stays comparable with
   * the BST's and the AVL's.
   *
   * Two things are different here, both checked in Rust rather than assumed. **Neither
   * churn end is a cheap spine**: every B-tree leaf sits at the same depth, so `min − 1` and
   * `max + 1` walk the full height like any stored key, and churn agrees *tightly* with the
   * finite-difference sum (`methodology_btree::btree_churn_and_finite_differences_agree_tightly`)
   * — the first tree for which it does. And **the pair settles**: the delete repairs only
   * true underflow, so after a few warm-up pairs an insert+delete of an edge key splits,
   * merges and allocates nothing
   * (`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`). CLRS's
   * single-pass delete would split and re-merge a node on every pair, and this curve would
   * then be measuring the allocator. `measure.ts` reads the op-count only after the warm-up
   * and timed batches, i.e. in the settled state. `keys` is transferred in by the caller.
   */
  async runBTreeMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = BTreeF64 as unknown as TreeMutationStructCtor;
    const churn = measureSweep(sizes, treeChurnRunnerFactory(Ctor, keys), now, opts);
    const fd = measureMutationFd(
      'btree',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'btree', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the §6.3 size-mutating measurement for the **backward-shift hash set** across
   * `sizes`: churn primary plus the finite-difference split, three series tagged `'hashbs'`
   * (docs/PLAN.md §13; docs/METHODOLOGY.md §2.8, regime NEW). Its own call, run by the
   * Compare pipeline **after every existing mutation sweep** (the heap's included), so
   * adding it changed no existing series' conditions — not because its recipe differs: it is
   * the flat structures' single-key runner with the open-addressing set's `max + 1`, which
   * `set_churn_key` expands into the **same block** of absent keys the tombstone set churns.
   * Equal footing is the point: the two lines then differ only in what a delete leaves
   * behind. There is no priming (no tombstone exists), only a capacity settle that matters at
   * the load threshold, and every pair restores the table bit for bit
   * (`hash_set_bs::tests::the_first_pair_is_already_the_steady_state`). `keys` is
   * transferred in by the caller.
   */
  async runHashBsMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = HashSetBsF64 as unknown as MutationStructCtor;
    const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys, aboveMax), now, opts);
    const fd = measureMutationFd(
      'hashbs',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'hashbs', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the §6.3 size-mutating measurement for the **min-heap** across `sizes` — the churn
   * primary plus the finite-difference split, as three series (`churn`, `insert`, `delete`)
   * tagged `'heap'`. A separate call because the heap's op set is different (docs/PLAN.md
   * §4.1, §8): its `churn` is insert + **extract-min** and its `delete` series is the
   * marginal extract-min, so these series are comparable within the heap's own group and
   * nowhere else (risk R6).
   *
   * **Churn uses the `min − 1` key, and that is forced, not preferred.** A heap has no
   * delete-by-value, so a size-preserving pair must be insert-then-extract-min; only a key
   * strictly below every stored key is the one the extract then removes. With `max + 1` the
   * extract would take a *real* key each time and drain the heap (pinned in Rust by
   * `heap::tests::a_high_churn_key_would_drain_the_heap`). The consequence to read honestly:
   * churn's insert half is the **worst-case** insert (a new minimum climbs the full height),
   * while an ordinary insert sifts O(1) levels — so the heap's churn constant runs *high*,
   * the mirror image of the trees' spine churn running low (docs/METHODOLOGY.md §4.2).
   *
   * The clock-free numeric findings — churn ≈ 1.5× the finite-difference sum, the insert
   * halves disagreeing on class, and the build's order-sensitivity — are pinned in Rust
   * (`structures::methodology`). `keys` is transferred in by the caller.
   */
  async runHeapMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = MinHeapF64 as unknown as MutationStructCtor;
    const churn = measureSweep(sizes, churnRunnerFactory(Ctor, keys, belowMin), now, opts);
    const fd = measureMutationFd(
      'heap',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'heap', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the §6.3 **search** measurement on **string keys** — the unsorted array, the hash
   * set and the **trie**, all storing `String` rather than `f64` (docs/PLAN.md §4.2, §8). `offsets`
   * and `bytes` are the marshalled offsets+UTF-8 buffer (transferred in by the caller);
   * each sweep point measures an order-preserving prefix, as the numeric sweeps do.
   *
   * These two series are read against **each other**, never against the numeric run: a
   * comparison here walks bytes and a hash here reads the whole key, so the unit of work
   * differs (docs/METHODOLOGY.md §2.5). What the pair buys that the numeric run cannot is
   * the **second cost axis** — key length L. Both classes below are in n; toggling the
   * UI's signal selector shows the hash set's op-count flat and identical to its numeric
   * twin's while its wall-clock carries the per-byte hashing cost.
   *
   * The **trie** is why this chart is worth three lines rather than two. It is flat in n
   * like the hash set, but by an unrelated mechanism — one branch per key byte, no hash at
   * all — so the pair separates "constant" from "cheap": whichever of the two sits lower is
   * a fact about this corpus's key lengths and this machine's memory, not about complexity.
   * Its probes are the *same* derived set the other two get (`buildStringProbes`), which
   * for a trie is deliberately its **deepest** absent case: a probe made by changing a
   * stored key's last character walks the whole key before failing, where an unrelated
   * absent string would fall off at the first byte. One probe set across the three
   * structures is what makes the chart a comparison at all, so the trie's constant is read
   * as a pessimistic one rather than the probe set being retuned per structure
   * (docs/METHODOLOGY.md §2.5).
   */
  async runStringSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
    mix: ProbeMix = DEFAULT_PROBE_MIX,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const arraystr = measureSweep(
      sizes,
      stringSearchRunnerFactory(ArrayStr, offsets, bytes, mix),
      now,
      opts,
    );
    const hashsetstr = measureSweep(
      sizes,
      stringSearchRunnerFactory(HashSetStr, offsets, bytes, mix),
      now,
      opts,
    );
    const triestr = measureSweep(
      sizes,
      stringSearchRunnerFactory(TrieStr, offsets, bytes, mix),
      now,
      opts,
    );
    return [
      { structure: 'arraystr', op: 'search', points: arraystr },
      { structure: 'hashsetstr', op: 'search', points: hashsetstr },
      { structure: 'triestr', op: 'search', points: triestr },
    ];
  },
  /**
   * Run the §6.3 size-mutating measurement on **string keys** for the same three
   * structures: the churn primary plus the finite-difference insert/delete split, three
   * series each.
   * Keep `sizes` modest — the string array's ordered delete makes its teardown O(n²), and
   * every comparison in it is a byte-wise one.
   *
   * The churn key is *derived from the corpus* — a stored key of median length with its
   * last character changed, checked absent against the prefix — rather than being a long
   * sentinel, so the array's scan pays the same per-byte comparison cost it pays on real
   * keys (`churnKeyFor` / `absentLike` in ./stringWorkload). `offsets`/`bytes` are
   * transferred in by the caller.
   *
   * The same derived key is what makes the **trie**'s churn the walk it should be: sharing
   * all but its last byte with a stored key, one insert+delete pair allocates and prunes
   * exactly one node, so the curve is the O(L) descent rather than the allocator. A key
   * sharing no prefix would build a whole branch on every pair — pinned on the Rust side by
   * `trie::tests::a_prefix_free_churn_key_allocates_a_whole_branch`.
   */
  async runStringMutationSweep(
    offsets: Uint32Array,
    bytes: Uint8Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const structures: ReadonlyArray<[StructureId, StringMutationStructCtor]> = [
      ['arraystr', ArrayStr as unknown as StringMutationStructCtor],
      ['hashsetstr', HashSetStr as unknown as StringMutationStructCtor],
      ['triestr', TrieStr as unknown as StringMutationStructCtor],
    ];
    const out: SweepSeries[] = [];
    for (const [structure, Ctor] of structures) {
      const churn = measureSweep(
        sizes,
        stringChurnRunnerFactory(Ctor, offsets, bytes),
        now,
        opts,
      );
      out.push({ structure, op: 'churn', points: churn });
      const fd = measureMutationFd(
        structure,
        sizes,
        stringBuildRunnerFactory(Ctor, offsets, bytes),
        stringBuildTeardownRunnerFactory(Ctor, offsets, bytes),
        now,
        opts,
      );
      out.push(fd.insert, fd.delete);
    }
    return out;
  },
  /**
   * Run the §6.3 size-mutating measurement for the **red-black tree** across `sizes`: the
   * churn primary plus the finite-difference split, as three series (`churn`, `insert`,
   * `delete`) tagged `'rbt'` (docs/PLAN.md §8 trees, §13). The AVL's recipe exactly — the
   * **two-key** churn runner (docs/METHODOLOGY.md §4.1) and the same build / teardown
   * factories — because the point of this line is to be read *against* the AVL's: same
   * metric (comparisons + rotations), same probe, so on the **op-count** signal any gap
   * between the two is the balancing scheme and nothing else. On the **wall clock** it is
   * not: the AVL is a recursive `Box` tree that allocates and frees a node on every churn
   * pair, while this one is a pre-sized arena that reuses one slot, so the timed gap also
   * carries allocator and memory-layout effects. Read the two wall-clock lines for shape.
   *
   * What the clock-free op-counts say that gap should be (docs/METHODOLOGY.md §2.9): on
   * shuffled keys the two are within a percent on comparisons and the red-black tree
   * rotates ~18 % less on inserts; on sorted keys its spines run deeper (height 21 vs 12 at
   * n = 4000), so its churn sits *above* the AVL's. Its real advantage — never more than 2
   * rotations per insert or 3 per delete — is a bound on single operations, which no
   * per-op average on this chart can show; it is pinned in Rust instead. Recolours are not
   * in the op-count (the AVL has no colour to pay for). `keys` is transferred in by the
   * caller.
   */
  async runRbtMutationSweep(
    keys: Float64Array,
    sizes: number[],
    opts?: MeasureOptions,
  ): Promise<SweepSeries[]> {
    await ready;
    const now = () => performance.now();
    const Ctor = RbtF64 as unknown as TreeMutationStructCtor;
    const churn = measureSweep(sizes, treeChurnRunnerFactory(Ctor, keys), now, opts);
    const fd = measureMutationFd(
      'rbt',
      sizes,
      buildRunnerFactory(Ctor, keys),
      buildTeardownRunnerFactory(Ctor, keys),
      now,
      opts,
    );
    return [{ structure: 'rbt', op: 'churn', points: churn }, fd.insert, fd.delete];
  },
  /**
   * Run the **graph** traversal measurement (docs/METHODOLOGY.md §2.7): BFS and DFS from
   * vertex 0 on each graph, in order. The loop is `measureGraphs` (./graphBench, unit-tested
   * there with the TS twin and a virtual clock); this method only supplies the real bench
   * twin and the worker clock. The adjacency lists are built before timing and the traversal
   * reuses preallocated scratch, so the timed region allocates nothing. `edges` buffers are
   * transferred in by the caller.
   */
  async runGraphSweep(
    graphs: GraphInput[],
    opts?: MeasureOptions,
  ): Promise<GraphTraversalMeasure[]> {
    await ready;
    const now = () => performance.now();
    return measureGraphs(graphs, (edges, numVertices) => new GraphAdj(edges, numVertices), now, opts);
  },
};

export type BenchWorkerApi = typeof api;

Comlink.expose(api);
