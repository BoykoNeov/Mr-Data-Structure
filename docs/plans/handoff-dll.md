# Handoff — the doubly linked list, measured end to end (`'dll'`, METHODOLOGY §2.11)

Branch `worktree-agent-a7a676d7ab8490c75`, cut from `main` @ 7450254. Measured half only;
the animation is a later round. This file holds the doc text the integrator should paste
into the living docs (which this slice was not allowed to edit), plus everything a reviewer
should look at twice.

---

## 1. PLAN §10 — "Done" entry (append under Phase 6)

```markdown
  - **Done (the doubly linked list — a second pointer that buys nothing, measured):**
    `DoublyLinkedListF64` in Rust (`bench-engine/src/structures/doubly_linked_list.rs`), a
    structure of its own (StructureId `'dll'`, colour `#ffbb78`, the light pair of the singly
    list's orange) with **real `prev` links** in the same `Option<u32>` index arena as the singly
    list. Its TypeScript teaching twin is the existing `DoublyLinkedListF64`
    (`src/structures/linkedList.ts`, gaining `keysReversed()`), pinned by a corpus of its own,
    `conformance/corpus-dll.txt`, generated inside the Rust module. It joins the *existing*
    numeric sweeps — search (6 series → 7) and the flat mutation sweep (12 series → 15) — with no
    new `BenchEngine` method, because it does the same three operations on the same key type.

    **The finding is sameness, and it is pinned as equality, not closeness.** On insert /
    search / delete-by-key the `prev` link is only ever *written*: a delete-by-value must still
    find its node with the singly list's head-first walk, visit for visit, and the splice `prev`
    makes cheaper was never counted on either list. So every op-count signal the Compare sweeps
    read — `search_counted`, `churn_counted`, the cumulative build and the cumulative teardown —
    is **equal** to the singly list's at every swept size, on sorted and shuffled builds
    (`structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`), and
    per op over random insert/delete/search streams (`tests/proptest_doubly_linked_list.rs`,
    which uses the singly list as the op-count reference — the second, independently linked list
    the singly proptest said it could not have). The price is pinned too: **24 bytes a node
    against 16** (`node_is_half_again_the_singly_node`). `prev` pays only for unlink-given-a-
    handle, which is on the test surface (`unlink_handle_counted`, 0 visits at any position)
    precisely because the canonical op set never hands a caller a node.

    **Regime 7 again, for the singly list's reason — and the same honesty rules.** Head insert
    puts *any* churn key at the head, so a churn pair is one visit whatever the key — above the
    max, below the min, or a stored key (`no_churn_key_recovers_the_linear_delete`). The engine
    passes the singly list's `max + 1` so the two curves are one experiment. The O(n)
    delete-by-value is the finite-difference teardown, which deletes the tail **by value** from
    the head — never through the `tail` handle, which would read O(1) and erase the class
    disagreement (`teardown_counted == n(n+1)/2` is asserted, not just "≫ churn"). Every rule
    that binds the `ll` flat curve binds this one: a caveat box beside the churn chart
    (`src/ui/DoublyListNotes.tsx`), the O(n) delete row in the split, the PNG cross-check legend
    row (free, via `deleteRows(split)`) and a caption line (`dllSheetNote`), and browser-gate pins
    mirroring the `ll` block.

    The corpus carries two dimensions the singly corpus cannot: the **backward order** (tail→head
    through `prev`) before and after a delete sequence, and a **mixed insert/delete stream** with
    per-op results, where a stale `prev` on a reused arena slot would hide. No canonical op reads
    `prev` on its walk, so a list with corrupt back-links passes every search, delete and op-count
    check — the doubly list's counterpart to the skip list's mis-linked express lane. **No new
    deps.**
```

## 2. PLAN §8 table — "Linear" row change

Replace the doubly row:

```markdown
| Doubly linked list | O(1) head | O(n) | O(n) | node-visits | **Measured (Phase 6)** as its own bench twin. Every op-count equals the singly list's on the same sequence — `prev` only speeds unlinking a node you already hold, which delete-by-key never does (it must find the node first). Costs 24 B/node vs 16. Churn is the singly list's regime-7 O(1) (METHODOLOGY §2.11) |
```

And, in the headline-results paragraph at the top of PLAN, after the linked list's "two answers at
once" clause, an optional sentence:

```markdown
the **doubly linked list** beside it draws the same curves — equal op-counts, pinned — because a
second pointer helps only to unlink a node you already hold, and removing a key means finding it
first (METHODOLOGY §2.11);
```

## 3. METHODOLOGY text

### New §2.11 (number assigned to this slice; §2.8–§2.10 belong to sibling slices)

```markdown
### 2.11 A second pointer that buys nothing (the doubly linked list)

