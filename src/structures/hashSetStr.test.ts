import { describe, it, expect } from 'vitest';
import { HashSetStr } from './hashSetStr';

describe('HashSetStr — teaching twin of the Rust HashSetStr', () => {
  it('answers membership correctly', () => {
    const s = HashSetStr.fromKeys(['one', 'two', 'three', 'four', 'five']);
    expect(s.search('three').found).toBe(true);
    expect(s.search('ninety-nine').found).toBe(false);
  });

  it('dedupes on insert (set semantics)', () => {
    const s = HashSetStr.fromKeys(['seven', 'seven', 'seven', 'eight']);
    expect(s.size).toBe(2);
  });

  it('counts at least the hash on every search', () => {
    const s = HashSetStr.fromKeys(['one', 'two', 'three']);
    const hit = s.search('two');
    expect(hit.found).toBe(true);
    expect(hit.ops).toBeGreaterThanOrEqual(2); // hash + >= 1 chain-step
    const miss = s.search('absent-key');
    expect(miss.found).toBe(false);
    expect(miss.ops).toBeGreaterThanOrEqual(1); // at least the hash
  });

  it('keeps chains short under load (search stays O(1))', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `key-${i}`);
    const s = HashSetStr.fromKeys(keys);
    expect(s.size).toBe(1000);
    expect(s.maxChain()).toBeLessThanOrEqual(8);
  });

  it('handles multi-byte keys byte-exactly', () => {
    const s = HashSetStr.fromKeys(['café', '日本', '🍎']);
    expect(s.search('café').found).toBe(true);
    expect(s.search('日本').found).toBe(true);
    expect(s.search('cafe').found).toBe(false); // "cafe" ≠ "café"
  });

  it('insert reports the hash + dedupe walk; a duplicate stores nothing', () => {
    const s = HashSetStr.fromKeys(['car', 'cart', 'cat', 'café', 'dog', 'ant']);
    expect(s.snapshotBuckets().length).toBe(8);
    // owl shares car + ant's bucket: hash + 2 chain-steps, then the 7th key doubles the table.
    expect(s.insert('owl')).toEqual({ inserted: true, ops: 3 });
    expect(s.snapshotBuckets().length).toBe(16);
    const dup = s.insert('owl');
    expect(dup.inserted).toBe(false);
    expect(s.size).toBe(7);
  });

  it('delete splices in place, preserving chain order, and never shrinks', () => {
    const s = HashSetStr.fromKeys(['car', 'cart', 'cat', 'café', 'dog', 'ant']);
    expect(s.snapshotBuckets()[7]).toEqual(['café', 'dog']);
    expect(s.delete('café')).toEqual({ removed: true, ops: 2 });
    expect(s.snapshotBuckets()[7]).toEqual(['dog']);
    expect(s.delete('café')).toEqual({ removed: false, ops: 2 }); // hash + walk past dog
    expect(s.size).toBe(5);
    expect(s.snapshotBuckets().length).toBe(8);
  });

  it('snapshotBuckets is a copy, not the live table', () => {
    const s = HashSetStr.fromKeys(['a']);
    const snap = s.snapshotBuckets();
    snap.forEach((b) => b.push('x'));
    expect(s.keysInOrder()).toEqual(['a']);
  });
});
