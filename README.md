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

**Status:** Phases 0–5 complete, Phase 6 well along — every Rust bench twin (the Linear
family including the **doubly linked list**, all three hash sets, the BST/AVL and
**red-black** trees and the **B-tree**, the **min-heap**, the **skip list**, and the
**string-key** array, hash set and **trie**) is
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
where this project can actually show it to you. The skip list now has **its own
animation** too, so the O(log n) search can be watched happening: the express lanes are
drawn as the real skips they are (the top lane jumps straight over most of the list),
and each step shows two things at once — the node the walk *stands* on and the node it
*compares* — so a hit visibly pays for the descent **and** one more equality test on the
same node.

The **graph** is now complete: an adjacency-list multigraph whose breadth-first and
depth-first traversals cost the *same* `V + 2E` while visiting in different orders (the
graph counterpart to "the array and the linked list are both O(n) by different
mechanisms"). Its own Compare section, fed by seeded synthetic graphs or your own edge
list, runs a sweep over vertices and a sweep over edge density, and plots both traversals
against the reached component's size — BFS and DFS visibly the same cost, and the `+E`
term visible only on the sweep that holds `V` fixed. It also has **its own animation**:
BFS and DFS drawn beside their adjacency lists (one cell per edge-visit), the frontier as
a real queue or stack, and DFS shown marking a vertex when it is pushed, not when it is
visited.

Phase 6 also answers several "which variant?" questions on exact counts, each on the
shared charts. A **red-black tree**, measured in the AVL's own unit, never rotates more
than twice per insert or three times per delete — but saves rotations in total only on
random inserts, and pays for its looser balance on sorted input. Its Explore tab shows each repair step
by name — which node is being fixed and which neighbour's colour decided how — with colour
changes counted apart from the comparisons and rotations it shares with the AVL. A **B-tree** makes the
AVL's number of comparisons in a quarter of its node hops; whether that shows on the clock
is printed for you to read, not claimed. Its Explore tab draws smaller nodes so the tree
fits on screen, and shows the nodes each walk visits beside the comparison count — the
saving the count itself cannot see. An **open-addressing hash set**, held to the
chaining set's exact table sizes, pays more probes per lookup (primary clustering, matching
Knuth's formulas) while staying flat, behind a tombstone policy that keeps its add/remove
from drifting with the timer's repetition count. Its Explore tab shows why: the same keys
as the chaining tab land in one run that wraps round the end of the table, a miss caught in
that run pays four probes where chaining pays one, and a deleted key leaves a tombstone the
next walk has to step over. And a **doubly linked list** draws the
same curves as the singly one — the same steps, counted exactly — because a back pointer
only helps remove a node you already hold, while each node takes half again the memory.
Its Explore tab now shows that with **real links**: the teaching twin keeps genuine forward
and backward pointers, and a delete is drawn as the walk a singly list would make followed
by two pointer writes that step around the node — free in the count, which is the point.

The search workload's **hits-vs-misses mix is now a choice** (the default is the
calibrated 50/50, reproduced exactly), and a structure that keeps one copy of each repeated
key says how many it actually held beside the input size — on the chart, in the exports
and in the PNG. And your **session is remembered in this browser**: your last run's
dataset — pasted data included — and chart settings come back on reload, while results are
always re-measured, never restored. The plain **BST and the AVL now share the search chart**
with the other trees, so the sorted-data lesson shows on lookups as well as on add/remove:
on reverse-sorted keys the BST's search climbs in a straight line (O(n)) while the AVL's
stays low. One case is flagged rather than hidden: with *misses only* selected, every
missing key sits above the largest stored one, which a reverse-sorted BST answers in one
step — so its line would read flat, and the page says so beside the chart and on the PNG.
**Every measured structure now animates**: the text-key array and hash set have their own
Explore tabs, each drawn comparison one whole-key test, as the benchmark counts it.

Six opt-in extras answer the plan's open "which variant?" questions, each leaving the
default page measuring exactly what it did:

- a **third hash set** that deletes by sliding the following keys back instead of leaving a
  tombstone — the tombstone turns out to cause all of the old set's add/remove-vs-cross-check
  disagreement and almost none of its cost, because sliding back walks the very stretch of
  table a tombstone would have made the next insert walk;
- a **load-factor control** for the open-addressing set (0.5 / 0.75 / 0.9), which reports how
  full each table actually got on the size ladder (less than the setting suggests) and flags
  the chart, PNG and exports "not like for like" whenever it differs from the chaining set's;
- a clock-free **worst single operation** view, on request: the red-black tree's ≤ 2 / ≤ 3
  rotations per operation against the AVL's worst delete growing with height, and the
  grow-and-copy hidden inside an array's or hash set's amortised O(1) insert;
- **misses between stored keys** as an alternative to misses past the largest key, which
  closes both the skip list's cheap-miss gap and the BST's misses-only blind spot;
- a **stored-size x-axis**, refitting every chart on how many keys each structure kept;
- and the text-key animations above.

Still open: the graph in the exports, and performance polish. The
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
  rotations the benchmark counts). Nine tabs take a **number**; the **trie** tab
  takes **text**, and counts char-steps instead — one for the root, one per byte of
  the key it is given; the **graph** tab runs BFS or DFS on a fixed seed graph, from
  vertex 0 or from a start vertex you type (Enter runs BFS).
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
  - **export** of the results as CSV or JSON with provenance columns, and the
    charts as a PNG sheet with their caveats as caption lines;
  - a **search workload** control — the share of probes that hit a stored key
    (0 / 25 / 50 / 75 / 100 %, default 50) — and a note under any chart whose
    structure held fewer keys than it was given (a set keeps one copy of a
    repeated key).

  The page **remembers your last run** in this browser (dataset, pasted data, probe
  mix, chart settings, Explore tab) and re-measures it on reload; it never stores
  results. The note above the dataset panel says what was restored and has a
  **forget saved session** button.
- **The graph gets its own section** at the end of Compare, measured only when you
  press *measure the graph*: synthetic graphs (connected random, path, grid) or your
  own pasted edge list, swept over vertex count at fixed density and over density at
  fixed vertex count, with both traversals plotted against the reached component's
  `V′ + 2E′`.
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
                     (and the graph's two sweeps)
  data/              data layer: import, type detection, generators, marshalling,
                     graph generators, edge-list import
  persist/           local session persistence (localStorage + IndexedDB)
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
