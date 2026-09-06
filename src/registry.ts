import type { ComplexityClass } from './bench/fit';
import type { StructureId, SweepOp } from './bench/measure';

/**
 * The structure registry (docs/PLAN.md §3 layer 2, §8) — the single source of
 * per-structure metadata that drives the comparison UI: display label, family,
 * chart colour, the declared **cost metric** for the op-count signal (§2.3 —
 * "operations" is not a universal unit), and the **theoretical** complexity per
 * operation, both the textbook average and the worst case.
 *
 * The theoretical classes are what the chart overlays as the dashed reference
 * curve next to the *measured* one (§7.1, §7.2), so divergence — sorted input
 * driving a naive BST to O(n) — is visible and explainable rather than hidden.
 * Nothing here is used to *label* a measurement; the fitter reads only the data.
 */

export type Family = 'linear' | 'hashing' | 'tree' | 'heap';

export interface OpComplexity {
  readonly search: ComplexityClass;
  readonly insert: ComplexityClass;
  readonly delete: ComplexityClass;
  /** The combined insert+delete pair the §6.3 churn primary measures. */
  readonly churn: ComplexityClass;
}

export interface StructureInfo {
  readonly id: StructureId;
  readonly label: string;
  readonly family: Family;
  /**
   * The key *type* this bench twin stores. Two structures are only comparable
   * when they share both the op set ({@link isCanonical}) **and** this: a
   * string-keyed scan pays per byte of the key, so lining its curve up against
   * an f64 scan would compare two different units of work. A Compare run is
   * therefore all-numeric or all-string, never mixed (docs/METHODOLOGY.md §2.5).
   */
  readonly keyType: 'number' | 'string';
  /** Chart colour (tab10), stable across every chart so a structure is always the same hue. */
  readonly color: string;
  /** The unit the op-count signal counts for this structure (§2.3, §6.4). */
  readonly costMetric: string;
  /** One-line mechanism, for the chart callouts. */
  readonly mechanism: string;
  /** Textbook average-case classes. */
  readonly average: OpComplexity;
  /** Textbook worst-case classes (equal to `average` where the structure has no bad input). */
  readonly worst: OpComplexity;
  /**
   * True when the *order* of the input changes the class (the unbalanced BST on
   * sorted keys). The overlay picks `worst` for such a structure on a sorted /
   * reverse-sorted dataset (§4.3 — "sorted data kills a naive BST").
   */
  readonly shapeSensitive: boolean;
}

const O1 = 'O(1)';
const OLOG = 'O(log n)';
const ON = 'O(n)';

