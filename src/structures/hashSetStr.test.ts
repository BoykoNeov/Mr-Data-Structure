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
});
