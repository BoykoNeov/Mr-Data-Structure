# Mr Data Structure — project guide for Claude

Project-specific working notes. Setup, full command list, and repo layout live
in [`README.md`](README.md); the design and phased roadmap live in
[`docs/PLAN.md`](docs/PLAN.md). This file holds only what's specific to working
in this repo — things that aren't obvious from the README or that have tripped
up past sessions.

## Gates — run before committing or claiming "done"

```sh
npm run typecheck        # tsc --noEmit (strict; no unused locals/params)
npm test                 # Vitest unit tests
npm run verify           # everything CI runs (wasm + rust + typecheck + build + vitest)
npm run verify:browser   # headless-Chromium runtime check (needs preview server up)
```

`npm run build` only proves the bundle compiles. To prove the worker→WASM→Comlink
path resolves at *runtime*, start `npm run preview` and run `verify:browser`
**in the same shell invocation** — a background preview server started in one
tool call does not survive into the next (each call is a fresh process).

## Repo etiquette

- Commit **and push** each completed, gate-green work batch (standing user
  instruction). Commits land directly on `main`, matching this repo's
  phase-on-main history.
- Run typecheck + tests before every commit. CI also runs `npm run verify` on
  push as the backstop.
- Commit subjects follow the existing style: `Phase N: <slice>` for phase work,
  Conventional-Commits prefixes (`chore(ci):`, `fix:`) otherwise.
- Keep the living docs current: when a phase lands, update the **Status** block
  in `README.md` and `docs/PLAN.md` (§ top + §10) in the same batch.

## Conventions

- Strict TS throughout; prefer fixing types over `any` or casts.
- Tests are co-located as `*.test.ts` next to the module.
- JSDoc on public surfaces cites the relevant `docs/PLAN.md §` section.
- Import sibling modules without the `.ts` extension (e.g. `from './dataset'`).
- Add dependencies sparingly — the data layer and engine are intentionally
  dependency-free. Justify any new dep.

## Gotchas (learned the hard way)

- **Keys are identity.** Keep numeric detection conservative — a cell is numeric
  only when `String(Number(s)) === s.trim()`, so leading-zero codes (`02134`)
  and ids past 2^53 stay strings. **Preserve every key, including duplicates —
  never dedupe** (it would corrupt benchmark inputs).
- **Shell is PowerShell** on this Windows box; a Bash tool is also available for
  POSIX scripts. They take different syntax.
- **Run `verify:browser` on a quiet machine — don't race it against `npm test`.** It
  times real work, and its noise-sensitive checks (the heap's extract-min-vs-insert
  cost ratio above all, a finite-difference figure the gate's own comments call
  mostly noise) will flake under CPU contention: one run against a concurrent Vitest
  suite reported 1.2× against a > 1.3× band, and 2.1× on its own moments later. A
  single failing ratio check with everything else green is a scheduling artefact, not
  a regression — re-run it alone before chasing it. **Class-label checks are the other
  flaky kind**: after the Phase 6 merge, two runs each failed one label (string
  array O(n²) at slope 1.04, string hash set O(log n) at 0.07) with its slope band green;
  the third passed 118/118. A new check should assert a band, not a label.
- **Contention is not the only way the gate flakes — check for a stale preview server
  first.** `scripts/verify-browser.mjs` hard-codes `http://localhost:4173`, so the gate
  measures whatever answers on that port, not necessarily the server it just started.
  Before `preview.strictPort` was set (`vite.config.ts`), a preview whose port was taken
  fell forward to 4174, 4175, … and printed the new port while the gate went on reading
  4173 — silently benchmarking *another session's* server. On 2026-09-06 that produced 24
  orphaned previews on one dev box holding 4173–4196, because a backgrounded
  `npm run preview` is **two** processes and killing the npm wrapper leaves the vite child
  alive (`.github/workflows/ci.yml` still does this). strictPort now turns the collision
  into a hard `Port 4173 is already in use` — if you see that, hunt the leftover server
  rather than switching ports. Kill it by the PID you started, never by image name.
