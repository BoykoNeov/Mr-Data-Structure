import { describe, it, expect } from 'vitest';
import { DynArrayStr } from './dynArrayStr';

describe('DynArrayStr — teaching twin of the Rust ArrayStr', () => {
  it('counts comparisons equal to the 1-based hit position', () => {
    const a = DynArrayStr.fromKeys(['ten', 'twenty', 'thirty']);
    expect(a.search('ten')).toEqual({ found: true, ops: 1 });
    expect(a.search('twenty')).toEqual({ found: true, ops: 2 });
    expect(a.search('thirty')).toEqual({ found: true, ops: 3 });
  });

  it('scans the whole array for an absent key', () => {
    const a = DynArrayStr.fromKeys(['ten', 'twenty', 'thirty']);
    expect(a.search('nope')).toEqual({ found: false, ops: 3 });
  });

  it('keeps duplicates (multiset) and short-circuits at the first match', () => {
    const a = DynArrayStr.fromKeys(['x', 'x', 'x']);
    expect(a.size).toBe(3);
    expect(a.search('x')).toEqual({ found: true, ops: 1 });
  });

  it('preserves insertion order and compares multi-byte keys byte-exactly', () => {
    const a = DynArrayStr.fromKeys(['café', '日本', '🍎']);
    expect(a.keysInOrder()).toEqual(['café', '日本', '🍎']);
    expect(a.search('café').found).toBe(true);
    expect(a.search('cafe').found).toBe(false); // "cafe" ≠ "café"
  });

  it('delete counts comparisons + shifts (the Rust remove_first)', () => {
    const a = DynArrayStr.fromKeys(['ten', 'twenty', 'thirty']);
    expect(a.delete('ten')).toEqual({ removed: true, ops: 3 }); // 1 comparison + 2 shifts
    expect(a.keysInOrder()).toEqual(['twenty', 'thirty']);
    expect(a.delete('thirty')).toEqual({ removed: true, ops: 2 }); // full scan, no shift
    expect(a.delete('nope')).toEqual({ removed: false, ops: 1 });
    expect(a.keysInOrder()).toEqual(['twenty']);
  });

  it('delete removes only the first occurrence', () => {
    const a = DynArrayStr.fromKeys(['x', 'x', 'y']);
    expect(a.delete('x').removed).toBe(true);
    expect(a.keysInOrder()).toEqual(['x', 'y']);
  });
});
