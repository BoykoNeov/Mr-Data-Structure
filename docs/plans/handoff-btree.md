# Handoff — a B-tree, measured end to end

Slice owner: parallel agent (worktree `agent-ae9ece34f71214abc`, branched from `main` @ 7450254,
**main @ 94a3168 merged in** before the final commit). Scope: StructureId `'btree'`, colour
`#c5b0d5`, METHODOLOGY **§2.10**. The measured half only — no animation (a later round).
The living docs (`README.md`, `docs/PLAN.md`, `CLAUDE.md`, `docs/METHODOLOGY.md`) were
deliberately not edited; this file holds the text for the lead to merge.

Files added: `bench-engine/src/structures/btree.rs`, `…/conformance_btree.rs`,
`…/methodology_btree.rs`, `bench-engine/tests/proptest_btree.rs`, `conformance/corpus-btree.txt`,
`src/structures/btree.ts`, `src/structures/btree.test.ts`,
`src/structures/conformance-btree.test.ts`, `src/ui/BTreeNotes.tsx`, this file.
Shared files touched (additive): `bench-engine/src/structures/mod.rs` (3 module lines),
`src/bench/{measure,BenchEngine,wasmBenchEngine,engine.worker}.ts`, `src/registry.ts` + test,
`src/compare/runSweeps.ts` + test, `src/ui/CompareSection.tsx`, `src/structures/index.ts`,
`scripts/verify-browser.mjs`.

---

