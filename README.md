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

**Status:** Phases 0–5 complete, Phase 6 begun — every Rust bench twin (the Linear
family, the BST/AVL trees, the **min-heap**, the **skip list**, and the **string-key**
array, hash set and **trie**) is
wired into the browser sweep for **both** search and add/remove, and the
comparison layer is done: the sweeps run on a **user-chosen dataset** (generators
or pasted CSV/JSON, or one of six **one-click presets**), with a theoretical
overlay, error bars, slope uncertainty, a local-slope panel, and CSV / JSON / PNG
export; tree add/remove is probed at
**both ends** of the key range so a reverse-sorted chain can no longer report a
misleading flat curve; the linked list's add/remove ships with the caveat it needs —
its flat O(1) line is true only for a key the list just put at its own head, so the
O(n) cost of removing a key already stored is shown beside it rather than left off
the page; and a **text-key dataset** runs its own three structures, where the same
classes hold in the number of keys while a second cost axis — the key's length —
shows up as a flat line that sits higher the longer the keys are.

Phase 6 has started with the **trie**, which puts a second flat line on that text-key
chart — flat for a reason that has nothing to do with hashing. A hash set reads the
whole key once to work out where to jump; a trie takes one branch per byte and never
hashes at all, so on one picture "constant in the number of keys" and "cheap" come
apart. The trie now also has **its own animation**, so the structure that made that
claim can be watched making it: it is the first Explore tab with **text keys**, and
it is drawn one node per **UTF-8 byte** rather than per character — `café` is five
levels deep, and the two bytes of the `é` are two nodes labelled `C3` and `A9`,
because that is what the benchmark actually walks. A ringed node marks where a stored
key ends, which is the whole difference between reaching a node and finding a key:
search `car` after deleting it and the walk still goes all the way down, and still
comes back empty.

Phase 6's numeric addition is the **skip list**, and it changes what the main charts
say twice over. On the search chart it is a second sub-linear line beside the sorted
array — and then on the add/remove chart the two part company, because keeping an
array in order costs a shift of everything after the change while splicing a node into
a few express lanes costs the same O(log n) the lookup did: *same read cost, different
write cost, same data*. And it is a third answer to the input that kills a naive binary
search tree. The AVL survives reverse-sorted keys by **rotating**; the skip list
survives by never having had a shape to lose, because a node's height comes from its
key's hash rather than from a coin toss or from the order the keys arrived in. That is
a deliberate departure from the textbook: it keeps the op-count signal reproducible,
lets the TypeScript twin reproduce the Rust corpus exactly, and moves the
"probabilistic" caveat from the algorithm's coin onto the *key distribution*, which is
where this project can actually show it to you. Its animation, the graph and session
persistence are still to come. The
phase table is at the top of
[`docs/PLAN.md`](docs/PLAN.md); the measurement science and its open hurdles
are in [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

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
  rotations the benchmark counts). Eight tabs take a **number**; the **trie** tab
  takes **text**, and counts char-steps instead — one for the root, one per byte of
  the key it is given.
- **Compare** — below the explorer, pick a **dataset** (a generator such as
  `uniform`, `sorted`, `reverse-sorted`, `near-sorted`, `gaussian`, `zipfian`,
  or paste your own CSV/JSON and name the key field) and run the sweeps. Every
  structure is measured on order-preserving prefixes of that one dataset, so
  its real distribution and order reach all of them — pick `sorted` to watch
  the naive BST degenerate to O(n) while the AVL holds O(log n). The charts plot
  measured search and mutation cost against n on log-log axes, with:
  - the **signal** toggle — *wall-clock* (ns/op, real timing on this machine)
    vs *op-count* (the clean algorithmic shape);
  - each series labelled with its fitted class and **slope ± standard error**;
  - **error bars** (min→max across timed reps) and a dashed **theoretical
    overlay** of the textbook class scaled onto the data;
  - a **local-slope panel** showing the empirical exponent on each interval
    (a falling trend is the logarithm's signature; a rising one means a fixed
    overhead is masking growth);
  - **export** of the results as CSV or JSON with provenance columns.
- **The min-heap gets its own section**, because it answers a different question.
  The structures above all do add / find / remove a key; a heap does add, *peek at
  the smallest*, and *remove the smallest*. Lining it up against the others would
  compare different operations, so it is charted separately: its add+remove pair
  reads **O(log n)**, and its “search” is shown next to the unsorted array’s scan
  as the honest answer to “can I just use a heap for everything?” — both **O(n)**,
  because a heap keeps only its minimum findable.

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
# In a sandbox with a pre-installed Chromium, point the gate at it:
#   VERIFY_CHROMIUM=/path/to/chrome npm run verify:browser http://localhost:4173
```

## Layout

```
bench-engine/        Rust crate -> WASM benchmark engine (the "production" impls)
  src/lib.rs
src/
  bench/             BenchEngine interface, Comlink worker, WASM-backed engine,
                     measurement loop (measure.ts), fitter (fit.ts), sweep sizes
  compare/           Compare orchestration: dataset -> every sweep -> fits -> proofs
  data/              data layer: import, type detection, generators, marshalling
  registry.ts        structure registry: labels, colours, cost metric, theoretical classes
  structures/        TypeScript teaching twins (drive the animations)
  ui/                Compare section, dataset picker, charts (sweep + local slope),
                     export, pedagogical copy
  viz/               step-event model, Player, SVG renderers, exploration UI
  App.tsx            app shell (layout only): explorer + Compare section
conformance/         cross-language conformance corpora
docs/PLAN.md         design + roadmap
docs/METHODOLOGY.md  measurement science, known hurdles, proof map
.github/workflows/   CI
```
