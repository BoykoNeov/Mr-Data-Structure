/**
 * A parsed tabular source — the intermediate between a raw importer (CSV/JSON)
 * and the normalized {@link import('./dataset').Dataset}. Cells are always
 * strings so a single detection/coercion path (see `./detect`) serves every
 * importer.
 *
 * `rows` are normalized to `fields.length` columns (short rows padded with `''`,
 * extra cells dropped) so column access by index is always safe.
 */
export interface Table {
  /** Column names — the header row, or synthesized `col0`, `col1`, … */
  readonly fields: string[];
  readonly rows: string[][];
}

/** Return the cells of one column by field name, or `undefined` if no such field. */
export function column(table: Table, field: string): string[] | undefined {
  const index = table.fields.indexOf(field);
  if (index < 0) return undefined;
  return table.rows.map((row) => row[index] ?? '');
}
