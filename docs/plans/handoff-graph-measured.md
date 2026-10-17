# Handoff — the graph's measured half (Phase 6)

Slice owner: the "graph measured half" agent. Branch `worktree-agent-a68f744aa6a3de274`, off
`main` @ 7450254. Lead is the sole writer of README / PLAN / METHODOLOGY / CLAUDE.md; the text
below is proposed for them.

## Files

New:

- `src/data/graphs.ts` (+ test) — seeded generators: connected random (random recursive tree +
  uniform extra edges), path, grid, `generateGridNear`; `GraphData` / `GraphOrigin`.
- `src/data/edgeList.ts` (+ test) — `parseEdgeList` (dense ids in first-seen order, string labels,
  never dedupe; comma / tab / whitespace; explicit header flag; `#` comments optional) and
  `edgePrefix` (prefix-stable sub-graph, copied buffer).
- `src/bench/graphBench.ts` (+ test) — `GraphInput`, `GraphTraversalMeasure`, `TraversableGraph`,
  and `measureGraphs` (the worker-side loop, unit-tested with the TS twin + a virtual clock).
- `src/compare/runGraphSweeps.ts` (+ test) — the orchestrator: V-sweep + degree-sweep, the
  independent `V' + 2E'` computation (`componentStats`), the identity checks, `window.__graphProof`.
- `src/ui/graphPicker.ts` (+ test) — the section's own picker, pure core.
- `src/ui/GraphChart.tsx` — uPlot chart with x = `V' + 2E'`.
- `src/ui/GraphCompareSection.tsx` (+ render test).

Edited (additive):

- `src/bench/measure.ts` — `| 'graph'` appended to `StructureId` + doc paragraph.
- `src/registry.ts` (+ test) — `KeyStructureId`, `GraphComplexity`, `GraphStructureInfo`, the
  `Registry` mapped type, the `graph` entry, `GRAPH`, `isCanonical` excludes `'graph'`,
  `CANONICAL_STRUCTURES` filters through `isCanonical`, `theoreticalClass('graph', …)` throws.
  **Not purely additive — see "Merge notes" below.**
- `src/bench/BenchEngine.ts`, `src/bench/wasmBenchEngine.ts`, `src/bench/engine.worker.ts` —
  `runGraphSweep` appended (worker imports `GraphAdj`).
- `src/compare/runSweeps.test.ts` — one stub (`runGraphSweep`) on the fake engine, which throws if
  a key run ever calls it.
- `src/ui/CompareSection.tsx` — one import + one `<GraphCompareSection …/>` at the end of the
  section.
- `bench-engine/src/structures/graph.rs` — one test appended
  (`the_timed_traversals_never_grow_their_scratch`). **No `lib.rs` / wasm-surface change** — the
  `#[wasm_bindgen]` timed calls (`GraphAdj::new`, `bfs_n`, `dfs_n`, `bfs_counted`, `dfs_counted`)
  already shipped with the clock-free slice; this slice wires them.
- `scripts/verify-browser.mjs` — a fourth pass (UNRUN, see §6).

`src/structures/graph.ts` is untouched (the animation agent owns its traversal code).

### Merge notes — the non-additive edits, and where conflicts can land

Four existing lines in `src/registry.ts` (a shared hotspot) were **changed**, not appended to.
All four are required by trap 1 or by giving the graph its own info shape:

1. The `REGISTRY` type annotation: `Readonly<Record<StructureId, StructureInfo>>` → the new
   `Registry` mapped type (`'graph'` → `GraphStructureInfo`, every other id → `StructureInfo`).
2. The `CANONICAL_STRUCTURES` filter predicate: `(s) => s.id !== 'heap'` → `(s) => isCanonical(s.id)`.
3. The `isCanonical` return line: `id !== 'heap'` → `id !== 'heap' && id !== 'graph'`.
4. A new guard at the top of `theoreticalClass` that throws for the graph.

