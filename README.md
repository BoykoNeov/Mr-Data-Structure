# Mr Data Structure

Interactive **exploration** and **empirical complexity comparison** of data
structures — on *your real data*, not on textbook formulas.

- **Explore:** insert / search / delete elements one at a time and watch the
  structure animate (comparisons, pointer moves, rotations, rehashing).
- **Compare:** load real data (or generate synthetic data), run
  insert/search/delete across a sweep of input sizes on several structures, and
  see their *measured* cost curves side by side.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design, the measurement
methodology, and the phased roadmap.

## Status

**Phase 1 — data layer.** On top of the Phase 0 scaffold (Vite + React +
TypeScript frontend, a Rust → WASM benchmark engine in a Web Worker via Comlink,
the `BenchEngine` interface, and CI — proving the main-thread → Worker → WASM
round-trip, `ping(41)` → `42`), the app now loads a normalized dataset from
CSV/JSON imports and seeded synthetic generators, with conservative type
detection, a key-field picker, and typed-array marshalling for WASM transfer.

## Toolchain

- Node ≥ 20, npm
- Rust (stable) with the `wasm32-unknown-unknown` target
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

## Develop

```sh
npm install
npm run dev      # builds the WASM engine (dev profile), then starts Vite
```

Open the printed local URL — you should see `status: ready` and `ping(41) → 42 ✓`.

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
  App.tsx            phase demo / smoke screen
docs/PLAN.md         design + roadmap
.github/workflows/   CI
```