export const REGISTRY: Readonly<Record<StructureId, StructureInfo>> = {
  array: {
    id: 'array',
    label: 'unsorted array',
    family: 'linear',
    keyType: 'number',
    color: '#d62728',
    costMetric: 'comparisons + shifts',
    mechanism: 'scans from the front; delete shifts the tail left to close the gap',
    average: { search: ON, insert: O1, delete: ON, churn: ON },
    worst: { search: ON, insert: ON, delete: ON, churn: ON },
    shapeSensitive: false,
  },
  ll: {
    id: 'll',
    label: 'linked list',
    family: 'linear',
    keyType: 'number',
    color: '#ff7f0e',
    costMetric: 'node-visits',
    mechanism: 'walks node by node from the head; insert is an O(1) head prepend',
    average: { search: ON, insert: O1, delete: ON, churn: O1 },
    worst: { search: ON, insert: O1, delete: ON, churn: O1 },
    shapeSensitive: false,
  },
  sarr: {
    id: 'sarr',
    label: 'sorted array',
    family: 'linear',
    keyType: 'number',
    color: '#2ca02c',
    costMetric: 'comparisons + shifts',
    mechanism: 'binary-searches; insert/delete shift the tail to keep order',
    average: { search: OLOG, insert: ON, delete: ON, churn: ON },
    worst: { search: OLOG, insert: ON, delete: ON, churn: ON },
    shapeSensitive: false,
  },
  hashset: {
    id: 'hashset',
    label: 'hash set',
    family: 'hashing',
    keyType: 'number',
    color: '#1f77b4',
    costMetric: 'hashes + chain probes',
    mechanism: 'hashes straight to a bucket; separate chaining, load-factor rehash',
    average: { search: O1, insert: O1, delete: O1, churn: O1 },
    worst: { search: ON, insert: ON, delete: ON, churn: ON },
    shapeSensitive: false,
  },
  bst: {
    id: 'bst',
    label: 'binary search tree',
    family: 'tree',
    keyType: 'number',
    color: '#9467bd',
    costMetric: 'comparisons',
    mechanism: 'descends left/right by comparison; no rebalancing, so sorted input makes a chain',
    average: { search: OLOG, insert: OLOG, delete: OLOG, churn: OLOG },
    worst: { search: ON, insert: ON, delete: ON, churn: ON },
    shapeSensitive: true,
  },
  avl: {
    id: 'avl',
    label: 'AVL tree',
    family: 'tree',
    keyType: 'number',
    color: '#8c564b',
    costMetric: 'comparisons + rotations',
    mechanism: 'a BST that rotates to stay height-balanced on any input order',
    average: { search: OLOG, insert: OLOG, delete: OLOG, churn: OLOG },
    worst: { search: OLOG, insert: OLOG, delete: OLOG, churn: OLOG },
    shapeSensitive: false,
  },
  /**
   * The min-heap is the one structure with a **different op set** (docs/PLAN.md §4.1,
   * §8), so the canonical slots carry heap meanings: `delete` is **extract-min**, and
   * `search` is the deliberate O(n) linear scan kept only as a *contrast* — a heap is
   * ordered for its root, not for membership. It is therefore compared only within its
   * own group (risk R6), which the UI enforces by rendering it in its own section.
   *
   * `insert` is the textbook split: **O(1) average** — most of a complete tree is
   * leaves, so a random key barely sifts — against **O(log n) worst**, a new global
   * minimum climbing the full height. Both readings are real and the tool shows both:
   * the finite-difference insert curve measures the average, while churn's insert half
   * is always the worst case by construction (docs/METHODOLOGY.md §4.2).
   *
   * **Not `shapeSensitive`, despite an order-sensitive build.** Ascending input is the
   * heap's *best* case (every insert appends after one failed comparison, an O(n) build)
   * and descending its *worst* (every insert climbs to the root, O(n log n)). A single
   * flag cannot say that, because `inputShapeOf` collapses both directions into one
   * `sorted` shape — overlaying the worst case would then be wrong on ascending input.
   * Churn, the primary curve, is genuinely order-insensitive: it always rides the full
   * height. So the flag stays false and the nuance is documented (METHODOLOGY §4.2)
   * rather than encoded in a flag that cannot hold it.
   */
  heap: {
    id: 'heap',
    label: 'min-heap',
    family: 'heap',
    keyType: 'number',
    color: '#e377c2',
    costMetric: 'comparisons + swaps',
    mechanism: 'keeps the smallest key at the root of a complete tree; sifts up on insert, down on extract',
    average: { search: ON, insert: O1, delete: OLOG, churn: OLOG },
    worst: { search: ON, insert: OLOG, delete: OLOG, churn: OLOG },
    shapeSensitive: false,
  },
  /**
   * The **string-key twins** (docs/PLAN.md §4.2, §8; docs/METHODOLOGY.md §2.5). Same
   * algorithms as `array` / `hashset`, same classes *in n* — and a second cost axis the
   * numeric structures do not have: the **key length L**. Every class below is in n only.
   * A string comparison walks bytes and a string hash reads the whole key, so both
   * structures pay O(L) per operation on top; that shows as the flat line sitting
   * *higher* on a long-key corpus while its slope stays 0 (O(1) in n, O(L) in the key).
   *
   * **They deliberately share their numeric twin's colour**, because they are the same
   * structure seen through a different key type, and the two can never appear on one
   * chart: a Compare run is all-numeric or all-string (see {@link StructureInfo.keyType}).
   * Pinned by `registry.test.ts` so nobody "fixes" the duplicate hue.
   */
  arraystr: {
    id: 'arraystr',
    label: 'unsorted array (string keys)',
    family: 'linear',
    keyType: 'string',
    color: '#d62728',
    costMetric: 'key comparisons + shifts',
    mechanism: 'scans from the front comparing whole keys; delete shifts the tail left',
    average: { search: ON, insert: O1, delete: ON, churn: ON },
    worst: { search: ON, insert: ON, delete: ON, churn: ON },
    shapeSensitive: false,
  },
  /**
   * The **trie** (prefix tree) — docs/PLAN.md §8 "Specialized", the Phase 6 structure.
   *
   * The first structure in the catalogue whose textbook cost does not mention `n` at
   * all: it stores a key as a *path*, one node per byte, so every operation costs the
   * length of the key it was handed and nothing else. Every class below is therefore
   * **O(1) in n**, average and worst — the same flat line as the string hash set, and
   * the point of putting the two on one chart is that they get there by different
   * means. The hash set reads all L bytes of the key once, to compute a hash, then
   * jumps; the trie never hashes and takes one branch per byte, stopping the moment a
   * byte has no child. The O(L) both pay is a constant in n that the class notation
   * cannot carry, which is why it lives in {@link StructureInfo.costMetric} and
   * {@link StructureInfo.mechanism} instead (docs/METHODOLOGY.md §2.5).
   *
   * **Its own hue, unlike the other two string twins**, because it has no numeric twin
   * to pair with: a trie over f64 keys is not a structure this project builds.
   *
   * **`family: 'tree'` on purpose**, though docs/PLAN.md §8 files the trie under
   * "Specialized". `Family` describes the *shape* — this is a tree, walked by descent —
   * while §8's grouping is about which structures are comparable, which the key type and
   * {@link STRING_STRUCTURES} already decide. Adding a `'specialized'` member would put a
   * catalogue heading into a field that answers a different question.
   */
  triestr: {
    id: 'triestr',
    label: 'trie (string keys)',
    family: 'tree',
    keyType: 'string',
    color: '#17becf',
    costMetric: 'char-steps',
    mechanism: 'walks the key one byte at a time down a tree of shared prefixes; never hashes, never compares a whole key',
    average: { search: O1, insert: O1, delete: O1, churn: O1 },
    worst: { search: O1, insert: O1, delete: O1, churn: O1 },
    shapeSensitive: false,
  },
  hashsetstr: {
    id: 'hashsetstr',
    label: 'hash set (string keys)',
    family: 'hashing',
    keyType: 'string',
    color: '#1f77b4',
    costMetric: 'hashes + chain probes',
    mechanism: 'hashes the key’s bytes straight to a bucket; separate chaining, load-factor rehash',
    average: { search: O1, insert: O1, delete: O1, churn: O1 },
    worst: { search: ON, insert: ON, delete: ON, churn: ON },
    shapeSensitive: false,
  },
};