The doubly linked list is the singly list with one more link per node, pointing back. Textbooks
list "O(1) delete" among its virtues, and that is true of exactly one operation: unlinking a node
*you already hold*. The canonical op set (PLAN §4.1) deletes **by key**, so a delete must first
find its node, and finding is the singly list's head-first walk, node for node. The splice that
`prev` shortens was never counted on either list (the unlink carries no node-visit). So the
claim here is not "about the same": it is **equal**.

- Every op-count signal the sweeps read is equal to the singly list's — `search_counted`,
  `churn_counted`, cumulative build (0), cumulative teardown (Σ i = n(n+1)/2 on distinct keys) —
  at n ∈ {250, 1000, 2000, 4000} on sorted and shuffled builds
  (`structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`), and per op
  over random streams (`tests/proptest_doubly_linked_list.rs`). The singly list is the op-count
  reference here: two independently linked implementations, not a model of one.
- What `prev` *does* buy is pinned on the test surface only: `unlink_handle_counted` costs 0
  visits at every position, while deleting the same key by value costs its position on both lists
  (`doubly_linked_list::tests::unlink_given_a_handle_is_free_but_delete_by_value_still_walks`).
  No chart measures it, because nothing in this project hands a structure a node.
- What `prev` costs is pinned too: 24 bytes per node against 16
  (`node_is_half_again_the_singly_node`). Both twins use `Option<u32>` links (a 4-byte tag padded
  to 8), so the difference is exactly the pointer. A `u32::MAX` sentinel encoding would shrink the
  doubly node to 16 and pad the singly one up to 16 — the extra pointer would then cost no bytes
  at all. The 24-vs-16 figure is a statement about this encoding, which both twins share.
- On the wall clock the doubly line should differ from the singly one by a **constant, not a
  slope**. One off-browser Node probe of the release wasm (not the browser gate) read the doubly
  search ≈ 1.24× the singly search at n = 1 000, 10 000 and 100 000 alike, with identical
  op-counts. The ratio not moving across sizes that span L1 to L3 suggests the cause is not
  cache capacity; the mechanism is **not** established and nothing asserts the ratio.

**Churn: regime 7, unchanged.** Head insert fixes the churn key's position at the head whatever its
value, so every churn key — above the max, below the min, equal to a stored key — costs exactly one
visit (`no_churn_key_recovers_the_linear_delete`; the skip list's
`neither_churn_end_changes_the_reported_class` reached "both ends are honest", this reaches "no key
is"). The engine uses the singly list's `max + 1`, so the two churn curves are one experiment. The
finite-difference teardown deletes the current tail **by value** from the head. A doubly list could
unlink its tail through the `tail` handle in O(1) — and that is exactly the trap: it would make the
teardown O(1) per delete, erase the class disagreement, and chart unlink-given-a-handle under the
name "delete". Every honesty rule bound to the singly list's flat curve (caveat box, the O(n) delete
row beside it, the PNG legend row and caption line, the gate pins) is bound to this one.

