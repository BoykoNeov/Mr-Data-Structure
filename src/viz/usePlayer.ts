import { useCallback, useEffect, useState } from 'react';
import * as P from './player';

/**
 * React binding for the pure {@link ./player Player} (docs/PLAN.md §5). It keeps
 * the immutable player state in `useState` and drives auto-play with an interval
 * that advances one frame at a time; all transport actions (step / back / seek /
 * reset) pause first, so manual control always wins. Auto-play stops on its own
 * at the end. The player logic stays pure and unit-tested; this hook only adds
 * the timer and React state.
 */
export interface PlayerControls<E> {
  readonly state: P.PlayerState<E>;
  readonly playing: boolean;
  /** Auto-play rate, steps per second. */
  readonly speed: number;
  setSpeed: (steps: number) => void;
  /** Load a new event stream and rewind to the start (pauses). */
  loadEvents: (events: readonly E[]) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  reset: () => void;
  toEnd: () => void;
  seek: (frame: number) => void;
}

const DEFAULT_SPEED = 3; // steps/sec — slow enough to follow a comparison.

export function usePlayer<E>(initial: readonly E[] = []): PlayerControls<E> {
  const [state, setState] = useState<P.PlayerState<E>>(() => P.load(initial));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);

  const pause = useCallback(() => setPlaying(false), []);

  const play = useCallback(() => {
    // Replaying from the end restarts from the top.
    setState((s) => (P.atEnd(s) ? P.reset(s) : s));
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => setPlaying((p) => !p), []);

  const loadEvents = useCallback((events: readonly E[]) => {
    setPlaying(false);
    setState(P.load(events));
  }, []);

  const next = useCallback(() => { setPlaying(false); setState(P.next); }, []);
  const prev = useCallback(() => { setPlaying(false); setState(P.prev); }, []);
  const reset = useCallback(() => { setPlaying(false); setState(P.reset); }, []);
  const toEnd = useCallback(() => { setPlaying(false); setState(P.toEnd); }, []);
  const seek = useCallback((frame: number) => {
    setPlaying(false);
    setState((s) => P.seek(s, frame));
  }, []);

  // Auto-advance while playing; halt at the end.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setState((s) => (P.atEnd(s) ? s : P.next(s)));
    }, 1000 / speed);
    return () => clearInterval(id);
  }, [playing, speed]);

  // Stop the engine once the cursor reaches the end.
  useEffect(() => {
    if (playing && P.atEnd(state)) setPlaying(false);
  }, [playing, state]);

  return {
    state, playing, speed, setSpeed,
    loadEvents, play, pause, toggle, next, prev, reset, toEnd, seek,
  };
}