- `verify:browser` needs Playwright's pinned Chromium; in a sandbox with a
  pre-installed one, set `VERIFY_CHROMIUM=/path/to/chrome`.
- The Compare default auto-run (what the browser gate measures first) is **one
  uniform dataset for every structure**. Don't switch it to `sorted` — the gate
  asserts sub-linear BST churn, which only holds on shuffled input. The gate then
  drives the picker to **reverse-sorted** for a second pass and asserts the
  opposite there (BST churn O(n), AVL still sub-linear) — the regression guard for
  the two-key churn probe, METHODOLOGY §4.1. A **third pass** then drives it to
  `string-corpus`. That one runs **after both numeric passes** on purpose and reads only
  `__stringSweepProof` / `__stringMutationProof`: a string run never sets the numeric
  globals, so a numeric assert placed after it would silently re-read the reverse-sorted
  pass. A **fourth pass**, the graph, clicks `measure the graph` (the graph section never
  runs on page load; the button's name must not match `/run the sweeps/`) and reads only
  `__graphProof`. Keep all four passes, in that order. Every pass also relies on the gate's
  **fresh, empty browser context** — see the session-persistence gotcha below.
- **The min-heap is deliberately kept off the shared Compare charts** (PLAN §8,
  risk R6): its op set is insert / peek / extract-min, not insert / search /
  delete, so `registry.ts` exposes `CANONICAL_STRUCTURES` / `isCanonical` and the
  UI filters through them. Its search *is* measured on the same ladder — that is
  what makes the O(n)-scan contrast against the array meaningful — but it renders
  only in the heap's own section. Don't "tidy" it back onto the shared charts.
- **Each flat structure's churn key is a measurement decision, not a default.**
  `runMutationSweep` names one per structure: array and hash set `aboveMax`; the
  **sorted array `belowMin`** (a tail key appends/pops with no shifts and would
  report O(log n) mutation for an honestly O(n) structure); the **linked list
  `aboveMax`**, whose head insert makes churn honestly O(1). That flat list curve
  is a *finding* (METHODOLOGY §2.3 regime 7), not a bug and not a fast structure —
  don't "fix" it with a different key (none exists), and don't ship it without the
  caveat box + the O(n) delete-by-value curve beside it. **That rule binds every way
  the curve leaves the page**, not just the screen: the PNG sheet (`ui/png.ts`) carries
  the delete-by-value figure as a cross-check legend row and the caveat as a caption
  line, because prose in the DOM does not travel with an exported image — and an image
  is the form most likely to be read with no page attached. `verify:browser` pins both
  halves.
- **A string probe/churn key is derived from the data, never invented.** There is no
  `max + 1` for strings, and the tempting substitute — a key longer than every stored
  key, absent by construction — biases the two string structures in *opposite*
  directions: Rust compares string slices length-first, so a uniquely long key bails out
  of every array comparison on the length check (understating the per-byte scan) while
  making the hash set's pass read more bytes than a real key would (overstating its
  constant). `absentLike` (`src/bench/engine.worker.ts`) therefore takes a stored key and
  changes its last character, checked absent against a `Set` of the decoded prefix. The
  long-key form is the documented fallback only. Related: `prefixOf` exists because
  wasm-bindgen copies the slice it is handed on **every** call — hand a timed static call
  the whole corpus and the copy, not the structure, sets the curve.
- **The trie's probe and churn keys are the *shared* string ones, and that is a
  decision.** All three string structures get one probe set (`buildStringProbes`), which
  for a trie is its **deepest** absent case: the workload's absent key is a stored key
  with its last character changed, so the walk descends the whole key before failing,
  where an unrelated string would fall off at the first byte. Don't "improve" the trie's
  number by giving it its own probes — a chart where each line gets a workload tuned to
  suit it stops being a comparison. The height is labelled a pessimistic constant beside
  the chart instead. Same key for churn, and there it also decides *what is measured*:
  sharing all but its last byte with a stored key, one insert+delete pair allocates and
  prunes exactly one node (the O(L) walk); a prefix-free key would build a whole L-node
  branch per pair and measure the allocator. Pinned by
  `trie::tests::a_prefix_free_churn_key_allocates_a_whole_branch` — the trie's counterpart
  to the heap's drain test — and its TS mirror.
