import type { StructureId } from '../bench/measure';
import { Callout } from './Explain';

/**
 * The doubly linked list's honesty copy for the Compare charts (docs/PLAN.md §2.3, §6.5;
 * docs/METHODOLOGY.md §2.3 regime 7 and §2.11). Kept out of `CompareSection.tsx` so the
 * shared page only gains the three lines that place it.
 *
 * Two claims travel with this structure wherever its curves go:
 *  1. **Its flat add/remove line is the singly list's trap, unchanged.** Head insert puts the
 *     churn key at the head, so the paired delete finds it in one visit — and that holds for
 *     every key, so no key choice fixes it. The real delete-by-value is the O(n) row in the
 *     finite-difference split. Every rule that binds the singly list's curve binds this one:
 *     the caveat box beside the chart, the delete row beside the line, and — because a PNG
 *     leaves the page without its boxes — a caption line on the exported sheet.
 *  2. **The second pointer buys nothing on this op set.** Delete-by-value must find its node
 *     with the same head-first walk, visit for visit; `prev` only speeds unlinking a node the
 *     caller already holds, which insert / search / delete-by-key never hands anyone. The
 *     op-counts are pinned *equal* to the singly list's, while each node is 24 bytes, not 16.
 */

/**
 * The PNG caption line for the doubly list, or `null` when its churn line is not on the
 * sheet. Mirrors the singly list's `sheetNotes` entry: an exported image is the form most
 * likely to be read with no page attached, so the qualifier has to be in the picture.
 */
export function dllSheetNote(churnStructures: readonly StructureId[]): string | null {
  if (!churnStructures.includes('dll')) return null;
  return (
    'The doubly linked list’s flat add/remove is the singly list’s trap again — the O(1) holds only for the key it ' +
    'just put at its own head; removing a stored key is the O(n) delete row above it. Its second (back) pointer ' +
    'changes no count here: a delete still has to walk to the key first, so both lists take exactly the same steps ' +
    '(METHODOLOGY §2.3, §2.11).'
  );
}

/** Under the search chart: why the doubly list's line sits on the singly list's. */
export function DllSearchNote() {
  return (
    <Callout title="Why the light-orange line sits on the orange one" tone="info">
      The doubly linked list (light orange) is the linked list with one extra pointer per node, pointing
      back to the previous node. A search never uses it: finding a key means walking forward from the
      front either way, so the two lists take <strong>exactly the same steps</strong> — switch the{' '}
      <strong>Signal</strong> to op-count and the two lines lie on top of each other. On wall-clock the
      light-orange line may run a little higher — each node is 24 bytes instead of 16 — but at the{' '}
      <em>same slope</em>: a constant factor on this machine, not a different growth rate. That is the
      price of the extra pointer, and on this chart it buys nothing in return (docs/METHODOLOGY.md §2.11).
    </Callout>
  );
}

/** Beside the churn chart, right after the singly list's caveat box. */
export function DllChurnCaveat() {
  return (
    <Callout title="The light-orange line is the same trap — and the extra pointer doesn’t get it out" tone="caveat">
      The doubly linked list’s add/remove line is flat for exactly the singly list’s reason: it adds at the
      front, so the key we then remove is the first one it looks at. No choice of key changes that — every
      key lands at the front. Removing a key that is already <em>in</em> the list is the light-orange{' '}
      <em>delete</em> row in the split below, and it is <strong>O(n)</strong>, like the singly list’s.
      <br />
      It is tempting to think the back pointer makes removal cheap. It only makes the last step cheap —
      reconnecting the neighbours of a node <em>you already hold</em>. Removing a key means finding its node
      first, and that is the same walk from the front, step for step; the reconnecting was never the
      expensive part on either list. So on these three operations — add, find, remove a key — the two lists
      take <strong>exactly the same number of steps</strong> (pinned, not estimated), and the doubly list
      pays 24 bytes a node for it instead of 16. The back pointer earns its keep only when something hands
      you a node directly, such as a cache that keeps a pointer to each entry; nothing on this page does
      (docs/METHODOLOGY.md §2.11).
    </Callout>
  );
}
