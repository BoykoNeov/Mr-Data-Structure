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

**Phase 2 — thin slice (complete).** The first vertical slice is in: two
contrasting structures — an unsorted dynamic array and a separate-chaining hash
set — run through the Rust/WASM bench engine, the §6.3 search-measurement
methodology (batch auto-grow past the clock clamp, warm-up, reps, variance), a
complexity-class fitter (§7.2), and one log-log comparison chart. The headline
result is proven in headless Chromium against the real browser clock: **array
search measures O(n) (slope ≈ 1) while hash-set search stays flat O(1) (slope
≈ 0)**. The dual-impl spine (§2.1) is now closed for both: TypeScript teaching
twins of the array and hash set run the *same* algorithm, and a cross-language
conformance corpus (§12) holds the two languages to identical observable results
— iteration order and per-search op-count (the hash is a bit-exact port of the
Rust `mix_f64`). The §6.3 **size-mutating measurement** is now in too:
insert/delete via churn (the combined-cost primary) plus the finite-difference
cross-check (per-insert from cumulative build, per-delete from cumulative
teardown), with the §12 self-test proving the two methods agree. Headless
Chromium confirms it on the real clock: **array churn O(n) (slope ≈ 1), hash-set
churn O(1)**, with the finite-difference split reading array delete O(n) and
insert flat. The final exit slice — the **string-key bench structures** — has
now landed: Rust `ArrayStr`/`HashSetStr` built from the offsets+UTF-8 marshal
layout (§4.2, risk R7), a portable `mix_str` string hash (FNV-1a → SplitMix64)
with a bit-exact TypeScript twin, the matching string teaching twins, and a
second cross-language conformance corpus (`conformance/corpus-str.txt`,
multi-byte UTF-8 included) pinning both languages to identical iteration order
and per-search op-count. Wiring the string structures into the sweep/chart UI is
left to the Phase 3/4 breadth work.

**Phase 1 — data layer.** On top of the Phase 0 scaffold (Vite + React +
TypeScript frontend, a Rust → WASM benchmark engine in a Web Worker via Comlink,
the `BenchEngine` interface, and CI — proving the main-thread → Worker → WASM
round-trip, `ping(41)` → `42`), the app loads a normalized dataset from
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

Open the printed local URL — you should see `status: ready` and the
array-vs-hash-set search comparison chart (array labelled O(n), hash set O(1)).

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