**The back-link blind spot.** No canonical op reads `prev` on its walk, so a list whose back-links
are corrupt answers every membership query, every delete result and every op-count correctly — and
only misbehaves on a later splice. The corpus therefore pins the **tail→head order** before and
after the delete sequence and after a mixed insert/delete stream (where free-list reuse would expose
a stale `prev`), and the proptest checks it after every op. This is the doubly list's counterpart to
the skip list's per-level corpus dimension (§2.6).
```

### §2.3 regime table — new row (after "linked list")

```markdown
| doubly linked list | **class disagreement, identical to the singly list's** (churn 1, FD delete ≈ 3n/4 — the same numbers, op for op) | head insert puts *any* churn key at the head; the teardown deletes the tail by value, never through the tail handle | **no** — reported, not hidden |
```

(Prose below the table: "the linked list's" flat-curve paragraph can add "— and the doubly linked
list's, for the same reason (§2.11)".) The regime *count* in the surrounding prose ("nine regimes")
is a judgement call: this is regime 7 recurring, not a tenth regime. I would keep "nine" and say
the doubly list shares regime 7.

### §5 proof-map rows

```markdown
| the doubly linked list's op-counts **equal** the singly list's — search, churn, cumulative build and teardown — at every swept size, sorted and shuffled; and regime 7 holds for it (churn 1, FD delete ≈ 3n/4) | `structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set` | none (op-counts) |
| …and per op, `(result, node-visits)`, over random insert/delete/search streams, with the singly list as the reference; the tail→head walk mirrors head→tail after every op | `bench-engine/tests/proptest_doubly_linked_list.rs` | none |
| no churn key recovers the O(n) delete on a head-inserting list: above-max, below-min and stored keys all cost exactly 1 visit | `structures::doubly_linked_list::tests::no_churn_key_recovers_the_linear_delete` | none |
| what `prev` buys (unlink-given-a-handle, 0 visits at any position) vs delete-by-value (its position, same on both lists), and what it costs (24 B vs 16 B per node) | `doubly_linked_list::tests::unlink_given_a_handle_is_free_but_delete_by_value_still_walks`, `…::node_is_half_again_the_singly_node` | none |
| a corrupt back-link cannot pass conformance: the corpus pins tail→head order after deletes and after a mixed stream | `conformance/corpus-dll.txt` + `src/structures/conformance-dll.test.ts` (+ `corpus_dll_matches_committed`) | none |
| **UNRUN:** the doubly list on the real clock — search O(n) band, churn flat (`\|slope\| < 0.6`), delete-by-value O(n) (slope > 0.6, ratio > 3), the two in different classes, gap > 20×; deliberately **no** dll-vs-ll wall-clock ratio | `scripts/verify-browser.mjs` (first pass) | real |
```

## 4. CLAUDE.md gotchas (suggested)

```markdown
- **The doubly linked list's teardown deletes the tail *by value*, never through the tail
  handle.** A doubly list *can* unlink its tail in O(1) — and that is the trap: the
  finite-difference delete would read O(1), the regime-7 class disagreement would vanish, and the
  chart would be timing unlink-given-a-handle, an op the canonical set never offers. Pinned by
  `teardown_counted == n(n+1)/2` in `structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`.
  Its churn is flat for the singly list's reason (head insert puts *any* key at the head —
  `no_churn_key_recovers_the_linear_delete`), so every rule that binds the `ll` flat curve binds
  `'dll'` too: caveat box (`src/ui/DoublyListNotes.tsx`), delete row, PNG caption
  (`dllSheetNote`), gate pins.
- **The doubly list's op-counts are *equal* to the singly list's, and that is the finding.** Don't
  "optimise" its delete or search to use `prev`, or let the two counts drift — the methodology test
  and the proptest compare them for equality, not closeness. Its wall-clock line may sit a constant
  factor above the singly one (24-byte nodes); never assert a ratio between them on the clock.
- **No canonical op reads `prev`, so a corrupt back-link is invisible to search/delete/op-counts.**
  The tail→head walk (`keys_in_reverse` / `keysReversed`, the corpus `*_rev*` lines) is the only
  thing that catches it — keep it in the corpus and the proptest.
```

## 5. README status — suggestion

In the Status paragraph, after the linked-list caveat clause:

> …and the **doubly linked list** sits beside it drawing the same curves — the same steps, counted
> exactly, because a back pointer only helps remove a node you already hold, and removing a key
> means finding it first — while each of its nodes takes half again the memory.

## 6. Unrun, follow-ups, and judgement calls

### UNRUN

- **`scripts/verify-browser.mjs` — none of the new/changed checks have run.** (Not allowed on this
  shared machine: port 4173 is hard-wired and the gate times real work.) Changed:
  - `'six search series measured'` → `'seven search series measured'` (`proof.length === 7`, adds
    `dllSearch`). **Merge hotspot**: every slice adding a search series bumps this number.
  - `'twelve mutation series measured (four flat structures)'` → `'fifteen … (five flat
    structures)'` (`mutation.length === 15`). **Merge hotspot** likewise.
  - New: dll search labelled O(n), slope 0.7..1.4, ratio > 20 (the `ll` bands verbatim).
  - New: dll churn `|slope| < 0.6`; dll delete slope > 0.6 and ratio > 3; class disagreement; delete
    vs churn gap > 20× (the `ll` block verbatim, thresholds unchanged).
  - Expected risk: dll churn will sit on the timer floor like `ll`'s (two-sided band chosen for
    that). The dll *search* label could in principle wobble like any O(n) fit; `ll`'s has held.
