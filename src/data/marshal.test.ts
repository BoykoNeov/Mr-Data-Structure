import { describe, it, expect } from 'vitest';
import { marshalKeys, unmarshalKeys, transferables } from './marshal';
import { makeDataset } from './dataset';
import { generateSorted, generateStringCorpus } from './generators';

describe('marshalKeys / unmarshalKeys', () => {
  it('round-trips numeric keys through a Float64Array', () => {
    const ds = generateSorted(1000);
    const m = marshalKeys(ds);
    expect(m.keyType).toBe('number');
    expect(unmarshalKeys(m)).toEqual([...ds.keys]);
  });

  it('represents large safe integers exactly', () => {
    const big = Number.MAX_SAFE_INTEGER; // 2^53 - 1
    const ds = makeDataset([big, 0, big - 1], 'number', { kind: 'as-loaded' });
    expect(unmarshalKeys(marshalKeys(ds))).toEqual([big, 0, big - 1]);
  });

  it('round-trips string keys via offsets + UTF-8 (incl. multibyte)', () => {
    const ds = makeDataset(['a', '', 'héllo', '日本語'], 'string', { kind: 'as-loaded' });
    const m = marshalKeys(ds);
    if (m.keyType !== 'string') throw new Error('expected string buffer');
    expect(m.offsets.length).toBe(ds.keys.length + 1);
    expect(m.offsets[0]).toBe(0);
    expect(m.offsets[m.offsets.length - 1]).toBe(m.bytes.length);
    expect(unmarshalKeys(m)).toEqual([...ds.keys]);
  });

  it('round-trips a generated string corpus', () => {
    const ds = generateStringCorpus(500, 3, 8, 'abcdef', 11);
    expect(unmarshalKeys(marshalKeys(ds))).toEqual([...ds.keys]);
  });

  it('exposes the backing buffers as transferables', () => {
    expect(transferables(marshalKeys(generateSorted(10)))).toHaveLength(1);
    const strM = marshalKeys(makeDataset(['x'], 'string', { kind: 'as-loaded' }));
    expect(transferables(strM)).toHaveLength(2);
    expect(transferables(strM).every((b) => b instanceof ArrayBuffer)).toBe(true);
  });
});