- **The trie's search is labelled O(log n) as often as O(1), and that is memory, not
  work.** The char-step count is provably identical across the sweep
  (`trie::tests::cost_is_flat_in_the_number_of_keys`); the wall clock drifts up ~3.8× over
  a 20× ladder because a lookup is one dependent pointer hop per key byte and a 20 k-key
  trie outgrows the caches a 1 k-key one sits in. Assert the slope band and the rise, never
  the label — the same call already made for the sorted array's and the string array's
  searches. Don't add a tighter band to "prove it isn't logarithmic": a log-log slope is
  not comparable across two different size ladders, and the clock-free op-count test is
  the separation that actually holds.
- **The trie's animation draws one node per UTF-8 *byte*, and a prefix search that
  walks the full depth and reports "not found" is correct.** Both are the structure,
  not the drawing: `café` is five levels because the twins walk `key.as_bytes()`, so
  the `é` is two nodes labelled `C3` / `A9` (any non-printable byte is labelled in
  hex) — collapsing them to one `é` node would animate a structure the benchmark
  does not measure. And reaching a node is *not* finding a key: only the terminal ring
  says a key ends there, so `search("car")` on a trie holding `cart` costs the full
  `1 + L` char-steps and still misses. The seed
  (`car`/`cart`/`cat`/`café`/`dog`, `VizPanel.tsx`) is chosen to put both facts on
  screen, and `TriePanel`'s summary line names the prefix case when it happens. Don't
  "fix" either one. Pinned by `src/viz/trace.trie.test.ts` (which runs the *Rust
  corpus's* keys and probes, so the animation's counts are chained to the bench twin)
  and the multi-byte label assertion in `views.render.test.ts`.

- **The skip list's node heights come from the key's hash, and that is not a
  simplification of the textbook — it is load-bearing.**
  `height(key) = 1 + min(23, trailing_zeros(splitmix64(to_bits(key) ^ SALT)))` is
  geometric with p = ½ like the coin it replaces, but it makes the list a *pure function
  of its key set*. Swap in an RNG and three things break at once: the counted path does
  real inserts, so heights (and therefore the op-count signal) would start depending on
  how `measure.ts` happened to interleave timed and counted batches; the TS twin could no
  longer reproduce `conformance/corpus-skip.txt`; and the teaching twin could only insert
  keys the corpus already recorded, which kills the animation slice. The **salt** matters
  too — `splitmix64(0) == 0`, so without it the key `0` gets a 24-level tower and doubles
  the constant on every descent in any dataset containing zero. Pinned by
  `skip_list::tests::height_anchors_are_pinned` and its TS mirror; the honest caveat (the
  guarantee is now over the key *distribution*, not a coin) is METHODOLOGY §2.6 and
  hurdle 12. Related: the skip-list corpus pins the **keys visible at each level**, not
  just the order — level 0 alone is a sorted linked list, so a mis-linked express lane
  answers every membership query correctly while being O(n).
- **The skip list's animation compares the level-0 candidate node *twice*, and that is
  honest, not a double-count.** The descent's level-0 step asks `node < key?` (→ drop),
  then the membership check asks `node = key?` on the **same** node — two real node-visits,
  both `skip.inspect` cost events, both counted by the Rust twin. So a hit costs one more
  than the descent alone; do not "dedupe" it (`countCostEvents === ops` would then break
  against `corpus-skip.txt`). The view shows the pair as a *stand-point* highlight (where
  the walk drops a level) plus a separately-tinted *compared* node — two things at once,
  the reason `SkipEvent`s carry both `at` and `index`. Two more skip-viz rules that look
  like bugs and are not: **`skip.enter` is not a cost event** (unlike the trie's root — the
  skip list's op-count starts at the first node inspected, and an empty list's search is
  `topLevel: -1`, zero inspects, `ops: 0`); and the display model **derives the express
  lanes from height + order, storing no per-level links** (`skipLevelKeys`), which is
  faithful only because the teaching twin always builds a correct list — `model.test.ts`
  pins it equal to `SkipListF64.levelKeys()`, and *that* equality is what ties the drawing
  to the express-lane dimension the corpus guards. Pinned in `src/viz/trace.skip.test.ts`
  (cost-events, chained to Rust for search/delete) and `src/viz/model.test.ts` (fold ⇒
  lanes). The seed is chosen by *computing* the hash-derived heights, never hand-guessed.
