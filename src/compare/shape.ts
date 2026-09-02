import type { Dataset } from '../data';
import type { InputShape } from '../registry';

/**
 * Classify a dataset's *input order* for the theoretical overlay (docs/PLAN.md
 * §4.3, §7.2): `sorted` when the keys arrive monotonically (either direction)
 * or came from a sorted-family generator, else `random`. Order is the one
 * property of real data that flips a structure's class — a monotone run turns
 * the naive BST into a chain — so the overlay must know it.
 *
 * Numeric keys only (the sweep is numeric); a string dataset reads as `random`.
 */
export function inputShapeOf(dataset: Dataset): InputShape {
  const k = dataset.order.kind;
  if (k === 'sorted' || k === 'reverse-sorted' || k === 'near-sorted') return 'sorted';
  if (dataset.keyType !== 'number' || dataset.keys.length < 2) return 'random';
  return isMonotone(dataset.keys) ? 'sorted' : 'random';
}

/** Non-decreasing or non-increasing throughout. */
export function isMonotone(keys: readonly number[]): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < keys.length && (up || down); i++) {
    if (keys[i] < keys[i - 1]) up = false;
    if (keys[i] > keys[i - 1]) down = false;
  }
  return up || down;
}
