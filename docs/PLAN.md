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
| 4 | Rust bench twins: BST, AVL, sorted array, linked list (Linear family complete), min-heap (Trees/heaps complete); churn-vs-FD regimes pinned clock-free | ✅ done — every bench twin, **numeric and string**, is wired into the browser sweep, search *and* mutation |
| 5 | comparison/analysis: **one user-chosen dataset drives every sweep** (generators incl. sorted/reverse/near-sorted/zipfian/string corpus, or pasted CSV/JSON); structure registry; theoretical overlay; rep-spread error bars; slope ± stderr/CI, local-slope panel, tail slope + trend; adaptive reps; one-click presets; CSV/JSON/PNG export | ✅ done — the interleaving experiment (§13) stays an open question, not a dropped feature |
| 6 | trie, skip list, graph; presets/demos; persistence; polish | 🟡 in progress — the **trie** is complete end to end (Rust bench twin + TS teaching twin + conformance + the string Compare run + the browser gate) and has its **own step-animation** in Explore, the first animated structure with string keys and the first drawn one node per UTF-8 *byte*. The **skip list** is now measured end to end too: O(log n) with no rebalancing at all, its node heights derived from each key's hash rather than a coin, so the structure is a pure function of its key *set* — and it now has **its own step-animation** in Explore, drawing the express lanes as the real skips they are and highlighting the walk's stand-point and its compared node separately (so a hit's level-0 double comparison is visible). The **graph** is complete end to end: an own-op-set adjacency-list multigraph whose BFS and DFS cost the same `V + 2E` in different orders, pinned clock-free (METHODOLOGY §2.7), **measured** in its own Compare section on a V-sweep and a degree-sweep (synthetic graphs or the user's own edge list, plotted against the reached component's `V′ + 2E′`), and **animated** in Explore (BFS and DFS beside their adjacency lists, DFS shown mark-on-push). Four more numeric structures are measured end to end: an **open-addressing hash set** held to the chaining set's table sizes — now **animated** too (slot strip with tombstones, the probe walk, purge vs double) — a **red-black tree** on the AVL's metric, also **animated** (colours, each CLRS fix-up case as its own step, recolours outside the count), a **B-tree** (not yet animated) and a **doubly linked list** (METHODOLOGY §2.8–§2.11), whose teaching twin now holds real back links that Explore draws, each pointer write a free step. The search workload's **hits-vs-misses mix** is a user choice, de-duplicating structures report **stored size** beside input size, and a **session is remembered** in this browser (never its results). Open: the B-tree animation, graph exports, and performance polish |

Headline results, all on the real browser clock unless noted: array search O(n)
vs hash-set search O(1) (the Phase 2 criterion); sorted-array search sub-linear
and linked-list search O(n) by a different mechanism; array churn O(n) vs
hash-set O(1); the **sorted array cheap to read and expensive to write** — a
sub-linear search and an O(n) add/remove on the same run; the **linked list's
two answers at once** — an honestly flat O(1) add-and-remove of a key it just
put at its own head, next to the honestly O(n) removal of a key already stored,
the one place the project's two measurement methods land in different
complexity classes (METHODOLOGY §2.3 regime 7, and the UI says so beside the
chart rather than letting the flat line pass for speed); BST and AVL churn
sub-linear on shuffled input; and — clock-free,
on exact op-counts — the AVL stays O(log n) on the sorted input that turns the
BST into an O(n) chain, plus twelve churn-vs-finite-difference regimes across the
structures (METHODOLOGY §2.3). Tree mutation is probed at **both ends** of the
key range, so a reverse-sorted chain can no longer report a flat O(1) curve
(METHODOLOGY §4.1). The **min-heap** completes the bench twins with its own op
set — insert / peek / extract-min, its add+remove pair reading O(log n) and its
"search" the deliberate O(n) scan that shows a heap is not a lookup structure —
and is kept off the shared charts, since comparing it to the others would be
comparing different operations (§8, risk R6). With **string keys** the array and
hash set keep their classes — O(n) scan, O(1) lookup — and gain a second cost
axis the classes cannot express: *hashing a string costs more than hashing a
number while staying just as flat* (14.1 ns vs 4.2 ns on one gate run), and
raising the key-length control lifts that flat line again without tilting it —
O(1) in the number of keys, O(L) in the size of one (METHODOLOGY §2.5). Phase 6
puts a **trie** on that same chart, which turns one flat line into two flat lines
that are flat for unrelated reasons: the hash set reads the whole key once and
jumps, the trie takes one branch per byte and never hashes at all — so "constant"
and "cheap" come apart on one picture (its search beats the string scan ~500× at
the top of the sweep while both stay in their own classes). Phase 6's numeric
addition is the **skip list**, which puts a second sub-linear search on the main
chart and then separates itself from the first one: the sorted array and the skip
list agree on read cost and disagree on write cost, because keeping an array in
order costs a shift of everything after the change while splicing a node into a
few express lanes costs the same O(log n) the lookup did. And it is the third
answer to the input that kills a naive BST — the AVL survives reverse-sorted keys
by **rotating**, the skip list by never having had a shape to lose, since its node
heights come from each key's hash rather than from a coin or from the order the
keys arrived in (METHODOLOGY §2.6). The rest of Phase 6's structures each answer a
"which variant?" question on exact op-counts. A **red-black tree** on the AVL's
metric never rotates more than twice per insert or three times per delete where one
AVL delete took ten — but in totals saves only ~18 % of rotations on random inserts,
nothing elsewhere, and pays 68 % more comparisons on a sorted build (METHODOLOGY §2.9). A
**B-tree** makes the AVL's comparison count in a quarter of its node hops, and is the
first tree whose churn agrees tightly with its finite-difference split; whether the
fewer hops show on the clock is logged, not claimed (METHODOLOGY §2.10). An **open-addressing hash
set**, on the chaining set's exact table sizes, pays Knuth's primary-clustering price
(a miss 7.7 probes vs chaining's 1.7 at α ≈ 0.73) while staying flat, behind a
tombstone policy without which its churn would chart as growing with n (METHODOLOGY §2.8). And a
**doubly linked list** draws the singly list's curves exactly — equal op-counts,
pinned — because a back pointer only helps remove a node you already hold (METHODOLOGY §2.11).
The **graph**, measured on two sweeps, shows BFS and DFS at the same `V′ + 2E′` and
the `+E` term only where `V` is held fixed (METHODOLOGY §2.7).

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
  trie as a **byte** tree — one node per UTF-8 byte, not per character, because
  that is what both twins walk; a terminal ring marks where a stored key ends,
  which is what makes "reaching a node ≠ finding a key" visible (**built**, Phase 6);
  graph as vertices + edges beside its adjacency lists, the frontier drawn as a
  queue / stack, and DFS shown mark-on-push (**built**, Phase 6).

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
  time a batch of `k` lookups. Mix of present/absent keys is configurable
  (0 / 25 / 50 / 75 / 100 % present, default 50 — Phase 6, METHODOLOGY §2.2).
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
    **spines**, while the build inserts dataset keys at their **average depth**. So the
    two methods agree in **complexity class**, not constant: the sum sits above churn
    where the spines are cheap (BST, skip list), below it where they are full-height
    (AVL, red-black), and agrees tightly only for the B-tree, whose leaves all sit at one
    depth (METHODOLOGY §2.3). Every regime is pinned clock-free in the §12 self-test
    (`structures::methodology`, and `structures::methodology_btree`).
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
difference relationship is *structure-specific* (twelve pinned regimes). All of
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
| Doubly linked list | O(1) head | O(n) | O(n) | node-visits | **Measured (Phase 6)** as its own bench twin with real `prev` links. Every op-count equals the singly list's on the same sequence — `prev` only speeds unlinking a node you already hold, which delete-by-key never does. Costs 24 B/node vs 16. Churn is the singly list's regime-7 O(1) (METHODOLOGY §2.11) |

### Hashing
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| Hash map / set | O(1) avg, O(n) worst | O(1) avg, O(n) worst | O(1) avg | probes / chain-steps + hashes | **separate chaining** (canonical v1); load-factor-driven rehash animated; delete removes from the chain in place (order-preserving), table never shrinks |
| Hash set (open addressing) | O(1) avg, O(n) worst | O(1) avg, O(n) worst | O(1) avg | hashes + slot probes | **Built (Phase 6).** Linear probing, set semantics, with the chaining set's hash / start size / 0.75 threshold / doubling, so both tables share a load factor at every n. Delete leaves a **tombstone**; insert reuses the first one on its path; tombstones count toward the load (purge in place or double). Counted on the chaining convention — occupied slots examined, the empty slot that ends a walk free (METHODOLOGY §2.8) |

### Trees / heaps
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| BST (unbalanced) | O(log n) avg, O(n) worst | same | same | comparisons | shows degeneration on sorted data |
| AVL (balanced) | O(log n) | O(log n) | O(log n) | comparisons + rotations | **AVL chosen** (cleanest rotations to animate) |
| Red-black tree | O(log n) | O(log n) | O(log n) | comparisons + rotations | **Built (Phase 6).** Classic CLRS (not left-leaning), the AVL's multiset / equal-keys-right / value-copy-delete semantics and its metric, so the two compare unit for unit; recolours counted separately, not in the metric. Height ≤ 2·log₂(n+1) (looser than the AVL's ≈ 1.44·log₂ n) in exchange for ≤ 2 rotations per insert, ≤ 3 per delete (METHODOLOGY §2.9) |
| B-tree (t = 16) | O(log n) | O(log n) | O(log n) | comparisons + splits/merges/borrows | **Built (Phase 6).** Up to 31 keys a node; balanced by construction (every leaf at one depth), so no input order changes its class — sorted input only leaves nodes half full. Multiset. Search is a lower-bound descent to a leaf with **one deferred equality test**: ≈ log₂ n comparisons, the AVL's count, in ≈ log_t n node-visits. Insert: CLRS proactive split; delete: **repair on underflow**, *not* CLRS's single-pass pre-fill, which thrashes split/merge on churn (METHODOLOGY §2.10) |
| Binary heap (min) | O(log n) worst, O(1) avg | — (peek O(1)) | O(log n) extract | comparisons + swaps | **different op set**: insert / peek / extract-min; "search" = O(n) scan, shown as a contrast. Compared only within its own group (risk R6) — the Compare UI gives it a separate section |

### Specialized (later phase)
| Structure | insert | search | delete | cost metric | notes |
|-----------|--------|--------|--------|-------------|-------|
| Trie (prefix tree) | O(L) | O(L) | O(L) | char-steps | strings only; L = key length, independent of n. **Built (Phase 6).** The `O(L)` here is in the *key*; `src/registry.ts` declares the class **in n**, which is `O(1)` for all four slots, and carries the L in `costMetric`. Both are the same statement in the two notations the project uses — the registry's `ComplexityClass` has no term for key length |
| Skip list | O(log n) avg | O(log n) avg | O(log n) avg | node-visits | **Built (Phase 6).** O(n) worst (every key in one lane). Cost metric is **node-visits** — one key comparison per node inspected; dropping a level is a pointer move and costs nothing, the same rule that makes the BST's successor walk free. "Probabilistic" with **no random numbers**: a node's height is `1 + min(23, trailing_zeros(splitmix64(to_bits(key) ^ salt)))`, geometric with p = ½ but a pure function of the key, so the list is a function of its key *set* — no RNG state to keep the op-count signal reproducible under, and no order that can unbalance it. The guarantee moves from a coin to the key distribution (METHODOLOGY §2.6) |
| Graph (adjacency list) | edge O(1) | traversal (BFS/DFS) O(V + E) | — | vertex-visits + edge-visits | **own op set**; out of the insert/search/delete comparison. **Built, measured and animated (Phase 6).** Undirected multigraph; a traversal costs exactly `V′ + 2E′` of the source's component. Measured in its own Compare section on two sweeps (V at fixed degree; degree at fixed V), x-axis = the reached component's `V′ + 2E′`; registry entry is its own `GraphStructureInfo`, `!isCanonical` (METHODOLOGY §2.7) |

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
    reliably separate log n from constant). The **mutation** side stayed Rust-only *this* slice: the
    `#[wasm_bindgen]` timed surface (front-churn, build/teardown) is ready and the methodology is
    proven by the self-test, but — exactly as the string structures left their impls ready with no
    TS `BenchEngine` method — the TS sweep + chart wiring waited for Phase 5 (a browser mutation
    curve would also be slow, both build and teardown being O(n²), and overhead-dominated at the
    small n that stays affordable). **No new deps.** *(Landed in Phase 5 — see "flat-family
    mutation on the browser clock" below; the front-churn curve reads O(n) on the real clock.)*
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
    side stayed Rust-only *this* slice — a flat O(1) churn curve on the browser clock would look
    identical to the hash set — so the TS sweep wiring waited for Phase 5. **No new deps.**
    *(Landed in Phase 5 — see "flat-family mutation on the browser clock" below. The concern was
    right and was answered rather than dissolved: the flat line now ships with a caveat box beside
    the chart and with the O(n) delete-by-value curve it must be read against, and the browser gate
    pins both halves so the pair cannot drift back to one reassuring line.)*

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
    (measured 7.5× and 10.6× per-op on two runs): both series are sub-linear so there is no
    class gap for a slope comparison to catch, and the heap's finite-difference halves are
    noise-dominated at these sizes — insert came out 0.31 ± 0.20 and 0.26 ± 0.28, and one run
    *mislabelled* extract-min as O(n log n). METHODOLOGY §4 hurdles 2 and 7 in the wild, now
    written up there: the heap's textbook **O(1) average insert is a theory claim this
    project states but cannot measure** (the churn probe is pinned to the worst case by
    construction, and the average-case reading is too noisy to separate O(1) from O(log n)),
    so only the clock-free op-count proof carries it. **No new deps.**

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
  - **Done (flat-family mutation on the browser clock — the last Phase 4 leftover):**
    the sorted array and the linked list now run their add/remove sweeps in the browser, so
    all four flat structures publish a churn primary plus a finite-difference split (twelve
    series where there were six). No Rust changed: both twins already had the full
    `#[wasm_bindgen]` timed surface, and `churnRunnerFactory` already took the
    `ChurnKeyPicker` seam the heap slice added — `runMutationSweep`'s table just widened to
    `[StructureId, Ctor, ChurnKeyPicker]`.
    **The churn key is the whole measurement decision, and it differs per structure.** The
    sorted array takes `min − 1`, deliberately the **front**: a tail key would append and pop
    with zero shifts and the chart would report **O(log n)** mutation for a structure whose
    insert and delete are honestly O(n) — the key's position, not the structure, setting the
    class. On the real clock its churn now reads **O(n)** (slope ≈ 0.84, ratio ≈ 5.7×) while
    its search on the same run is sub-linear (≈ 0.24): the signature split — cheap to read,
    expensive to write — which until now existed only in op-counts.
    **The linked list is the honest hard case this wiring was deferred for**, and the answer
    is to show both curves, not to hide one. Its churn is flat **O(1)**, and that is true:
    the list head-inserts, so the key the pair then deletes is the first one it looks at, and
    *no* key choice makes a same-key churn expensive on this structure. Read alone that line
    sits beside the hash set's and reads as "cheap list" — but the hash set is flat for *any*
    key, and the list only for the one it just placed itself. The cost that matters, removing
    a key already stored, is the finite-difference `delete`, which reads **O(n)** on the same
    run (slope ≈ 1.15, ratio ≈ 11.5×, and 562× the per-op cost of churn at the top of the
    sweep). So the UI gains a caveat box beside the chart saying exactly that, the split
    paragraph names the list, and the churn callout tells the reader not to read the orange
    line on its own. This is METHODOLOGY §2.3 **regime 7 — the project's only complexity-class
    disagreement between its two measurement methods — on the wall clock for the first time**;
    it was previously proven only on exact op-counts.
    `verify:browser` gained nine checks (twelve series; sorted-array churn rising and its
    search/churn split on one run; the list's flat churn, its O(n) delete-by-value, and that
    the two disagree on class by a margin no one can call noise). Neither structure gets a
    second-pass (reverse-sorted) assert: neither is shape-sensitive, and the second pass does
    not reset `__mutationProof`, so such an assert would silently re-read the first pass —
    noted in the gate so nobody adds one by accident. The whole gate still runs in ~13 s.
    `runSweeps.test.ts`'s fake engine now returns all four structures and asserts the list's
    class disagreement survives the pipeline. **No new deps.**
  - **Done (string-key sweeps — the last Rust-only structures reach the browser):**
    `ArrayStr` and `HashSetStr` had the full timed surface in Rust since Phase 2 and no way
    into the UI; they now have their own engine calls (`runStringSweep`,
    `runStringMutationSweep`), their own registry entries (`arraystr`, `hashsetstr`), their
    own picker generator (**random string keys**, with the key-length range exposed) and
    their own Compare section. A dataset is numeric *or* textual, so a run drives one set of
    structures or the other: `runAllSweeps` and `runStringSweeps` are separate entry points
    returning **separate types**, and `runSweeps.test.ts` pins that a numeric result never
    carries a string-keyed series. Two structures are comparable only when they share the op
    set *and* the key type — `isCanonical` is only the first half, and its JSDoc now says so.
    The string twins deliberately **reuse their numeric twin's colour** (same structure, other
    key type; they can never share a chart), pinned by `registry.test.ts` so the duplicate
    isn't "fixed".
    Two measurement decisions carry this slice, both in `engine.worker.ts`:
    **(1) the absent probe/churn key is derived from the corpus**, not invented. There is no
    `max + 1` for strings, and the obvious substitute — a key longer than every stored key —
    is wrong in *two directions at once*: Rust compares string slices length-first, so a
    uniquely long key bails out of every array comparison on the length check (understating
    the per-byte scan this section exists to show) while making the hash set read more bytes
    than a real key would (overstating its constant). Opposite biases on the one chart that
    compares the two. The key is instead a stored key with its last character changed,
    verified absent against a `Set` of the decoded prefix (untimed). **(2) every timed static
    call gets the offsets+bytes *prefix* for its own n** (`prefixOf`), because wasm-bindgen
    copies the slice it is handed on each call — passing the whole corpus while measuring
    n = 250 would put a constant full-corpus copy inside every timed region.
    On the real clock (`verify:browser` gained a **third pass**, run last, on its own globals
    since a string run never sets the numeric ones): string array search rises **O(n)**
    (slope 1.02 ± 0.03, R² 0.9995, 1998× over the ladder) and string hash-set search stays
    **O(1)** (slope 0.04); string array churn rises (slope 0.94) while string hash-set churn
    stays flat (0.05). And the claim the numeric run cannot make — **hashing a string costs
    more than hashing a number** (14.1 ns vs 4.2 ns on the same gate run) *while both stay
    flat*: the class is in n, the constant is in the key length L. The picker's key-length
    range makes that second axis a thing the user can move.
    One honest wrinkle, pinned rather than papered over: the string array's scan is labelled
    **O(n log n)** about as often as O(n), because its *tail* slope runs above 1 (1.16) — a
    `Vec<String>` holds pointers to heap bytes, so a 20 k scan loses cache locality and each
    element costs a little more than the last. Risk R3 with a mechanism. The gate therefore
    asserts the slope band and the rise, as it already does for the sorted array's search,
    and the UI says why beside the chart. **No new deps.**
  - **Done (one-click presets, and a PNG of the charts):**
    Six presets in the dataset panel (`PRESETS`), each a *complete* `PickerState` plus the
    finding it produces — the fair fight, "sorted data kills a naive BST", its
    reverse-sorted mirror, duplicate-heavy zipfian, and **text keys short vs long**, which
    turns the string run's second cost axis into a two-click comparison (the flat line stays
    flat and sits higher). Complete states, not patches: the `n`-trim on the kind selector
    only fires on user interaction, so a preset must bring its own trimmed `n` or a click
    from cold would generate 100 k string keys the sweep never reaches. Preset labels are
    kept clear of the phrase "run the sweeps" — the browser gate clicks the run button by
    that text and these buttons sit above it in the DOM — and a test pins that.
    **PNG export** (`ui/png.ts`) stacks the charts the page is *currently* showing into one
    image with their titles, legends and this run's provenance (dataset, key length, signal,
    engine, timestamp). It composes rather than dumping a canvas, because uPlot renders its
    legend as DOM: a raw `toDataURL` would export lines with nothing naming them.
    **The qualifiers travel with it, which is the point.** An exported image is the form most
    likely to be read with no page attached, so a churn chart carries the finite-difference
    **delete-by-value** figures as cross-check legend rows, and the caption carries the
    sentences the page prints beside the charts — the linked list's flat line being flat only
    for the key it just head-inserted (the rule `CLAUDE.md` states: never ship that curve
    without its pair), the string array's fitted label not being a claim the tool makes, and
    wall-clock numbers being specific to one machine. Caption lines are wrapped to the sheet
    width rather than clipped: a truncated caveat is worse than none, because it looks
    complete. The layout
    arithmetic is a pure function with its own tests (nothing overlaps, nothing falls off the
    sheet, the furniture scales with the device pixel ratio — uPlot's canvas is already
    DPR-scaled, so unscaled labels would come out microscopic on exactly the screens people
    export from). Charts are found by a `data-chart` attribute rather than a callback prop,
    which keeps them out of `SweepChart`'s effect dependencies (an inline arrow would rebuild
    the whole plot every render) and yields them in DOM order, which is the stacking order.
    Two bugs this slice surfaced and fixed: the controls bar (signal selector, exports) was
    gated on the *numeric* result, so a string run lost the very selector its copy tells the
    reader to use; and every chart's size axis was being rendered as **dates** — uPlot treats
    the x series as UNIX timestamps unless told otherwise, so the sweep sizes printed as
    "2:00am 1/1/70". **No new deps.**
  - **Open:** interleaved structure order per sweep point — still an open *question* (§13),
    not a committed feature. It changes the per-point thermal and frequency conditions, which
    is exactly what this gate's slope bands encode, so it wants its own slice where a moved
    band can only have one cause.