- **The heap's churn key must stay `min − 1`** (`belowMin`). A heap has no
  delete-by-value, so the pair is insert + extract-min, and only a key below every
  stored key is the one the extract takes back; `max + 1` silently *drains* the
  heap. Pinned by `heap::tests::a_high_churn_key_would_drain_the_heap`.
- **The doubly linked list's teardown deletes the tail *by value*, never through the
  tail handle**, and its op-counts are **equal** to the singly list's — that equality is
  the finding (METHODOLOGY §2.11). Unlinking via `tail` would read O(1), erase regime 7's
  class disagreement and chart unlink-given-a-handle as "delete"; making search or delete
  use `prev` would break the equality the methodology test and proptest assert. Its flat
  churn takes every `ll` honesty rule (caveat box `DoublyListNotes.tsx`, delete row, PNG
  caption `dllSheetNote`, gate pins). No canonical op reads `prev`, so only the tail→head
  corpus lines catch a corrupt back-link — keep them. Never assert a dll-vs-ll clock ratio.
  The **TS twin holds real links** (an arena like Rust's), so those lines bite on both sides;
  don't fold it back into the array-backed singly class. Its animation's pointer writes
  (`dll.relink`, 3 per insert, 2 per hit delete) are **steps, never cost events** — adding one
  to `COST_EVENT_KINDS` would break the visit equality. `DoublyListView` draws the links its
  model *stores* (the bypassed node mid-delete is the whole picture), so don't switch it to
  order-derived arrows like the singly view; events name nodes by display position.
- **The red-black tree's metric is the AVL's on purpose: comparisons + rotations.**
  Recolours are counted on their own counter (a write that *changes* a colour) and never
  folded into `ops` — the AVL has no colour to pay for. "Fewer rotations" is a
  **per-operation bound** (≤ 2 / ≤ 3), not a lower total, and on sorted input its churn
  sits *above* the AVL's — the finding, so add no "red-black below AVL" gate check. The
  AVL is a `Box` tree and the red-black tree an arena, so their wall-clock gap mixes scheme
  with storage; keep every comparative sentence qualified by signal. The NIL sentinel (slot
  0) is never written — don't restore CLRS's `nil.p` trick.
- **The red-black animation: recolours are steps, never cost events, and fill is colour.**
  `rbt.recolour` is emitted exactly where the twin's *separate* recolour counter ticks; adding
  it to `COST_EVENT_KINDS` breaks the corpus chain in `trace.rbt.test.ts`. `RbtView` highlights
  with **rings** only — a highlight fill would hide the node's colour on the very frame it is
  compared or repainted. Paths are recomputed from parent links at each event (a rotation
  moves nodes), and the delete's double black on an empty child is addressed by parent path
  + side (`nil: true`) and drawn as a NIL box. No caption, intro or test may claim the tree
  rotates less than the AVL (`VizPanel.test.ts` greps for it); the intro's 3, 5, 5 / 10
  recolours figures are computed from both twins and pinned.
- **The B-tree's delete is not CLRS's, on purpose.** Insert keeps the CLRS proactive split;
  delete repairs only *underflow* on the way back up. CLRS's single-pass pre-fill delete
  re-merges what the split just made, on every churn pair (every level on sorted input), so
  the churn curve would time the allocator (`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`).
  Its search never stops early on an internal hit — one deferred equality test at the leaf
  is what makes comparisons ≈ log₂ n and node-visits = height. Its comparison count
  *should* match the AVL's; its advantage is hops, which the op-count cannot see — the gate
  only *logs* the clock comparison (`btree hypothesis (info only)`); don't turn it into an
  assertion.
- **The B-tree animation runs at t = 3, and its hop tally is deliberately outside the count.**
  The Explore tab's nodes hold at most 5 keys so the tree fits; the benchmark's hold 31 — say so
  wherever a number is quoted, and never quote "a quarter of the AVL's hops" (that is t = 16).
  Nodes visited ride on `btree.result` and the footer, never in `COST_EVENT_KINDS`. Free steps,
  as the twins count them: `btree.descend`, key placement / the predecessor swap, `growRoot`,
  `collapseRoot`. A **root split has no `btree.medianCompare`** (the next probe in the new root
  makes that choice) — emitting one double-counts. `trace.btree.test.ts` holds two invariants:
  cost events == `ops`, and structural events by kind == the `eventCounts()` deltas.
- **The open-addressing set's tombstone policy is a measurement decision** (METHODOLOGY
  §2.8), all four rules mirrored in the TS twin and `corpus-hoa.txt`: insert reuses the
  first tombstone on its path; tombstones count toward the load; `set_churn_key` primes to
  a fixed point; churn cycles a `clamp(⌊len/32⌋, 1, 16)`-key block from `max + 1`. Drop
  reuse and churn drifts with the batcher's rep count (and reads as growth in n); stop
  counting tombstones and a miss can loop forever. It must also keep the **chaining set's
  hash, start size, 0.75 threshold and doubling** (`grows_at_exactly_the_chaining_sets_points`)
  — tuning it to 0.5 ends the comparison — and count on the chaining convention (the empty
  slot ending a walk is free), not Knuth's. A finite difference across a table doubling reads
  a *negative* marginal delete; difference between equal load factors.