/**
 * Every **numeric-key** structure, in catalogue order (§8: linear, hashing, trees, heaps)
 * — the catalogue the shared Compare charts are drawn from. The string twins live in
 * {@link STRING_STRUCTURES}, because a run measures one key type or the other.
 */
export const STRUCTURES: readonly StructureInfo[] = [
  REGISTRY.array,
  REGISTRY.ll,
  REGISTRY.sarr,
  REGISTRY.hashset,
  REGISTRY.bst,
  REGISTRY.avl,
  REGISTRY.heap,
];

/**
 * Structures on the **canonical** op set (insert / search / delete on a key), which are
 * the only ones comparable against each other (docs/PLAN.md §4.1, §8, risk R6). The
 * min-heap is excluded: its op set is insert / peek / extract-min, so putting it on a
 * shared chart would invite a comparison that isn't meaningful. The Compare UI filters
 * the shared charts through this list and gives the heap its own section.
 */
export const CANONICAL_STRUCTURES: readonly StructureInfo[] = STRUCTURES.filter(
  (s) => s.id !== 'heap',
);

/**
 * The **string-key** catalogue (docs/PLAN.md §4.2, §8): the two bench twins that store
 * string keys. A Compare run drives *one* key type — a string dataset cannot build an
 * f64 structure and an f64 dataset has nothing to say about byte-wise comparison — so
 * these are rendered in their own section and never merged with {@link STRUCTURES}.
 *
 * Three of them since Phase 6: the array, the hash set, and the **trie**, which is the
 * one that makes the section's point unarguable — two flat lines and one rising one,
 * where the two flat ones are flat for unrelated reasons.
 */
export const STRING_STRUCTURES: readonly StructureInfo[] = [
  REGISTRY.arraystr,
  REGISTRY.hashsetstr,
  REGISTRY.triestr,
];

/**
 * Whether `id` is on the canonical op set — insert / search / delete on a key
 * (see {@link CANONICAL_STRUCTURES}). True for the string twins: they do the same three
 * operations.
 *
 * **Sharing a chart needs two things, and this is only one of them.** The other is the
 * same {@link StructureInfo.keyType}: `arraystr` is canonical, yet its curve must never
 * be drawn beside `array`'s, because one comparison walks bytes and the other compares
 * two f64s. In practice the split is structural — a numeric run and a string run produce
 * different result objects and are pinned apart by `runSweeps.test.ts` — but if you ever
 * filter a merged list, filter on both.
 */
export function isCanonical(id: StructureId): boolean {
  return id !== 'heap';
}

/** The input order the dataset arrived in, as far as the theoretical overlay cares. */
export type InputShape = 'random' | 'sorted';

/**
 * The theoretical class to overlay for `structure` × `op` on data of the given
 * shape: the textbook average, except that a shape-sensitive structure on
 * sorted input is shown at its worst case — the whole point of §4.3.
 */
export function theoreticalClass(
  structure: StructureId,
  op: SweepOp,
  shape: InputShape = 'random',
): ComplexityClass {
  const info = REGISTRY[structure];
  const table = shape === 'sorted' && info.shapeSensitive ? info.worst : info.average;
  return table[op];
}
