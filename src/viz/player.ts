/**
 * Step-through player (docs/PLAN.md §5, "Controls") — structure-agnostic. It
 * holds a *materialized* event list and a frame cursor; everything else (which
 * cells exist, what's highlighted) is derived by folding `events[0..frame)` in
 * the renderer. That fold-from-zero is why step-**back** needs no reverse-ops and
 * can't drift: at the ≤200-node visualization cap (docs/PLAN.md §5) replaying the
 * prefix on every seek is free and bug-proof.
 *
 * The state is a plain immutable record and the transitions are pure functions,
 * so the React hook (`usePlayer`) can keep it in `useState` and the logic is
 * unit-tested without a DOM.
 *
 * Frames: `frame` counts how many events have been applied. `frame === 0` is the
 * initial state (before the op); `frame === events.length` is the final state.
 */

/** Immutable player state: the event list plus how many events are applied. */
export interface PlayerState<E> {
  readonly events: readonly E[];
  readonly frame: number;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.trunc(n)));

/** A fresh player over `events`, positioned at the start (frame 0). */
export function load<E>(events: readonly E[]): PlayerState<E> {
  return { events, frame: 0 };
}

/** The number of steps (= events). The cursor ranges over `0..length`. */
export function length<E>(s: PlayerState<E>): number {
  return s.events.length;
}

export function atStart<E>(s: PlayerState<E>): boolean {
  return s.frame === 0;
}

export function atEnd<E>(s: PlayerState<E>): boolean {
  return s.frame === s.events.length;
}

/** The events applied so far — what the renderer folds into the display state. */
export function applied<E>(s: PlayerState<E>): readonly E[] {
  return s.events.slice(0, s.frame);
}

/** The event most recently applied (the "active" one to highlight), if any. */
export function current<E>(s: PlayerState<E>): E | undefined {
  return s.frame > 0 ? s.events[s.frame - 1] : undefined;
}

/** Seek to an absolute frame, clamped to `0..length`. */
export function seek<E>(s: PlayerState<E>, frame: number): PlayerState<E> {
  const clamped = clamp(frame, 0, s.events.length);
  return clamped === s.frame ? s : { ...s, frame: clamped };
}

/** Apply the next event (no-op at the end). */
export function next<E>(s: PlayerState<E>): PlayerState<E> {
  return seek(s, s.frame + 1);
}

/** Undo the last event (no-op at the start). */
export function prev<E>(s: PlayerState<E>): PlayerState<E> {
  return seek(s, s.frame - 1);
}

/** Back to the initial state (frame 0). */
export function reset<E>(s: PlayerState<E>): PlayerState<E> {
  return seek(s, 0);
}

/** Jump to the final state (all events applied). */
export function toEnd<E>(s: PlayerState<E>): PlayerState<E> {
  return seek(s, s.events.length);
}
