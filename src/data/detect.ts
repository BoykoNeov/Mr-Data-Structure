import type { KeyType } from './dataset';

/**
 * Type detection and key coercion for imported data (docs/PLAN.md §4.3).
 *
 * Keys are *identity* for search/dedup, so detection is deliberately
 * **conservative**: a value is numeric only if it round-trips exactly through
 * `Number()`. This rejects the inputs that would silently collapse distinct
 * keys into collisions if coerced — leading-zero codes ("007", ZIP "02134")
 * and integers beyond 2^53 (64-bit IDs) — keeping them as strings instead. A
 * wrong key identity means wrong cost curves, which is the one failure this
 * layer must never produce.
 */

/**
 * True iff `cell` is an exact decimal representation of a JS number. The
 * round-trip `String(Number(s)) === s.trim()` is the conservative test: any
 * formatting the parser would lose (leading zeros, trailing `.0`, precision
 * beyond 2^53, `1e3` shorthand) fails and the cell stays a string.
 */
export function isNumeric(cell: string): boolean {
  const s = cell.trim();
  if (s === '') return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  return String(n) === s;
}

/**
 * Detect a column's key type from its cells. Numeric only if there is at least
 * one non-empty cell and **every** non-empty cell {@link isNumeric}; otherwise
 * string. Empty cells are ignored here (the import layer decides skip-vs-error
 * for empty *key* cells).
 */
export function detectColumnType(cells: readonly string[]): KeyType {
  let sawValue = false;
  for (const c of cells) {
    if (c.trim() === '') continue;
    sawValue = true;
    if (!isNumeric(c)) return 'string';
  }
  return sawValue ? 'number' : 'string';
}

/**
 * Coerce a raw cell to a key of the detected type. Numbers are parsed (trimmed);
 * strings are kept verbatim, since surrounding whitespace can be part of a
 * real string key.
 */
export function coerceKey(cell: string, type: 'number'): number;
export function coerceKey(cell: string, type: 'string'): string;
export function coerceKey(cell: string, type: KeyType): number | string;
export function coerceKey(cell: string, type: KeyType): number | string {
  return type === 'number' ? Number(cell.trim()) : cell;
}
