import { Callout } from './Explain';

/**
 * The B-tree's honesty copy for the Compare charts (docs/METHODOLOGY.md §2.10; docs/PLAN.md
 * §2.3, §6.5). Kept in its own file so the B-tree slice adds two lines to
 * `CompareSection.tsx` rather than rewriting its shared callouts.
 *
 * The one thing these boxes must say, because the chart cannot: **the op-count signal is
 * blind to memory locality.** The B-tree's declared cost is comparisons, and it makes about
 * as many as the sorted array or the AVL; what it saves is *pointer hops*, which nothing on
 * the op-count axis counts. So any gap between it and its neighbours on the wall clock is
 * the machine, and no gap on the op-count signal is the expected result, not a failure.
 */
export function BTreeSearchNote({
  present,
  midRangeMisses = false,
}: {
  readonly present: boolean;
  /** The run's misses sat between stored keys (docs/PLAN.md §13): no "just past the largest" queries to name. */
  readonly midRangeMisses?: boolean;
}) {
  if (!present) return null;
  return (
    <Callout title="The B-tree (pale purple): same comparisons, fewer hops" tone="caveat">
      The B-tree finds a key with about as many comparisons as the sorted array — roughly log₂ n,
      because both are binary searches. Switch the <strong>Signal</strong> selector to op-count and the
      two lines should nearly coincide. What differs is <em>where</em> those comparisons happen. The
      B-tree keeps up to 31 keys in each node, so a search visits only 3–4 nodes at these sizes and
      does a short binary search inside each one. The op-count cannot see that difference: it counts
      comparisons, not the memory each one touches. So if the pale purple line sits apart from the green
      one on <em>wall-clock</em>, that gap is this machine’s memory doing it, not extra work. If it does
      not, that is a result too: at these sizes everything may already fit in cache. Every B-tree search
      walks all the way to a leaf, so a key that is missing costs within one comparison of one that is
      found, and{' '}
      {midRangeMisses ? (
        <>this run’s misses, which sit between stored keys, cost it about what a found key does (docs/METHODOLOGY.md §2.10).</>
      ) : (
        <>
      the shared workload’s many “just past the largest key” queries do not flatter this line the way
      they flatter the skip list’s (docs/METHODOLOGY.md §2.10).
        </>
      )}
    </Callout>
  );
}

export function BTreeChurnNote({ present, sorted }: { readonly present: boolean; readonly sorted: boolean }) {
  if (!present) return null;
  return (
    <Callout title="The B-tree’s add/remove line: no cheap end to probe" tone="info">
      The pale purple line is the B-tree. It stays <strong>O(log n)</strong> on any input order, because
      it only ever grows at the root and every leaf sits at the same depth. The same fact makes this line
      unusually trustworthy. The test key we add and remove sits just below the smallest key or just
      above the largest, and for the BST and the skip list those are cheap edges. A B-tree has no cheap edge: its
      ends are as deep as its middle. So on the op-count signal this line and the per-operation split
      below agree closely, which they do not for the BST or the skip list. (On wall-clock the split is
      noisier, as it is for every structure.) Once the first few rounds have settled, each
      add-and-remove pair splits nothing and merges nothing, so the line measures the walk down the tree,
      not memory allocation.
      {sorted && (
        <>
          {' '}
          <strong>On sorted data</strong> the B-tree pays a constant, not a class. Splitting nodes as sorted
          keys arrive leaves each node about half full, so the tree has roughly 40 % more nodes and is
          sometimes one level deeper. Its line moves up a little; its slope does not.
        </>
      )}
    </Callout>
  );
}
