/**
 * Display models and the event fold (docs/PLAN.md §5). A renderer shows the
 * structure at frame `f` by folding `events[0..f)` over the model captured
 * *before* the op (see {@link ./player}). Keeping the fold here — pure, no JSX —
 * means the animation's correctness is unit-tested, not eyeballed (the advisor's
 * "make the logic bulletproof, treat pixels as smoke").
 *
 * Each stored item carries a stable `id` independent of its value, so a renderer
 * can animate a *moving* item (an array shift, a rehash relocation) by tracking
 * identity across frames — values alone can't (the structures hold duplicates).
 * Reducers are total: structural events transform the model; highlight-only
 * events (`compare`, `probe`, `result`, …) return it unchanged (the view derives
 * the highlight from the active event instead).
 */

import type { ArrayEvent, HashSetEvent } from './events';

/** A stored array cell with a stable identity for animation. */
export interface Cell {
  readonly id: number;
  readonly value: number;
}

/** The vacated slot during a shift-compact delete. It carries its own id and
 * bubbles toward the tail as the survivors shift left, so every intermediate
 * frame keeps unique slot ids (each frame must be renderable, not just the
 * last). It's dropped by the final `arr.pop`. */
export interface Hole {
  readonly id: number;
  readonly hole: true;
}

/** A slot in the array view: a real cell or the transient delete hole. */
export type Slot = Cell | Hole;

export const isHole = (s: Slot): s is Hole => 'hole' in s;

/** The array's display state: ordered slots plus the next free id. */
export interface ArrayModel {
  readonly cells: readonly Slot[];
  readonly nextId: number;
}

/** Build the initial array model from the structure's current keys. */
export function arrayModel(values: readonly number[]): ArrayModel {
  return { cells: values.map((value, id) => ({ id, value })), nextId: values.length };
}

/** Fold one array event into the model (docs/PLAN.md §8 shift-compact delete). */
export function reduceArray(m: ArrayModel, e: ArrayEvent): ArrayModel {
  switch (e.kind) {
    case 'arr.append':
      return { cells: [...m.cells, { id: m.nextId, value: e.value }], nextId: m.nextId + 1 };
    case 'arr.removeTarget': {
      // Replace the found cell with a hole (its own id); the survivors then shift
      // left past it. The hole is what makes every shift frame renderable.
      const cells = m.cells.slice();
      cells[e.index] = { id: m.nextId, hole: true };
      return { cells, nextId: m.nextId + 1 };
    }
    case 'arr.shift': {
      // The survivor at `from` slides left into `to`; the hole swaps to `from`,
      // bubbling one step toward the tail. Swapping (not overwriting) keeps every
      // slot id unique within the frame — no duplicate React keys.
      const cells = m.cells.slice();
      const tmp = cells[e.to];
      cells[e.to] = cells[e.from];
      cells[e.from] = tmp;
      return { cells, nextId: m.nextId };
    }
    case 'arr.pop':
      return { cells: m.cells.slice(0, -1), nextId: m.nextId };
    // highlight-only: compare / result — no structural change.
    default:
      return m;
  }
}

/** A stored hash-set chip with a stable identity for animation. */
export interface Chip {
  readonly id: number;
  readonly value: number;
}

/** The hash set's display state: buckets of chains, plus the next free id. */
export interface HashModel {
  readonly buckets: readonly (readonly Chip[])[];
  readonly nextId: number;
}

/** Build the initial hash model from the structure's bucket snapshot. */
export function hashModel(buckets: readonly (readonly number[])[]): HashModel {
  let id = 0;
  const out = buckets.map((b) => b.map((value) => ({ id: id++, value })));
  return { buckets: out, nextId: id };
}

/** Fold one hash-set event into the model (insert / chain-remove / rehash). */
export function reduceHash(m: HashModel, e: HashSetEvent): HashModel {
  switch (e.kind) {
    case 'hs.insert': {
      const buckets = m.buckets.map((b, i) =>
        i === e.bucket ? [...b, { id: m.nextId, value: e.value }] : b,
      );
      return { buckets, nextId: m.nextId + 1 };
    }
    case 'hs.chainRemove': {
      const buckets = m.buckets.map((b, i) =>
        i === e.bucket ? b.filter((_, pos) => pos !== e.pos) : b,
      );
      return { buckets, nextId: m.nextId };
    }
    case 'hs.rehash': {
      // Redistribute by zipping current chips (old-iteration order: buckets by
      // index, chains front-to-back) with the event's per-key moves, so each
      // chip keeps its id as it relocates.
      const next: Chip[][] = Array.from({ length: e.newCap }, () => []);
      let i = 0;
      for (const bucket of m.buckets) {
        for (const chip of bucket) {
          const move = e.moves[i++];
          next[move.toBucket].push(chip);
        }
      }
      return { buckets: next, nextId: m.nextId };
    }
    // highlight-only: hash / probe / duplicate / result — no structural change.
    default:
      return m;
  }
}

/** Fold a whole event prefix into the model — the renderer's per-frame state. */
export function foldArray(initial: ArrayModel, events: readonly ArrayEvent[]): ArrayModel {
  return events.reduce(reduceArray, initial);
}

export function foldHash(initial: HashModel, events: readonly HashSetEvent[]): HashModel {
  return events.reduce(reduceHash, initial);
}
