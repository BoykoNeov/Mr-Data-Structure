import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const t = parseCsv('id,name\n1,Alice\n2,Bob\n');
    expect(t.fields).toEqual(['id', 'name']);
    expect(t.rows).toEqual([
      ['1', 'Alice'],
      ['2', 'Bob'],
    ]);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a\n1\n2\n').rows).toEqual([['1'], ['2']]);
  });

  it('handles quoted fields with commas, quotes, and newlines', () => {
    const t = parseCsv('id,note\n1,"a, b"\n2,"she said ""hi"""\n3,"line1\nline2"\n');
    expect(t.rows).toEqual([
      ['1', 'a, b'],
      ['2', 'she said "hi"'],
      ['3', 'line1\nline2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']]);
  });

  it('strips a leading UTF-8 BOM from the first field', () => {
    const t = parseCsv('﻿id,name\n1,Alice\n');
    expect(t.fields).toEqual(['id', 'name']);
  });

  it('supports headerless input with synthesized field names', () => {
    const t = parseCsv('1,2\n3,4\n', { header: false });
    expect(t.fields).toEqual(['col0', 'col1']);
    expect(t.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('normalizes ragged rows to the field count', () => {
    const t = parseCsv('a,b,c\n1\n1,2,3,4\n');
    expect(t.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('honors a custom delimiter', () => {
    expect(parseCsv('a\tb\n1\t2\n', { delimiter: '\t' }).rows).toEqual([['1', '2']]);
  });
});
