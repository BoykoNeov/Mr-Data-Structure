import type { Table } from './table';

/**
 * A small, dependency-free CSV parser (docs/PLAN.md §4.3 — import path).
 * RFC-4180-ish: handles quoted fields, `""`-escaped quotes inside quotes,
 * embedded delimiters and newlines, and both `\n` and `\r\n` line endings. It
 * strips a leading UTF-8 BOM (Excel exports begin with `﻿`, which would
 * otherwise corrupt the first header name).
 *
 * Whether the first record is a header is an explicit option, never guessed —
 * a fragile auto-detect heuristic is worse than asking the caller.
 */
export interface CsvOptions {
  /** First record is the header row. Default `true`. */
  header?: boolean;
  /** Field delimiter. Default `','`. */
  delimiter?: string;
}

/** Split raw CSV text into records of raw string fields. */
function parseRecords(text: string, delimiter: string): string[][] {
  // Strip a leading UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++; // CRLF → one line break
      endRecord();
    } else {
      field += ch;
    }
  }

  // Flush the final field/record unless the input ended exactly on a line
  // break (which would otherwise yield a phantom empty record).
  if (field !== '' || record.length > 0) endRecord();

  return records;
}

/** Parse CSV text into a normalized {@link Table}. */
export function parseCsv(text: string, options: CsvOptions = {}): Table {
  const { header = true, delimiter = ',' } = options;
  const records = parseRecords(text, delimiter);

  if (records.length === 0) return { fields: [], rows: [] };

  let fields: string[];
  let dataRecords: string[][];
  if (header) {
    // The header row is the schema; data rows are normalized to its width.
    fields = records[0].slice();
    dataRecords = records.slice(1);
  } else {
    // No header: synthesize a name per column, widening to the widest record.
    const width = records.reduce((max, r) => Math.max(max, r.length), 0);
    fields = Array.from({ length: width }, (_, i) => `col${i}`);
    dataRecords = records;
  }

  // Normalize every row to exactly `fields.length` cells.
  const rows = dataRecords.map((r) => {
    const row = r.slice(0, fields.length);
    while (row.length < fields.length) row.push('');
    return row;
  });

  return { fields, rows };
}
