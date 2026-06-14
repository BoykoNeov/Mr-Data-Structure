import { describe, it, expect } from 'vitest';
import {
  generateSorted,
  generateReverseSorted,
  generateNearSorted,
  generateUniform,
  generateGaussian,
  generateZipfian,
  generateStringCorpus,
} from './generators';
import type { Dataset } from './dataset';

const isSortedAsc = (a: readonly number[]) => a.every((v, i) => i === 0 || a[i - 1] <= v);

describe('generateSorted', () => {
  it('produces ascending consecutive integers and records the descriptor', () => {
    const ds = generateSorted(5) as Dataset & { keyType: 'number' };
    expect(ds.keys).toEqual([0, 1, 2, 3, 4]);
    expect(ds.keyType).toBe('number');
    expect(ds.size).toBe(5);
    expect(ds.order).toEqual({ kind: 'sorted', n: 5, start: 0 });
  });
});

describe('generateReverseSorted', () => {
  it('produces descending integers', () => {
    expect((generateReverseSorted(4) as Dataset & { keyType: 'number' }).keys).toEqual([3, 2, 1, 0]);
  });
});

describe('generateNearSorted', () => {
  it('is mostly sorted but perturbed, and reproducible by seed', () => {
    const a = generateNearSorted(50, 5, 0, 123);
    const b = generateNearSorted(50, 5, 0, 123);
    expect(a.keys).toEqual(b.keys);
    expect(a.keys).not.toEqual([...a.keys].sort((x, y) => (x as number) - (y as number)));
  });
});

describe('generateUniform', () => {
  it('is reproducible and stays within bounds', () => {
    const ds = generateUniform(1000, 0, 9, true, 42) as Dataset & { keyType: 'number' };
    expect(ds.keys.every((k) => k >= 0 && k <= 9 && Number.isInteger(k))).toBe(true);
    expect(generateUniform(1000, 0, 9, true, 42).keys).toEqual(ds.keys);
  });
});

describe('generateGaussian', () => {
  it('has roughly the requested mean', () => {
    const ds = generateGaussian(5000, 100, 15, 7) as Dataset & { keyType: 'number' };
    const mean = ds.keys.reduce((s, k) => s + k, 0) / ds.keys.length;
    expect(Math.abs(mean - 100)).toBeLessThan(3);
  });
});

describe('generateZipfian', () => {
  it('is duplicate-heavy and never de-duplicates', () => {
    const ds = generateZipfian(2000, 50, 1.2, 9) as Dataset & { keyType: 'number' };
    expect(ds.keys.length).toBe(2000); // full multiplicity preserved
    const distinct = new Set(ds.keys).size;
    expect(distinct).toBeLessThan(2000); // duplicates exist
    expect(ds.keys.every((k) => k >= 1 && k <= 50)).toBe(true);
  });
});

describe('generateStringCorpus', () => {
  it('produces string keys of bounded length, reproducibly', () => {
    const ds = generateStringCorpus(100, 3, 6, 'abc', 5) as Dataset & { keyType: 'string' };
    expect(ds.keyType).toBe('string');
    expect(ds.keys.every((s) => s.length >= 3 && s.length <= 6 && /^[abc]+$/.test(s))).toBe(true);
    expect(generateStringCorpus(100, 3, 6, 'abc', 5).keys).toEqual(ds.keys);
  });
});

// Guard the empirical selling point: sorted/reverse are exact worst-case orders.
describe('order is the empirical signal', () => {
  it('sorted ascends, reverse descends', () => {
    expect(isSortedAsc((generateSorted(10) as Dataset & { keyType: 'number' }).keys)).toBe(true);
    expect(isSortedAsc((generateReverseSorted(10) as Dataset & { keyType: 'number' }).keys)).toBe(false);
  });
});
