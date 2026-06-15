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

**Phase 4 — benchmark breadth + methodology hardening (in progress; the BST, AVL, and
sorted-array bench twins landed).** The first production (Rust→WASM) twin of a Phase 3
teaching-only structure is in: `bst::BstF64`, the bench twin of `src/structures/bst.ts`. It is an
**iterative, index-arena** multiset BST (`key < node` ⇒ left, else right; equal keys
go right) — a `Vec<Node{value, left, right: Option<u32>}>` arena walked with loops,
deliberately *not* a recursive `Box<Node>` tree, so the headline sorted-input
degeneration to a 10⁵–10⁶-deep right chain can't overflow the WASM stack (search,
insert, delete, traversal, and drop are all flat). Cost metric **comparisons**,
behind the same zero-overhead `const COUNT: bool` flag as the Phase 2 structures,
with the **Hibbard (value-copy) delete** whose in-order-successor walk carries no
comparison — the §2.1/R1 contract the teaching twin already fixed. It's pinned to the
TS twin by a dedicated **`conformance/corpus-bst.txt`** that, unlike the linear/hash
corpus, also pins the **tree shape** (pre-order with explicit null markers — in-order
alone can't tell a balanced tree from a chain) and a **delete sequence** with
per-delete `(removed, ops)` across every Hibbard branch (leaf / one-child each side /
two-child / two-child root / delete-to-empty / one-of-duplicates). Hand-computed Rust
unit tests plus a **proptest** (random insert/delete vs a sorted-multiset reference —
correctness only; op-counts stay pinned by hand + the corpus, since a reference that
reproduced comparison counts would just be a second BST) round it out.

On top of that algorithm + counters + conformance batch, the **timed harness surface and
engine/sweep wiring** have now landed: the `#[wasm_bindgen]` surface on `BstF64` mirrors
the Phase 2 structures — `search_n`/`search_counted`, the `churn_n`/`churn_counted`
primary, and the `build_insert_*`/`teardown_*` finite-difference cross-check — reusing the
existing `measure.ts` orchestration unchanged. **Teardown deletes the current maximum
repeatedly** (the rightmost node, always leaf-or-one-child — never the two-child Hibbard
path — reached down the right spine exactly as the churn key `max + 1`; deleting the root
would be O(1)/op on a chain and break the cross-check). The engine boundary gains
`runBstMutationSweep` (kept separate from the array/hash-set sweep because a tree is
data-shape-sensitive: sorted input degenerates to an O(n) chain with an O(n²) build, so the
caller feeds a **balanced** dataset), and `verify:browser` confirms balanced-tree churn
measures **sub-linear** on the real clock — the contrast to array O(n) / hash-set O(1). The
slice owns the open question — does `churn(n) ≈ insert_fd(n) + delete_fd(n)` hold for a tree
the way it does for the array? — and **answers it both ways** in a clock-free self-test:
**tight on the degenerate chain** (the right spine is the whole tree, as position-uniform as
the array), but on a **balanced** tree the finite-difference sum *overshoots* churn (churn
rides the cheap right spine while the build pays each key's average depth), so the methods
agree only in complexity class — reported, not buried. No chart wiring yet (deferred
breadth, like the string structures). No new dependencies.

The **balanced AVL bench twin** (`avl::AvlF64`) now joins it — the bench twin of
`src/structures/avl.ts`, same ordering and Hibbard delete as the BST but with the cost
metric **comparisons + rotations** (single rotation = 1, double = 2; the height/balance
arithmetic and the successor walk count nothing). It is deliberately a **recursive
`Box<Node>` tree, not** the BST's arena: the AVL invariant bounds height at ≈ 29 for a
million keys, so the stack-overflow hazard that forced the BST's arena is gone — and the
recursive form mirrors the recursive teaching twin almost line-for-line, the surest guard
against op-count drift (R1). Pinned by **`conformance/corpus-avl.txt`** whose cases force
every rotation kind (single LL/RR, double LR/RL, equal-keys-then-rebalance, and a *delete*
that triggers a rotation) — the shape pin is the only cross-language witness that the same
rotations fired, since in-order can't see them. A **proptest** adds the AVL-specific
property: the balance factor stays in {−1,0,+1} at every node after every random op. The
full timed harness + `runAvlMutationSweep` wire it through the same `measure.ts`
machinery (a separate sweep call for per-structure tagging, **not** for shape-sensitivity
— the AVL balances on any input), and `verify:browser` confirms balanced-tree churn is
**sub-linear** on the real clock. Two findings live in the clock-free Rust self-test: the
AVL stays **O(log n) on the exact sorted input that degenerates the BST to an O(n) chain**
(a deterministic op-count contrast), and — a third answer to the churn-vs-finite-difference
question — the two methods here **agree closely** (within ~6%), with churn marginally the
larger (it rides the full-height spine, vs the shallower average insert). No new
dependencies.

The first **Linear**-family bench twin now joins them: `sorted_array::SortedArrayF64`,
the bench twin of `src/structures/sortedArray.ts` — a sorted multiset with
**binary-search** lookup and shift-based insert/delete (cost metric **comparisons +
shifts**). Its search is the O(log n) **"missing middle"** between the unsorted array's
O(n) scan and the hash set's O(1) lookup, and it is **wired into the search sweep**, so
the chart now shows the three-way contrast — `verify:browser` confirms it on the real
clock (array O(n) slope ≈ 0.92 / **sorted O(log n) slope ≈ 0.23** / hash set O(1) slope
≈ 0.00). The drift-prone half (R1) is the binary-search comparison count: `locate`
mirrors the TS twin exactly (one comparison per midpoint, `==` short-circuit before `<`,
half-open window). It is pinned by **`conformance/corpus-sarr.txt`** — which, unlike the
BST/AVL corpora, has no shape dimension (a sorted array's iteration order *is* the sorted
multiset) but is the **first corpus to pin a shift-inclusive op-count cross-language**, its
delete sequence running front / back / middle deletes so the `+ shifts` term agrees across
languages. A hand-computed unit suite plus a **proptest** (random ops vs a sorted-multiset
reference) round it out. The full timed harness mirrors `ArrayF64`, with two mutation
specifics in the module doc: churn rides the **front** (`min − 1`) so mutation reads the
honest O(n) — a tail key would read a misleading O(log n), and (unlike the BST's cheap
right spine) a sorted array's tail is a *different class* than its average position — and
the build must see **shuffled** input to read O(n). Two findings live in the clock-free
Rust self-test: a fourth churn-vs-finite-difference regime (front churn *overshoots* the
finite-difference sum, both O(n)) and the structure's **signature split** — the same
structure is O(log n) to search but O(n) to mutate. The mutation side stays Rust-only this
slice — the `#[wasm_bindgen]` timed surface is ready and the self-test proves the
methodology, but (like the string structures) the TS sweep + chart wiring is deferred to
Phase 5, and a browser mutation curve would be slow (build *and* teardown are O(n²)). No
new dependencies.

**Phase 3 — visualization breadth (complete; animation engine, linear breadth,
the BST, plus the AVL tree + min-heap landed).** The step-through exploration spine is in for the two proven
structures. Each teaching twin emits a typed **step-event** stream via an
optional tracer that's threaded *alongside* the op-count logic — so a search
animation shows exactly the comparisons/probes the benchmark counts (a stream's
cost-event count equals its op-count, pinned against the Rust corpus); the
untraced path is byte-identical, so conformance is unchanged. A
structure-agnostic pure **Player** drives play / pause / step / step-back / speed
(step-back replays the event prefix — no reverse-ops), and plain-SVG renderers
animate the array (cells + shift-compact slide) and the hash set (buckets/chains
+ hash/probe highlight + animated rehash redistribution). The `delete` op is now
in the TS array + hash-set twins too (ordered shift-compact / order-preserving
chain-remove, mirroring Rust). It's wired into the app beside — and without
disturbing — the Phase 2 sweep, and renders in headless Chromium.

**Batch 2** adds the rest of the **Linear** family as teaching twins + viz (their
Rust twins are Phase 4): a **sorted array** with an animated binary search (the
live `[lo, hi)` window shades the eliminated halves — the O(log n) halving made
visible — and insert/delete shift the tail to stay sorted), and the **singly +
doubly linked lists** (O(1) head insert; node-visit search/delete; one renderer
draws both, the doubly variant adding back-pointers). The step-event ↔ op-count
honesty gate is extended to the new cost events, fold reducers are proven against
the real algorithm (every animation prefix renderable), and a render-smoke test
draws every frame of each new view to SVG (the browser gate only drives the sweep
tab). Three new exploration tabs, `App.tsx` untouched. No new dependencies.

**Batch 3** adds the unbalanced **binary search tree** (`BstF64`) as a teaching
twin + viz (its Rust twin is Phase 4): a multiset BST (`key < node` ⇒ left, else
right, so equal keys go right — never deduped; in-order traversal is the sorted
multiset). Its cost metric is **comparisons**, and the only cost event is the key
comparison, so the honesty gate pins `countCostEvents == ops` for search, insert,
*and* delete. Delete is the textbook value-copy (Hibbard) scheme — a two-child
node takes its in-order successor's value, then the successor is unlinked (the
successor walk follows pointers, not comparisons, so it isn't counted — the
contract the Phase 4 Rust op-counter mirrors). Step-events address nodes by a root
path, so the path-based fold reducer never replays the search logic; the
fold-mirrors-structure test compares the full nested tree shape (not just the
in-order keys, which can't distinguish a balanced tree from a degenerate chain).
The tree view lays nodes out by in-order rank × depth with stable ids — inserting
a sorted run visibly degenerates it to an O(n) right-leaning chain. A fourth
exploration tab, `App.tsx` untouched. No new dependencies.

**Batch 4** adds the two remaining tree-family teaching twins + viz (Rust twins are
Phase 4), closing the Phase 3 teaching breadth. The balanced **AVL tree** (`AvlF64`)
shares the BST's ordering and value-copy delete but retraces each insert/delete and
**rotates** to stay O(log n) — so the AVL tab stays balanced on a sorted run where
the BST tab degenerates. Its cost metric is **comparisons + rotations**, and *both*
are tagged cost events, so the honesty gate `countCostEvents == ops` holds for
search, insert, *and* delete; the view reuses the BST tree layout and derives each
node's balance factor from the drawn shape, tinting any node that reaches ±2 so you
watch imbalance appear and a rotation fix it (the rotate reducer preserves node ids,
so nodes slide to their new places). The array-backed **binary min-heap**
(`MinHeapF64`) has a *different* op set — insert / peek / extract-min — with `search`
kept as a deliberate O(n) contrast; its cost metric is **comparisons + swaps**, and
it is drawn as **both an array and the implicit tree** (the child of `i` at `2i+1` /
`2i+2`), the same chip animating in both as it sifts. The `Controls` op-button row is
now configurable so the heap can declare its own ops. Two more exploration tabs,
`App.tsx` untouched. No new dependencies.

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