Consequences: any code that reads `.average`, `.worst` or `.shapeSensitive` off `REGISTRY[x]`
with an **arbitrary** `StructureId` fails typecheck until it narrows the graph away
(`if (info.family === 'graph') …`) — intended, it is the type system enforcing trap 1. Reads via a
literal key (`REGISTRY.bst.average`) and of the common fields are unaffected. Every branch that
adds a `BenchEngine` method also adds a fake stub just above `dispose` in
`src/compare/runSweeps.test.ts`, so expect adjacent-line conflicts there (keep all stubs).

## (1) Proposed PLAN §10 "Done" entry

- **Done (the graph, measured — generators, edge-list import, the two-sweep Compare section):**
  the graph's measured half, wiring the bench twin's existing `bfs_n` / `dfs_n` timed surface
  into its **own** Compare section. The graph has its own data: seeded synthetic generators
  (`src/data/graphs.ts` — a random **connected** graph at a chosen average degree, built as a
  random spanning tree plus uniform extra edges; a path; a square grid) and a user's **own edge
  list** (`src/data/edgeList.ts`). It never reads the shared key dataset — a list of keys carries
  no edges, and inventing some would measure a made-up graph. The section is measured **on
  request** (its own button), not on page load, so the key runs' default auto-run and the browser
  gate's three passes are byte-for-byte unaffected; it shares the bench worker, so a graph run
  queues behind a key run rather than racing it for the clock.

  **Two sweeps, because one cannot separate `O(V)` from `O(V + E)`** (METHODOLOGY §2.7). The
  **V-sweep** grows the graph (1k → 50k vertices) at a fixed average degree — or, for an imported
  list, takes ever longer prefixes of it; the **degree-sweep** holds `V = 5,000` and grows the
  average degree 2 → 64. The random generator is **nested by construction** (one seed draws the
  same tree and the same extra edges in the same order), so each degree-sweep point is literally
  the previous graph plus edges — `V` fixed, `E` alone growing. Both are plotted against the
  **reached component's `V' + 2E'`**, which the orchestrator computes itself from the edges and
  then **checks** the engine's op-count against at every point (`countsMatchComponent`), along with
  `BFS ops = DFS ops` (`bfsEqualsDfs`) and reached/V (`allReached`, plus a per-point "reached x of
  V" column). An `O(V)` cost reads slope 1 on the V-sweep and flat on the degree-sweep — pinned
  with a fake engine in `runGraphSweeps.test.ts`.

  **The four traps, each pinned:** (1) `isCanonical('graph') === false`, `CANONICAL_STRUCTURES`
  filters through `isCanonical`, and the graph has its own `GraphStructureInfo` (no
  `average`/`worst`/`shapeSensitive`/`keyType`; `ops: { addEdge: 'O(1)', traversal: 'O(V + E)' }`);
  `theoreticalClass('graph', …)` throws — `registry.test.ts`. (2) Edge-list labels map to dense ids
  in **first-seen order**, so vertex 0 is the first endpoint of the first edge; first-seen order is
  also prefix-stable, so a swept prefix is itself dense — `edgeList.test.ts`. (3) Labels are
  **strings** (`02134 ≠ 2134`, `1.0 ≠ 1`, only surrounding whitespace trimmed) and ids are a
  `Uint32Array`, integers by type — `edgeList.test.ts`, `graphs.test.ts`. (4) Disconnected graphs
  plot at the reached component's `V' + 2E'`; an engine that reported the nominal `V + 2E` is
  caught by `countsMatchComponent` — `runGraphSweeps.test.ts`.

  Nothing is allocated in the timed region: the traversal reuses the generation-stamped `visited`
  array and the `V`-sized frontier, pinned by `graph::tests::the_timed_traversals_never_grow_their_scratch`
  on a dense multigraph (every ordered pair, so parallel edges and a loop on every vertex) — same
  capacity and same heap pointers after 400 timed traversals. The graph's measure options start
  the batch at 1 (one "op" is a whole traversal). Parallel edges and self-loops are kept by every
  generator and by the import (never dedupe). The chart is its own component (`ui/GraphChart`)
  because `SweepChart` is built around `n` and the key structures' theory; BFS solid, DFS dotted,
  one registry hue (`#7f7f7f`). Browser-gate pass written, **not yet run**. **No new deps.**

## (2) PLAN §8 table change

Graph row — replace the cost-metric cell and notes:

| Graph (adjacency list) | edge O(1) | traversal (BFS/DFS) O(V + E) | — | vertex-visits + edge-visits | **own op set**; out of the insert/search/delete comparison. **Built (Phase 6).** Measured in its own Compare section on two sweeps (V at fixed degree; degree at fixed V), x-axis = the reached component's `V' + 2E'`; registry entry is its own `GraphStructureInfo`, `!isCanonical` |

(The current row says cost metric "edge-visits"; the twin has counted vertex-visits + edge-visits
since the clock-free slice, so the row was already stale.)

## (3) METHODOLOGY §2.7 (continued — the measured half)

Replace the "*(Status: …)*" paragraph and the future-tense "will" phrasing, then append:

> **The measured half.** The graph's Compare section runs two sweeps, both plotted against
> `V' + 2E'` — the vertex-visits plus edge-visits of vertex 0's connected component.
>
> - **V-sweep** — random connected graphs at a fixed average degree (default 4), `V` = 1k … 50k on
>   the 1-2-5 ladder; or a path, or a square grid; or, for a user's edge list, its first 10, 20,
>   50, … edges (capped at 500k).
> - **Degree-sweep** — always synthetic: one random connected graph on `V = 5,000` vertices at
>   average degree 2, 4, 8, 16, 32, 64. The generator is *nested*: one seed draws the same spanning
>   tree and then the same extra edges in the same order, so a lower degree's edge list is an exact
>   prefix of a higher one's and every point is the previous graph plus edges. `V` is not merely
>   equal across the sweep, it is the same graph.
>
> **The x-coordinate is computed, then checked.** The orchestrator derives `V'` (BFS reach of the
> TS twin) and `E'` (edges with an endpoint in the reach) from the edges themselves, plots each
> point at `V' + 2E'`, and checks that both bench-twin op-counts equal it and both traversals
> reached exactly `V'`. So "op-count = `V' + 2E'`" is re-verified on every point of every run on
> the real WASM twin, not only on the corpus — and the op-count chart is a check (slope exactly 1,
> BFS on top of DFS), not a tautology. Plotting against the nominal `V + E` instead would put a
> traversal that touched 3 vertices of a disconnected file at the x of the whole file.
>
> **Why random graphs bend the V-sweep's wall clock.** In a random graph almost every step of a
> walk is a jump to an unpredictable place in memory (the next vertex's `visited` mark and its
> separately-allocated neighbour list). Growing the graph from 1k to 50k vertices takes it from
> cache-resident to not, so ns per visit rises (a node run on a loaded dev box: ~2.3 → ~7.4 ns per
> unit of `V' + 2E'`) and the wall-clock slope reads ~1.3, which the fitter can label `O(n log n)`.
> That is memory, not the walk; the op-count is exactly linear. Same call as the string array's
> and the trie's: assert the band, show the "ns per visit" column, say why beside the chart. The
> degree-sweep at a fixed 5k vertices is much less exposed, and its slope reads a little *below* 1
> for an honest `O(V + E)`: a vertex-visit costs more than an edge-read, and the vertices' share of
> the work shrinks as edges are added.
>
> **Imported edge lists.** Labels are text and are numbered in first-seen order (so vertex 0, the
> traversal's source, is always the first endpoint of the first edge, and every prefix of the file
> is a dense graph on ids `0..k−1`); `02134` and `2134` are two vertices; repeated lines are
> parallel edges and `a,a` a self-loop, all kept; a header row and `#` comments are explicit
> options, never guessed. A prefix may be disconnected — the per-point table shows "reached x of
> V" and the x-coordinate is the reached component's.

§5 proof-map rows to add:

| Claim | Pinned by |
|---|---|
| The graph is never canonical, has its own info shape, and has no key-structure theory | `src/registry.test.ts` — "keeps the graph off every shared chart, with its own info shape" |
| Edge-list labels → dense ids in first-seen order; vertex 0 always real; prefix-stable | `src/data/edgeList.test.ts` — trap 2 + `edgePrefix` tests |
| Labels are strings, never numbers; ids handed to the twin are integers | `src/data/edgeList.test.ts` — trap 3 tests; `src/data/graphs.test.ts` |
| Disconnected graphs plot at the reached component's `V' + 2E'`; a nominal-size op-count is caught | `src/compare/runGraphSweeps.test.ts` — "plots a disconnected import…", "flags an engine whose op-count…" |
| One sweep cannot separate O(V) from O(V+E): an O(V) cost is linear on the V-sweep, flat on the degree-sweep | `src/compare/runGraphSweeps.test.ts` — "shows why one sweep is not enough" |
| The degree-sweep holds V fixed and only adds edges (nested generator) | `src/data/graphs.test.ts` — "nests across degrees" |
| No allocation inside the timed traversals | `graph::tests::the_timed_traversals_never_grow_their_scratch` |
| Runtime: op-count = `V' + 2E'`, BFS = DFS, linear V-sweep, rising degree-sweep on the real clock | `scripts/verify-browser.mjs` fourth pass (**UNRUN**) |

## (4) CLAUDE.md gotchas worth adding

- **The graph's x-axis is the reached component's `V' + 2E'`, computed by the page, not by the
  engine.** `runGraphSweeps` derives `V'`/`E'` from the edges and *checks* the bench twin's
  op-count against them (`countsMatchComponent`). Don't "simplify" it to use the op-count as x
  (it makes the check a tautology) or the nominal `V + E` (a disconnected file then plots a
  3-vertex walk at the whole file's size).
- **The degree-sweep's graphs are nested on purpose.** `generateConnectedRandom` draws the tree,
  then extra edges, from one seed, so a lower degree is an exact prefix of a higher one. Changing
  the draw order (e.g. interleaving extras with the tree, or reseeding per degree) keeps every
  test of degree passing while silently making each point a *different* graph.
- **The graph section never runs on page load.** The key runs' default auto-run is what the browser
  gate measures first; the graph is a fourth, final gate pass driven by its own button
  (`measure the graph`, which must not match `/run the sweeps/`).
- **`REGISTRY[id]` for an arbitrary `StructureId` is a union** (`StructureInfo | GraphStructureInfo`).
  Read `average`/`worst` only after narrowing the graph away (`theoreticalClass` throws for it).
  `GraphStructureInfo.keyType?: never` exists only so `REGISTRY[x].keyType` still typechecks.
- **Every graph handed to `runGraphSweep` must own its buffer** — the engine transfers each, and
  one buffer twice in a transfer list is a `DataCloneError` (`edgePrefix` copies; the orchestrator
  `slice()`s).

## (5) README status suggestion

Phase 6 row: "…The **graph** is now measured end to end too: its own Compare section, fed by seeded
synthetic graphs or your own edge list, runs a V-sweep and a degree-sweep and plots both
traversals against the reached component's `V' + 2E'` — BFS and DFS visibly the same cost in
different orders, and the `+E` term visible only on the sweep that holds `V` fixed. Its
step-animation, session persistence and performance polish remain open."

## (6) Unrun / unverified / open, and judgement calls

**UNRUN:**

- `scripts/verify-browser.mjs` fourth pass (never run — preview/gate forbidden for this slice).
  Thresholds are educated guesses from a **node** smoke run (below), not from Chromium:
  V-sweep slope band 0.7..1.6 for both traversals; degree-sweep rise > 3× and slope 0.4..1.4; the
  three identity booleans true; ≥ 5 points per sweep. Wait timeout 120 s.
- No `npm run verify` (it rebuilds wasm + runs everything; I ran its pieces individually).

**What was run** (all at below-normal priority, on a machine shared with six other agents):

> The Bash tool refused the `cmd //v:on //c "start /belownormal …"` wrapper in this worktree, so
> every run used the same wrapper from PowerShell, where its **exit code did not propagate** (it
> reported 0 on a `tsc` run that printed an error). Every result below is read from the tools'
> own output lines, not from exit codes.

- `cargo test --manifest-path bench-engine/Cargo.toml` — lib **192 passed** (191 + 1 new), 9
  ignored; integration/proptest binaries 2 + 2 + 1 + 2 + 10 + 2 passed; 0 failed.
- `npm run typecheck` — clean.
- `npx vitest run` — **56 files, 828 tests passed**.
- `npx vite build` — clean (worker chunk 33 kB).
- A scratch **node** smoke run (vite-node, the real WASM twin via `initSync`, the real
  `measureGraphs` + `runGraphSweeps`; a throwaway script outside the repo, since deleted): whole graph run ~7.3 s;
  V-sweep BFS slope 1.33 ± 0.04 / DFS 1.38 ± 0.08 (labelled `O(n log n)` — the cache effect,
  ns per visit 2.3 → 7.4); degree-sweep BFS 0.88 ± 0.08 / DFS 0.85 ± 0.20, rise ~18× over a 21.7×
  x range; `countsMatchComponent`, `bfsEqualsDfs`, `allReached` all true; a disconnected
  600-edge import gave `301/502` reached at the right x. Noisy (loaded box). Chromium's numbers will
  differ.

**Open follow-ups:**

- The graph charts are **not** in the Compare section's PNG / CSV / JSON exports (those iterate a
  fixed list of key-structure charts in `CompareSection.tsx`, a hotspot). The PNG would need the
  memory caveat as a caption line, per the CLAUDE.md "every way the curve leaves the page" rule.
- No local-slope panel for the graph (`SlopeChart` takes key-structure `SeriesView`s); the
  per-point "ns per visit" column stands in for it.
- The degree-sweep uses one fixed `V` (5,000) and seed; not user-configurable.
- Edge-list import does not accept isolated-vertex lines (a single label) — they are skipped and
  counted. A traversal from 0 could never reach an isolated vertex anyway, but `V` (the nominal
  count) would then under-count the file's vertices.

**Judgement calls a reviewer might disagree with:**

1. **Registry typing.** Instead of a `Record<StructureId, StructureInfo>` with a graph entry full of
   false theory, `REGISTRY` is a mapped type giving `'graph'` its own `GraphStructureInfo`. Indexing
   with an arbitrary `StructureId` now yields a union; every existing call site already used only
   common fields (or `?.`), so none changed. `GraphStructureInfo` declares `keyType?: never` purely
   so `runSweeps.test.ts`'s `REGISTRY[...].keyType === 'number'` still typechecks — the alternative
   was editing that hotspot test.
2. **`theoreticalClass('graph', …)` throws** rather than returning a class. A silent fallback would
   be exactly the false theory trap 1 warns about.
3. **The graph run is on-demand, not auto-run** — keeps the existing gate passes untouched and the
   page load as fast as before, at the cost of an empty section until clicked.
4. **x = the page-computed `V' + 2E'`**, with the op-count checked against it, rather than x = the
   engine's op-count (which the PLAN text literally suggests: "plot against the reached
   component's `V' + 2E'` (the measured op-count)"). Same numbers when the twin is right; a real
   check when it is not.
5. **The degree-sweep is always synthetic**, even when the user imported a list (holding `V` fixed
   while adding only edges is not something a given file can do). Labelled as generated on screen.
6. **An imported list's V-sweep is an edge-prefix sweep** (each prefix's own first-seen vertices),
   capped at 500k edges, needing ≥ 20 edges.
7. **The random generator keeps self-loops and parallel edges** its independent draws produce
   (rare at these sizes) rather than redrawing — "never dedupe".
8. **Labels are trimmed** of surrounding whitespace (`" 2134 "` = `"2134"`), as the key importer's
   detection does; anything else is literal.
9. **V-sweep's gate band is 0.7..1.6**, wide on the high side for the cache effect; a tighter band
   would flake on machines with smaller caches. It was set from a node run where DFS already read
   1.38 ± 0.08, so headroom is thin. If it flakes in Chromium, check the "ns per visit" column
   first: a rising column means memory is tilting the slope, which argues for widening the band,
   not for re-tuning the graphs.
