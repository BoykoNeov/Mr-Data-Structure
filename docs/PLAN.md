# Mr Data Structure — Project Plan

> An interactive tool for **exploring** data structures through rich animated
> visualization, and for **empirically comparing** their add / remove / search
> cost on the user's *own real data* — not on textbook formulas.

Status: **Phase 2 in progress** — the thin slice's *headline* has landed. An
unsorted dynamic array and a separate-chaining hash set now run through the
Rust/WASM engine, the §6.3 search-measurement methodology (pure, testable
orchestration + batched WASM primitives), the §7.2 complexity-class fitter, and
a log-log comparison chart. The §10 success criterion is proven in headless
Chromium on the real browser clock: **array search → O(n) (slope ≈ 1), hash-set
search → O(1) (slope ≈ 0)**. The dual-impl spine (§2.1) is now closed for both
structures: TypeScript teaching twins run the same algorithm, and a
cross-language conformance corpus (§12, R1) holds the two languages to identical
iteration order and per-search op-count. The **size-mutating methodology (§6.3)
has now landed**: insert/delete via churn (the combined-cost primary) plus the
finite-difference cross-check (per-insert from cumulative build, per-delete from
cumulative teardown), with the §12 self-test proving the two methods agree. On
the real browser clock the headline holds — **array churn → O(n) (slope ≈ 1),
hash-set churn → O(1)**; the finite-difference split reads array delete O(n) /
insert flat. The only Phase 2 exit work left (§10/§12) is the **string-key bench
structures**. (Phase 1 — data layer — is complete: CSV/JSON + generators →
normalized `Dataset` + marshalling.) See §10.

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
  O(log n)) is visible and explainable.

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
| Binary heap (min) | O(log n) | — (peek O(1)) | O(log n) extract | comparisons + swaps | **different op set**: insert / peek / extract-min; "search" = O(n) scan, shown as a contrast |

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

- **Phase 2 — THIN SLICE (the de-risker). 🚧 in progress.** Two contrasting
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
  - **Remaining for Phase 2 exit:** the **string-key** bench structures — the next
    pairing, landing the Rust + TS string variants together so both languages
    exercise the offsets+UTF-8 marshal layout (and the string conformance corpus)
    at once.

- **Phase 3 — Visualization breadth.** Mature animation (step controls,
  rotations, rehash, probing); add teaching impls for remaining Linear + Tree
  structures + heap.

- **Phase 4 — Benchmark breadth + methodology hardening.** Warm-up/reps/variance,
  op-counters, churn + finite-difference isolation validated against each other,
  progress reporting; Rust bench impls for all core structures.

- **Phase 5 — Comparison / analysis.** Multi-overlay, log-log, fitter with
  honesty UI, theoretical overlay, export.

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

---

## 14. Immediate next step (needs approval)

Begin **Phase 0** (scaffold + WASM round-trip + `BenchEngine` interface + CI).
Nothing is built until this plan is approved.
