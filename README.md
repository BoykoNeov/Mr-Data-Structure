# Mr Data Structure

> **License:** [Boyko Non-Commercial License v1.0 (BNCL-1.0)](LICENSE) — free to use, modify, and distribute for non-commercial purposes. Commercial use requires separate written permission from the copyright holder.

Interactive **exploration** and **empirical complexity comparison** of data
structures — on *your real data*, not on textbook formulas.

- **Explore:** insert / search / delete elements one at a time and watch the
  structure animate (comparisons, pointer moves, rotations, rehashing).
- **Compare:** load real data (or generate synthetic data), run
  insert/search/delete across a sweep of input sizes on several structures, and
  see their *measured* cost curves side by side.

Each structure has two implementations: a TypeScript **teaching twin** that
drives the animation and a Rust→WASM **bench twin** that drives the
measurements, held to identical behaviour by a cross-language conformance
corpus. See [`docs/PLAN.md`](docs/PLAN.md) for the full design, the measurement
methodology, and the phased roadmap.

**Status:** Phases 0–3 complete; Phase 4 (Rust bench twins) in progress — the
Linear family and the BST/AVL trees have landed. Full phase-by-phase status is
in [`docs/PLAN.md`](docs/PLAN.md) (top Status block and §10).

## Prerequisites

- Node ≥ 20, npm
- Rust (stable) with the `wasm32-unknown-unknown` target
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

## Quickstart

```sh
npm install
npm run dev      # builds the WASM engine (dev profile), then starts Vite
```

Open the printed local URL. The page header should read `status: ready`.

## Using the app

The page has two parts, matching the two modes above:

- **Explore** — pick a structure tab, click `insert` / `search` / `delete`, and
  use the play / pause / step / step-back / speed controls to walk through the
  animation one cost event at a time (the same comparisons, probes, shifts, and
  rotations the benchmark counts).
- **Compare** — below the explorer, the sweep charts plot measured search and
  mutation cost across a range of input sizes. The **signal** selector toggles
  between *wall-clock* (ns/op, the real timing) and *op-count* (the clean
  algorithmic shape); each series is labelled with its fitted complexity class
  (e.g. array search O(n) vs hash-set search O(1)).

## Build / test / verify

```sh
npm run build      # build WASM (release) + typecheck + bundle frontend
npm test           # TS unit tests (Vitest)
npm run test:rust  # Rust unit tests
npm run verify     # everything CI runs, locally
```

Headless browser round-trip check (proves the worker → WASM → Comlink handshake
resolves at runtime — `npm run build` only proves it bundles):

```sh
npx playwright install chromium   # one-time
npm run build
npm run preview &                 # serves dist on :4173 (or pass --port)
npm run verify:browser http://localhost:4173
```

## Layout

```
bench-engine/        Rust crate -> WASM benchmark engine (the "production" impls)
  src/lib.rs
src/
  bench/             BenchEngine interface, Comlink worker, WASM-backed engine
  data/              data layer: import, type detection, generators, marshalling
  structures/        TypeScript teaching twins (drive the animations)
  viz/               step-event model, Player, SVG renderers, exploration UI
  App.tsx            app shell: explorer + comparison sweep
conformance/         cross-language conformance corpora
docs/PLAN.md         design + roadmap
.github/workflows/   CI
```