- **The open-addressing animation draws two steps it does not count, on purpose.** The empty
  slot that ends a walk is its own frame (`hoa.stop`) and is **free** — the chaining set's "end
  of the chain"; and a rebuild's re-placement walks are drawn (`hoa.rehash` moves) but
  uncounted, because `insert` has returned its `ops` before `rehash()` runs. Adding either to
  `COST_EVENT_KINDS` breaks the corpus chain in `trace.hoa.test.ts`. A **tombstone is never
  drawn as empty** (the model keeps `'tomb'` distinct from `null`) — a walk does not stop there,
  which is the whole lesson. The seed is the chaining tab's on purpose (same 8 slots, same
  rehash point); its teaching numbers (55 → 4 vs chaining's 1, `search(60)` = 5 before and after
  `delete(40)`) are computed and pinned, so changing a key changes the intro's claims.
- **The graph's x-axis is the reached component's `V′ + 2E′`, computed by the page and
  *checked* against the engine** (`countsMatchComponent`). Using the op-count as x makes the
  check a tautology; using nominal `V + E` plots a 3-vertex walk of a disconnected file at
  the whole file's size. The degree-sweep's graphs are **nested** (one seed draws the tree,
  then the extras, in order) — reseeding per degree keeps every test passing while making
  each point a different graph. `REGISTRY[id]` for an arbitrary id is a union with
  `GraphStructureInfo`: narrow the graph away before reading `average` / `worst`. Every
  graph handed to `runGraphSweep` must own its buffer (one buffer twice in a transfer list is
  a `DataCloneError`).
- **The graph animation's `graph.mark` is its own frame, and that is the point.** DFS is
  mark-on-push: a vertex is marked (on the stack) long before it is visited, and a later
  edge to it is skipped — the real rule, not recursive DFS. Don't fold the mark into the
  examine or caption a marked-only skip "already visited" (`VizPanel.test.ts` pins the
  wording). Entries are addressed `(from, slot)` through `GraphModel.incident`, never by
  vertex pair (parallel edges collide). The seed is computed: changing an edge changes four
  pinned facts in `trace.graph.test.ts`.
- **The probe mix's default is a calibrated workload, not a starting value.** At 50 % the
  builders must return *exactly* the 64 + 64 keys the gate's bands were tuned on —
  `probeMix.test.ts` pins it against **frozen copies** of the old builders; don't "simplify"
  those to import the new code. `mix` is a **required** argument of every search runner
  factory so a new structure without it fails to compile. The control is radio buttons
  *after* the dataset panel because the gate drives the generator with
  `page.locator('select').first()`.
