import { describe, it, expect } from 'vitest';
import {
  REGISTRY,
  STRUCTURES,
  STRING_STRUCTURES,
  CANONICAL_STRUCTURES,
  isCanonical,
  theoreticalClass,
} from './registry';
import type { StructureId } from './bench/measure';

/**
 * The registry is the one place the theoretical classes live (docs/PLAN.md §3,
 * §8); these pin the catalogue against the §8 tables so a drift in one shows up.
 */
describe('structure registry', () => {
  it('covers every StructureId exactly once, with a distinct colour each', () => {
    const ids: StructureId[] = ['array', 'hashset', 'bst', 'avl', 'sarr', 'll', 'heap'];
    for (const id of ids) expect(REGISTRY[id].id).toBe(id);
    // STRUCTURES is the *numeric* catalogue — the one the shared charts draw from.
    expect(STRUCTURES.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(STRUCTURES.every((s) => s.keyType === 'number')).toBe(true);
    expect(new Set(STRUCTURES.map((s) => s.color)).size).toBe(STRUCTURES.length);
  });

  it('keeps the string twins in their own catalogue, sharing their numeric twin’s hue', () => {
    expect(STRING_STRUCTURES.map((s) => s.id)).toEqual(['arraystr', 'hashsetstr']);
    expect(STRING_STRUCTURES.every((s) => s.keyType === 'string')).toBe(true);
    expect(new Set(STRING_STRUCTURES.map((s) => s.color)).size).toBe(STRING_STRUCTURES.length);
    // The shared hue is deliberate: it is the *same structure* seen through a different
    // key type, and the two can never appear on one chart (a run is all-numeric or
    // all-string). Don't "fix" the duplicate — the pairing is the teaching point.
    expect(REGISTRY.arraystr.color).toBe(REGISTRY.array.color);
    expect(REGISTRY.hashsetstr.color).toBe(REGISTRY.hashset.color);
    // Same op set as their twins (so `isCanonical` is true), same classes *in n* — the
    // extra O(L) in key length is a constant the classes cannot express (METHODOLOGY §2.5).
    expect(isCanonical('arraystr')).toBe(true);
    expect(theoreticalClass('arraystr', 'search')).toBe(theoreticalClass('array', 'search'));
    expect(theoreticalClass('hashsetstr', 'search')).toBe(theoreticalClass('hashset', 'search'));
    // ...but they are not in the numeric catalogue the shared charts iterate.
    expect(STRUCTURES.map((s) => s.id)).not.toContain('arraystr');
    expect(CANONICAL_STRUCTURES.map((s) => s.id)).not.toContain('hashsetstr');
  });

  it('pins the §8 search classes: O(n) scan/walk, O(log n) binary search, O(1) hash', () => {
    expect(theoreticalClass('array', 'search')).toBe('O(n)');
    expect(theoreticalClass('ll', 'search')).toBe('O(n)');
    expect(theoreticalClass('sarr', 'search')).toBe('O(log n)');
    expect(theoreticalClass('hashset', 'search')).toBe('O(1)');
    expect(theoreticalClass('bst', 'search')).toBe('O(log n)');
    expect(theoreticalClass('avl', 'search')).toBe('O(log n)');
  });

  it('shows the naive BST at its worst on sorted input, and the AVL unchanged', () => {
    expect(theoreticalClass('bst', 'churn', 'random')).toBe('O(log n)');
    expect(theoreticalClass('bst', 'churn', 'sorted')).toBe('O(n)');
    expect(theoreticalClass('bst', 'search', 'sorted')).toBe('O(n)');
    expect(theoreticalClass('avl', 'churn', 'sorted')).toBe('O(log n)');
    // Only the BST is shape-sensitive in the catalogue.
    expect(STRUCTURES.filter((s) => s.shapeSensitive).map((s) => s.id)).toEqual(['bst']);
  });

  it('separates the min-heap from the canonical op set (docs/PLAN.md §4.1, §8, risk R6)', () => {
    // A heap does insert / peek / extract-min, so it must never land on a shared chart
    // beside structures doing insert / search / delete. The UI filters through this list.
    expect(CANONICAL_STRUCTURES.map((s) => s.id)).not.toContain('heap');
    expect(CANONICAL_STRUCTURES).toHaveLength(STRUCTURES.length - 1);
    expect(isCanonical('heap')).toBe(false);
    expect(isCanonical('array')).toBe(true);
  });

  it('pins the heap: an O(n) scan, O(log n) extract-min, and the O(1)/O(log n) insert split', () => {
    // Searching a heap has no shortcut — the deliberate contrast against the array's scan.
    expect(theoreticalClass('heap', 'search')).toBe('O(n)');
    // Extract-min (the `delete` slot) and the churn pair both walk one root-to-leaf path.
    expect(theoreticalClass('heap', 'delete')).toBe('O(log n)');
    expect(theoreticalClass('heap', 'churn')).toBe('O(log n)');
    // Insert is the textbook split: O(1) average (most of a heap is leaves) vs O(log n)
    // worst (a new global minimum climbs the full height — which is what churn measures).
    expect(REGISTRY.heap.average.insert).toBe('O(1)');
    expect(REGISTRY.heap.worst.insert).toBe('O(log n)');
    // A heap cannot degenerate on ordered input, so the overlay never switches to worst —
    // and it must not, since ascending input is the heap's *best* case for the build while
    // descending is its worst, a distinction one flag cannot carry (METHODOLOGY §4.2).
    expect(REGISTRY.heap.shapeSensitive).toBe(false);
    expect(theoreticalClass('heap', 'churn', 'sorted')).toBe('O(log n)');
  });

  it('records the linked list churn as O(1) — the §6.3 fifth-regime honesty point', () => {
    // Head insert + delete-of-the-newest is O(1) even though delete-by-value is O(n).
    expect(theoreticalClass('ll', 'churn')).toBe('O(1)');
    expect(theoreticalClass('ll', 'delete')).toBe('O(n)');
  });

  it('declares a cost metric for every structure (op-counts are shape-only, §2.3)', () => {
    for (const s of STRUCTURES) expect(s.costMetric.length).toBeGreaterThan(0);
  });
});
