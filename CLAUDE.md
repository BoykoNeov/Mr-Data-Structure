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
  a regression — re-run it alone before chasing it.
- `verify:browser` needs Playwright's pinned Chromium; in a sandbox with a
  pre-installed one, set `VERIFY_CHROMIUM=/path/to/chrome`.
- The Compare default auto-run (what the browser gate measures first) is **one
  uniform dataset for every structure**. Don't switch it to `sorted` — the gate
  asserts sub-linear BST churn, which only holds on shuffled input. The gate then
  drives the picker to **reverse-sorted** for a second pass and asserts the
  opposite there (BST churn O(n), AVL still sub-linear) — the regression guard for
  the two-key churn probe, METHODOLOGY §4.1. A **third pass** then drives it to
  `string-corpus`. That one runs **last** on purpose and reads only
  `__stringSweepProof` / `__stringMutationProof`: a string run never sets the numeric
  globals, so an assert placed after it would silently re-read the reverse-sorted pass.
  Keep all three passes, in that order.
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
- **The heap's churn key must stay `min − 1`** (`belowMin`). A heap has no
  delete-by-value, so the pair is insert + extract-min, and only a key below every
  stored key is the one the extract takes back; `max + 1` silently *drains* the
  heap. Pinned by `heap::tests::a_high_churn_key_would_drain_the_heap`.
- `dist/` and `bench-engine/pkg/` are gitignored build artifacts (CI rebuilds
  them) — leave them untracked.

## Architecture map

- `bench-engine/` — Rust crate → WASM, the "production" benchmark impls; its
  `structures/mod.rs` `mod methodology` pins the eight churn-vs-finite-difference
  regimes clock-free.
- `src/bench/` — `BenchEngine` interface, Comlink Web Worker, WASM-backed engine;
  `measure.ts` (batching, adaptive reps, spread), `fit.ts` (classes, slope ± SE,
  local slopes, trend), `sweep.ts`.
- `src/compare/` — Compare orchestration (`runSweeps.ts`): one dataset → every
  sweep → fits → the `window.__*Proof` mirrors the browser gate reads. Tested
  against a fake engine.
- `src/registry.ts` — the structure registry: labels, colours, cost metric,
  theoretical (average/worst) classes; the only source of "theory" in the UI.
- `src/data/` — Phase 1 data layer: import (CSV/JSON), conservative type
  detection, KV key-field picker, seeded generators, typed-array marshalling.
- `src/ui/` — `CompareSection`, `DatasetPicker`, `SweepChart` (error bars +
  theory overlay), `SlopeChart`, `export.ts`, `Explain` (honesty copy).
- `src/App.tsx` — layout only.
- `docs/METHODOLOGY.md` — the measurement science, its open hurdles, and the
  proof map. Update it whenever a measurement claim or a gate changes.
