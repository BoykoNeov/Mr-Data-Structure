import type { Table } from './table';

/**
 * Parse JSON into a normalized {@link Table} (docs/PLAN.md §4.3 — import path).
 * Two shapes are accepted:
 *
 * - **Array of primitives** (`[1, 2, 3]` or `["a", "b"]`) → a single-column
 *   table with field `value`.
 * - **Array of records** (`[{ id, name }, …]`) → one column per key, unioned
 *   across all rows so ragged records are handled; missing fields become `''`.
 *
 * Cells are stringified so the one detection/coercion path (`./detect`) applies
 * uniformly. JSON numbers stringify losslessly within the precision JSON itself
 * preserves, and `null`/booleans become their literal text.
 */
export function parseJson(text: string): Table {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('JSON import expects a top-level array');
  }
  if (parsed.length === 0) return { fields: [], rows: [] };

  const allRecords = parsed.every(
    (item) => item !== null && typeof item === 'object' && !Array.isArray(item),
  );

  if (allRecords) {
    // Union the keys, preserving first-seen order.
    const fields: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed as Record<string, unknown>[]) {
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          fields.push(key);
        }
      }
    }
    const rows = (parsed as Record<string, unknown>[]).map((item) =>
      fields.map((f) => (f in item ? cell(item[f]) : '')),
    );
    return { fields, rows };
  }

  // Treat as a flat list of primitive values.
  return { fields: ['value'], rows: parsed.map((v) => [cell(v)]) };
}

/** Stringify a JSON scalar to a table cell; objects/arrays are JSON-encoded. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
