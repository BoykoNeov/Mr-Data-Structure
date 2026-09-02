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

export type Family = 'linear' | 'hashing' | 'tree';

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
    color: '#8c564b',
    costMetric: 'comparisons + rotations',
    mechanism: 'a BST that rotates to stay height-balanced on any input order',
    average: { search: OLOG, insert: OLOG, delete: OLOG, churn: OLOG },
    worst: { search: OLOG, insert: OLOG, delete: OLOG, churn: OLOG },
    shapeSensitive: false,
  },
};

/** Every registered structure, in catalogue order (§8: linear, hashing, trees). */
export const STRUCTURES: readonly StructureInfo[] = [
  REGISTRY.array,
  REGISTRY.ll,
  REGISTRY.sarr,
  REGISTRY.hashset,
  REGISTRY.bst,
  REGISTRY.avl,
];

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
