# Mr Data Structure — Project Plan

> An interactive tool for **exploring** data structures through rich animated
> visualization, and for **empirically comparing** their add / remove / search
> cost on the user's *own real data* — not on textbook formulas.

Status — one line per phase; the full per-batch log is in §10, the measurement
science and its open hurdles in [`METHODOLOGY.md`](METHODOLOGY.md).

| phase | scope | state |
|---|---|---|
| 0 | scaffold, WASM round-trip, `BenchEngine`, CI | ✅ done |
| 1 | data layer: import, type detection, generators, marshalling | ✅ done |
| 2 | thin slice: array + hash set through both twins, §6.3 methodology, fitter, chart; string-key bench structures | ✅ done |
| 3 | animation engine + teaching twins/viz for the Linear family, BST, AVL, min-heap | ✅ done |
| 4 | Rust bench twins: BST, AVL, sorted array, linked list (Linear family complete), min-heap (Trees/heaps complete); churn-vs-FD regimes pinned clock-free | 🟡 all bench twins built; string structures + sorted-array/linked-list *mutation* not wired into the browser sweep |
| 5 | comparison/analysis: **one user-chosen dataset drives every sweep** (generators incl. sorted/reverse/near-sorted/zipfian, or pasted CSV/JSON); structure registry; theoretical overlay; rep-spread error bars; slope ± stderr/CI, local-slope panel, tail slope + trend; adaptive reps; CSV/JSON export | 🟡 first slice landed (see §10); string-key sweep, presets, PNG export open |
| 6 | trie, skip list, graph; presets/demos; persistence; polish | ⬜ not started |

Headline results, all on the real browser clock unless noted: array search O(n)
vs hash-set search O(1) (the Phase 2 criterion); sorted-array search sub-linear
and linked-list search O(n) by a different mechanism; array churn O(n) vs
hash-set O(1); BST and AVL churn sub-linear on shuffled input; and — clock-free,
on exact op-counts — the AVL stays O(log n) on the sorted input that turns the
BST into an O(n) chain, plus eight churn-vs-finite-difference regimes across the
structures (METHODOLOGY §2.3). Tree mutation is probed at **both ends** of the
key range, so a reverse-sorted chain can no longer report a flat O(1) curve
(METHODOLOGY §4.1). The **min-heap** completes the bench twins with its own op
set — insert / peek / extract-min, its add+remove pair reading O(log n) and its
"search" the deliberate O(n) scan that shows a heap is not a lookup structure —
and is kept off the shared charts, since comparing it to the others would be
comparing different operations (§8, risk R6).

---

## 1. Vision & goals

Two things at once, deliberately:

1. **Exploration** — watch a structure *work*. Insert, search, delete elements
   one at a time and see the mechanism animate: comparisons, pointer moves, tree
   rotations, hash probing, rehashing.
2. **Empirical complexity comparison** — load *real data* (or generate
   synthetic data), run insert/search/delete across a sweep of input sizes on
   several structures, and **see and compare the actual cost curves** side by
   side. The complexity is *measured*, never asserted.

The differentiator is the word **real**: the user tests structures against their
own dataset — including its real distribution and ordering — and sees how that
data actually behaves, then compares structures empirically.

### Non-goals (v1)
- Not a general algorithm-animation suite (sorting, graph algorithms beyond
  basic traversal are out of v1 scope).
- Not a microbenchmark of language internals; we measure *relative* cost curves,
  honestly labeled as machine/browser-specific.
- Not a teaching course; it's a sandbox.

---

## 2. Core design principles (the spine)

### 2.1 Two implementations per structure — on purpose

| Impl | Language | Purpose | Scale | Speed |
|------|----------|---------|-------|-------|
| **Teaching impl** | TypeScript | Emits a stream of step-events for animation | small (≤ ~200) | irrelevant |
| **Production impl** | Rust → WASM | Source of truth; benchmarked; carries cheap op-counters | full (→ millions) | matters |

This split is what lets the tool be *both* explorable *and* real. We accept the
cost of two implementations because their goals are incompatible: instrumentation
for animation is intrusive and slow; benchmarking demands idiomatic speed.

> **Alternative considered:** a *single* Rust impl with instrumentation behind a
> feature flag, streaming events across the WASM boundary. This eliminates drift
> entirely but makes the animation event-stream awkward and chatty across the
> boundary. We chose the split for front-end ergonomics. **This trade-off is
> recorded deliberately** (see Risk R1).

**Drift mitigation — conformance at the algorithm level, not just results.**
A teaching tool must animate *the same algorithm it benchmarks*. If TS animates a
naive recursive BST while Rust benchmarks a red-black tree, the user sees one
thing and measures another. Therefore:
- Pick **one** algorithm / balancing scheme per structure (see §8) and implement
  it the *same way* in both languages.
- Conformance tests assert both impls produce **identical observable results**
  (membership, iteration order, op-count for the same op sequence) — see §12.

### 2.2 Two signals for "complexity," both plotted

- **Operation counts** — from cheap counters inside the Rust impl. Deterministic,
  hardware-independent. The *clean* curve.
- **Wall-clock time** — measured in WASM with proper methodology (§6.2). Carries
  real machine constants (cache, allocation). The *real* curve.

The user asked for *real*, not theoretical — so we give both: the platonic shape
**and** what the machine actually does.

### 2.3 Honesty about measurement (non-negotiable)

A wrong big-O label on a teaching tool destroys trust instantly. Therefore:
- The **log-log plot is the primary signal** — the user reads the slope
  (slope ≈ 1 ⇒ linear, ≈ 0 ⇒ constant, ≈ 2 ⇒ quadratic).
- The **auto-classifier is secondary**, always shown with an R²/confidence
  caveat. It is honest that it reliably separates only *gross* classes
  (constant / linear / quadratic) and that **log n vs n vs n·log n are often
  empirically ambiguous** over realistic n-ranges (~7× apart across two decades —
  easily swamped by constants and noise). See §7.2.
- **"Operations" is not a universal unit.** Comparisons (trees, sorted array),
  probes (hash), node-visits (lists), char-steps (trie) are *not* comparable in
  absolute magnitude — only in **growth shape**. The registry declares each
  structure's cost metric; charts are labeled so they never imply false absolute
  comparison. Op-count overlay = shape only; wall-clock overlay = shape *and*
  magnitude (both in ns).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UI Shell (React + TS)                                         │