- **Phase 6 — Specialized + polish.** Trie, skip list, graph; presets/demos
  (e.g. "sorted data kills a naive BST"); persistence of sessions; docs;
  performance polish (Canvas if needed). Added in-phase, from §13's variant
  questions: open addressing, red-black, B-tree, doubly linked list, and the probe
  mix. Those five, the graph's measured and animated halves, and persistence were
  built as eight parallel slices and merged in one batch (gate 118/118 after it).
  - **Done (the trie — a second flat line, for a different reason):**
    `TrieStr` in Rust (`bench-engine/src/structures/trie.rs`) and its TypeScript teaching
    twin (`src/structures/trie.ts`), held together by the string conformance corpus, which
    gained a `prefixes` case and two trie-only dimensions: **lexicographic-by-byte
    iteration** (an order the trie gets free from its shape, and the hash set has not at
    all) and a **delete sequence**, because the prune is the drift-prone half — clearing a
    terminal flag is easy, deciding which nodes may then be unlinked is not. It joins the
    *existing* string sweeps rather than getting its own call (2 search series → 3, 6
    mutation series → 9), because it does the same three operations on the same key type.
    Declared classes are **O(1) in n**, average and worst: the trie is the first structure
    here whose textbook cost never mentions n, and `ComplexityClass` has no term for key
    length, so the O(L) lives in the cost metric (**char-steps**) and the mechanism string.
    On the real clock (third gate pass): trie search flat (slope 0.17, ratio 3.8× over a
    20× ladder) against the string array's 2000× rise, **~500× cheaper at the top of the
    sweep**, and trie churn flat (slope 0.00).
    Two measurement decisions, both made deliberately and both pinned by a test that fails
    if they are reversed. **The probe set stays shared** across all three string
    structures, which for a trie is its *deepest* absent case — the workload's absent key
    is a stored key with its last character changed, so the walk goes all the way down
    before failing, where an unrelated string would fall off at the first byte. A chart on
    which each line got a workload tuned to suit it would not be a comparison, so the trie's
    height is labelled a pessimistic constant instead (UI + METHODOLOGY §2.5). **The churn
    key is the same derived key**, which makes one insert+delete pair allocate and prune
    exactly one node — the O(L) walk rather than the allocator; a prefix-free key would
    build a whole L-node branch per pair, the trie's counterpart to the heap's drain
    hazard (`trie::tests::a_prefix_free_churn_key_allocates_a_whole_branch`).
    One wrinkle pinned rather than papered over, the trie's version of the string array's:
    its search is labelled **O(log n)** about as often as O(1). The char-step count is
    *identical* across the ladder with no clock involved
    (`trie::tests::cost_is_flat_in_the_number_of_keys`), so the wall-clock bend is memory,
    not work — one dependent pointer hop per key byte against a tree that outgrows the
    caches, where the hash set's single bucket jump drifts ~6× less. Risk R3 with a
    mechanism; the gate asserts the band and the rise, the UI explains the bend. **No new
    deps.**
  - **Done (the trie's own step-animation — the measured structure becomes watchable):**
    a `trie.*` event family, a display model + fold, `TrieView`, and a `TriePanel` tab, so
    the trie is now the ninth Explore tab and the **first animated structure with string
    keys**. Three things that made it more than a copy of the BST view:
    **(a) the key input.** Every other panel types a number; `Controls` gained a
    `keyKind` discriminant so the trie gets a text box and a `(op, string)` handler, with
    the numeric path and its tests untouched.
    **(b) one node per UTF-8 byte.** The view draws what the twins walk, so `café`
    is *five* levels and the two bytes of `é` are two nodes labelled `C3` / `A9`. Any byte
    outside printable ASCII is labelled in hex for that reason — the seed
    (`car`/`cart`/`cat`/`café`/`dog`) exists to put that fact, previously only in
    docstrings, on the screen.
    **(c) the terminal ring**, drawn with an in-picture legend rather than only prose
    beside it. It is the difference between "the walk reached this node" and "a key ends
    here", i.e. why a **proper prefix** of a stored key costs the full depth and still
    reports absent — the trie's own trap, and the one the panel's summary line names when
    it happens.
    The honesty gate holds for search, insert **and** delete: the cost events are
    `trie.enterRoot` + `trie.step`, so `countCostEvents(stream) === op-count`
    (`src/viz/trace.trie.test.ts`). For **search and delete** that test is **chained to
    the Rust source of truth** — it runs the keys and probes of
    `conformance/corpus-str.txt`, whose counts are generated from the bench twin, which
    also proves the tracer perturbs no counter. **Insert is not chained**: the corpus has
    no insert column, so insert's `1 + L` is asserted against the formula directly. That
    is weaker on purpose rather than by oversight — the count is forced by construction
    (an insert never falls off the tree, so it always walks the whole key, exactly as
    `insert_generic::<true>` counts it), and adding a `trie_insert` column means
    regenerating the corpus from Rust, which is its own slice.
    The fold is asserted against `snapshot()` shape *and* `nodeCount()`, not just the key
    set: a reducer that dropped a prune event would still answer every membership question
    while leaving litter nodes on screen. **No new deps.**
  - **Done (the skip list — O(log n) without ever rebalancing):**
    `SkipListF64` in Rust (`bench-engine/src/structures/skip_list.rs`) and its TypeScript
    teaching twin (`src/structures/skipList.ts`), pinned to each other by
    `conformance/corpus-skip.txt`. It joins the *existing* numeric sweeps rather than
    getting its own section — same three operations, same key type — so the search chart
    gains a sixth line and the churn chart a fourth structure. Declared **O(log n)
    average, O(n) worst**; `family: 'linear'` because the shape is a tower of linked
    lists, the same call the trie's `family: 'tree'` makes about a §8 heading.

    **The design decision the whole slice turns on: node heights come from the key's hash,
    not from an RNG.** `height(key) = 1 + min(23, trailing_zeros(splitmix64(to_bits(key) ^
    salt)))` — geometric with p = ½, so the textbook shape, but a *pure function of the key
    set*. Three things need that, and an RNG breaks all three. (a) The counted path does
    **real inserts**, and `measure.ts` interleaves timed and counted calls under adaptive
    batching, so with a shared stream the op-count signal would depend on the machine's
    clock — and the op-count is supposed to be the deterministic half of the two signals.
    (b) The teaching twin reproduces the corpus exactly with **no new cross-language
    primitive** (`splitMix64` / `toBits` were already bit-exact with pinned anchors), where
    replaying recorded heights would have left it unable to insert a key the corpus never
    saw — killing the animation slice before it started. (c) The finding gets *stronger*:
    heights are insertion-order-independent by construction, so the headline holds with no
    RNG caveat. The honest price is stated rather than buried (METHODOLOGY §2.6, hurdle
    12): the probabilistic guarantee moves from the coin to the **key distribution**.
    The salt earns its place too — `splitmix64(0) == 0`, so the raw-bit version handed the
    key `0` a full-height tower, and `0` is one of the commonest keys real data contains;
    one such key doubled the constant on every later descent.

    **The headline, clock-free and then on the clock.** On the reverse-sorted input that
    builds a naive BST into an O(n) chain, the skip list searches the far end in < 60
    node-visits against the BST's 2000 (`structures::methodology::
    skip_list_keeps_its_class_on_the_input_that_degenerates_a_bst`), and the browser gate's
    second pass confirms its churn stays sub-linear where the BST's reads O(n). Two
    structures survive that input for opposite reasons — the AVL **rotates**, the skip list
    never had a shape to lose. On the first (uniform) pass the gate also pins the pairing
    the structure was added for: **sub-linear search *and* sub-linear churn on the same
    run**, against the sorted array's sub-linear search and O(n) churn. Measured on one
    gate run: skip-list search slope 0.23 (the sorted array's 0.25, the array's 0.92) and
    churn slope 0.02 against the sorted array's 0.82; on the reverse-sorted pass, churn
    0.09 while the BST's reads 1.02.

    Two measurement decisions, both checked rather than assumed. **Churn is two-keyed**,
    the trees' recipe — and here *neither* end would mislabel the class: `min − 1` fails one
    comparison per level, `max + 1` runs off the end of each level and pays nothing for it,
    a constant apart and both O(log n)
    (`skip_list::tests::neither_churn_end_changes_the_reported_class`). The recipe is kept
    because it is what makes this curve comparable with the BST's and the AVL's, not
    because it rescues anything. **Teardown alternates delete-max / delete-min**, which
    needs a max that is not an O(n) walk to the tail — the pointer descent that takes every
    forward link it finds — keeping the teardown Θ(n log n).

    The corpus carries a dimension none of the earlier ones do: the **express-lane
    profile**, the keys visible at each level, before and after a delete sequence. Level 0
    alone is a sorted linked list, so a skip list whose upper levels are mis-linked or
    never built answers every membership query correctly and returns a plausible op-count
    while being O(n); order plus op-count would pass it. It is this structure's counterpart
    to the BST corpus's pre-order shape, and it subsumes a height histogram. The ninth
    churn-vs-finite-difference regime lands with it (METHODOLOGY §2.3): the FD sum
    overshoots churn by ~56 %, the balanced BST's story told by a structure with no tree in
    it. **No new deps.**
  - **Done (the skip list's own step-animation — the second Phase 6 structure becomes
    watchable):** an Explore tab (`SkipListView`) that draws the list as a grid of towers —
    nodes left→right in ascending order, level 0 the sorted base list, the express lanes
    stacked above it and drawn as the **real skips** (a link on a lane jumps straight over
    every shorter tower, which is the O(log n)). A new `SkipEvent` family
    (`src/viz/events.ts`) whose one cost event is `skip.inspect` (one node-visit), so
    `countCostEvents === op-count` holds for search / insert / delete — search and delete
    chained to `corpus-skip.txt` in `trace.skip.test.ts`, insert self-consistent only (no
    corpus column, like the trie). Nodes are addressed by **level-0 index**, resolved
    through a rank map built only when a tracer is passed (it perturbs no counter). Two
    design points the honesty gate turns on: a hit **compares the level-0 node twice** —
    the descent's `< key?` then the membership `= key?`, both real node-visits, shown as a
    stand-point highlight (where the walk drops a level) plus a separate compared-node
    tint; and the display model **derives the express lanes from the folded heights +
    order** rather than storing links, pinned equal to `SkipListF64.levelKeys()` in
    `model.test.ts` so the drawing is chained to the express-lane dimension the corpus
    guards. The seeded structure is a four-lane staircase with a duplicate, chosen by
    computing the hash-derived heights. Rendered every-frame in `views.render.test.ts`.
    **No new deps.**
  - **Done (the graph, clock-free — the twin, the corpus, and the `V + 2E` identity):**
    `GraphAdj` in Rust (`bench-engine/src/structures/graph.rs`) and its TypeScript teaching
    twin (`src/structures/graph.ts`), pinned to each other by `conformance/corpus-graph.txt`.
    It is the **third own-op-set structure** (after the heap, and — by data type — the trie):
    a graph is not a key container, so its op set is **add-edge + whole-graph traversal**
    (BFS via a queue, DFS via an explicit stack), not insert/search/delete of a key. Like the
    heap it is therefore `!isCanonical` — compared only within its own group, never on the
    shared charts (docs/PLAN.md §8, risk R6).

    **The representation is an undirected adjacency-list multigraph, and the cost metric is
    vertex-visits + edge-visits — exactly `V + 2E` on a connected graph.** `add_edge(u, v)`
    pushes each endpoint onto the other's list (a self-loop appears twice in its own list, the
    convention that keeps Σ deg = 2E); parallel edges are kept (the project's "never dedupe"
    rule, and what keeps `add_edge` O(1)). A traversal counts one vertex-visit per vertex taken
    off the frontier and one edge-visit per adjacency entry examined — two rules the TS twin
    must match exactly or the corpus diverges. **BFS and DFS cost the same and visit in
    different orders**, which is the graph's headline (the counterpart to "array and linked
    list are both O(n) by different mechanisms").

    **Two decisions that are correctness, not tuning.** DFS is **iterative, mark-on-push** —
    never recursion, which would overflow the WASM stack on a long path, the same hazard that
    forced the BST's arena. And the traversal reuses a **generation-stamped** visited array and
    a preallocated frontier, so nothing is allocated inside the (future) timed region.

    The corpus carries three graph-specific dimensions none of the earlier ones do: the
    **adjacency profile** (each vertex's neighbour list — catches a divergent edge build even
    when every traversal still reaches every vertex), the **two traversal orders**, and
    **per-traversal `(reached : ops)`** (which on the `disconnected` case pins that a traversal
    reaches only its source's component). Hand-written Rust unit tests, a TS unit test, and a
    **proptest** (BFS/DFS reach exactly 0's connected component against a union-find reference,
    and the op-count equals `|C| + Σ deg`). Two findings live in the clock-free
    `structures::methodology`: the exact `V + 2E` identity with BFS ≡ DFS at every size, and
    **why the browser half needs two sweeps** — a V-sweep at fixed degree cannot separate
    `O(V)` from `O(V+E)` (both scale together), so a degree-sweep at fixed `V` isolates the
    `+E` term (it moves by exactly 2 per edge). Written up in docs/METHODOLOGY.md **§2.7** (a
    structure with two size axes). **This slice is Rust + TS + corpus + methodology only** — no
    `#[wasm_bindgen]`-timed sweep is wired into the UI yet, exactly as the string and
    sorted-array twins first landed impl-ready with no `BenchEngine` method. **No new deps.**
  - **Done (the graph becomes watchable — BFS and DFS step-animation):** a `GraphEvent` family
    whose two cost events are exactly the graph's two counting rules — `graph.visit` (a vertex
    taken off the frontier) and `graph.examine` (an adjacency entry examined, whether or not it
    discovers anything) — so `countCostEvents === ops` holds for **both traversals**. Unlike the
    trie and skip-list animations there is no self-consistent-only half: a traversal is the
    graph's whole op set, and every corpus case is run traced and held to the corpus's own
    `ops`, `reached` and visit order (`src/viz/trace.graph.test.ts`). **Marking is its own free
    frame (`graph.mark`)** because DFS is mark-on-push: a vertex is marked when pushed and can
    wait on the stack long after, so a later edge to it is skipped though it is unvisited — the
    real rule, and the step the frame exists to show (one extra frame per discovered vertex; a
    reviewer may prefer folding it into the examine). `GraphView` draws three linked panels: the
    graph (every parallel copy its own arc, a self-loop its own loop), the **adjacency lists**
    one cell per entry (an edge-visit is one cell; a finished traversal ticks the `2E′`), and
    the frontier, visit order and running tally. Entries are tied to drawn edge copies by
    replaying `addEdge`'s pushes, pinned equal to `GraphAdj.adjacency()` in `model.test.ts`. The
    seed (8 vertices, 10 edges, hand-placed in columns by BFS distance — arguably flattering
    BFS) is computed so BFS, mark-on-push DFS and recursive DFS all differ, with a parallel
    edge, a self-loop and an isolated vertex (cost 27 = 7 + 2·10, not 28). A typed number picks
    the start vertex (range-checked); the box's placeholder says so and Enter runs BFS
    (`bdc4935`). No add-edge control yet — `Controls` takes one key, an edge needs two.
    **No new deps.**
  - **Done (the search workload becomes a choice, and stored size is said beside input size):**
    the §6.3 promise "mix of present/absent keys is configurable" is now true. A *Search
    workload — hits vs misses* control (`src/ui/ProbeMixControl.tsx`, radio buttons after the
    dataset panel, so the gate's `select().first()` still finds the generator) offers
    0 / 25 / **50 (default)** / 75 / 100 % present probes, as **five named workloads, not a
    slider**, on a fixed budget of 128 probes. The builders moved out of the worker into
    `src/bench/probeMix.ts` and `buildStringProbes(keys, mix)`, and **the default reproduces the
    calibrated 64 + 64 workload byte for byte** — pinned in `probeMix.test.ts` against frozen
    copies of the old builders over the default and string ladders and edge sizes, with a
    negative control that every other mix differs. The shared-probes rule holds by
    construction: the mix is one value per run, threaded to a **required** `mix` parameter of
    every search runner factory, so a structure added without it fails to compile. String
    misses are now seeded from `min(absent, n)` spread stored keys (identical at the default;
    the old rule invented keys on a misses-only run). The mix applies to search only, is not
    part of `PickerState` (presets do not reset it), and results report the mix they *ran*.
    **Stored size:** each built structure's own `len()` is read back untimed into
    `SweepPoint.storedN` — measured, not a registry flag — and wherever a structure held fewer
    keys than it was given, the chart says so under the plot and in its hover read-out, the CSV
    gains `stored_n`, the JSON `storedN`, and the PNG caption the sentence. The x-axis stays
    **input n**. It shows on the **default** run: the uniform generator draws with replacement,
    so at n = 100 000 the hash set holds ~63 % of its input (METHODOLOGY §4 hurdles 8–9). The
    gate asserts the default run measured 64 + 64 and the hash set's stored share is 50–75 %.
    **No new deps.**
  - **Done (the doubly linked list — a second pointer that buys nothing, measured):**
    `DoublyLinkedListF64` in Rust (`doubly_linked_list.rs`, StructureId `'dll'`, the light pair
    of the singly list's orange) with **real `prev` links** in the singly list's `Option<u32>`
    arena, pinned by `conformance/corpus-dll.txt` and a proptest that uses the singly list as
    its op-count reference. It joins the existing numeric search and flat mutation sweeps with
    no new engine call. **The finding is sameness, pinned as equality:** on insert / search /
    delete-by-key `prev` is only ever *written*, so every op-count the sweeps read equals the
    singly list's at every size, sorted and shuffled
    (`methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`); the price is 24
    bytes a node against 16, and what `prev` buys (unlink-given-a-handle, 0 visits) is on the
    test surface only. **Regime 7 again**, with the same honesty rules — caveat box
    (`src/ui/DoublyListNotes.tsx`), the O(n) delete row, the PNG legend row and caption line,
    gate pins — and a teardown that deletes the tail **by value**, never through the `tail`
    handle (which would read O(1) and erase the class disagreement). The corpus pins the
    **tail→head order** after deletes and after a mixed stream, because no canonical op reads
    `prev` and a corrupt back-link would pass everything else. Judgement calls: a separate bench
    struct at all (the old module doc called it "pure duplication" — equality is now a pinned
    measurement and a chart line instead of a comment); the TS teaching twin is the existing
    array-backed list plus `keysReversed()`, so its backward lines pin agreement, not link
    integrity. On the clock: search slope 1.01 ± 0.006, labelled O(n log n) on its first run,
    so its label check now accepts O(n) or O(n log n) like the string array's. **No new deps.**
  - **Done (the graph, measured — generators, edge-list import, the two-sweep Compare section):**
    the bench twin's existing `bfs_n` / `dfs_n` timed surface wired into the graph's **own**
    Compare section (`src/compare/runGraphSweeps.ts`, `src/ui/GraphCompareSection.tsx`,
    `src/ui/GraphChart.tsx`). Its own data — seeded generators (`src/data/graphs.ts`: a random
    **connected** graph at a chosen average degree, a path, a grid) or the user's **own edge
    list** (`src/data/edgeList.ts`) — never the key dataset, since a list of keys carries no
    edges. Measured **on request** (its own button, not on page load), so the key runs' auto-run
    and the gate's first three passes are untouched; it shares the bench worker, so a graph run
    queues behind a key run. **Two sweeps**: a V-sweep (1k → 50k at fixed degree, or prefixes
    of an imported list) and a degree-sweep at `V = 5,000`, degree 2 → 64, whose generator is
    **nested** — each point is the previous graph plus edges. Both are plotted against the
    reached component's `V′ + 2E′`, **computed by the page and checked** against the engine's
    op-count at every point (`countsMatchComponent`, `bfsEqualsDfs`, `allReached`) — a reviewer
    may note PLAN's own wording suggested plotting the op-count itself, which would make the
    check a tautology. The four traps flagged before this slice are each pinned:
    `isCanonical('graph') === false` with its own `GraphStructureInfo` and a
    `theoreticalClass('graph', …)` that throws (`registry.test.ts`); dense ids in first-seen
    order; string labels, integer ids; disconnected prefixes at the reached component's size.
    No allocation in the timed region (`graph::tests::the_timed_traversals_never_grow_their_scratch`).
    The gate's **fourth pass** drives the button: V-sweep slope 1.33–1.34 (band 0.7..1.6, thin
    headroom — the walk outgrows the caches, ns per visit rises), degree-sweep 1.01 / 1.08.
    `REGISTRY` is now a mapped type, so `REGISTRY[id]` for an arbitrary id is a union that must
    narrow the graph away before reading theory. **No new deps.**
  - **Done (a red-black tree — the balancing-scheme comparison of §13):** `RbtF64` in Rust
    (`rbt.rs`) and its TS teaching twin (`src/structures/rbt.ts`), pinned by
    `conformance/corpus-rbt.txt` (shape **with colours**, rotation and recolour totals); a
    proptest against a multiset reference checking every invariant and the rotation budget
    after every op; the numeric search and mutation sweeps; the browser gate. Classic **CLRS**,
    on the AVL's exact semantics and metric (**comparisons + rotations**), so the two balanced
    trees compare unit for unit; **recolours are counted outside the metric** (the AVL has no
    colour to pay for) and reported beside it. Arena-backed with a never-written NIL sentinel,
    parent links and free-list reuse. **The finding is narrower than the slogan:** the bound —
    ≤ 2 rotations per insert, ≤ 3 per delete — holds on every op, while one AVL delete rotated
    **ten** times; in *totals* it rotates ~18 % less only on random inserts and recolours four
    times as often as it rotates; and its looser height bound costs 68 % more comparisons on a
    sorted build (height 21 vs 12) while the finished tree searches only ~4 % dearer. Regime
    10: churn above the FD sum, the AVL's direction, wider. Judgement calls: the AVL's
    rotations were split by subtracting a pre-op search count rather than adding a counter to
    `avl.rs` (valid for distinct keys only); the gate asserts class only; and because the AVL is
    a `Box` tree and this an arena, the wall-clock gap between them mixes scheme with storage —
    every "red-black above/below AVL" sentence on the page is qualified by signal. The AVL is not
    on the search chart, so the two trees' search comparison is clock-free only. On the clock:
    search 0.25, churn 0.14 (0.16 reverse-sorted). **No new deps.**
  - **Done (a B-tree — the AVL's comparisons in a quarter of its node hops):** `BTreeF64`
    (`btree.rs`, minimum degree **t = 16**, ≤ 31 keys a node) and its TS twin (degree a
    parameter), pinned by `conformance/corpus-btree.txt` at t = 2, 3 and 16 (per-insert ops and
    the level-by-level shape), proptests with duplicates everywhere, clock-free methodology in
    its own `structures::methodology_btree`, and both numeric sweeps. Metric **comparisons +
    splits/merges/borrows**. **Equal comparisons, fewer hops:** within ~8 % of the AVL's and the
    sorted array's comparisons while visiting only its height (3–4 nodes against the AVL's
    12–20) — which the op-count chart cannot see, so node-visits are reported clock-free, and
    the clock comparison is printed by the gate as a **hypothesis, not asserted**. **Regime 11:
    tight, for a tree** — every leaf at one depth, so churn has no cheap spine (25.0 vs 24.5).
    **The design correction a reviewer should look at:** the brief asked for CLRS, but CLRS's
    single-pass pre-fill delete, combined with the proactive split, splits and re-merges a node
    on *every* churn pair (at every level on sorted input) — the churn curve would time the
    allocator. Delete instead repairs only true underflow on the way back up; after warm-up a
    churn pair restructures and allocates nothing
    (`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`). Search defers
    its equality test to the leaf (it will look odd animated: "found it, keeps going"). Its
    results sit in their own `CompareResult.btree` bucket, the skip list's precedent. The page's
    locality caveat (`src/ui/BTreeNotes.tsx`) does not yet travel in the PNG. On the clock:
    search 0.20 ± 0.02, churn 0.04 (0.18 reverse-sorted). **No new deps.**
  - **Done (a second hash set — open addressing, measured against chaining on equal terms):**
    `HashSetOaF64` (`hash_set_oa.rs`) and its TS twin (`src/structures/hashSetOa.ts`), pinned
    slot for slot by `conformance/corpus-hoa.txt`, on the numeric search and flat mutation
    charts with no new engine call. **Linear probing, set semantics, tombstone delete**, held to
    the chaining set's hash, start size, 0.75 threshold and doubling, so the two tables have the
    **same load factor at every n** and the pair of lines isolates the collision strategy.
    Metric **hashes + slot probes** on the chaining convention (the empty slot that ends a walk
    is free). **The tombstone policy is the measurement decision** — four rules, each pinned:
    insert reuses the first tombstone on its path; tombstones count toward the load (or a miss
    can loop forever); `set_churn_key` primes its keys to a fixed point (the first pair is
    cheaper than the rest); churn cycles a block of `clamp(⌊len/32⌋, 1, 16)` keys (one key
    samples one cluster and jumped several-fold between sweep points). Without reuse, churn's
    mean cost climbs with the batcher's rep count and **charts as growth in n**. The charts now
    say: same hash, same table, more probes — a miss costs Knuth's ½(1 + 1/(1−α)²) (7.70 vs
    chaining's 1.72 at α ≈ 0.73), sawing with α and trending with nothing. **Regime 12:** churn
    overshoots the FD sum by ~27 %, and an unprimed pair shows the overshoot is the churn keys'
    own tombstones. Judgement calls: tombstones rather than backward-shift deletion (the
    textbook choice, and the finding); 0.75 load to match chaining rather than linear probing's
    usual 0.5 (fairer comparison, dearer OA); the churn block is a recipe difference from the
    chaining set's single key. Which set is faster on the clock is not asserted. On the clock:
    search 0.02, churn |slope| 0.11. **No new deps.**
  - **Done (sessions are remembered — on this browser only, and never as results):** the §13
    question is settled *local only* (the user's decision). A reload brings back the dataset
    panel as it was when the user last pressed run or a preset — **pasted CSV / JSON included**
    — with that run's probe mix, the chart view (signal, overlay, spread) and the selected
    Explore tab (`src/persist/`). Small settings sit under one versioned `localStorage` key; the
    paste text sits in IndexedDB, because a real paste can outgrow `localStorage`. The text is
    stored **raw** and re-parsed by the same importer, so keys come back exactly — pinned over
    leading-zero codes, duplicates, ids past 2^53, astral and combining characters and CRLF —
    and checked on the way back by length + hash. **Results are never saved:** the mount-time
    auto-run re-measures the restored configuration, and a saved timing would be the one number
    on the page not measured now, on this machine; the page says "measured fresh on this load".
    With **empty storage the auto-run is byte-for-byte the default run** and IndexedDB is never
    opened (pinned with counting fakes, and by the gate's first pass). Missing, blocked, full,
    slow (2 s cap) or corrupt storage degrades silently, section by section. A **forget saved
    session** button clears both stores and is never disabled mid-run. Judgement calls: save on
    *run*, not on every edit (the reload never measures a configuration the user never ran — so
    later unsaved edits are lost); the auto-run fires on a restored paste too (a huge saved
    paste re-runs every load — hence the always-enabled forget button); the preset highlight is
    not restored. The real browser stores are exercised only by the gate's fresh-context check;
    a save → reload → restore round-trip (and IndexedDB's open/upgrade/put path) has not been
    run in a browser — Vitest has no browser storage. **No new deps.**
  - **Done (the doubly linked list's links become real — and watchable):** the TS teaching
    twin `DoublyLinkedListF64` is now its own class holding **real `next` / `prev` links** in
    an index arena that mirrors the Rust twin (head/tail handles, freed slots reused LIFO), so
    `keysReversed()` follows `prev` and the corpus's backward lines bite on the TS side too (a
    stale back link injected into the twin fails 14 tests). The singly twin stays array-backed;
    the two share a `LinkedListTwin` interface. Every pointer write is traced as a new
    **`dll.relink`** step — three per insert, two per hit delete — and is **not** a cost event,
    so the animation's visits equal the singly list's per op (METHODOLOGY §2.11). Explore's
    doubly tab gets its own fold and view (`DoublyListView`) that **store and draw the real
    links** instead of deriving arrows from order: mid-delete the removed node stays drawn,
    dashed, with both neighbours' links arcing past it; mid-insert the new node appears before
    anything points at it; the just-written link is blue. Captions call every write "free, not a
    node-visit" and every visit the singly walk; the intro says the counts are equal and the
    back link costs writes. Pinned: the fold equals the twin's positional `snapshot()` after every
    op (and over a 400-op stream), no frame draws a link to an undrawn node, the per-op write
    counts, and the caption wording. Judgement calls: events address nodes by **display
    position** (duplicates rule out values), which is stable because the display order changes
    only on the prepend and the final drop; the singly tab draws no relink steps (its twin has no
    links to show). **No new deps.**
  - **Done (open addressing, watchable):** `HashSetOaF64`'s insert / search / delete take an
    optional tracer, and Explore gets a **hash set (open addressing)** tab: one slot strip
    (wrapped into rows of 8) drawing live keys, **tombstones** and empty slots as three
    different things, the walk from the home slot shaded as it goes, an insert's remembered
    first tombstone tagged `reuse`, and every rebuild captioned as **double** or **purge in
    place**. Cost events are `hoa.hash` and `hoa.probe` (a live key compared or a tombstone
    stepped over), so the gate holds for all three ops — and, because `corpus-hoa.txt` has an
    insert column, all three are **chained to Rust**, and the folded drawing is checked against
    the corpus's slot layouts after build, deletes and re-inserts. The seed is the chaining
    tab's (same 8 slots, same rehash point), which puts four keys on home slot 5 in one run that
    wraps to slot 0: a miss homed at 6 pays 4 to chaining's 1, and `search(60)` still pays 5
    after `delete(40)` because it steps over the tombstone — pinned in `trace.hoa.test.ts`.
    Judgement calls: the empty slot that ends a walk is drawn as its own step (`hoa.stop`) but
    **free**, and the rebuild's re-placement walks are drawn but uncounted — both exactly as the
    twins count them (METHODOLOGY §2.8). **No new deps.**
  - **Done (the red-black tree, watchable):** `RbtF64`'s insert / search / delete take an
    optional tracer, and Explore gets a **red-black tree** tab on the AVL tab's keys. A node's
    fill *is* its colour, so every highlight is a ring; each CLRS fix-up case is its own marker
    step naming the node it repairs and the node whose colour decided it (the uncle on insert,
    the sibling on delete) — eight cases, mirror side included, the inner-child insert case
    shown as two markers because it falls into the outer one. The delete's "double black" on an
    empty child is drawn as a NIL box under its parent; a red node under a red parent is flagged
    from the drawn shape. Cost events are `rbt.compare` and `rbt.rotate` (the AVL's metric);
    **`rbt.recolour` is not one** — it is emitted exactly where the twin's separate recolour
    counter ticks, so both counts read off the stream. Everything is **chained to Rust**: a
    traced build checked per insert, the rotation and recolour totals, the probes, the delete
    sequence, and the *drawn* pre-order shape with colours against `corpus-rbt.txt`. A 3 000-op
    stream pins the per-operation bound (≤ 2 rotations per insert, ≤ 3 per delete) and sees all
    eight cases. The intro claims no total-rotation advantage — on the sorted run 90, 95, 99
    both trees pay 3, 5, 5 ops and this one also makes 10 recolours (pinned). Judgement calls:
    paths are recomputed from the parent links at every event (a rotation moves nodes); the
    fix-up markers and the successor walk are free. **No new deps.**
  - **Open:** the step-animation for the last new numeric structure (B-tree: per-probe compares,
    split/borrow/merge events, the deferred equality test explained). The graph's charts are
    **not yet in the PNG / CSV / JSON exports**, and the PNG would need the V-sweep's memory
    caveat as a caption line; the B-tree's locality caveat is likewise page-only. The graph
    section's controls are not persisted. The AVL and BST are not on the search chart, so the
    red-black and B-tree search comparisons against the AVL are clock-free only. A gate pass
    for persistence (paste, run, reload, assert the restored text) is sketched in the slice's
    handoff note (commit `208c39c`) but deliberately not wired — it re-navigates, so it must
    run after every other pass and clear storage first. Presets/demos beyond the six from
    Phase 5, and performance polish.

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

- ~~Hash table: stay with separate chaining, or add open-addressing as a *second*
  selectable variant?~~ **Done** (Phase 6) — both are measured on the same charts,
  held to the same hash and table sizes (METHODOLOGY §2.8). Remaining: (a) a
  **backward-shift-delete** variant (no tombstones; a churn pair would restore the
  table by construction, with no priming and no overshoot) as a third line — the
  cleanest test of how much of regime 12 is the tombstone; (b) a **load-factor
  control** (0.5 is the usual linear-probing ceiling; 0.75 was kept to match
  chaining, which makes OA's miss cost ~4.5× chaining's near the top of each
  sawtooth); (c) a churn *block* for the chaining set too, for symmetry (its
  single key has the same one-bucket sampling problem, milder).
- ~~Balanced tree: AVL chosen; offer red-black as an alternative later for a
  balancing-scheme comparison?~~ **Done** (Phase 6, METHODOLOGY §2.9) — measured,
  not yet animated. Remaining: the per-operation rotation bound is the scheme's real
  difference, and no per-op *average* on a chart can show a worst case — should
  Compare grow a "max cost of one operation" view so it is visible on the clock and
  not only in Rust (METHODOLOGY §4 hurdle 13)?
- ~~Session persistence: local-only (IndexedDB) vs shareable URLs/exported files?~~
  **Decided: local only** (Phase 6, `src/persist/`). Settings in `localStorage`,
  the user's pasted data in IndexedDB, nothing uploaded, nothing in the URL.
  Measured results are deliberately not persisted — a reload re-measures.
  Shareable URLs remain out of scope; the CSV / JSON / PNG exports are the way to
  hand a result to someone else.
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
- ~~Configurable present/absent probe mix (§6.3), and reporting *stored* size next
  to *input* size for de-duplicating structures (METHODOLOGY §4.8–4.9).~~ **Done**
  (Phase 6). Two narrower questions remain: (a) should the numeric absent block
  offer a **mid-range** form (keys between stored keys) as well as `max + 1 …`? It
  is the skip list's dearer miss and would close the hurdle-9 gap, but it is a
  different workload whose slope bands would need their own calibration; (b) should
  the charts offer an explicit **stored-n x-axis** for the de-duplicating
  structures? Today the axis is input n everywhere, with the stored count reported
  beside it.

---

## 14. Next steps

1. ~~Finish Phase 4: wire the sorted-array, linked-list and string mutation
   surfaces into the browser sweep.~~ **Done** — every bench twin is now measured
   in the browser, search and mutation.
2. ~~Phase 5 remainder: one-click presets; PNG export.~~ **Done.** The
   interleaving experiment from §13 remains open, deliberately as its own slice —
   it moves the conditions the gate's slope bands were calibrated under.
3. Promote `verify:browser` to a blocking CI gate once its slope bands prove
   stable on shared runners — and since its class-*label* checks are the flaky kind
   (METHODOLOGY §5), likely as bands-only checks first.
4. ~~Phase 6: the trie's step-animation.~~ **Done** — the trie is measured *and*
   watchable, drawn one node per UTF-8 byte with a terminal ring for "a key ends
   here".
5. ~~Phase 6: the skip list, measured.~~ **Done** — O(log n) search *and* add/remove
   on any input order, from hash-derived tower heights rather than a coin.
6. ~~Phase 6: the skip list's step-animation.~~ **Done** — the express lanes are drawn
   as real skips, and each step highlights the walk's stand-point and its compared node
   separately, so a hit's level-0 double comparison (`< key?` then `= key?`) is visible.
7. ~~Phase 6: the graph — measured and animated.~~ **Done** — a V-sweep and a
   degree-sweep against the reached component's `V′ + 2E′`, BFS and DFS stepped beside
   their adjacency lists (METHODOLOGY §2.7).
8. ~~Phase 6: open addressing, red-black, B-tree, doubly linked list; probe mix and
   stored size; session persistence.~~ **Done** — measured end to end, gate 118/118
   (METHODOLOGY §2.8–§2.11, §4 hurdles 8–9).
9. Phase 6 remainder, in rough order:
   - ~~the doubly list's real back links and step-animation~~ **done** — the TS twin holds real
     `prev` links and Explore draws them, pointer writes as free steps (METHODOLOGY §2.11);
   - ~~step-animation for open addressing~~ **done** — tombstones, the probe walk, purge vs double,
     every op's count chained to the Rust corpus;
   - ~~step-animation for the red-black tree~~ **done** — colours, each fix-up case its own step,
     recolours outside the count, every count and the drawn colours chained to the Rust corpus;
   - step-animation for the B-tree;
   - the graph section in the **PNG / CSV / JSON exports**, with the V-sweep's memory
     caveat as a PNG caption line; the **B-tree's** locality caveat in the PNG too;
   - persist the graph section's controls (a small `run`-style section in
     `src/persist/session.ts`);
   - an AVL (and BST) search series, so the balanced trees share the search chart;
   - the persistence reload pass in the gate;
   - performance polish.
10. The interleaving experiment (§13), as its own slice.
