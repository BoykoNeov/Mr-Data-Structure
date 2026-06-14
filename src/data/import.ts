import { makeDataset, type Dataset } from './dataset';
import { coerceKey, detectColumnType } from './detect';
import { parseCsv, type CsvOptions } from './csv';
import { parseJson } from './json';
import type { Table } from './table';

/**
 * Turn an imported {@link Table} into a normalized {@link Dataset}
 * (docs/PLAN.md §4.1–§4.3). The caller picks which field is the **key**; for
 * key–value records the whole row becomes the index-aligned value.
 */
export interface ToDatasetOptions {
  /**
   * The key field. Required when the table has more than one column (the KV
   * key-field picker, §4.1). For a single-column table it defaults to that
   * column.
   */
  keyField?: string;
  /**
   * Attach each source row as the value for its key (`values[i]` ↔ `keys[i]`).
   * Default `true` when the table has more than one column, `false` otherwise.
   */
  keepValues?: boolean;
  /**
   * What to do with a row whose key cell is empty: `'skip'` drops the row
   * (keeping keys/values aligned); `'error'` throws. Default `'skip'`.
   */
  onMissingKey?: 'skip' | 'error';
}

/** Build a {@link Dataset} from a parsed table by selecting a key field. */
export function tableToDataset(table: Table, options: ToDatasetOptions = {}): Dataset {
  if (table.fields.length === 0) throw new Error('table has no columns');

  const multiColumn = table.fields.length > 1;
  const keyField = options.keyField ?? (multiColumn ? undefined : table.fields[0]);
  if (keyField === undefined) {
    throw new Error(
      `keyField is required for a multi-column table (fields: ${table.fields.join(', ')})`,
    );
  }
  const keyIndex = table.fields.indexOf(keyField);
  if (keyIndex < 0) throw new Error(`unknown key field: ${keyField}`);

  const onMissingKey = options.onMissingKey ?? 'skip';
  const keepValues = options.keepValues ?? multiColumn;

  // First pass: collect non-empty key cells (respecting the missing-key policy)
  // and the rows that survive, so keys and values stay index-aligned.
  const keyCells: string[] = [];
  const keptRows: string[][] = [];
  for (const row of table.rows) {
    const cell = row[keyIndex] ?? '';
    if (cell.trim() === '') {
      if (onMissingKey === 'error') throw new Error('empty key cell');
      continue; // skip
    }
    keyCells.push(cell);
    keptRows.push(row);
  }

  const keyType = detectColumnType(keyCells);
  const keys =
    keyType === 'number'
      ? keyCells.map((c) => coerceKey(c, 'number'))
      : keyCells.map((c) => coerceKey(c, 'string'));
  const values = keepValues
    ? keptRows.map((row) => rowToRecord(table.fields, row))
    : undefined;

  return makeDataset(keys, keyType, { kind: 'as-loaded' }, values);
}

/** Turn an aligned row into a `{ field: cell }` record (the KV payload). */
function rowToRecord(fields: readonly string[], row: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < fields.length; i++) record[fields[i]] = row[i] ?? '';
  return record;
}

/** Parse CSV text and build a dataset in one step. */
export function importCsv(
  text: string,
  options: ToDatasetOptions & CsvOptions = {},
): Dataset {
  return tableToDataset(parseCsv(text, options), options);
}

/** Parse JSON text and build a dataset in one step. */
export function importJson(text: string, options: ToDatasetOptions = {}): Dataset {
  return tableToDataset(parseJson(text), options);
}
