import { describe, it, expect } from 'vitest';
import { REGISTRY, CANONICAL_STRUCTURES, isCanonical, theoreticalClass } from './registry';

/**
 * The doubly linked list's registry entry (docs/PLAN.md §8 "Linear"; docs/METHODOLOGY.md
 * §2.11). Kept in its own file so the shared `registry.test.ts` only gains the id.
 *
 * The entry's whole claim is *sameness*: every theoretical class equals the singly list's,
 * because on insert / search / delete-by-key the `prev` pointer changes no walk. If someone
 * "improves" the doubly list's delete to O(1) here, the overlay would draw a line the bench
 * twin cannot produce (its delete must find the node first) — this test is what stops that.
 */
describe('registry — doubly linked list', () => {
  it('declares exactly the singly list’s classes, average and worst', () => {
    for (const op of ['search', 'insert', 'delete', 'churn'] as const) {
      expect(REGISTRY.dll.average[op]).toBe(REGISTRY.ll.average[op]);
      expect(REGISTRY.dll.worst[op]).toBe(REGISTRY.ll.worst[op]);
    }
    expect(theoreticalClass('dll', 'delete')).toBe('O(n)');
    // The singly list's regime-7 trap, inherited: the churn pair is O(1), delete-by-value O(n).
    expect(theoreticalClass('dll', 'churn')).toBe('O(1)');
    expect(theoreticalClass('dll', 'churn', 'sorted')).toBe('O(1)');
  });

  it('counts the same unit as the singly list, on the same key type, on the shared charts', () => {
    expect(REGISTRY.dll.costMetric).toBe(REGISTRY.ll.costMetric);
    expect(REGISTRY.dll.keyType).toBe('number');
    expect(REGISTRY.dll.family).toBe('linear');
    expect(REGISTRY.dll.shapeSensitive).toBe(false);
    expect(isCanonical('dll')).toBe(true);
    expect(CANONICAL_STRUCTURES.map((s) => s.id)).toContain('dll');
  });

  it('takes the light pair of the singly list’s orange, and says what prev is for', () => {
    // tab20: #ff7f0e (singly) → #ffbb78 (its light pair). A variant takes its parent's hue.
    expect(REGISTRY.ll.color).toBe('#ff7f0e');
    expect(REGISTRY.dll.color).toBe('#ffbb78');
    expect(REGISTRY.dll.label).toBe('doubly linked list');
    // The mechanism line must not imply the back-pointer helps a delete-by-value.
    expect(REGISTRY.dll.mechanism).toMatch(/node you already hold/);
  });
});