│  dataset panel · structure picker · viz canvas · bench config  │
│  · results dashboard · comparison view                         │
├───────────────┬───────────────────────┬──────────────────────┤
│ Data layer    │ Visualization engine  │ Comparison / analysis │
│ (TS)          │ (TS, D3/SVG)          │ (TS, uPlot)           │
│ import/gen/   │ teaching impls →      │ charts · log-log ·    │
│ typed dataset │ step-events → render  │ fit · overlay · export│
├───────────────┴───────────────────────┴──────────────────────┤
│ Structure registry (TS) — metadata, theoretical complexities,  │
│ supported ops, supported data types, cost metric per structure │
├────────────────────────────────────────────────────────────────┤
│ Benchmark engine — behind a TS interface (see R-tooling)        │
│   default: Rust → WASM (wasm-bindgen) in a Web Worker           │
│   production impls + counters + timing harness + sweep runner   │
└────────────────────────────────────────────────────────────────┘
```

**Layers**
1. **Data layer (TS)** — import CSV/JSON/paste/file; type detection; KV key-field
   picker; synthetic generators (§4). Produces one normalized dataset shared by
   viz and bench.
2. **Structure registry (TS)** — single source of metadata that drives the UI
   dynamically (which ops, which data types, theoretical complexities, cost
   metric). See §8.
3. **Visualization engine (TS)** — teaching impls emit step-events; renderer
   animates with play/pause/step/speed.
4. **Benchmark engine** — behind a TS interface (`BenchEngine`); default
   implementation is Rust→WASM in a Web Worker. The interface allows a pure-TS
   fallback if the WASM+Worker toolchain proves too heavy in Phase 0 (cheap
   insurance; see R5).
5. **Comparison / analysis (TS)** — charts, log-log, multi-structure overlay,
   complexity-class fit, theoretical overlay, export (CSV/PNG/JSON).
6. **UI shell** — orchestrates the above.

---

## 4. Data model & canonical operations

### 4.1 Canonical op set (makes comparison apples-to-apples)
Every comparable structure implements exactly:
- `insert(key)`
- `search(key)`
- `delete(key)`

operating on the **key**. For key–value records, the user picks a key field; the
row is the value. Structures whose semantics differ (heap, graph) declare a
different op set in the registry and are compared only within their own group
(§8).

### 4.2 Normalized dataset
```
Dataset = {
  keys: number[] | string[],     // the comparison/lookup keys
  values?: unknown[],            // optional payload (KV records)
  keyType: "number" | "string",
  order: "as-loaded" | <generator descriptor>,
  size: n
}
```
Passed into WASM as typed arrays / transferables to minimize copy (numbers → a
single `Float64Array`/`Int32Array`; strings → length-prefixed UTF-8 buffer).

### 4.3 Inputs (all four data kinds chosen)
- **Numbers** — int/float columns; paste or CSV column.
- **Strings / text** — words, tokens, IDs, log lines (also feeds the trie).
- **Key–value records** — CSV/JSON rows; choose key field.
- **Synthetic generators** — uniform-random, **sorted**, **reverse-sorted**,
  near-sorted, gaussian, **zipfian / duplicate-heavy**, string corpora.

> **Lean into real data's shape.** A dataset's *order and distribution* is exactly
> what makes this empirical, not theoretical — e.g. already-sorted input into a
> naive BST degenerates to O(n). Pairing the user's real data with the synthetic
> generators (especially `sorted`/`reverse`) is a primary selling point and a
> built-in demo.

---

## 5. Visualization engine

- **Scale split (critical UX):** visualization runs at *small n only*. When the
  user's real dataset is large, we visualize a **representative sample** of it
  (preserving order/distribution where relevant), while the benchmark runs on the
  full data. The UI states this plainly.
- **Step-events:** teaching impls yield events like `compare(a,b)`, `visit(node)`,
  `move-pointer`, `rotate(node, dir)`, `rehash(oldCap→newCap)`, `probe(slot)`.
- **Renderer:** D3 + SVG for v1 (≤200 nodes is comfortable; far simpler than
  Canvas). Canvas/WebGL is a later optimization if needed.
- **Controls:** insert/search/delete a value; play / pause / step / step-back /
  speed; highlight the active comparison and the path taken.
- **Per-family visuals:** arrays as cells with index + shift animation; lists as
  node+pointer chains; hash tables as bucket arrays with chains/probing and
  rehash animation; trees with rotation animations; heap as array *and* tree view;
  trie as a character tree.

---

## 6. Benchmark engine & measurement methodology

This section is the technical crux. The value proposition lives or dies here.

### 6.1 Sweep
- Geometric size sweep, bounded by dataset size:
  `n ∈ {1k, 2k, 5k, 10k, 20k, 50k, 100k, …, ≤ dataset_size}`.
- **Real-data curves come from subsampling the user's dataset** to each n
  (order-preserving option for distribution-sensitive structures).
- Per n: warm-up rounds (discarded) → `r` repetitions → aggregate
  (median + p95, with error bars / IQR). Outliers trimmed.

### 6.2 Timing under a coarse clock (WASM has no native high-res clock)
- Time is **one `performance.now()` around a whole batch** of `k` operations
  executed *inside* a single WASM call; **per-op = elapsed / k**.
- `k` (and the work per call) is chosen large enough that elapsed time
  **dominates the clock clamp** (browsers clamp `performance.now()` to ~0.1–1ms+
  for security). The harness auto-grows `k` until elapsed ≫ clamp resolution.
- Runs in a **Web Worker** so the UI stays responsive; progress is reported back.
- Boundary overhead is amortized by doing all `k` ops inside one WASM call (no
  per-op JS↔WASM crossing).

### 6.3 Per-operation cost isolation — the named sub-design (Gap 1)

> The hard problem: you cannot time a single op (clock too coarse), but you also
> cannot naively time "a batch of inserts at size n" because **each insert changes
> n**, conflating per-op cost with the size sweep itself. Methodology is
> therefore *operation-specific*:

- **`search` (size-preserving) — clean:** pre-build the structure to size n, then
  time a batch of `k` lookups. Mix of present/absent keys is configurable.
- **`insert` / `delete` (size-mutating) — measure amortized cost *around* n:**
  - **Primary method — churn at fixed size:** pre-build to n, then time `k`
    *insert+delete pairs* that hold size ≈ n (insert a key, delete a key). This
    isolates the per-op cost at a stable n. Because a single op type can't
    net-preserve size, churn measures the **combined** insert+delete cost.
  - **Cross-check method — finite differences on cumulative build *and*
    teardown:** record cumulative *build* time at each sweep point and difference
    it (per-insert near n ≈ Δtime/Δn); likewise difference cumulative *teardown*
    time (per-delete near n). Build alone is inserts only — for an array that is
    O(1) append and would never reproduce churn's O(n) (delete-dominated) shape,
    so teardown is essential. The methods agree when
    `churn(n) ≈ insert_fd(n) + delete_fd(n)`, validated by the §12 self-test.
  - **The identity is structure-specific, not universal.** It holds *tightly* for the
    array because its costs are **position-uniform** (insert is a free append; any delete
    is O(n)). A **tree** breaks that symmetry: churn's spare keys ride the tree's
    **spines**, while the build inserts dataset keys at their **average depth**. So for
    both trees `insert_fd + delete_fd` sits at or above churn, and the two methods agree
    in **complexity class**, not constant. Every regime is pinned clock-free in the §12
    self-test (`structures::methodology`).
  - **Tree churn uses two keys, and the teardown alternates** (METHODOLOGY §4.1). A single
    key at `max + 1` walks only the *right* spine — which on **reverse-sorted** input (a
    *left* chain) is one node, so the BST's mutation measured **O(1)** while its search
    measured **O(n)**: a wrong class, not just a wrong constant. Churn therefore alternates
    `min − 1` and `max + 1` pair by pair and reports their **mean** (one pair stays one
    unit, keeping the tree series on the same per-pair axis as every other structure), and
    teardown removes the current **maximum and minimum in turn** so churn's deletes and the
    finite-difference delete stay on the same two paths. Both extremes are always
    leaf-or-one-child, so no teardown delete takes the two-child Hibbard path — delete-min
    provably so, even with duplicate keys, since nothing sorts left of the minimum;
    deleting the *root* instead would be O(1)/op on a chain and break the cross-check.
  - **Consequence for the BST mutation curve:** both spines are still cheaper than a random
    key (≈ ln n against an average depth of ≈ 2 ln n), so the BST's *measured mutation
    magnitude* stays low even with two keys. That is the deliberate price of a
    robustly-absent churn key and a Hibbard-free teardown, and it is harmless because the
    **shape** is right (O(log n)): per §2.3 a tree's mutation curve is read for its shape,
    never its absolute ns, exactly as op-count magnitude already is.
- Op-count signal uses the same isolation (counters read at the same points).

This sub-design is implemented and validated **first** (see §10, Phase 2).

### 6.4 Op-counters
- Cheap counters in the Rust impl (behind a flag): comparisons, probes,
  node-visits, swaps, rotations, char-steps — whichever is the declared cost
  metric for that structure (§8). Near-free; valid at full scale.

### 6.5 Honest caveats surfaced in the UI
- Wall-clock results are labeled **"measured on *this* machine/browser"**.
- Variance/error bars always shown.
- The methodology (batch size, reps, isolation method) is inspectable.

### 6.6 Uncertainty, regimes, and limits
The per-point rep spread (min → max) is drawn as error bars; reps are adaptive
(continue until the coefficient of variation meets a target, bounded); every
fitted slope carries a standard error and a 95 % CI; the local (per-interval)
slope is plotted so regime changes are visible; and the churn-vs-finite-
difference relationship is *structure-specific* (eight pinned regimes). All of
it, with the open hurdles (churn-key position bias, small-n overhead, cache
regimes, sequential ordering), is in [`METHODOLOGY.md`](METHODOLOGY.md).

---

## 7. Comparison & analysis

### 7.1 Charts
- **uPlot** for fast many-point line charts.
- Axes: linear / log-y / **log-log** (default for complexity reading).
- Multi-structure overlay for the *same operation* (e.g. search cost vs n for
  array / sorted-array / hashset / AVL).
- Toggle signal: **wall-clock (ns)** vs **op-count (shape)**.
- Theoretical reference curve (normalized) optionally overlaid.
- Export: results as CSV/JSON, chart as PNG.

### 7.2 Complexity-class fitter (secondary, honest — Gap 2)
- Least-squares fit over candidate bases {O(1), log n, n, n·log n, n²}.
- Reports **best fit + R²** and an explicit confidence note.
- **The log-log slope (read by the user) is the headline; the auto-label is a
  hint.** UI copy states that constant/linear/quadratic separate reliably but
  log n / n / n·log n are often empirically ambiguous.
- Shows inferred empirical class *next to* the registry's theoretical class, so
  divergence (e.g. sorted-data → naive BST → measured ~O(n) vs theoretical
  O(log n)) is visible and explainable — the registry (`src/registry.ts`) is
  the single source of the theoretical classes, and the overlay picks the
  *worst case* for a shape-sensitive structure on sorted input.
- Reports the slope **with its uncertainty** (OLS standard error, 95 % CI), the
  **local slope** per interval, the **tail slope**, and the local-slope
  **trend** — *falling* is the logarithm's signature, *rising* means a fixed
  overhead is masking growth. This is what lets the tool tell "O(log n)" from
  "O(1) + noise" honestly (METHODOLOGY §3).

---

## 8. Structure registry & catalog (all families chosen)

Each entry declares: ops, supported key types, theoretical complexities
(avg / worst), and the **cost metric** for the op-count signal. One fixed
algorithm per structure, implemented identically in TS and Rust.

### Linear
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| Dynamic array (unsorted) | O(1) amort. (append) | O(n) | O(n) | comparisons + shifts | delete = ordered shift-compact (scan, then shift the tail left) — *not* swap-remove, so iteration order is preserved for the teaching twin + conformance |
| Sorted array | O(n) | O(log n) | O(n) | comparisons + shifts | binary search |
| Singly linked list | O(1) head | O(n) | O(n) | node-visits | |
| Doubly linked list | O(1) head | O(n) | O(n) | node-visits | |

### Hashing
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| Hash map / set | O(1) avg, O(n) worst | O(1) avg, O(n) worst | O(1) avg | probes / chain-steps + hashes | **separate chaining** (canonical v1); load-factor-driven rehash animated; delete removes from the chain in place (order-preserving), table never shrinks |

### Trees / heaps
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| BST (unbalanced) | O(log n) avg, O(n) worst | same | same | comparisons | shows degeneration on sorted data |
| AVL (balanced) | O(log n) | O(log n) | O(log n) | comparisons + rotations | **AVL chosen** (cleanest rotations to animate) |
| Binary heap (min) | O(log n) worst, O(1) avg | — (peek O(1)) | O(log n) extract | comparisons + swaps | **different op set**: insert / peek / extract-min; "search" = O(n) scan, shown as a contrast. Compared only within its own group (risk R6) — the Compare UI gives it a separate section |

### Specialized (later phase)
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| Trie (prefix tree) | O(L) | O(L) | O(L) | char-steps | strings only; L = key length, independent of n |
| Skip list | O(log n) avg | O(log n) avg | O(log n) avg | node-visits / level-hops | probabilistic |
| Graph (adjacency list) | edge O(1) | traversal (BFS/DFS) | — | edge-visits | **own op set**; out of the insert/search/delete comparison; v1-late |

Comparisons are grouped: heap, trie, and graph compare only within compatible op
sets / data types; the core cross-structure comparison is the
insert/search/delete group on a shared key type.

---

## 9. Tech stack

- **Frontend:** React + TypeScript, **Vite**.
- **Bench engine:** **Rust → WASM** via `wasm-bindgen` + `wasm-pack`, run in a
  **Web Worker** (Comlink for ergonomics). Behind a `BenchEngine` TS interface.
- **Structure viz:** D3 + SVG.
- **Charts:** uPlot.
- **Curve fitting:** small least-squares routine in TS.
- **Testing:** Rust unit + `proptest`; TS unit (Vitest); cross-language
  conformance harness; Playwright smoke test for the UI later.
- **CI:** build WASM + TS, run all tests.

---

## 10. Phasing & milestones

> Strategy: a **thin vertical slice early** to de-risk the whole pipeline before
> breadth. Specialized structures last.

- **Phase 0 — Scaffold. ✅ done.** Vite + React + TS; `wasm-pack` pipeline; Web
  Worker + Comlink round-trip ("hello WASM"); `BenchEngine` interface defined; CI
  green. *Exit:* a number goes TS → Worker → WASM → back, in CI. (If the toolchain
  is painful here, the interface lets us start with a TS bench fallback — decision
  point recorded.)

- **Phase 1 — Data layer. ✅ done.** Import (CSV/JSON/paste/file), type detection,
  KV key-field picker, synthetic generators, normalized dataset + typed-array
  marshalling into WASM. *Exit:* load a real CSV and a generated `sorted` dataset.

- **Phase 2 — THIN SLICE (the de-risker). ✅ done.** Two contrasting
  structures — **dynamic array + hash set** — fully through *both* impls (TS
  teaching + Rust bench), the **measurement methodology of §6.3**, and one
  comparison chart.
  - **Concrete success criterion — ✅ met:** on a sweep, the chart shows
    **array-search rising linearly and hashset-search staying flat**, and the
    fitter labels them **O(n) / O(1)** with good R². Proven in headless Chromium
    (`verify:browser`): array slope ≈ 0.92 (R² 1.000), hashset slope ≈ 0.01
    (R² 0.999). This proves measurement + isolation + charting + the headline
    feature in one slice.
  - **Done:** Rust array + hash-set (numeric keys) with zero-overhead op-counters
    + proptest; pure/testable measurement orchestration (`src/bench/measure.ts`);
    `runSweep` across the `BenchEngine` boundary; the §7.2 fitter; the uPlot chart.
    **TS teaching impls** of both structures (`src/structures/`) — same algorithm
    as the Rust bench impls, with a bit-exact BigInt port of `mix_f64` — and the
    **cross-language conformance corpus** (R1, §12): a committed corpus generated
    from the Rust source of truth (`conformance/corpus.txt`) that both languages
    assert against (Rust re-checks it; TS reproduces it), pinning identical
    iteration order and per-search op-count across the empty/duplicate/multi-rehash
    cases.
  - **Done (§6.3 size-mutating measurement):** Rust `delete` for both structures
    (array ordered shift-compact; hash set order-preserving chain-remove) with
    zero-overhead op-counters + proptest vs a reference model; the **churn**
    primary (insert+delete pairs at fixed n) and the **finite-difference**
    cross-check (cumulative build → insert, cumulative teardown → delete) as pure
    testable orchestration (`measureMutationFd`); `runMutationSweep` across the
    `BenchEngine` boundary; and the **§12 methodology self-test** — stub cost
    shapes on a virtual clock proving `churn ≈ insert_fd + delete_fd` numerically
    and that both methods infer the same class. Proven on the real browser clock
    (`verify:browser`): array churn slope ≈ 1.04 (R² 1.000), hash-set churn slope
    ≈ 0.01; array delete slope ≈ 0.96 (R² 0.999).
  - **Done (string-key structures — Phase 2 exit):** Rust `ArrayStr` +
    `HashSetStr` built from the offsets+UTF-8 marshal layout (§4.2, R7) with the
    same op-counters + proptest as the numeric pair; a portable `mix_str` string
    hash (64-bit FNV-1a over the UTF-8 bytes → SplitMix64, factored to share the
    `splitmix64` finalizer with `mix_f64`) with a bit-exact TS twin and pinned
    anchors on both sides; the **TS string teaching twins** (`DynArrayStr`,
    `HashSetStr`); and a **second cross-language conformance corpus**
    (`conformance/corpus-str.txt`) whose cases include **multi-byte UTF-8** keys
    (accents, CJK, an emoji — byte-length ≠ char-length), pinning identical
    iteration order and per-search op-count across the two languages. The
    empty-string / `offsets[i]==offsets[i+1]` edge is covered by the structures'
    constructor tests (where the marshal decode lives). Wiring these into the
    sweep/chart UI — the only thing not done — is left to Phase 3/4 breadth, as
    the §10 success criterion (the numeric O(n) vs O(1) chart) is already met.

- **Phase 3 — Visualization breadth.** Mature animation (step controls,
  rotations, rehash, probing); add teaching impls for remaining Linear + Tree
  structures + heap.
  - **Done (batch 1 — the animation engine, on the two proven structures):** a
    typed **step-event model** (`src/viz/events.ts`) the teaching impls emit via
    an optional tracer threaded *alongside* the op-count logic — so a search
    stream's cost-event count equals its op-count, pinned against the Rust corpus
    (`src/viz/trace.test.ts`) so the animation shows *exactly* what the benchmark
    counts (§2.1, R1); the untraced path stays byte-identical (conformance
    unchanged). A structure-agnostic pure **Player** (`src/viz/player.ts`,
    materialized event list + frame cursor; step-back folds `events[0..f)` — no
    reverse-ops) with a React `usePlayer` (play/pause/step/back/seek/speed). Pure
    **fold reducers** (`src/viz/model.ts`) validated *against the real algorithm*
    (fold of an op's events == the structure's post-op state, including rehash
    relocation with stable ids). Plain-SVG renderers (array cells with
    shift-compact slide; hash buckets/chains with probe + animated rehash
    redistribution), step controls, and the `VizPanel` exploration UI wired
    additively into `App.tsx` (Phase 2 sweep + its `__sweepProof` mirrors
    intact). `delete` added to the TS array + hash-set teaching twins (ordered
    shift-compact / order-preserving chain-remove, mirroring Rust). Verified
    rendering in headless Chromium alongside the unchanged sweep gate. **No new
    deps.**
  - **Done (batch 2 — linear breadth, teaching twins + viz):** the rest of the
    **Linear** family (§8) as TypeScript teaching twins with step-event
    animation; their Rust bench twins (and a cross-language corpus) come in
    Phase 4. A **sorted array** (`SortedArrayF64`): binary search whose
    `sarr.compare` events carry the live `[lo, hi)` window so the renderer shades
    the eliminated halves (the O(log n) halving made visible); insert
    binary-searches the slot then shifts the tail *right* to open a gap and drops
    the value in; delete shifts *left* and pops (cost metric comparisons +
    shifts). The **singly + doubly linked lists** (`SinglyLinkedListF64` /
    `DoublyLinkedListF64`, sharing one `LinkedListF64` algorithm): O(1) head
    insert (0 node-visits), linear search/delete counted in node-visits; one
    `LinkedListView` draws both, the doubly variant adding back-pointers. The
    step-event ↔ op-count honesty gate (§2.1, R1) is extended: `sarr.compare`
    and `ll.visit` join `COST_EVENT_KINDS`, with `trace.linear.test.ts` pinning
    `countCostEvents == ops` for sorted-array *search* (insert/delete add the
    untagged `+ shifts` term by design) and for linked-list *search and delete*
    (pure node-visits; insert is 0). Fold reducers are proven against the real
    algorithm (`model.test.ts`, every prefix renderable / unique ids through the
    new shift directions), and `views.render.test.ts` renders **every animation
    frame** of each view to static SVG (the browser gate never clicks past the
    default sweep tab). Wired additively into `VizPanel` as three new tabs;
    `App.tsx` and the Phase 2 sweep untouched. **No new deps.**
  - **Done (batch 3 — the unbalanced BST, teaching twin + viz):** `BstF64`
    (`src/structures/bst.ts`) — an unbalanced **multiset** BST (`key < node` ⇒
    left, else right, so equal keys go right and never dedupe; in-order traversal
    is the sorted multiset). Cost metric **comparisons**: the *only* cost event is
    `bst.compare`, emitted where the comparison counter ticks, so the honesty gate
    (`trace.bst.test.ts`) pins `countCostEvents == ops` for **search, insert, *and*
    delete** (cleaner than the sorted array — no untagged shift term). Delete is the
    textbook **value-copy (Hibbard)** scheme: a two-child node takes its in-order
    successor's value, then the successor is unlinked; the successor min-walk
    (`bst.descend`) follows pointers, not comparisons, so it is deliberately not a
    cost event — the **Phase 4 Rust op-counter must mirror this** (documented on
    `bst.ts` + `events.ts`, risk R1). Step-events address nodes by **root path**
    (`'L'|'R'[]`, the tree analog of the linear structures' indices), so the dumb
    path-based reducer (`reduceBst`) never replays the search logic; the
    fold-mirrors-structure test (`model.test.ts`) compares the **full nested
    `{value,left,right}` shape** (not `keysInOrder()`, which is shape-invariant for
    BSTs — a right-chain and a balanced tree share an in-order). `BstView` lays
    nodes out by in-order rank × depth with stable ids (insert/delete shift ranks
    and the nodes transition to their new positions); `views.render.test.ts`
    renders **every frame** of leaf / one-child *either side* / two-child / root /
    empty deletes. New `binary search tree` tab in `VizPanel`; `App.tsx` and the
    sweep untouched. **No new deps.** Remaining: AVL + heap (batch 4), each
    TS-teaching + viz only (Rust twins are Phase 4).
  - **Done (batch 4 — the balanced AVL tree + the binary min-heap, teaching twins +
    viz):** the two remaining tree-family structures, each TS-teaching + viz only
    (Rust twins are Phase 4). This closes the Phase 3 teaching breadth — the Linear,
    Hashing, BST, AVL, and heap twins + viz are all in.
    - **AVL** (`AvlF64`, `src/structures/avl.ts`) — a height-balanced **multiset**
      BST sharing the unbalanced BST's ordering (`key < node` ⇒ left, else right) and
      value-copy (Hibbard) delete, but it retraces the insert/delete path to update
      node heights and **rotate** wherever a balance factor leaves {-1, 0, +1}. So
      where the BST tab degenerates to an O(n) chain on sorted input, the AVL tab
      stays O(log n) — the contrast the two tree tabs now make side by side. Cost
      metric **comparisons + rotations** (§8): *both* are tagged cost events
      (`avl.compare`, one per node on a find path; `avl.rotate`, one per single
      rotation — a double rotation is two), so the honesty gate `countCostEvents ==
      ops` holds for **search, insert, AND delete** (`trace.avl.test.ts`) — cleaner
      than the sorted array's untagged `+ shifts`. The in-order-successor walk
      (`avl.descend`) follows pointers, no comparison, mirroring the BST (risk R1, the
      Phase 4 Rust contract). The display model **reuses the BST's generic tree node**
      (identical `{id,value,left,right}`, via aliases); the one new reducer case,
      `rotateAtPath`, restructures a subtree **preserving node ids** so each node
      slides to its new place — proven by the fold-mirrors-structure test against the
      full *rebalanced* shape (`model.test.ts`; every rotating-insert/delete frame is
      uniquely-id'd and renderable). `AvlView` reuses the BST layout and **derives
      each node's balance factor from the drawn shape** (height is a pure function of
      subtree shape — no extra model state), tinting any |bf| ≥ 2 node so you watch
      imbalance appear and then a rotation fix it.
    - **Min-heap** (`MinHeapF64`, `src/structures/heap.ts`) — an array-backed binary
      **min-heap** with the §8 **different op set: insert / peek / extract-min**, plus
      an O(n) `search` kept as a deliberate **contrast** (a heap gives no membership
      shortcut). Insert sifts up; extract-min moves the last element to the root and
      sifts down. Cost metric **comparisons + swaps** (§8): `heap.compare` (sift),
      `heap.scan` (search), and `heap.swap` are the cost events, so `countCostEvents
      == ops` for insert, extract-min, and search (`trace.heap.test.ts`); `peek` is
      O(1) with no cost. It **reuses the array display model**; the new reducer cases
      (`heap.swap`, `heap.replaceRoot`) keep cell ids stable so the same chip animates
      in *both* the **array and the implicit tree** the renderer draws (§5: the child
      of `i` at `2i+1` / `2i+2`). The fold test pins the model to the backing array
      through insert/extract churn; the round-trip test heap-sorts (extract-all ==
      sorted multiset).
    - The `Controls` op-button row is now **configurable** so the heap can declare its
      own op set (the canonical insert/search/delete stays the default). Two new
      `VizPanel` tabs (`AVL tree`, `min-heap`); `App.tsx` and the Phase 2 sweep
      untouched. **No new deps.**

- **Phase 4 — Benchmark breadth + methodology hardening.** Warm-up/reps/variance,
  op-counters, churn + finite-difference isolation validated against each other,
  progress reporting; Rust bench impls for all core structures.
  - **Done (BST bench twin):** `bst::BstF64` (`bench-engine/src/structures/bst.rs`) —
    the production twin of the `src/structures/bst.ts` teaching impl, the first of the
    Phase 3 teaching-only structures to get its Rust bench impl. An **iterative,
    index-arena** multiset BST (`Vec<Node{value, left/right: Option<u32>}>` walked with
    loops, *not* a recursive `Box<Node>` tree) so the sorted-input degeneration to a
    10⁵–10⁶-deep right chain can't overflow the WASM stack (search/insert/delete/
    in-order/pre-order all flat). Cost metric **comparisons** behind the zero-overhead
    `const COUNT: bool` flag (§6.4); **Hibbard (value-copy) delete** whose
    in-order-successor walk carries no comparison — the §2.1/R1 contract the teaching
    twin fixed. Pinned to the TS twin by a dedicated **`conformance/corpus-bst.txt`**
    that — beyond the linear/hash corpus's in-order + per-probe `(found:ops)` — also
    pins the **tree shape** (pre-order with explicit null markers; in-order is
    shape-invariant) and a **delete sequence** with per-delete `(removed:ops)` across
    every Hibbard branch. Hand-computed Rust unit tests + a **proptest** (random
    insert/delete vs a sorted-multiset reference — correctness only; op-counts stay
    pinned by hand + the corpus, a reference reproducing them being circular). No
    `#[wasm_bindgen]` surface in that batch.
  - **Done (BST timed harness + engine/sweep wiring):** the `#[wasm_bindgen]` surface on
    `bst::BstF64`, mirroring `ArrayF64`: `search_n`/`search_counted` (size-preserving),
    the `churn_n`/`churn_counted` primary (insert+delete pairs at fixed n), and the
    `build_insert_*`/`teardown_*` finite-difference cross-check — reusing the Phase 2
    `measure.ts` orchestration unchanged (the BST satisfies the same structural runner
    interfaces). **Teardown deletes the current maximum repeatedly** — the rightmost node,
    always leaf-or-one-child (never the two-child Hibbard path), reached down the right
    spine exactly as the churn key (`max + 1`); deleting the root would be O(1)/op on a
    chain and break the cross-check. Engine wiring: `StructureId += 'bst'` and a dedicated
    `runBstMutationSweep` on the `BenchEngine` boundary (worker + Comlink), kept separate
    from `runMutationSweep` because a tree is **data-shape-sensitive** — sorted input
    degenerates to an O(n) chain with an O(n²) build, so the caller feeds a **balanced
    (shuffled)** dataset at modest n. Wired into `App.tsx` on a uniform dataset (publishing
    `__bstMutationProof`) and asserted in `verify:browser` — balanced-tree churn measures
    **sub-linear** on the real clock (slope ≈ 0.00, flat), the contrast to array O(n) /
    hashset O(1). **The open question — does `churn ≈ insert_fd + delete_fd` hold for a
    tree? — is answered both ways** by the clock-free §12 self-test
    (`structures::methodology`): **tight on the degenerate chain** (right spine ≡ the whole
    tree, like the array), but on a **balanced** tree the finite-difference sum *overshoots*
    churn (churn rides the cheap right spine ≈ 2 ln n while the build pays average depth
    ≈ 2 ln n per insert), so the methods agree only in complexity class — the honesty point
    is reported, not buried (§2.3, §6.3). Its **churn** series is now charted on the
    mutation comparison beside the array O(n) / hash-set O(1) (commit 53a5756); the FD
    insert/delete split stays published to `window` only (deferred breadth). **No new deps.**
  - **Done (AVL bench twin):** `avl::AvlF64` (`bench-engine/src/structures/avl.rs`) — the
    bench twin of the `src/structures/avl.ts` teaching impl, the balanced tree. Same ordering
    and **Hibbard (value-copy) delete** as the BST, but the cost metric is **comparisons +
    rotations** (a single rotation counts 1, a double counts 2; the retrace's height/balance
    arithmetic and the in-order-successor walk count nothing — the §2.1/R1 contract the
    teaching twin fixed). Deliberately a **recursive `Box<Node>` tree, *not* the BST's index
    arena**: the AVL invariant bounds height at ≈ 1.44·log₂n ≈ 29 for a million keys, so the
    deep-chain stack-overflow hazard that *forced* the arena is absent — and recursion mirrors
    the recursive teaching twin almost line-for-line, the surest guard against op-count drift
    (the recursion *is* the op-count spec). Pinned to the TS twin by a dedicated
    **`conformance/corpus-avl.txt`** that — like the BST corpus — pins **shape** (the only
    cross-language witness that the same rotations fired; in-order can't see them) and a
    **delete sequence**, with cases forcing every rotation kind: single (LL/RR), double
    (LR/RL), equal-keys-go-right-then-rebalance, and a *delete* that triggers a rotation (a
    distinct path from insert-triggered). Hand-computed Rust unit tests (the four rotation
    orders all converging to the same balanced `20{10,30}`) + a **proptest** that, beyond the
    BST's correctness checks, asserts the **balance factor ∈ {−1,0,+1} at every node after
    every op** (the AVL-specific invariant). The full `#[wasm_bindgen]` timed surface mirrors
    `BstF64` (`search_n`/churn/build-teardown, delete-max teardown — whose op-count now folds
    in the rebalancing rotations), wired via **`runAvlMutationSweep`** (a separate sweep call
    for per-structure tagging, **not** for shape-sensitivity — the AVL balances on *any* input,
    the whole point), published to `__avlMutationProof` and asserted **sub-linear** by
    `verify:browser`. Two findings live in the clock-free `structures::methodology` self-test:
    (1) the AVL stays **O(log n) on the exact sorted input that degenerates the BST to an O(n)
    chain** (a deterministic op-count contrast — `search`-max = n for the BST chain vs ≤ height
    for the AVL, and an O(n log n) vs O(n²) build), and (2) a **third** answer to the
    churn-vs-finite-difference question: unlike the array (tight) and the balanced BST (FD sum
    overshoots), here the two methods **agree closely** (~6%), with churn marginally the larger
    because it rides the full-height right spine while `insert_fd` reflects the shallower
    average depth. Its **churn** series is now charted on the mutation comparison alongside
    the BST (commit 53a5756); the FD insert/delete split stays published to `window` only
    (deferred breadth). **No new deps.**
  - **Done (sorted-array bench twin):** `sorted_array::SortedArrayF64`
    (`bench-engine/src/structures/sorted_array.rs`) — the bench twin of
    `src/structures/sortedArray.ts`, the first **Linear**-family teaching-only structure to
    get its Rust impl. A sorted multiset with **binary-search** lookup — the O(log n) **"missing
    middle"** between the unsorted array's O(n) scan and the hash set's O(1) — and shift-based
    insert/delete, cost metric **comparisons + shifts** (§8). The drift-prone half (R1) is the
    binary-search comparison count: `locate` mirrors the TS twin *exactly* — `mid = lo +
    (hi−lo)/2` (floored, == JS `>>> 1`), **one** comparison per midpoint, the `==` match
    short-circuit checked **before** the `<` branch, a half-open `lo < hi` window — hand-verified
    on `[10,20,30,40,50]` (`search(50)`=2, `search(35)`=3) before trusting the corpus. Pinned by
    a dedicated **`conformance/corpus-sarr.txt`**: unlike the BST/AVL corpora it carries no
    *shape* (a sorted array's iteration order *is* the sorted multiset, fully determined), but it
    is the **first corpus to pin a shift-inclusive op-count cross-language** — its delete sequence
    runs front / back / middle deletes so the `+ shifts` term agrees across the two languages
    (the unsorted array's corpus skipped deletes; BST/AVL deletes are pure comparisons).
    Hand-computed Rust unit tests + a **proptest** (random insert/delete vs a sorted-multiset
    reference — correctness only). The full `#[wasm_bindgen]` timed surface mirrors `ArrayF64`
    (`search_n`/churn/build-teardown), with **two mutation specifics** the module doc records:
    (1) churn rides the **front** (`min − 1`), not the tail — each op shifts the whole array, the
    honest O(n); a *tail* key would append/pop with zero shifts and read O(log n), and (unlike the
    BST's cheap right spine, the *same* O(log n) class as the average path, only a constant
    cheaper) the tail of a sorted array is a **different class** than the average position, so tail
    churn would *mislabel* the structure's mutation; and (2) the build must see **shuffled** input
    (ascending input is all appends → 0 shifts → `insert_fd` would read O(log n) and contradict the
    O(n) churn in the same proof). Two findings live in the clock-free `structures::methodology`
    self-test: (a) a **fourth** churn-vs-finite-difference regime — front churn *overshoots* the FD
    sum (≈ 2n vs ≈ 3n/2), both unmistakably O(n), the opposite direction from the balanced BST and
    distinct from the array's tight match and the AVL's close agreement; and (b) the structure's
    **signature split** — the *same* structure is O(log n) to **search** but O(n) to **mutate**.
    Engine wiring: `StructureId += 'sarr'` and the **search sweep now includes the sorted array**,
    so `runSweep` returns the three-way contrast (array O(n) / sorted O(log n) / hash set O(1)) —
    asserted in `verify:browser` (sorted-array search slope ≈ 0.23, R² 0.99, sub-linear and
    flatter than the array; the slope *band* is asserted, not the fitter label, since §7.2 can't
    reliably separate log n from constant). The **mutation** side stays Rust-only this slice: the
    `#[wasm_bindgen]` timed surface (front-churn, build/teardown) is ready and the methodology is
    proven by the self-test, but — exactly as the string structures left their impls ready with no
    TS `BenchEngine` method — the TS sweep + chart wiring waits for Phase 5 (a browser mutation
    curve would also be slow, both build and teardown being O(n²), and overhead-dominated at the
    small n that stays affordable). **No new deps.**
  - **Done (linked-list bench twin — the Linear family is complete):**
    `linked_list::LinkedListF64` (`bench-engine/src/structures/linked_list.rs`), the bench twin of
    *both* `src/structures/linkedList.ts` teaching twins at once. The singly and doubly lists are
    **bench-identical** under the **node-visit** cost metric (same head→tail order, same
    search/delete op-counts — the doubly's `prev` only buys an O(1) unlink-with-a-handle, but the
    unlink is uncounted in both and the find-walk dominates), so a second struct/corpus/sweep would
    be pure duplication: **one** impl + **one** `conformance/corpus-ll.txt` pin both, and the TS
    conformance test asserts *both* twins reproduce it. It is an **index arena**
    (`Vec<Node{value, next: Option<u32>}>`) by the repo's own rule — `Box`/recursion where height
    is bounded (the AVL), an arena where a deep chain would overflow the stack (the BST, and a
    linked list *is* that depth-n chain that rule exists for; `Box<Node>` would overflow on its
    recursive `Drop`). Cost metric **node-visits** behind the zero-overhead `const COUNT: bool`
    flag: **O(1) head insert** (0 visits) and **O(n) search/delete** (one visit per node from the
    head, short-circuit on match — the drift-prone R1 half, hand-verified against the TS twin before
    trusting the corpus). The corpus carries no shape dimension (a list's head→tail order *is* its
    structure) and pins head-insert reversal, duplicate handling (delete removes the head-most
    occurrence), and head/middle/tail/absent deletes. Hand-computed Rust unit tests + a **proptest**
    (random ops vs a `Vec` reference: prepend-insert, head-most delete — correctness only).
    **Search is wired into `runSweep` as a fourth series** (`StructureId += 'll'`), so the chart
    now shows array O(n) scan / linked-list O(n) pointer-walk / sorted-array O(log n) / hash-set
    O(1) — `verify:browser` confirms linked-list search reads **O(n) (slope ≈ 1.02, R² 1.000)** on
    the real clock, the same shape as the array via a different mechanism (§2.2) and visibly slower
    in absolute ns. The full `#[wasm_bindgen]` timed mutation surface is built and proven by the
    clock-free `structures::methodology` self-test, which records a **fifth churn-vs-finite-
    difference regime — a complexity-class *disagreement***: head-insert structurally places the
    churn key where deletion is O(1), so there is *no* size-preserving same-key churn that yields
    O(n) — churn (insert + delete-of-the-newest) is honestly **O(1)**, while the finite-difference
    teardown (delete the oldest/tail repeatedly, a full walk each) surfaces the canonical **O(n)**
    delete-by-value, so churn ≪ insert_fd + delete_fd (the two methods in *different classes*,
    after the array's tight match, the balanced BST's overshoot, the AVL's close agreement, and the
    sorted array's front-churn overshoot — all same-class). As with the sorted array the mutation
    side stays Rust-only this slice — a flat O(1) churn curve on the browser clock would look
    identical to the hash set — so the TS sweep wiring waits for Phase 5. **No new deps.**

  - **Done (min-heap bench twin — the Trees/heaps family complete, §8):**
    `heap::MinHeapF64` is the bench twin of `src/structures/heap.ts` — an array-backed
    complete tree (a multiset; cost metric **comparisons + swaps**), iterative sift loops
    with no arena, since a heap's height is ⌊log₂ n⌋ by construction and there is no
    degenerate-chain stack hazard to design around. Pinned to the teaching twin by
    `conformance/corpus-heap.txt`, whose dimensions differ from the trees': the **array
    layout** (the multiset alone does not determine it, so this is the line that catches a
    divergent sift tie-break — extracted *values* come out ascending whatever the tie-break
    does) plus an **extract sequence** exercising all six counting rules at once. Six hand-
    computed Rust unit tests pin those rules individually.
    **The op set is different, and that is enforced, not just documented.** A heap does
    insert / peek / extract-min; `search` exists only as the deliberate **O(n) scan
    contrast**. `StructureId += 'heap'`, and the registry gains `CANONICAL_STRUCTURES` /
    `isCanonical`, through which the Compare UI filters the shared charts — so the heap
    can never land beside structures doing a different job (risk R6). It renders in its
    own section: its add+remove pair, its insert/extract split, and its scan shown next to
    the array's *already-measured* scan as the "a heap is not a lookup structure" contrast.
    **Churn is `insert(min − 1)` + `extract_min()`, and the low key is forced, not
    preferred:** a heap has no delete-by-value, so the pair must be insert-then-extract-min,
    and only a key strictly below every stored key is the one the extract takes back. With
    `max + 1` the extract removes a *real* key and the heap **drains** — pinned by its own
    Rust test so nobody "simplifies" it to the recipe the flat structures use. The worker's
    `churnRunnerFactory` is now parameterised by a `ChurnKeyPicker` (`aboveMax` / `belowMin`)
    instead of hardcoding `max + 1`; the sorted array and linked list will need the same seam
    when their mutation is wired.
    The self-test records an **eighth churn-vs-finite-difference regime**, and a new kind:
    the two methods agree in class on the *total* (churn 53 vs sum 34.9 at n = 4000, both
    Θ(log n)) while their **insert halves disagree on class** — churn's insert is the
    worst-case insert by construction (a new global minimum climbs the full height) whereas a
    shuffled build's marginal insert is O(1), because most of a heap is leaves. A narrower
    version of the linked list's disagreement, where the totals diverged too. Two further
    clock-free findings: the heap's signature split (**O(n) search vs Θ(log n) extract-min**
    on the same structure — the sorted array's split inverted), and that the **build** is
    order-sensitive (ascending is its best case, Θ(n); descending its worst, Θ(n log n))
    while **churn is not**, which is why the heap is *not* registered as shape-sensitive —
    one flag cannot say "ascending best, descending worst" when `inputShapeOf` collapses both
    into one `sorted` shape. `verify:browser` gained heap checks on both passes: the scan
    reads **O(n)** (slope ≈ 1.0, ratio ≈ 6000×) and churn stays **sub-linear** (slope ≈ 0.14)
    on uniform input and **still sub-linear on reverse-sorted** (≈ 0.10) — a heap cannot
    degenerate. The insert-vs-extract asymmetry is asserted on **magnitude, not slope**
    (measured 7.5× per-op): both series are sub-linear so there is no class gap for a slope
    comparison to catch, and the finite-difference insert slope is noise-dominated at these
    sizes (0.31 ± 0.21) — METHODOLOGY §4 hurdle 7 in the wild. **No new deps.**

- **Phase 5 — Comparison / analysis.** Multi-overlay, log-log, fitter with
  honesty UI, theoretical overlay, export.
  - **Done (first slice — one dataset, every structure; honesty instruments):**
    - **Compare runs on a user-chosen dataset.** `src/compare/runSweeps.ts` is the
      pure orchestration (dataset → sweep sizes capped by the dataset → every
      engine sweep → fits → the `window.__*Proof` mirrors), unit-tested against a
      fake `BenchEngine`; `ui/DatasetPicker` offers the §4.3 generators (uniform,
      sorted, reverse-sorted, near-sorted, gaussian, zipfian) or pasted CSV/JSON
      with a key field; `ui/CompareSection` renders. Every sweep point is an
      order-preserving *prefix* of the dataset, so the same distribution and order
      reach the array, lists, hash set and both trees — "sorted data kills a naive
      BST" is now something the user *does* (pick `sorted`, watch the BST churn
      leave the AVL). The default auto-run (the runtime gate's input) is one
      uniform dataset for every structure, replacing the previous sorted-for-linear
      / uniform-for-trees split. `App.tsx` is layout only.
    - **Structure registry** (`src/registry.ts`, §3 layer 2): label, family,
      colour, cost metric, mechanism, average + worst theoretical classes per op,
      shape-sensitivity; `theoreticalClass(structure, op, shape)` picks the worst
      case for a shape-sensitive structure on sorted input. Colours and labels now
      come from one place.
    - **Fitter uncertainty** (`fit.ts`): slope ± OLS standard error and a 95 % CI;
      per-interval local slopes; tail slope; local-slope trend (t-tested) — the
      falling trend is how O(log n) is told from flat (METHODOLOGY §3).
    - **Measurement hardening** (`measure.ts`): min/max rep spread per point;
      adaptive reps to a coefficient-of-variation target, bounded by `maxReps`;
      conservative spread propagation through the finite-difference split.
    - **Charts**: rep-spread error bars (canvas hook), dashed theoretical overlay
      least-squares-scaled onto each series, legend with slope ± stderr,
      responsive width; a **local-slope panel** (`ui/SlopeChart`) with O(1)/O(n)/
      O(n²) guides; CSV/JSON export with provenance columns (`ui/export.ts`).
    - The browser gate additionally asserts the published compare meta and that
      every fit carries finite uncertainty fields. **No new deps.**
  - **Done (two-key tree churn — the honesty fix, METHODOLOGY §4.1):** a tree's
    add/remove cost was probed with one spare key, `max + 1`, and torn down by
    repeatedly deleting the maximum — both of which walk only the **right** spine. On
    **reverse-sorted** input the naive BST is a *left* chain whose right spine is a single
    node, so the chart reported a flat **O(1)** mutation curve for a structure whose search
    on the same data is **O(n)**: a wrong complexity *class*, the worst thing this tool can
    say. `BstF64`/`AvlF64` now take **two** churn keys (`set_churn_keys(min − 1, max + 1)`),
    alternate them pair by pair — the flag persists across calls, so even the measurer's
    one-pair warm-up batches see both ends — and `churn_counted` returns the two pairs'
    **mean**, so one measured unit is still one insert+delete pair and the tree series stays
    on the same axis as every other structure (and comparable with the per-marginal-op
    `insert_fd + delete_fd`). **Teardown alternates delete-max / delete-min**, without which
    churn's deletes and the finite-difference delete would no longer measure the same paths
    — the precondition the whole cross-check rests on. Both extremes stay leaf-or-one-child,
    so no Hibbard two-child copy enters the teardown; delete-min is provably safe even with
    duplicate minima (nothing sorts left of the minimum), pinned by its own Rust test. The
    flat structures are deliberately **untouched** — the sorted array's *front* churn and the
    linked list's *head* churn are documented findings (§2.3 regimes 6 and 7), so the worker
    keeps a separate single-key runner for them and adds a `treeChurnRunnerFactory` used only
    by the two tree sweeps. Two self-test findings moved and are re-derived, not predicted:
    the sorted-input **chain** is no longer a tight churn-vs-FD match (churn 1002 vs sum
    1500) — its *delete* halves still agree exactly, which is what alternating the teardown
    buys, while the insert halves cannot, since the build drops every key at the chain's
    bottom; and the AVL's close agreement widened from ~6 % to ~10 %. A new self-test pins
    the fix itself: on reverse-sorted input the old one-keyed recipe reads ≤ 3 ops while the
    two-key recipe reads > n/4, and `verify:browser` gained a **second pass**: it drives the
    picker to reverse-sorted and asserts on the *real clock* that BST churn now reads O(n)
    (measured slope 1.00, R² 1.000, ratio 8× across the sweep) while the AVL stays sub-linear
    (0.16) on the same input — the curve the user actually sees, which no op-count test can
    prove. UI copy on the reverse-sorted callout, METHODOLOGY §2.3/§4.1/§5 and this section
    updated to match. **No new deps.**
  - **Open:** string-key sweep wiring; presets ("sorted data kills a naive BST"
    as one click); PNG export; interleaved structure order per sweep point.

- **Phase 6 — Specialized + polish.** Trie, skip list, graph; presets/demos
  (e.g. "sorted data kills a naive BST"); persistence of sessions; docs;
  performance polish (Canvas if needed).

---

## 11. Risks & mitigations

| # | Risk | Mitigation |
|---|------|------------|
| R1 | **Dual-impl drift** (TS teaching vs Rust bench diverge) | One fixed algorithm per structure, implemented identically; **algorithm-level conformance tests** (§12), not just result-equality. Single-impl alternative recorded but not chosen. |
| R2 | **Browser clock clamp / precision** | Batch timing inside one WASM call; auto-grow batch until elapsed ≫ clamp; warm-up + reps + variance; label results machine-specific (§6.2). |
| R3 | **Fitter mislabels adjacent classes** (n vs n·log n) | Log-log slope is primary; auto-label secondary with R²/confidence caveat; honest UI copy (§7.2). |
| R4 | **Viz can't draw 1M nodes** | Hard mode split: viz on a small representative *sample*; bench on full data; UI states it (§5). |
| R5 | **WASM + Worker toolchain heavier than expected** | `BenchEngine` interface allows a TS fallback; Phase 0 is the go/no-go on tooling. |
| R6 | **Non-uniform op semantics** (heap/trie/graph) | Registry declares per-structure op sets + cost metric; comparisons grouped by compatible ops/types; charts labeled shape-only for op-counts. |
| R7 | **WASM data-transfer overhead** for big datasets | Typed arrays / transferables; build structure inside WASM from a single passed buffer. |
| R8 | **Scope** (all families × all data types is large) | Strict phasing; thin slice first; specialized structures last. |

---

## 12. Testing strategy

- **Rust:** unit tests + `proptest` (random op sequences vs a reference model —
  e.g. compare against `std::collections` / a sorted `Vec`).
- **TS:** Vitest unit tests for teaching impls and the data layer.
- **Conformance (cross-language):** a shared corpus of op sequences run through
  both the TS teaching impl and the Rust bench impl; assert **identical
  observable results** — membership, iteration/traversal order, and **op-count**
  for the same sequence. This catches algorithm-level drift (R1), not just result
  drift.
- **Methodology self-test:** the §6.3 churn method and the finite-difference
  method must agree within tolerance on known structures (array O(n), hashset
  O(1)); this is part of Phase 2's exit.
- **UI:** Playwright smoke (load data → run bench → see chart) from Phase 5.

---

## 13. Open questions (revisit during build, not blocking)

- Hash table: stay with separate chaining, or add open-addressing as a *second*
  selectable variant once the framework is proven? (Great comparison once cheap.)
- Balanced tree: AVL chosen; offer red-black as an alternative later for a
  balancing-scheme comparison?
- Session persistence: local-only (IndexedDB) vs shareable URLs/exported files?
- How far to push absolute-time comparability across machines (probably: don't —
  keep it explicitly relative).
- ~~Churn-key position bias: add a second churn key (`min − 1`) and alternate, so a
  tree's measured mutation isn't a right-spine reading?~~ **Done** (Phase 5,
  METHODOLOGY §4.1). The remaining, narrower question: both spines are still cheaper
  than a random key, so should churn also offer a *representative* mode that inserts
  and deletes at an average-depth key (at the cost of a key that is only probably
  absent)?
- Interleave structures per sweep point to cancel frequency/thermal drift
  between sequential sweeps (METHODOLOGY §4.5)?
- Configurable present/absent probe mix (§6.3), and reporting *stored* size next
  to *input* size for de-duplicating structures (METHODOLOGY §4.8–4.9).

---

## 14. Next steps

1. Finish Phase 4: wire the sorted-array and linked-list *mutation* surfaces into
   the browser sweep (both are built and clock-free-proven in Rust; only the sweep
   wiring is missing), and the string structures. The churn-key selector the worker
   now takes (`aboveMax` / `belowMin`) is the seam those need.
2. Phase 5 remainder: string-key sweep; one-click presets; PNG export; the
   interleaving experiment from §13.
3. Promote `verify:browser` to a blocking CI gate once its slope bands prove
   stable on shared runners.
