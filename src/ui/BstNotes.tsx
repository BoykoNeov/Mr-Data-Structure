import type { StructureId } from '../bench/measure';
import { Callout } from './Explain';

/**
 * The BST's and the AVL's honesty copy for the **search** chart (docs/METHODOLOGY.md §4
 * hurdle 15). Kept in its own file so the slice that put the two trees on that chart adds a
 * few lines to `CompareSection.tsx` rather than rewriting its shared callouts.
 *
 * The one thing these boxes must say, because the chart cannot: **the shared absent probes
 * test only the BST's right edge.** Every structure is asked the same questions, and the
 * missing keys are all above the largest stored one. On reverse-sorted input the BST is a
 * left chain whose right edge is the root alone, so a miss costs one comparison at any size.
 * At any mix with hits in it the slope stays honest; on a **misses-only** run the purple line
 * reads flat for an O(n) chain — a wrong class on the chart, which is why the loud form of
 * the note (and its PNG caption) appears exactly then. Pinned clock-free by
 * `bst::tests::above_max_misses_cost_one_comparison_on_a_left_chain`.
 */

/** Whether a run's probes were all misses — the case where the BST's search line can lie. */
export function missesOnly(presentFraction: number | undefined): boolean {
  return presentFraction === 0;
}

/** Under the search chart: what the two plain-descent trees show, and the one blind spot. */
export function BstSearchNote({
  present,
  sorted,
  reverse,
  presentFraction,
}: {
  readonly present: boolean;
  readonly sorted: boolean;
  readonly reverse: boolean;
  /** The present share the on-screen run measured (`undefined` before any run). */
  readonly presentFraction: number | undefined;
}) {
  if (!present) return null;
  const loud = missesOnly(presentFraction);
  return (
    <Callout
      title={
        loud
          ? 'Misses only: the purple line sees only one edge of the BST'
          : 'The BST (purple) and the AVL (brown): the same search, different shapes'
      }
      tone={loud ? 'caveat' : 'info'}
    >
      Both trees search the same way: start at the root and step left or right until the key turns up
      or the path runs out. So each line reads how deep its tree is. The AVL rebalances itself as keys
      arrive and stays <strong>O(log n)</strong> on any input. The BST never rebalances, so its depth is
      whatever the order of the data made it.{' '}
      {sorted ? (
        <>
          <strong>This dataset is sorted</strong>, so the BST built itself into one long chain and a search
          walks it: <strong>O(n)</strong>, while the AVL beside it stays low. That is the add/remove
          chart’s headline, seen on the read side too.
        </>
      ) : (
        <>
          On shuffled data the two lines nearly coincide. Pick the <em>sorted</em> generator above to watch
          the BST’s search turn into a walk down a chain.
        </>
      )}{' '}
      {loud ? (
        <>
          <strong>This run asked only for keys that are missing</strong>, and every structure here gets the
          same questions: keys just above the largest stored one. For the BST, such a search only follows its
          right-hand edge.{' '}
          {reverse ? (
            <>
              On this reverse-sorted data that edge is a single node, so every search costs one comparison
              at every size, and <strong>the purple line reads flat, O(1), for a tree that is really an O(n)
              chain</strong>.
            </>
          ) : (
            <>
              On data whose largest keys arrive first, that edge is short and the purple line reads lower
              and flatter than the tree really is. On reverse-sorted data it reads perfectly flat.
            </>
          )}{' '}
          Run again with some hits in the mix: a found key walks the real path, and the line shows the
          tree’s true slope. The add/remove chart below tries both ends of the key range, so it is honest
          either way (docs/METHODOLOGY.md §4 hurdle 15).
        </>
      ) : (
        <>
          One allowance: the missing keys in the workload are all above the largest stored key, so for the
          BST they test only its right-hand edge. Found keys walk the real path, so with hits in the mix the
          slope stays honest; on a <em>misses only</em> run with reverse-sorted data the purple line would
          read flat for an O(n) chain (docs/METHODOLOGY.md §4 hurdle 15).
        </>
      )}
    </Callout>
  );
}

/**
 * The same warning as a PNG caption line — present only when the search chart could be lying
 * (a misses-only run with the BST on it), since an exported image travels without the box.
 */
export function bstSheetNote(
  searchStructures: readonly StructureId[],
  presentFraction: number | undefined,
): string | null {
  if (!searchStructures.includes('bst') || !missesOnly(presentFraction)) return null;
  return (
    'This run asked only for missing keys, all above the largest stored one, so the BST’s search line follows only ' +
    'its right-hand edge: on reverse-sorted data a single node, so the line reads flat for an O(n) chain. Re-run with ' +
    'hits in the mix to see the true slope (METHODOLOGY §4 hurdle 15).'
  );
}
