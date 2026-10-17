# Handoff — the graph's BFS / DFS step-animation (Phase 6)

Slice: the graph becomes watchable in Explore. Written for whoever merges this branch and
owns the living docs (README / PLAN / METHODOLOGY / CLAUDE.md were deliberately not edited
here, per the parallel-agent rules).

Files touched:

- `src/structures/graph.ts` — additive: optional `trace` parameter on `bfs` / `dfs` / `traverse`
- `src/viz/events.ts` — new `GraphEvent` family; `graph.visit` + `graph.examine` added to `COST_EVENT_KINDS`
- `src/viz/model.ts` — `GraphModel`, `graphModel`, `reduceGraph`, `foldGraph`, `graphAdjacency`, `otherEnd`
- `src/viz/GraphView.tsx` — new renderer
- `src/viz/VizPanel.tsx` — `GRAPH_SEED`, `describeGraph`, `summarizeGraph`, `GraphPanel`, a tab
- `src/viz/trace.graph.test.ts` — new: cost events checked against the Rust corpus
- `src/viz/model.test.ts`, `src/viz/views.render.test.ts`, `src/viz/VizPanel.test.ts` — additive tests

## 1. Proposed PLAN §10 "Done" entry

> - **Done (the graph becomes watchable — BFS and DFS step-animation):** a new `GraphEvent`
>   family whose two cost events are exactly the graph's two counting rules — `graph.visit`
>   (one vertex-visit per vertex taken off the frontier) and `graph.examine` (one edge-visit
>   per adjacency entry examined, whether or not it discovers anything) — so
>   `countCostEvents === ops` (`V + 2E` connected, `V′ + 2E′` otherwise) holds for **both
>   traversals**. Unlike the trie and skip-list animations there is no weaker,
>   self-consistent-only half: a traversal is the graph's whole op set, and every corpus
>   case is run traced and held to the corpus's *own* `ops`, `reached` and visit order
>   (`src/viz/trace.graph.test.ts`), with the traced-vs-untraced pair proving the tracer
>   perturbs nothing. Starting, marking and finishing are free events. **Marking is its own
>   frame (`graph.mark`)** because DFS is mark-on-push: a vertex is marked when pushed and
>   can wait on the stack long after, so a later edge to it is skipped though it is
>   unvisited — the real rule, not textbook recursion, and the step this frame exists to
>   show. The view (`GraphView`) draws three linked panels: the graph (a hand-placed
>   layout for the seed, a circle otherwise; every parallel copy is its own arc and a
>   self-loop its own loop, because each is two adjacency entries of real cost); the
>   **adjacency lists**, one cell per entry, so an edge-visit is one cell and a finished
>   traversal ticks the `2E′`; and the frontier (queue / stack, out-end first), the visit
>   order, and a running tally that equals the cost events folded so far. The display model
>   ties each adjacency entry to its drawn edge copy by replaying `addEdge`'s pushes, pinned
>   equal to `GraphAdj.adjacency()` and to "every edge id appears exactly twice" in
>   `model.test.ts`; the fold is also checked frame by frame against the queue/stack
>   discipline (each visit takes the real out-end). The seed (8 vertices, 10 edges) is
>   chosen so BFS (0 3 1 5 2 6 4) and DFS (0 5 6 4 2 1 3) differ, so mark-on-push DFS
>   differs from recursive DFS (0 3 2 1 4 6 5), with a parallel 1–2 edge, a self-loop on 4,
>   and an isolated vertex 7 (reached 7 of 8, cost 27 = 7 + 2·10, not 28). The headline
>   ("BFS and DFS cost the same V + 2E and visit in different orders") is on screen, and
>   the summary after either run states both orders, the split cost, and `V′ + 2E′` with
>   `E′` counted independently. **No new deps.**

The "Open" bullet should then drop "then the graph's step-animation".

The PLAN status table (row 6) and §5's per-family visuals line could add: "graph as
vertices + edges beside its adjacency lists, the frontier drawn as a queue / stack, and DFS
shown mark-on-push (**built**, Phase 6)".

## 2. METHODOLOGY touch — §5 proof-map rows

No §2.7 prose change is needed. The animation adds no measurement claim. Proposed proof-map
rows, to sit after the skip-list animation rows:

| claim | where it is proven | clock |
|---|---|---|
| the graph's **animation shows exactly the vertex-visits + edge-visits the benchmark counts**, for BFS *and* DFS — every corpus case run traced and held to the corpus's own `ops`, `reached` and visit order (chained to the Rust twin's counts, with no self-consistent-only half), the traced and untraced runs agreeing, and each stream checked structurally (each visit followed by that vertex's whole list, in order; a mark after an examine iff it discovers) | `src/viz/trace.graph.test.ts` (from `conformance/corpus-graph.txt`) | none (op-counts) |
| the graph's animation **folds to the traversal, frontier discipline and all** — every visit takes the folded frontier's real out-end (queue front / stack top), the per-frame tally equals the cost events folded so far, and each drawn adjacency entry maps to the edge copy `GraphAdj` stores there (`graphAdjacency ≡ adjacency()`, every edge id in exactly two entries — Σ deg = 2E in the drawing layer) | `src/viz/model.test.ts` | none |

