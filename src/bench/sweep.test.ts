import { describe, it, expect } from 'vitest';
import { geometricSweep } from './sweep';

describe('geometricSweep', () => {
  it('produces a 1-2-5 progression within bounds', () => {
    expect(geometricSweep(1000, 100000)).toEqual([
      1000, 2000, 5000, 10000, 20000, 50000, 100000,
    ]);
  });

  it('always includes the dataset size (max) as the final point', () => {
    const s = geometricSweep(1000, 64000);
    expect(s[s.length - 1]).toBe(64000);
    expect(s).toContain(50000);
  });

  it('returns empty for invalid bounds', () => {
    expect(geometricSweep(0, 10)).toEqual([]);
    expect(geometricSweep(100, 10)).toEqual([]);
  });

  it('is sorted and de-duplicated', () => {
    const s = geometricSweep(1, 5000);
    expect(s).toEqual([...s].sort((a, b) => a - b));
    expect(new Set(s).size).toBe(s.length);
  });
});
