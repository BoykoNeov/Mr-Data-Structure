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
  caveat box + the O(n) delete-by-value curve beside it. `verify:browser` pins both
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