## 1. docs/PLAN.md §10 — "Done" entry (append under Phase 6)

  - **Done (a B-tree — the AVL's comparisons in a quarter of its node hops):** the Trees family
    gains its wide-node balanced tree, measured end to end: Rust bench twin
    (`btree::BTreeF64`, minimum degree **t = 16**, ≤ 31 keys a node), TypeScript teaching twin
    (`src/structures/btree.ts`, degree a parameter), a cross-language corpus
    (`conformance/corpus-btree.txt`, cases at t = 2, 3 and 16, with a per-insert op column and
    the level-by-level shape), proptests against a sorted-`Vec` multiset with duplicates
    everywhere (t = 2, 3, 16), clock-free methodology tests
    (`structures::methodology_btree`), a registry entry, and both numeric Compare sweeps — a
    seventh search line and a churn trio on the shared charts. Cost metric **comparisons +
    splits/merges/borrows** (the counterpart of the AVL's rotations). The slice turns on two
    findings and one design correction:
    - **Equal comparisons, fewer hops.** Per search on the engine's own probes the B-tree makes
      within ~8 % of the AVL's comparisons (16.5 vs 15.3 at n = 100 000) and of the sorted
      array's (15.8), while visiting only its height — 3–4 nodes against the AVL's 12–20. The
      op-count chart cannot see that; node-visits are reported clock-free, not charted. Whether
      the wall clock separates the B-tree from its neighbours is a **hypothesis**, printed by
      the gate for reading and not asserted.
    - **The tenth churn-vs-FD regime: tight, for a tree.** Every leaf is at one depth, so the
      two-key churn probe (`min − 1` / `max + 1`) has no cheap spine to ride: churn 25.0 vs
      FD sum 24.5 (shuffled, ~2 %), 24.5 vs 24.7 ascending, 26.0 vs 27.5 descending.
    - **CLRS's single-pass delete replaced by repair-on-underflow.** With the proactive split,
      CLRS's pre-fill delete splits and re-merges a node on *every* churn pair (hand trace in
      the `btree` module doc), and on sorted input at every level — the churn curve would
      measure the allocator. Repairing only true underflow has hysteresis: after a few warm-up
      pairs a churn pair restructures and allocates **nothing**
      (`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`, ascending /
      descending / shuffled, t = 2 and 16). Insert keeps the CLRS proactive split.
    Gates: cargo test 234 passed (incl. 3 new proptests), vitest 1023 passed, typecheck clean;
    `verify:browser` **UNRUN** (five new B-tree checks, conservative class bands only). No new
    deps.

## 2. docs/PLAN.md §8 — table row (Trees / heaps)

| B-tree (t = 16) | O(log n) | O(log n) | O(log n) | comparisons + splits/merges/borrows | **Built (Phase 6).** Up to 31 keys a node; balanced by construction (grows only at the root, every leaf at one depth), so no input order changes its class — sorted input only leaves nodes half full (a constant). Multiset; delete removes the first occurrence in order. Search is a lower-bound descent to a leaf with **one deferred equality test**, so it makes ≈ log₂ n comparisons — the AVL's count — in ≈ log_t n node-visits. Insert: CLRS proactive split; delete: **repair on underflow** (borrow left, borrow right, merge), *not* CLRS's single-pass pre-fill, which thrashes split/merge on churn (METHODOLOGY §2.10) |

## 3. docs/METHODOLOGY.md

### §2.10 — new section

### 2.10 Equal work, fewer hops (the B-tree)

The B-tree is the structure where the two signals of §1 are *expected* to tell different
stories about the constant. Its declared cost is **key comparisons** (plus one per split,
merge or borrow, the counterpart of the AVL's rotations), and on that axis it is
indistinguishable from the AVL and the sorted array: binary search is binary search, ≈ log₂ n
comparisons whether the keys sit in one array, in a binary tree, or in a few 31-key nodes.
Measured on the engine's own probe set (`methodology_btree::btree_matches_the_avl_on_comparisons_but_takes_a_quarter_of_the_node_visits`):

| n | B-tree comparisons | AVL comparisons | sorted array | B-tree node-visits | AVL node-visits |
|---|---|---|---|---|---|
| 4 000 | 12.1 | 11.7 | 11.1 | 3 | 11.7 |
| 10 000 | 13.2 | 12.6 | 12.6 | 3 | 12.6 |
| 100 000 | 16.5 | 15.3 | 15.8 | 4 | 15.3 |

(The AVL compares once per node it visits, so its two columns are the same number.) What the
B-tree does not do is take one *dependent pointer hop* per comparison. A search visits exactly
its height — 3–4 levels at these sizes — and does a short binary search inside each node's
contiguous key block. The op-count literally cannot see that difference; node-visits can, and
are reported clock-free rather than charted, because a node-visit is a proxy for a cache miss,
not a measurement of one. **The wall-clock claim is a hypothesis, not a finding**: the gate
prints the B-tree's top-of-sweep search time against the sorted array's (and its churn against
the AVL's) without asserting either way. Three reasons to expect the gap to be small or absent
here: the search sweep tops out at 100 000 keys (≈ 800 KB of keys, near L2/L3 sizes), the churn
sweep at 4 000 (everything in L2), and the AVL's churn allocates a `Box` per pair where a settled
B-tree pair allocates nothing — so a churn gap would be confounded by the allocator. If the
lines coincide on the clock too, that is a result about this machine's memory at these sizes,
not a failure of the structure.

**Why t = 16.** A node is 31 keys = 248 bytes, about four 64-byte cache lines (its child array is
a separate 128-byte block). That is wide enough that 100 000 keys need four levels and small
enough that the in-node search stays inside one short contiguous run. The claim is *fewer
dependent hops*, not "one cache line per node" — it is not one line. (Page-sized nodes, t ≈ 256,
are the on-disk answer and irrelevant in memory.)

**Search defers the equality test.** Each node is binary-searched for the first key ≥ k using `<`
only, the candidate is remembered, and the descent always continues to a leaf; one equality test
at the end decides membership. That is what makes the comparison count ≈ log₂ n with no per-node
equality overhead, and it makes a missing key cost the same as a present one — so the shared
`max + 1 …` absent probes carry no bias for this structure (contrast the skip list, hurdle 9).

**The delete is not CLRS's, and that is a measurement decision.** CLRS's single-pass delete
pre-fills every node it enters that holds exactly t − 1 keys. Combined with the proactive split
(which leaves both halves at exactly t − 1) a churn pair can split a node on the way down and
merge it straight back on the way down again, every pair. Hand trace at t = 2: root `[20]`, left
child `[5 10 15]` (full; leaves `[1] [7] [12] [17]`), right child `[30]` (leaves `[25] [35]`).
Insert 0: the full child splits to `[5]`, `[15]` with 10 lifted (root `[10 20]`), leaf `[0 1]`.
CLRS delete 0: `[5]` has t − 1 keys and so does its sibling, so they merge back to `[5 10 15]`
and the root returns to `[20]` — the start state. On sorted input a proactive-split build leaves
the whole left spine at t − 1, so it thrashes at every level, and the churn curve would measure
node allocation and O(t) key moves rather than the descent. The bench twin therefore repairs
only **underflow** (< t − 1 keys) on the way back up — borrow from the left sibling, else from the
right, else merge (left first) — which has hysteresis: a split yields t − 1 (not underflow), a
merge at most 2t − 2 (not full). After a few warm-up pairs a churn pair splits, merges and
allocates nothing, on ascending, descending and shuffled builds at t = 2 and t = 16
(`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`, and its TS mirror).
`measure.ts` reads `opCountPerOp` after the auto-grow and timed batches, i.e. in the settled
state. A side benefit: a delete of an absent key never touches the tree
(`btree::tests::deleting_an_absent_key_changes_nothing`).

**Input order moves a constant, not the class.** Sorted input leaves each split's left half at
the minimum fill and never touches it again, so an ascending build has ~40 % more nodes (66 vs 48
at n = 1 000) and is sometimes a level deeper (4 vs 3 at n = 10 000), while a search still costs
≈ log₂ n comparisons (`methodology_btree::sorted_input_builds_half_full_nodes_without_changing_the_class`).
`shapeSensitive` stays false; the constant is stated beside the chart.

### §2.3 — the regime table gains a tenth row

| B-tree | **tight** (~2 % shuffled: churn 25.0 vs sum 24.5; ≤ 6 % on sorted/reverse) | every leaf is at one depth, so the two churn keys walk the same height as any stored key — no cheap spine — and a settled churn pair is exactly one insert descent plus one delete descent, as the build's and teardown's marginal ops are | yes, O(log n) |

…and the paragraph after the table should say "Ten regimes": the B-tree is the first *tree*
whose churn and FD sum agree tightly, because it is the first whose spines are not special.

### §5 — proof-map rows

| claim | where it is proven | clock |
|---|---|---|
| the B-tree makes about **as many comparisons** per search as the AVL and the sorted array (within ~8 %) while visiting only its **height** — a third to a quarter of the AVL's node-visits | `structures::methodology_btree::btree_matches_the_avl_on_comparisons_but_takes_a_quarter_of_the_node_visits` | none (op-counts) |
| B-tree churn ≈ its finite-difference sum (the tenth regime: tight) on shuffled, ascending and descending input | `structures::methodology_btree::btree_churn_and_finite_differences_agree_tightly` | none |
| after warm-up a B-tree churn pair performs **zero** splits/merges/borrows and allocates nothing (why CLRS's single-pass delete was replaced) | `structures::btree::tests::churn_settles_into_zero_restructures_and_zero_allocation` + `src/structures/btree.test.ts` | none |
| the B-tree keeps O(log n) on the reverse-sorted input that makes a BST an O(n) chain | `structures::methodology_btree::btree_keeps_its_class_on_the_input_that_degenerates_a_bst` | none |
| sorted input builds half-full nodes (~40 % more, sometimes one level deeper) without changing the class | `structures::methodology_btree::sorted_input_builds_half_full_nodes_without_changing_the_class` | none |
| every B-tree invariant (occupancy, one leaf depth, inclusive separators, size, no leaked node) holds after every op of random duplicate-heavy streams at t = 2, 3, 16 | `bench-engine/tests/proptest_btree.rs` | none |
| TS twin ≡ Rust twin: per-insert ops, order, per-probe counts, level-by-level shape, delete sequence and shape after, at t = 2, 3, 16 | `conformance/corpus-btree.txt` + `src/structures/conformance-btree.test.ts` | none |
| **the B-tree on the real clock:** search sub-linear and flatter than the array; churn sub-linear and near-flat; reverse-sorted churn sub-linear (**UNRUN** at handoff) | `scripts/verify-browser.mjs`, both passes | real |
| **deliberately not asserted:** any clock advantage of the B-tree over the sorted array (search) or the AVL (churn). Printed as `btree hypothesis (info only)` lines | — | — |

## 4. CLAUDE.md — Gotchas to add

- **The B-tree's delete is not CLRS's, on purpose.** Insert uses the CLRS proactive split;
  delete repairs only *underflow* (< t − 1 keys) on the way back up (borrow left, borrow right,
  merge left, merge right — in that order). CLRS's single-pass pre-fill delete thrashes: the
  split leaves halves at exactly t − 1, the pre-fill merges them straight back, and every churn
  pair splits and re-merges a node (every level, on sorted input) — the churn curve would time
  the allocator. Pinned by `btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`.
  Don't "restore the textbook" delete.
- **A B-tree search never stops early on an internal hit, and that is the cost model.** It
  binary-searches with `<` only, remembers the candidate, walks to a leaf, and does one
  deferred equality test — so comparisons ≈ log₂ n and node-visits = height exactly. The
  internal-key delete takes the predecessor from the leaf the descent already reached (no
  second search, no re-delete by value). Changing either changes the corpus.
- **The B-tree's comparison count *should* match the AVL's and the sorted array's.** Its
  advantage is pointer hops, which the op-count cannot see (node-visits are reported
  clock-free, not charted). Don't add a gate assertion that it is faster on the clock; the gate
  prints the comparison as info only (METHODOLOGY §2.10).

## 5. README status suggestion

Append to the Phase 6 sentence of the **Status** block: "…, and a **B-tree** (t = 16) on the
shared numeric charts — the AVL's comparison count in a quarter of its node hops, the first tree
whose churn agrees tightly with its finite-difference split."

## 6. UNRUN, follow-ups, and judgement calls a reviewer might disagree with

**UNRUN:** `npm run verify:browser` (forbidden on this shared machine). New checks: *B-tree
search sub-linear (< 0.4)*, *B-tree search flatter than array*, *three B-tree mutation series*,
*B-tree churn sub-linear (< 0.6)*, *B-tree churn near-flat (ratio < 6)*, *reverse-sorted B-tree
churn sub-linear (< 0.6)* — the same bands the skip list/AVL use. Plus two `info only` printed
lines (no assert). `npm run build` was not run separately (typecheck clean).

**Merge hazards (where other parallel slices will collide):**
- `scripts/verify-browser.mjs`: the search-count check is now `'seven search series measured'`
  / `proof.length === 7 && … && btreeSearch`. Any other slice adding a search series edits the
  same line. The header comment still says "six search series and seven mutation sweeps" (left
  untouched to avoid a second conflict) — now eight sweeps.
- `src/compare/runSweeps.test.ts`: exact lists — `statuses` length 7, the search structure
  order, `canonicalSearch` order, and the `Object.keys(win)` proof order (`__btreeMutationProof`
  after `__skipMutationProof`, before `__compareMeta`).
- `src/ui/CompareSection.tsx`: the "Six structures look up a key six different ways…" sentence.
- `bench-engine/src/structures/mod.rs`: `pub mod btree;` inserted after `pub mod bst;`, and two
  `#[cfg(test)]` module lines after `mod conformance;`.

**Judgement calls:**
1. **Replaced CLRS's single-pass delete** with repair-on-underflow (the brief asked for CLRS).
   Rationale and the hand trace above; the trace is design rationale, not a charted claim, so no
   second (CLRS) delete was built in the crate to demonstrate it.
2. **Deferred equality search** (no early exit on an internal hit). Makes comparisons ≈ log₂ n
   and node-visits = height; costs nothing measurable (~95 % of keys are in leaves at t = 16). It
   will look odd in the animation ("found it, keeps going") — the animation slice should say so.
3. **Cost metric counts split/merge/borrow as one op each** (like the AVL's rotations), plus the
   one median comparison after a split. Key moves are not counted (bounded block copies — the
   trie's in-node-lookup rule). A root collapse is not a separate event.
4. **Delete removes the first occurrence in sorted order**; insert places after equal keys.
5. **t = 16**, a runtime parameter in both twins (the WASM type fixes it); the corpus and
   proptests run mostly at t = 2/3 for coverage.
6. **Separate result bucket** `CompareResult.btree` (not added to `trees`), so existing BST/AVL
   consumers and tests did not change — the skip list's precedent.
7. **No search-chart AVL.** The AVL is not on the search sweep, so the "B-tree vs AVL" search
   comparison lives only in the clock-free methodology test; on the chart the B-tree's natural
   neighbour is the sorted array. Adding the AVL/BST to `runSweep` is a separate decision.
8. **Diagnostic event tallies** (`event_counts`) increment unconditionally on split/merge/borrow
   (not behind `COUNT`) — rare O(t) events, never on the settled timed path.

**Follow-ups:**
- PNG export: the B-tree caveat (op-count blind to locality) lives in `src/ui/BTreeNotes.tsx` on
  the page only; `src/ui/png.ts` carries no caption line for it. Not required by any CLAUDE.md
  rule today, but the same "the caveat must travel with the image" logic would apply.
- Animation slice: a tracer on `btree.ts` (`btree.compare` per probe, `btree.split` /
  `btree.borrow` / `btree.merge` per event) with the cost-event ≡ op-count invariant, chained to
  the corpus (which already has a per-insert column).
- If the browser run shows a clear B-tree vs sorted-array search gap, record the numbers in §2.10
  and consider a (still conservative) magnitude assertion.
