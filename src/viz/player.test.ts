import { describe, it, expect } from 'vitest';
import {
  load, length, atStart, atEnd, applied, current, seek, next, prev, reset, toEnd,
  type PlayerState,
} from './player';

/** A tiny event type just to exercise the cursor — the player is generic. */
type E = string;
const make = (): PlayerState<E> => load(['a', 'b', 'c']);

describe('Player — pure step-through cursor', () => {
  it('starts at frame 0 with nothing applied', () => {
    const s = make();
    expect(s.frame).toBe(0);
    expect(length(s)).toBe(3);
    expect(atStart(s)).toBe(true);
    expect(atEnd(s)).toBe(false);
    expect(applied(s)).toEqual([]);
    expect(current(s)).toBeUndefined();
  });

  it('next applies events one at a time and exposes the active one', () => {
    let s = next(make());
    expect(s.frame).toBe(1);
    expect(applied(s)).toEqual(['a']);
    expect(current(s)).toBe('a');
    s = next(s);
    expect(applied(s)).toEqual(['a', 'b']);
    expect(current(s)).toBe('b');
  });

  it('prev folds back; step-back never goes below the start', () => {
    let s = toEnd(make());
    expect(atEnd(s)).toBe(true);
    s = prev(s);
    expect(s.frame).toBe(2);
    expect(applied(s)).toEqual(['a', 'b']);
    s = prev(prev(prev(s))); // 3 prevs from frame 2 → clamps at 0
    expect(s.frame).toBe(0);
    expect(atStart(s)).toBe(true);
  });

  it('next clamps at the end (no overshoot)', () => {
    let s = make();
    for (let i = 0; i < 10; i++) s = next(s);
    expect(s.frame).toBe(3);
    expect(atEnd(s)).toBe(true);
    expect(current(s)).toBe('c');
  });

  it('seek clamps out-of-range frames', () => {
    const s = make();
    expect(seek(s, -5).frame).toBe(0);
    expect(seek(s, 99).frame).toBe(3);
    expect(seek(s, 2).frame).toBe(2);
    expect(seek(s, 1.9).frame).toBe(1); // truncates
  });

  it('seek to the current frame returns the same object (stable identity)', () => {
    const s = seek(make(), 2);
    expect(seek(s, 2)).toBe(s);
  });

  it('reset and toEnd jump to the bounds', () => {
    const s = seek(make(), 1);
    expect(reset(s).frame).toBe(0);
    expect(toEnd(s).frame).toBe(3);
  });

  it('an empty event list is both at the start and at the end', () => {
    const s = load<E>([]);
    expect(atStart(s)).toBe(true);
    expect(atEnd(s)).toBe(true);
    expect(next(s).frame).toBe(0);
  });
});
