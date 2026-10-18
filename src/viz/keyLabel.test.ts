import { describe, it, expect } from 'vitest';
import { keyLabel, textWidth, cellWidthFor } from './keyLabel';

describe('keyLabel: the views draw a key’s exact text', () => {
  it('numbers print as themselves', () => {
    expect(keyLabel(42)).toBe('42');
    expect(keyLabel(-0.5)).toBe('-0.5');
  });

  it('a string prints verbatim, multi-byte included', () => {
    expect(keyLabel('café')).toBe('café');
    expect(keyLabel('日本')).toBe('日本');
  });

  it('spaces and the empty key stay visible (SVG would collapse them)', () => {
    expect(keyLabel(' a ')).toBe('␣a␣');
    expect(keyLabel('')).toBe('""');
  });
});

describe('cellWidthFor: long keys widen the cell, short ones keep the minimum', () => {
  it('every numeric seed and the short text keys keep the 46 px cell', () => {
    expect(cellWidthFor([42, 7, 88, 7, 23], 14, 46)).toBe(46);
    expect(cellWidthFor(['car', 'cat', 'dog', 'ant'], 14, 46)).toBe(46);
  });

  it('a long key grows the cell past its label', () => {
    const key = 'a-much-longer-key';
    expect(cellWidthFor([key], 14, 46)).toBeGreaterThan(textWidth(key, 14));
  });

  it('wide (CJK) characters count wider than Latin ones', () => {
    expect(textWidth('日本', 14)).toBeGreaterThan(textWidth('ab', 14));
  });
});
