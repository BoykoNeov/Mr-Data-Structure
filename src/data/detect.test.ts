import { describe, it, expect } from 'vitest';
import { isNumeric, detectColumnType, coerceKey } from './detect';

describe('isNumeric', () => {
  it('accepts plain integers and decimals', () => {
    expect(isNumeric('0')).toBe(true);
    expect(isNumeric('42')).toBe(true);
    expect(isNumeric('-7')).toBe(true);
    expect(isNumeric('3.14')).toBe(true);
    expect(isNumeric(' 100 ')).toBe(true); // trimmed
  });

  it('rejects identity-corrupting numerics (the cases that cause collisions)', () => {
    expect(isNumeric('007')).toBe(false); // leading zeros
    expect(isNumeric('02134')).toBe(false); // ZIP code
    expect(isNumeric('9007199254740993')).toBe(false); // 2^53 + 1, loses low bit
    expect(isNumeric('1e3')).toBe(false); // shorthand wouldn't round-trip
    expect(isNumeric('1.50')).toBe(false); // trailing zero lost
  });

  it('rejects non-numbers and empties', () => {
    expect(isNumeric('')).toBe(false);
    expect(isNumeric('  ')).toBe(false);
    expect(isNumeric('abc')).toBe(false);
    expect(isNumeric('NaN')).toBe(false);
    expect(isNumeric('Infinity')).toBe(false);
  });
});

describe('detectColumnType', () => {
  it('is numeric only when every non-empty cell round-trips', () => {
    expect(detectColumnType(['1', '2', '3'])).toBe('number');
    expect(detectColumnType(['1', '', '3'])).toBe('number'); // empties ignored
    expect(detectColumnType(['1', '02134', '3'])).toBe('string'); // one bad ⇒ string
  });

  it('treats an all-empty (or empty) column as string', () => {
    expect(detectColumnType([])).toBe('string');
    expect(detectColumnType(['', '  '])).toBe('string');
  });
});

describe('coerceKey', () => {
  it('parses numbers and keeps strings verbatim', () => {
    expect(coerceKey('  42 ', 'number')).toBe(42);
    expect(coerceKey('  hi ', 'string')).toBe('  hi '); // whitespace preserved
  });
});