- **`n` on every chart is input keys; `storedN` is what the structure holds**, read back from
  its own `len()` — so every bench twin must keep exporting `len()`. The hash set holding
  ~63 % of its input on the *default* page is a finding (draws with replacement), not a bug.
- **A saved session changes what the mount-time auto-run measures; the gate stays valid only
  because its context starts empty.** `verify-browser.mjs` navigates once in a fresh
  Playwright context. A `page.reload()`, a second `goto` or a persistent profile would
  auto-run whatever pass 2–3 saved and silently measure the wrong thing — clear storage
  first. On a dev box an odd first run after reload is probably your saved session (press
  *forget saved session*). Persistence never saves results, and stores the paste **raw**
  (re-parsing the exact text is what keeps keys exact).
- **Parallel slices that bump a shared count merge *silently* to the wrong number** when
  both make the identical edit: 6 → 7 on two branches merges cleanly as 7, not 8. The gate's
  series counts (`proof.length`, `mutation.length`), `runSweeps.test.ts`'s status count and
  key-order lists, and prose like "six flat structures" or "twelve regimes" are all such
  sums. After merging slices, grep for the counts and recount them from the code. (In the
  Phase 6 batch the red-black and B-tree slices both made the identical `statuses` 6 → 7
  edit, so both parents of merge `166543b` read 7 and the 8 had to be put in by hand; and
  three slices each named their regime "the tenth".)
- **An agent worktree's `node_modules` is a junction into the main checkout's.** Remove it
  with `rmdir` (not a recursive delete) before removing the worktree, or the delete follows
  the junction and empties the main checkout's `node_modules`.
- `dist/` and `bench-engine/pkg/` are gitignored build artifacts (CI rebuilds
  them) — leave them untracked.

## Architecture map

- `bench-engine/` — Rust crate → WASM, the "production" benchmark impls; its
  `structures/mod.rs` `mod methodology` pins the churn-vs-finite-difference regimes
  clock-free (twelve; the B-tree's in `structures/methodology_btree.rs`).
- `src/bench/` — `BenchEngine` interface, Comlink Web Worker, WASM-backed engine;
  `measure.ts` (batching, adaptive reps, spread), `fit.ts` (classes, slope ± SE,
  local slopes, trend), `sweep.ts`; `probeMix.ts` (the hits/misses workload builders),
  `stringWorkload.ts`, `graphBench.ts` (the worker-side graph measure loop).
- `src/compare/` — Compare orchestration (`runSweeps.ts`): one dataset → every
  sweep → fits → the `window.__*Proof` mirrors the browser gate reads; `runGraphSweeps.ts`
  for the graph's V- and degree-sweeps (`window.__graphProof`). Tested against a fake
  engine.
- `src/registry.ts` — the structure registry: labels, colours, cost metric,
  theoretical (average/worst) classes; the only source of "theory" in the UI. The
  graph has its own `GraphStructureInfo` shape.
- `src/data/` — Phase 1 data layer: import (CSV/JSON), conservative type
  detection, KV key-field picker, seeded generators, typed-array marshalling;
  `graphs.ts` (seeded graph generators) and `edgeList.ts` (edge-list import).
- `src/persist/` — local session persistence: storage adapters (`localStorage` /
  IndexedDB, never throwing), the versioned session record, Compare's hook, and
  `SessionNote` (the forget button).
- `src/structures/` — the TypeScript teaching twins; `src/viz/` — step-event model,
  Player, SVG views (one per Explore tab), `VizPanel`.
- `src/ui/` — `CompareSection`, `DatasetPicker`, `ProbeMixControl`, `SweepChart` (error
  bars + theory overlay, stored-size note), `SlopeChart`, `export.ts`, `png.ts`, `Explain`
  (honesty copy), per-structure notes (`DoublyListNotes`, `BTreeNotes`), and the graph's
  own `GraphCompareSection` / `GraphChart` / `graphPicker`.
- `src/App.tsx` — layout only.
- `docs/METHODOLOGY.md` — the measurement science, its open hurdles, and the
  proof map. Update it whenever a measurement claim or a gate changes.
