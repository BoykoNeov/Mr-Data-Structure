# Phase 2 — Thin slice (the de-risker)

## Context

Phases 0 (WASM round-trip + `BenchEngine` interface) and 1 (data layer:
import, type detection, generators, marshalling) are complete and on `main`,
tree clean. Phase 2 (`docs/PLAN.md §10`) is the deliberate **thin vertical
slice** that de-risks the whole pipeline before breadth: take **two
contrasting structures — unsorted dynamic array + hash set (separate
chaining)** all the way through *both* impls (Rust bench + TS teaching), the
**measurement methodology of §6.3**, a complexity-class fitter (§7.2), and one
comparison chart.

**Concrete success criterion (§10):** on a size sweep, the chart shows
**array-search rising linearly and hashset-search staying flat**, and the
fitter labels them **O(n) / O(1)** with good R². **Phase 2 exit also requires
(§12)** the churn-vs-finite-difference *methodology self-test* to agree on
known structures — so a clean search chart is the headline, **not** the whole
phase.

The riskiest unknown is **R2**: can the measurement methodology produce clean
O(n) vs O(1) curves through the browser clock at all? So the slicing drives one
path (Rust) for **search only** to a real measured curve *first*, before
breadth (dual-impl conformance, insert/delete churn).

## Key design decisions

- **Timing boundary = one bulk WASM call, timed in the worker.** §6.2 wants the
  timed region to hold many ops (elapsed ≫ clock clamp) and to avoid per-op
  boundary crossings. WASM exposes *bulk* primitives (e.g. "build to n, then run
  k searches, return op-count"); the worker times a single such call with
  `performance.now()`. This satisfies R2 without adding a Rust clock dep
  (`web-sys`/`js-sys`) — the underlying browser clock is the same wherever it's
  read.
- **Orchestration is pure, testable TS.** Sweep sizing, batch auto-grow (until
  elapsed ≫ clamp), warm-up, reps, and variance live in a new
  `src/bench/measure.ts`, parameterized by an injected *op-runner* callback. The
  worker drives it with the real WASM primitives; Vitest drives it with
  deterministic stub runners (known cost shapes).
- **Verification split** (forced by: `web`-target WASM runs only in a
  browser/Worker, never in Vitest/Node — confirmed, no WASM-in-Vitest
  precedent):
  - *Deterministic logic* (sweep math, auto-grow/reps/variance, fitter,
    op-count assertions, TS teaching impls) → **Vitest**.
  - *Rust impl correctness* → **`cargo test` + `proptest`** vs a reference
    (`Vec` / `std::collections`).
  - *Real wall-clock shape (R2)* → **`verify:browser`** extended to run the
    sweep in the built app and assert array-rises / hashset-flat. This is the
    faithful home for R2 (real browser clock).
  - *Cross-language conformance (R1)* → a **shared op-sequence corpus with a
    single expected op-count table**; both `cargo test` (Rust) and Vitest (TS)
    assert against the *same* hardcoded expected numbers, so the two impls are
    pinned to each other without a live bridge. Counting semantics
    ("comparison" / "chain-step" / "shift" / "probe") are defined **once** and
    mirrored bit-for-bit.
- **`uPlot`** is the chart lib (pre-specified in §7.1) — justified new
  `dependency`. Only added in Batch 3.
- **`BenchEngine.ts`'s "sweep API lands in Phase 4" comment is stale** — §6.3
  line 241 ("implemented and validated *first*"), §10, and §12 all place the
  methodology in Phase 2. Update that comment when `runSweep` is added.

## Batches (each gate-green, committed + pushed on `main`)

> Order front-loads R2. Batches 1–3 = the visible headline slice; 4–5 finish
> the phase's exit criteria. Commit at every green boundary (standing user
> instruction).
>
> **This round (user-confirmed scope): Batches 1–3, then pause for review.**
> Batches 4–5 (dual-impl conformance R1, insert/delete churn + the §12
> methodology self-test) are planned but deferred to the next round — so Phase 2
> is **not** marked complete until 4–5 land; the status-block update happens
> then, not after Batch 3.

### Batch 1 — Rust array + hashset + search sweep (kills R2, zero UI)
- `bench-engine/src/structures/`: `dyn_array.rs` (unsorted) + `hash_set.rs`
  (separate chaining, load-factor rehash), each **built from the marshalled
  buffer** (number + string key types — see `src/data/marshal.ts` layout:
  `Float64Array` for numbers; offsets + UTF-8 bytes for strings).
- Op-counters behind a build flag (§6.4): array = comparisons; hashset =
  hashes + chain-steps.
