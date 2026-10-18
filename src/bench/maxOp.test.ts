import { describe, it, expect } from 'vitest';
import { MAX_OP_FIELDS, MAX_OP_STRUCTURES, readMaxOpProfile } from './maxOp';
import { CANONICAL_STRUCTURES, STRING_STRUCTURES } from '../registry';

describe('max-op wire contract (docs/PLAN.md §13)', () => {
  it('copies every field, and only the fields, off the wasm object', () => {
    // A stand-in for the wasm class: every field gets a distinct value, plus methods and an
    // extra property that must not cross the Comlink boundary.
    const src = Object.fromEntries(MAX_OP_FIELDS.map((f, i) => [f, i + 0.5])) as Record<(typeof MAX_OP_FIELDS)[number], number>;
    const wasmLike = { ...src, free: () => {}, extra: 1 };
    const out = readMaxOpProfile('avl', wasmLike);
    expect(Object.keys(out).sort()).toEqual(['structure', ...MAX_OP_FIELDS].sort());
    for (const [i, f] of MAX_OP_FIELDS.entries()) expect(out[f]).toBe(i + 0.5);
    expect(out.structure).toBe('avl');
  });

  it('profiles exactly the canonical numeric structures: no heap, no graph, no text keys', () => {
    const canonicalNumeric = CANONICAL_STRUCTURES.map((s) => s.id).filter(
      (id) => !STRING_STRUCTURES.some((t) => t.id === id) && id !== 'graph',
    );
    expect([...MAX_OP_STRUCTURES].sort()).toEqual([...canonicalNumeric].sort());
    expect(MAX_OP_STRUCTURES).not.toContain('heap');
    expect(MAX_OP_STRUCTURES).not.toContain('graph');
    // Mirrors `MAX_OP_STRUCTURES` in bench-engine/src/structures/maxop.rs, order included.
    expect(MAX_OP_STRUCTURES).toEqual(['array', 'll', 'sarr', 'hashset', 'skiplist', 'dll', 'rbt', 'btree', 'hashoa', 'bst', 'avl']);
  });
});
