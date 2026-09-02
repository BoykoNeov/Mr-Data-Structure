import { describe, it, expect } from 'vitest';
import { REGISTRY, STRUCTURES, theoreticalClass } from './registry';
import type { StructureId } from './bench/measure';

/**
 * The registry is the one place the theoretical classes live (docs/PLAN.md §3,
 * §8); these pin the catalogue against the §8 tables so a drift in one shows up.
 */
describe('structure registry', () => {
  it('covers every StructureId exactly once, with a distinct colour each', () => {
    const ids: StructureId[] = ['array', 'hashset', 'bst', 'avl', 'sarr', 'll'];
    for (const id of ids) expect(REGISTRY[id].id).toBe(id);
    expect(STRUCTURES.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(new Set(STRUCTURES.map((s) => s.color)).size).toBe(STRUCTURES.length);
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

  it('records the linked list churn as O(1) — the §6.3 fifth-regime honesty point', () => {
    // Head insert + delete-of-the-newest is O(1) even though delete-by-value is O(n).
    expect(theoreticalClass('ll', 'churn')).toBe('O(1)');
    expect(theoreticalClass('ll', 'delete')).toBe('O(n)');
  });

  it('declares a cost metric for every structure (op-counts are shape-only, §2.3)', () => {
    for (const s of STRUCTURES) expect(s.costMetric.length).toBeGreaterThan(0);
  });
});
