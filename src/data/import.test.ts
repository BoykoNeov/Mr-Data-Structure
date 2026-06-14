import { describe, it, expect } from 'vitest';
import { importCsv, importJson, tableToDataset } from './import';
import type { Dataset } from './dataset';

const asNum = (ds: Dataset) => ds as Dataset & { keyType: 'number' };
const asStr = (ds: Dataset) => ds as Dataset & { keyType: 'string' };

describe('importCsv — the Phase 1 exit criterion', () => {
  it('loads a real KV CSV, picking a numeric key field and keeping rows as values', () => {
    const csv = 'id,name,city\n3,Alice,NYC\n1,Bob,LA\n2,Cara,SF\n';
    const ds = importCsv(csv, { keyField: 'id' });
    expect(ds.keyType).toBe('number');
    expect(asNum(ds).keys).toEqual([3, 1, 2]); // as-loaded order, not sorted
    expect(ds.size).toBe(3);
    expect(ds.order).toEqual({ kind: 'as-loaded' });
    expect(ds.values).toEqual([
      { id: '3', name: 'Alice', city: 'NYC' },
      { id: '1', name: 'Bob', city: 'LA' },
      { id: '2', name: 'Cara', city: 'SF' },
    ]);
  });

  it('keeps a leading-zero key column as strings (no collisions)', () => {
    const ds = importCsv('zip,city\n02134,Allston\n02134,Allston\n10001,NYC\n', {
      keyField: 'zip',
    });
    expect(ds.keyType).toBe('string');
    expect(asStr(ds).keys).toEqual(['02134', '02134', '10001']); // duplicate kept
  });

  it('defaults the key to the only column for single-column input', () => {
    const ds = importCsv('7\n8\n9\n', { header: false });
    expect(asNum(ds).keys).toEqual([7, 8, 9]);
    expect(ds.values).toBeUndefined();
  });
});

describe('missing key policy & alignment', () => {
  it('skips rows with empty keys, keeping keys ↔ values aligned', () => {
    const ds = importCsv('id,v\n1,a\n,b\n2,c\n', { keyField: 'id' });
    expect(asNum(ds).keys).toEqual([1, 2]);
    expect(ds.values).toEqual([
      { id: '1', v: 'a' },
      { id: '2', v: 'c' },
    ]);
    expect(ds.keys.length).toBe(ds.values!.length);
  });

  it('throws on empty key when policy is error', () => {
    expect(() => importCsv('id,v\n1,a\n,b\n', { keyField: 'id', onMissingKey: 'error' })).toThrow();
  });
});

describe('tableToDataset guards', () => {
  it('requires a key field for multi-column tables', () => {
    expect(() => importCsv('a,b\n1,2\n')).toThrow(/keyField is required/);
  });

  it('rejects an unknown key field', () => {
    expect(() => importCsv('a,b\n1,2\n', { keyField: 'nope' })).toThrow(/unknown key field/);
  });

  it('rejects a table with no columns', () => {
    expect(() => tableToDataset({ fields: [], rows: [] })).toThrow(/no columns/);
  });
});

describe('importJson', () => {
  it('loads a flat array of primitives', () => {
    expect(asNum(importJson('[5, 3, 9]')).keys).toEqual([5, 3, 9]);
  });

  it('loads an array of records with a chosen key field', () => {
    const ds = importJson('[{"id":1,"name":"a"},{"id":2,"name":"b"}]', { keyField: 'id' });
    expect(asNum(ds).keys).toEqual([1, 2]);
    expect(ds.values).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ]);
  });

  it('unions ragged record fields, filling gaps with empty', () => {
    const ds = importJson('[{"id":1,"x":"a"},{"id":2,"y":"b"}]', { keyField: 'id' });
    expect(ds.values).toEqual([
      { id: '1', x: 'a', y: '' },
      { id: '2', x: '', y: 'b' },
    ]);
  });

  it('rejects non-array JSON', () => {
    expect(() => importJson('{"a":1}')).toThrow(/top-level array/);
  });
});