- The **mutation sweep now does one more O(n²) teardown** per run (the dll's), so the first gate
  pass takes a little longer; `waitForFunction`'s 90 s timeout was not re-tuned.
- The UI copy (`DllSearchNote`, `DllChurnCaveat`) has only been rendered in a unit test, never
  seen on the page.

### Gates run here

- `cargo test` (crate): 228 passed, 0 failed, 10 ignored — lib 206 passed / 10 ignored (this slice
  adds 14 in `doubly_linked_list::tests` + 1 ignored regen, and 1 in `methodology`), the new
  `proptest_doubly_linked_list` 3 passed, every other integration file unchanged and green.
- `npm run typecheck`: clean. `npx vitest run`: full suite green (53 files, 820 tests).
- `vite build` (into a temp dir): clean.
- Priority: the prescribed `cmd //v:on //c "start /belownormal …"` wrapper was **refused by this
  worktree's isolation guard** (it rejects any `cmd` invocation). Every build/test instead ran from
  a PowerShell process that first set **its own PID's** priority to BelowNormal; children inherit
  the priority class, so cargo/rustc/node workers ran below normal from the start.

### Judgement calls a reviewer might disagree with

1. **A separate bench struct at all.** `linked_list.rs` previously argued a second struct would be
   "pure duplication" since the counts are identical. The task asked for it; the justification is
   that equality becomes a *pinned measurement* and a visible chart line instead of a comment. I
   rewrote that module doc and the matching comments in `conformance.rs` / `conformance-ll.test.ts`
   so they no longer contradict the code.
2. **TS teaching twin = the existing array-backed `DoublyLinkedListF64`**, plus `keysReversed()`.
   It does not hold real `prev` links, so on the TS side the backward-order corpus lines pin
   agreement, not link integrity (stated in its JSDoc). Link integrity is tested for real only in
   Rust (unit + proptest + the corpus generator walking `prev`). Rewriting the twin node-based would
   have touched the viz's event contract; **follow-up for the animation round**: give the doubly
   twin real `prev` links so the drawn back-arrows come from state and the `*_rev` lines bite on
   both sides.
3. **Corpus generator lives in `doubly_linked_list.rs`**, not appended to the shared
   `conformance.rs` — to keep the shared file's diff to a comment. Same `regen_corpus_*` /
   `corpus_*_matches_committed` convention; the integrator may prefer to move it.
4. **Churn key `max + 1`** (`aboveMax`), the singly list's — for comparability; no key is "right"
   because none recovers O(n) (pinned).
5. **No reverse-sorted-pass gate checks** for the dll — like `ll` it is shape-insensitive, and the
   second pass does not reset `__mutationProof` (the existing comment's warning).
6. **`Option<u32>` links (24 B nodes) instead of a sentinel (16 B)** — chosen so the two twins
   differ by exactly the pointer. The honest caveat (a sentinel encoding would make the pointer
   free in bytes) is in the test doc and in the §2.11 text above.
7. **The 1.24× wall-clock figure** comes from an off-browser Node probe of the release wasm, run
   once on a shared machine, not from the gate. It appears only in a code comment in
   `engine.worker.ts` and in the suggested §2.11 text, labelled as such; the UI copy says only
   "a constant factor, not a different growth rate". Its mechanism is unexplained (constant across
   L1→L3 sizes, so probably not cache capacity).
8. **`runSweeps.ts` status string** changed from "…linked list)…" to "…linked lists)…" and the
   `CompareResult.mutation` doc updated (four → five flat structures, twelve → fifteen series) —
   small edits in a hotspot file, made because leaving them would have been a stale claim.
9. **The search-section intro** ("Five structures look up a key five different ways") was left
   alone — still literally true, since the dll is not a sixth *way*; the `DllSearchNote` callout
   under the chart says so. The singly caveat's title ("The flat orange line is a trap") was also
   left alone; the dll caveat directly below it names the light-orange line.
10. **Not done:** `mod.rs`'s module doc (Phase 4 paragraph) still describes `LinkedListF64` as the
    twin of both TS lists — historical, in a hotspot file; one sentence could be added there.