- `cargo test` + `proptest`: membership + op sequences vs a reference model.
- WASM bulk primitive exported via `wasm_bindgen`: build-to-n + run-k-searches
  (configurable present/absent mix), returns op-count (and is the timed unit).
- `src/bench/measure.ts` (pure): `geometricSweep` (reuse `src/bench/sweep.ts`)
  → per-size measurement with auto-grow/warm-up/reps/variance via an injected
  op-runner. **Vitest**: feed stub runners with O(n) and O(1) cost; assert the
  pipeline reports rising vs flat and sane variance.
- Extend `BenchEngine` + `engine.worker.ts` + `wasmBenchEngine.ts` with
  `runSweep(...)`; fix the stale Phase-4 comment.

### Batch 2 — Complexity-class fitter (§7.2)
- `src/bench/fit.ts` (pure): least-squares over {O(1), log n, n, n·log n, n²};
  returns best-fit class + R² + log-log slope + a confidence note.
- **Vitest**: synthetic linear / constant / quadratic series label O(n) / O(1)
  / O(n²) with high R²; ambiguity caveat for n·log n vs n exercised.

### Batch 3 — uPlot chart + App demo (the *visible* criterion)
- Add `uplot` dep; `src/ui/SweepChart.tsx` (line chart, log-log default,
  multi-series overlay, fitter label + R² shown next to the registry's
  theoretical class).
- Extend `src/App.tsx`: generate/import a dataset → `runSweep` array+hashset
  search → render the chart. Replace the Phase-0/1 smoke content's headline.
- Extend `scripts/verify-browser.mjs`: drive the built app, run the sweep,
  assert **array-search cost rises with n while hashset stays flat** and the
  fitter shows O(n)/O(1). This is the empirical R2 proof + §10 success
  criterion.

### Batch 4 — TS teaching impls + op-counters + conformance (R1)
- `src/structures/array.ts` + `src/structures/hashSet.ts` (TS teaching impls,
  same fixed algorithm as Rust, instrumented with the *same* op-counters).
- **Vitest** unit tests; conformance corpus + shared expected op-count table
  asserted in **both** Vitest (TS) and `cargo test` (Rust).

### Batch 5 — insert/delete methodology + self-test (completes Phase 2 exit)
- Add churn-at-fixed-size (k insert+delete pairs holding n) as the primary
  insert/delete measurement, and finite-difference-on-cumulative-build as the
  cross-check, to `measure.ts` + the Rust bulk primitives.
- **Methodology self-test (§12, exit-critical):** churn and finite-difference
  agree within tolerance on array (O(n) insert) and hashset (O(1) insert).
  Asserted deterministically via op-counts in Vitest; wall-clock cross-check in
  `verify:browser`.
- Update §10 / §7 chart to offer the insert op too.

## Files

- **New (Rust):** `bench-engine/src/structures/{mod,dyn_array,hash_set}.rs`;
  extend `bench-engine/src/lib.rs` exports.
- **New (TS):** `src/bench/measure.ts` (+ `.test.ts`), `src/bench/fit.ts`
  (+ `.test.ts`), `src/ui/SweepChart.tsx`,
  `src/structures/{array,hashSet}.ts` (+ `.test.ts`),
  conformance corpus module (+ `.test.ts`).
- **Modified:** `src/bench/BenchEngine.ts`, `src/bench/engine.worker.ts`,
  `src/bench/wasmBenchEngine.ts`, `src/App.tsx`, `scripts/verify-browser.mjs`,
  `package.json` (uplot), `README.md` + `docs/PLAN.md` status blocks.
- **Reused:** `src/data/marshal.ts` (buffer layout + `transferables`),
  `src/bench/sweep.ts` (`geometricSweep`), `src/data/generators.ts`
  (`generateSorted`/`generateUniform` for sweep inputs).

## Verification (gates per `CLAUDE.md`)

- `npm run typecheck` — strict TS, no unused.
- `npm test` — Vitest: measure pipeline (stub runners), fitter, TS impls,
  conformance op-counts.
- `npm run test:rust` — `cargo test` + proptest + conformance op-counts.
- `npm run verify` — full CI (wasm + rust + typecheck + build + vitest).
- `npm run preview` **then** `npm run verify:browser` *in the same shell
  invocation* — real worker→WASM→Comlink sweep; assert array O(n) rises /
  hashset O(1) flat + fitter labels (the §10 success criterion).

Update the **Status** blocks in `README.md` and `docs/PLAN.md` (§ top + §10) in
the batch that lands Phase 2.
