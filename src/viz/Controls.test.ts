import { describe, it, expect } from 'vitest';
import { opNeedsValue, parseKey, dispatchFor, enterSpecFor, type OpSpec } from './Controls';

/**
 * The op-dispatch decision of the step `Controls` (docs/PLAN.md §5). The
 * render-smoke suite (`views.render.test.ts`) drives the structures directly and
 * mounts the panels via SSR (no click events fire), so the one genuinely new path
 * of the heap batch — a `needsValue: false` op (extract-min / peek) dispatching
 * *without* a typed-in key — has no end-to-end coverage there. These helpers are
 * the pure core of that decision; pinning them here proves extract-min/peek
 * dispatch on an empty box (passing `0`, never `NaN`) and that Enter never fires a
 * no-key op. (The button → `run` → `onOp` wiring is a type-checked one-liner.)
 */

type HeapOp = 'insert' | 'extractMin' | 'peek' | 'search';
const HEAP_OPS: readonly OpSpec<HeapOp>[] = [
  { op: 'insert', label: 'insert' },
  { op: 'extractMin', label: 'extract-min', needsValue: false },
  { op: 'peek', label: 'peek', needsValue: false },
  { op: 'search', label: 'search' },
];

const insert = HEAP_OPS[0];
const extractMin = HEAP_OPS[1];
const peek = HEAP_OPS[2];
const search = HEAP_OPS[3];

describe('opNeedsValue', () => {
  it('defaults to true when needsValue is omitted', () => {
    expect(opNeedsValue(insert)).toBe(true);
    expect(opNeedsValue(search)).toBe(true);
  });
  it('is false only for an explicit needsValue: false', () => {
    expect(opNeedsValue(extractMin)).toBe(false);
    expect(opNeedsValue(peek)).toBe(false);
  });
});

describe('parseKey', () => {
  it('rejects a blank or whitespace-only box', () => {
    // Number('') is 0 (a JS quirk), so the blank-guard — not Number.isFinite — is
    // what rejects an empty box; either way `valid` is false and the value is unused.
    expect(parseKey('').valid).toBe(false);
    expect(parseKey('   ').valid).toBe(false);
  });
  it('rejects non-numeric text (would be NaN)', () => {
    expect(parseKey('abc').valid).toBe(false);
  });
  it('accepts finite numbers, including zero and negatives', () => {
    expect(parseKey('42')).toEqual({ valid: true, value: 42 });
    expect(parseKey('0')).toEqual({ valid: true, value: 0 });
    expect(parseKey('-3')).toEqual({ valid: true, value: -3 });
    expect(parseKey('1e3')).toEqual({ valid: true, value: 1000 });
  });
});

describe('dispatchFor: a no-key op runs without a typed key (the heap headline)', () => {
  it('extract-min dispatches on an empty box, passing 0 (not NaN)', () => {
    expect(dispatchFor(extractMin, '')).toEqual({ op: 'extractMin', value: 0 });
    expect(dispatchFor(peek, '   ')).toEqual({ op: 'peek', value: 0 });
  });
  it('a no-key op still dispatches when a key happens to be typed (value ignored downstream)', () => {
    expect(dispatchFor(extractMin, '99')).toEqual({ op: 'extractMin', value: 99 });
  });
});

describe('dispatchFor: a key-taking op is suppressed without a valid key', () => {
  it('returns null on a blank or non-numeric box', () => {
    expect(dispatchFor(insert, '')).toBeNull();
    expect(dispatchFor(search, 'abc')).toBeNull();
  });
  it('dispatches the parsed value when the key is valid', () => {
    expect(dispatchFor(insert, '7')).toEqual({ op: 'insert', value: 7 });
    expect(dispatchFor(search, '0')).toEqual({ op: 'search', value: 0 });
  });
});

describe('enterSpecFor: Enter picks search, else the first key-taking op', () => {
  it('prefers search when present (the heap has one)', () => {
    expect(enterSpecFor(HEAP_OPS)).toBe(search);
  });
  it('falls back to the first key-taking op when there is no search', () => {
    const ops: readonly OpSpec<'insert' | 'peek'>[] = [
      { op: 'peek', label: 'peek', needsValue: false },
      { op: 'insert', label: 'insert' },
    ];
    expect(enterSpecFor(ops)?.op).toBe('insert');
  });
  it('is undefined when every op is a no-key op (Enter does nothing)', () => {
    const ops: readonly OpSpec<'peek'>[] = [{ op: 'peek', label: 'peek', needsValue: false }];
    expect(enterSpecFor(ops)).toBeUndefined();
  });
});