## 3. CLAUDE.md gotchas worth adding

- **The graph's animation marks in its own frame, and that is the point, not padding.**
  `graph.examine` (an edge-visit, a cost event) is followed by a free `graph.mark` only
  when it discovers. DFS is mark-on-push, so a vertex turns "marked" (amber, on the stack)
  long before it is visited. When DFS pops 2 in the seed, it meets 3 and 1 still waiting and
  skips them. Recursive DFS would go there. Don't fold the mark into the examine, and
  don't caption a marked-only skip as "already visited" (`VizPanel.test.ts` pins the
  wording). Also: a self-loop is **two** examines from its own vertex, and each parallel
  copy is drawn and lit separately. The view addresses an entry as `(from, slot)` through
  `GraphModel.incident`, never by vertex pair, because pairs collide.
- **The graph tab's seed is computed, not decorative.** Ids are deliberately not numbered
  by BFS layer, so BFS order is not mistaken for ascending id order. Changing an edge changes
  four pinned facts in `trace.graph.test.ts`: the two orders, recursive ≠ mark-on-push, the
  `[3, 1, 1]` waiting-skip sequence, and the 27-vs-28 total.

## 4. README status suggestion

In the Phase 6 status line, replace "its measured half … and its animation are still open"
with something like: "…and it now has **its own step-animation** in Explore: BFS and DFS
drawn beside their adjacency lists (one cell per edge-visit), the frontier as a real queue /
stack, and DFS shown mark-on-push — the same `V + 2E`, two orders. Its measured half
(generators + edge-list import + the two-sweep Compare section + browser gate) is still
open." Merge this with whatever wording the measured-half agent proposes.

## 5. Unverified, follow-ups, and judgement calls

**Unverified**
- Not checked in the running app. `npm run preview` / `verify:browser` were off limits
  this round. Instead, six frames were rendered to static HTML and screenshotted with
  headless Chromium: the initial state, the DFS skip of a waiting vertex, a BFS examine of
  the second parallel copy, the self-loop with its arrowhead, and the BFS and DFS end
  states. They read correctly. That check does **not** cover the panel's interactive wiring:
  clicking BFS/DFS, the typed-source path and the invalid-source message. Only SSR mount
  and pure-function tests cover those. One click-through in a real browser is still owed.
- `verify:browser` does not drive any Explore panel, so it is unaffected. It was not run.

**Judgement calls a reviewer might disagree with**
1. **A separate `graph.mark` event** (advisor's recommendation) versus folding the mark
   into the examine. It costs one extra frame per discovered vertex (6 of 35 frames on the
   seed's BFS: 1 start + 7 visits + 20 examines + 6 marks + 1 done) and is what makes mark-on-push visible.
2. **Typed source vertex.** The ops are `needsValue: false`, so a blank box starts at 0
   (the corpus's source). If the user types a number, that vertex is the start, guarded by
   `Number.isInteger` and the range check (PLAN trap 3: `adjLists[1.5]` is `undefined`). An
   invalid source shows "no vertex X" and loads an empty stream. The box's placeholder still
   says "key" because `Controls.tsx` was left alone. Also, Enter does nothing on this tab,
   since `enterSpecFor` finds no key-taking op. Both are small `Controls` follow-ups.
3. **The layout is hand-placed in columns by BFS distance from 0.** This arguably favours
   BFS: its order reads left to right. DFS's dive (0 → 5 → 6 → 4 → 2 …) is still plain to
   see. A circle layout, the fallback for any other graph, would be neutral but harder to
   read. The visit-index badges (`#1`, `#2`, …) carry the order either way.
4. **No add-edge op in the UI.** The graph's op set is add-edge + traverse, but `Controls`
   takes one key, and an edge needs two. The graph stays fixed. A later slice could add an
   "add edge u v" control, plus an incremental `graph.addEdge` event for the model, which
   would be trivial since `incident` grows by two pushes.
5. **Isolated vertex rather than a second component.** A separate component with an edge
   would also show `E′ < E`. An isolated vertex keeps every edge in 0's component, so the
   gap is exactly one vertex-visit (27 vs 28). That is the cleaner "unreached costs nothing"
   lesson, but the edge half of `V′ + 2E′` stays implicit on the seed. The corpus's
   `disconnected` case covers it in tests.
6. **`summarizeGraph` re-runs both traversals untraced** to state both orders after either
   button. That costs trivial work at this size, and it is what keeps the headline on
   screen after any run.
7. **The view is wider than the other Explore views** (about 730 px for the seed) because it
   shows the adjacency lists beside the drawing. On narrow screens it scrolls like the
   others. There is no responsive layout.

**Follow-ups**
- An add-edge control (see 4), and a typed-source label / Enter binding in `Controls` (see 2).
- When the measured half lands, consider letting the Explore graph show a small sample of
  the user's own edge list (PLAN §5 scale split). That needs the dense-id remap from the
  measured half's import.
