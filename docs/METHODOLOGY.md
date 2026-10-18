# Measurement methodology — the science, its hurdles, and what is proven where

> Companion to [`PLAN.md`](PLAN.md) §2.2–§2.3, §6 and §7. The plan says *what* the
> tool promises (measured, never asserted, complexity); this document records
> *how* the measurement is made trustworthy, the places where it is **not** yet,
> and the test that pins each claim. If a number on the chart cannot be traced
> to a section here, it is not a claim the tool should be making.

Contents: §1 signals · §2 timing and isolation · §3 reading a curve (the fitter)
· §4 known hurdles and limits · §5 proof map.

---

## 1. Two signals, one algorithm

Every structure is implemented twice — a TypeScript *teaching twin* that emits
step-events for the animation and a Rust→WASM *bench twin* that is timed — and
held to the same algorithm by a cross-language conformance corpus (PLAN §2.1,
§12). The bench twin exposes two signals per operation:

| signal | what it is | properties | what to read off it |
|---|---|---|---|
| **op-count** | the structure's declared cost metric (comparisons, probes, node-visits, shifts, rotations…) counted inside the Rust impl behind a zero-overhead `const COUNT: bool` flag | exact, deterministic, machine-independent | the *shape* (class) — never absolute magnitude across structures, because "one comparison" ≠ "one probe" |
| **wall-clock** | ns / op from `performance.now()` around a batch of ops inside one WASM call | noisy, machine- and browser-specific, includes cache and memory effects | the *real* cost on this machine; shape **and** magnitude, both only for this machine |

The op-count curve is the platonic shape; the wall-clock curve is what the
hardware actually does. Where they agree the class is solid; where they
diverge (a cache cliff, a fixed overhead flattening the small-n end) the
divergence is itself the finding, and the UI shows both.

## 2. Timing under a coarse clock, and per-op isolation

### 2.1 The clock problem

`performance.now()` in a Web Worker is clamped to ~100 µs (5 µs only under
cross-origin isolation) — coarser than any single operation. So (PLAN §6.2):

- **Batching.** `k` operations run inside *one* WASM call; per-op = elapsed / k.
  No JS↔WASM crossing inside the timed region.
- **Auto-grow.** `k` doubles until one timed call lasts ≥ `minBatchMillis`
  (2 ms for search, 1 ms for the O(n²) mutation runners) — i.e. ≥ 10–20× the
  clamp, so quantisation contributes ≤ 5–10 % and is then averaged away.
- **Warm-up.** Untimed reps first (JIT, caches, page faults on the fresh buffer).
- **Reps → median.** `reps` timed runs; the **median** is the reported value
  (robust to a single preemption), the sample stddev is recorded, and the
  **min → max** spread is what the chart draws as error bars (PLAN §6.5).
- **Adaptive reps.** After the minimum reps, sampling continues — up to
  `maxReps` — until the coefficient of variation (stddev / mean) is at or below
  `targetRelStddev` (5 % search, 10 % mutation). Quiet points stop early; noisy
  points get the extra samples. Every point records how many reps it took.
- **Isolation.** The sweep runs in a Worker; the main thread only renders.

Pinned by `src/bench/measure.test.ts` on a *virtual clock* (auto-grow reaches
the clamp, `maxBatch` ceiling, median/stddev/min/max, adaptive reps reach the
target or stop at `maxReps`). The real browser clock is exercised only by the
headless gate (`scripts/verify-browser.mjs`), because that is the only place
risk R2 can be observed.

### 2.2 Size-preserving ops: `search`

Build to n (untimed), then time `k` lookups over a stored probe workload of **128 probes**:
a block of present keys spread evenly through the prefix (`keys[⌊i·n/p⌋]`), then a block
guaranteed absent. The split is the run's **probe mix** (`src/bench/probeMix.ts`), chosen in
the UI as 0 / 25 / 50 / 75 / 100 % present. The **default is 64 present + 64 absent** — the
workload every gate band was calibrated on — and is reproduced byte for byte. The present
block is capped at n (at n = 10 the default is 10 + 64, as it always was); the absent block
is not. Numeric absent keys are `max + 1 … max + a`. String absent keys are derived by
`absentLike` (§2.5) from `min(a, n)` stored seeds spread through the prefix — identical to the
old "cycle the present block" rule at the default, and the only rule that stays
derived-from-the-data on a misses-only run. Every structure in a run gets the same probe
set. A 50/50 mix keeps the array's expected scan at ~n/2 + n and the hash set's at O(1);
what the other mixes do is hurdle 9.

### 2.3 Size-mutating ops: churn and the finite-difference cross-check

You cannot time "inserts at size n" because each insert changes n. Two methods,
each on the same structure (PLAN §6.3):

- **Churn (primary).** Build to n, then time `k` insert+delete *pairs* of a
  spare key (absent by construction: `max + 1`, or `min − 1` for the sorted
  array and the **min-heap** — for the heap that choice is forced, not tuned,
  since a higher key makes the pair's extract-min remove a *real* key and drain
  the structure, §4.2). Size stays at n; the pair cost is the combined mutation cost. **The
  trees use two spare keys**, `min − 1` and `max + 1`, alternating pair by
  pair, and average them — one key can only ever walk one spine, which on a
  degenerate input reports the wrong *class* (§4.1). Their teardown alternates
  delete-max / delete-min for the same reason, keeping churn's deletes and the
  finite-difference delete on the same two paths.
- **Finite differences (cross-check).** Time a full build to each sweep size
  (cumulative insert cost) and a full build+teardown (build cancels on
  subtraction ⇒ cumulative delete cost); difference consecutive sizes to get
  the marginal per-insert and per-delete cost near n. The spread of a
  differenced point is propagated conservatively (sum of the two cumulative
  spreads / Δn).

The agreement claim `churn(n) ≈ insert_fd(n) + delete_fd(n)` turned out to be
**structure-specific**, because the churn key is placed at a chosen *position*
(a tree's spines, an array's front) while the build inserts at the *average*
position. Every regime is pinned clock-free on exact op-counts in
`bench-engine/src/structures/mod.rs` (`mod methodology`; the B-tree's in its own
`structures/methodology_btree.rs`):

| # | structure | regime | why | class agreement |
|---|---|---|---|---|
| 1 | unsorted array | **tight** (< 2 %) | costs are position-uniform: insert is a free append, any delete is O(n) | yes, O(n) |
| 2 | hash set | **loose** (< 50 %) | both sides are tiny O(1) counts; the churn key's chain vs the swept average | yes, O(1) |
| 3 | BST, sorted input (chain) | **FD sum overshoots churn** on the insert side (1500 vs 1002) | the *delete* halves match exactly (both alternate the two ends), but churn's insert averages a full-chain descent with a root-adjacent one (≈ n/2) while the build drops every key at the chain's bottom (≈ n) | class only, O(n) |
| 4 | BST, shuffled (balanced) | **FD sum overshoots churn** (~32 %: 23.7 vs 18) | churn rides the two cheap spines (≈ ln n each) while `insert_fd` reflects the average depth (≈ 2 ln n) and `delete_fd` is added on top | class only, O(log n) |
| 5 | AVL | **close** (~10 %), churn ≥ sum | height and average depth differ by only ~1.44×, so the spine probes and the average insert nearly coincide | yes, O(log n) |
| 6 | sorted array (front churn) | **churn overshoots sum** (≈ 2n vs ≈ 3n/2) | front churn shifts the whole array twice; the shuffled build inserts at average position n/2 | yes, O(n) — and *tail* churn would have read O(log n): the key position sets the class |
| 7 | linked list — singly **and doubly**, op for op (§2.11) | **class disagreement** (churn O(1), FD delete O(n)) | head insert puts the churn key where deletion is O(1); the canonical delete-by-value (teardown of the oldest) walks the list. The doubly list's teardown deletes the tail **by value**, never through its tail handle | **no** — reported, not hidden |
| 8 | min-heap | **churn overshoots sum** (~1.5×: 53 vs 34.9), but the *insert halves* are in different classes | churn's insert is a new global minimum climbing the full height (Θ(log n), forced — see §4.2); a shuffled build's marginal insert is O(1), since most of a heap is leaves | totals yes, Θ(log n); **insert halves no** |
| 9 | skip list | **FD sum overshoots churn** (~56 %: 35.2 vs 22.5) | the two churn keys sit just off either end, where a descent is cheap — running off the *right*-hand end costs no comparison at all — while `insert_fd` reflects the average key's full search path and `delete_fd` is added on top. Nothing to do with balance: this structure never rebalances (§2.6) | class only, O(log n) |
| 10 | red-black tree | **close-ish** (~18 %: churn 27 vs sum 22.2), churn ≥ sum | the AVL's direction: churn's keys ride the spines while the build inserts at average depth — wider than the AVL's ~10 % because the looser height bound lets a red-black tree's spines run further past its average path (§2.9) | yes, O(log n) |
| 11 | B-tree (t = 16) | **tight** (~2 % shuffled: churn 25.0 vs sum 24.5; 24.5 vs 24.7 ascending, 26.0 vs 27.5 descending) | every leaf is at one depth, so the two churn keys walk the same height as any stored key — no cheap spine — and a settled churn pair is exactly one insert descent plus one delete descent (§2.10) | yes, O(log n) |
| 12 | open-addressing hash set | **churn overshoots sum** (~27 %: 7.69 vs 6.06) | churn's own tombstones bridge runs; an unprimed pair (5.81) matches the FD sum (§2.8) | yes, O(1) |
| 13 | backward-shift hash set | **tight** (~0.7 %: churn 7.39 vs sum 7.34) | no tombstone: the walk a tombstone defers to the next insert is paid inside the delete's shift scan, which the teardown sees too (`delete_fd` 3.80 vs 2.52); pair = the tombstone set's unprimed pair + the shift scan, exactly (§2.8) | yes, O(1) |

Both BST rows moved with the two-key change (they were "tight" and
"overshoot"): alternating the ends is what fixes the *class* on reverse-sorted
input, and the price is that the chain's constants no longer coincide. The tree
rows then fall into three groups by what churn's two end keys walk compared with
the build's average key. Where the ends are **cheap spines** — the BST (≈ ln n
against ≈ 2 ln n) and the skip list (running off an end is free) — the
finite-difference sum overshoots churn. Where the ends are **full-height spines** —
the AVL and the red-black tree — churn overshoots the sum, the red-black tree by
more because its bound lets a spine run further past the average. And where there
is **no special spine** — the B-tree, every leaf at one depth — the two agree
tightly, on either side depending on input order.

Consequence for the UI: churn is shown as *the* mutation curve, the FD split as
the cross-check, and both are read for **shape** (PLAN §2.3). Where the churn
key's position biases the constant (trees, sorted array) or even the class
(linked list), the bias is stated next to the chart and in §4 below.

Thirteen regimes. The skip list's is the balanced BST's story told by a structure
with no tree in it: both probe the cheap edges of a shape whose average is
dearer. What differs is *why* the shape is safe — the tree rebalances, the skip
list was never unbalanced (§2.6). The B-tree's is the first tree whose churn and
FD sum agree tightly, because it is the first whose spines are not special. And
the open-addressing set's is the one regime set by a **deletion policy** rather
than a key position: the overshoot is the churn keys' own tombstones (§2.8) — and the
backward-shift set's is the same table with that policy removed: its churn agrees with
the FD sum, and its churn line barely moves.

All seven flat structures (both arrays, all three hash sets, both lists) run this pair
of methods **on the browser clock**, not only on op-counts, and regimes 6 and 7
are where that matters most:

- The **sorted array**'s churn key is `min − 1` precisely so the measured curve
  is the structure's honest O(n). A tail key would append and pop with no shifts
  and the chart would report O(log n) mutation — the key's position, not the
  structure, setting the class. Its own search on the same run is sub-linear, so
  the user sees one structure that is cheap to read and expensive to write.
- The **linked list**'s flat O(1) churn is the one measured line in this project
  that is true and misleading at once: on screen it sits beside the hash set's
  flat line, but the hash set is flat for *any* key while the list is flat only
  for the key it just put at its own head. No key choice fixes it — the
  structure has no expensive same-key churn — so the honest presentation is
  *both* curves at once, and the UI prints a caveat box beside the chart saying
  so, pointing at the O(n) delete-by-value in the finite-difference split.
  `scripts/verify-browser.mjs` pins both halves so the pair cannot silently
  drift back to a single reassuring line. The **doubly linked list** draws the
  same pair for the same reason (§2.11), and every one of those rules — caveat
  box, delete row, PNG legend row and caption line, gate pins — binds it too.

### 2.5 String keys: a second cost axis, and a probe that must not be a sentinel

Every structure above stores `f64` keys, where a comparison is one instruction
and a hash mixes one 64-bit word. The **string twins** — `arraystr` and
`hashsetstr`, the same unsorted array and separate-chaining hash set over
`String` — keep the same classes *in n* and add a second cost factor the classes
cannot express: the **key length L**. A scan compares bytes; a hash reads every
byte. So `O(1)` here means constant in the number of keys and linear in the size
of one, and the tool shows the difference rather than asserting it:

- **Two signals separate on the same run.** The op-count curve (hashes +
  chain-steps) is identical to the numeric twin's — flat, one hash, a short
  chain walk. The wall-clock curve is flat too, but *higher*, and it lifts again
  when the key-length control is raised without its slope changing. That gap is
  L, isolated by the pair of signals of §1.
- **The two runs never share a chart.** A dataset is numeric or textual, so a
  Compare run drives one set of structures or the other and the results are
  separate types (`CompareResult` vs `StringCompareResult`). Two structures are
  comparable only when they share the op set *and* the key type; `isCanonical`
  covers the first half only.

**The probe/churn key is derived from the data, not invented.** The numeric
sweeps get a guaranteed-absent key from arithmetic (`max + 1`, `min − 1`, §4.1).
Strings have no such arithmetic, and the obvious substitute — a key longer than
every stored key, absent by construction — is *wrong here*, in two directions at
once. Rust compares string slices length-first, so a uniquely long key:

- makes every array comparison bail out in O(1) on the length check, understating
  exactly the per-byte scan cost this section exists to show; while
- making the hash set's pass read more bytes than a real key would, overstating
  its constant.

Opposite biases on the one chart whose purpose is to compare the two. The
absent key is therefore a **stored key with its last character changed**,
verified absent against a `Set` of the decoded prefix (untimed setup) — so it
carries the corpus's own length and shape. The long-key form survives only as
the fallback for a corpus that exhausts its alphabet at that length.

The churn key takes that mutation from a key of **median length**, not from
`keys[0]`. The cycled key inherits its seed's length, and on imported data the
first row is an accident of ordering: a corpus that happens to begin with a
one-character key would otherwise cycle a one-character key, and the measured
mutation *constant* would move with row order rather than with the structure.
The numeric side has no equivalent exposure, since `max + 1` and `min − 1` are
properties of the whole prefix. `src/bench/stringWorkload.ts` holds the code, the
reasons, and the tests that pin them — deliberately outside the worker, which
cannot be unit-tested, and which should hold the timing rather than the decisions.

One more measurement detail specific to the two-buffer marshal layout: every
timed static call (`build_insert_n` and friends) is handed the offsets+bytes
*prefix* for the point's `n`, never the whole corpus. wasm-bindgen copies the
slice it is given into WASM memory on each call, so passing the full buffer while
measuring n = 250 would put a constant, full-corpus copy inside every timed
region and flatten the curve into noise. That is `prefixOf`, the two-buffer
equivalent of the numeric side's `keys.subarray(0, n)`.

One measured wrinkle worth stating, since the chart shows it: the string array's
scan is fitted as **O(n log n)** about as often as O(n), on a slope of 1.02 ±
0.03 with R² 0.9995. Its *tail* slope runs above 1 (≈ 1.16) because a
`Vec<String>` stores pointers to heap-allocated bytes — as n grows the scan
chases further and each element costs a little more than the last. That is risk
R3 with a mechanism behind it, not a fitter defect, and the numeric array (whose
f64s sit inline) shows no such drift. The browser gate therefore asserts the
slope band and the rise rather than the label, as it already does for the sorted
array's search, and the UI says why beside the chart. The op-count signal —
comparisons per probe — is exactly linear either way.

#### The trie: a third string structure, and the probe question it sharpens

Phase 6 adds `triestr` to the same run — a prefix tree, on the same three
operations and the same key type, so it goes on the same chart. It earns its
place by being **flat in n for an unrelated reason**: the hash set reads all L
bytes once to compute a bucket and then jumps; the trie never hashes, and instead
takes one branch per byte, stopping the instant a byte has no child. Two flat
lines from two mechanisms is what makes the chart say something a two-line version
could not — whichever sits lower is a fact about this corpus's key lengths and
this machine's memory, not about complexity. Its declared cost metric is
**char-steps**: one for entering the root, one per key byte whose child lookup is
attempted. The within-node lookup is a binary search over at most 256 sorted
children — bounded, so counting it would let a representation detail masquerade as
complexity.

**The shared probe set is now load-bearing, and it biases the trie.** For the
array and the hash set, `absentLike` (a stored key with its last character
changed) mainly protects the *constant*. For a trie it decides which of two very
different numbers the chart shows: an absent key derived that way walks the whole
key before failing — the trie's **deepest** miss — where an unrelated absent
string falls off at the first byte, the trie's cheapest. The probe set stays
shared and unchanged anyway, because a chart on which each line got a workload
tuned to suit it would not be a comparison. The consequence is stated rather than
hidden: **the trie's height on this chart is a pessimistic constant**, and the UI
says so beside it. What no probe choice can do is tilt the line, since nothing the
trie does depends on how many keys are stored. The probe *mix* (§2.2) does not
change this either: a hit and a last-character miss both cost `1 + L` char-steps,
so the trie's search cost is the same at every mix (exactly equal at the two
extremes, `probeMix.test.ts`) — the one structure the mix control cannot move.

The **churn key** is the same derived key, and for a trie that is again a
decision, not a default. Sharing all but its last byte with a stored key, one
insert+delete pair allocates exactly one node and prunes it again, so the curve is
the O(L) descent. A key sharing no prefix would build a whole L-node branch on
every pair and measure the allocator instead — the trie's counterpart to the
heap's drain hazard (§4.1), pinned the same way, by a Rust test that fails under
the wrong key (`trie::tests::a_prefix_free_churn_key_allocates_a_whole_branch`)
and by its teaching-twin mirror.

A second measured wrinkle, alongside the string array's: **the trie's search is
fitted `O(log n)` about as often as `O(1)`** — slope 0.17 ± 0.01, tail slope 0.14
and falling, R² 0.999, rising from ~14 ns to ~55 ns across a 20× size ladder on
one gate run. The char-step count over that same ladder is *identical*, which is
not a clock claim at all: `trie::tests::cost_is_flat_in_the_number_of_keys` pins
the same probe costing the same steps in a 100-key trie and a 100,000-key one. So
the drift is **memory, not work**. A lookup is one dependent pointer hop per key
byte, and a trie over 20k short keys is tens of thousands of separately allocated
nodes, well past the caches a 1k-key trie fits inside; the hash set, making one
bucket jump instead of ~6 hops, is exposed to the same effect roughly six times
less and drifts ~1.5× over the same sweep. Risk R3 with a mechanism, handled as
the sorted array's and the string array's searches already are: the gate asserts
the slope band and the rise limit, allows either label, and the UI explains the
bend beside the chart. It deliberately does *not* try to separate this curve from
a genuinely logarithmic one by slope — a log-log slope is not comparable across
two different size ladders, and the separation that matters is the clock-free one
above.

### 2.6 A probabilistic structure with no random numbers (the skip list)

A skip list is the one structure in the catalogue whose textbook complexity is
*expected* rather than worst-case: each node is given a random height, tall
nodes form sparse express lanes, and a search drops through them. Ours gives
each node a height too — but derives it from the key rather than flipping a
coin:

```text
height(key) = 1 + min(23, trailing_zeros(splitmix64(to_bits(key) ^ SALT)))
```

`trailing_zeros` of a well-mixed 64-bit hash is geometric with p = ½, which is
exactly the distribution the coin flips produce, so the *shape* is the textbook
one. What changes is that the structure becomes a **pure function of its key
set**. Three things in this project need that:

1. **The op-count signal must not depend on the clock.** The counted code path
   performs real inserts (`churn_counted`, `build_insert_counted`), and
   `measure.ts` interleaves timed and counted calls under adaptive batching. A
   shared RNG stream would make node heights — and therefore the op-count — a
   function of how many timed batches happened to run first. The op-count is
   meant to be the deterministic half of the two signals (§1).
2. **Cross-language conformance stays exact.** The TypeScript teaching twin
   reproduces `conformance/corpus-skip.txt` bit for bit, using primitives that
   already had bit-exact ports (`splitMix64`, `toBits`). The alternative —
   recording heights in the corpus for the twin to replay — would leave the
   teaching impl unable to insert a key the corpus never saw, which is the whole
   job of an animation.
3. **The finding gets stronger.** Heights are insertion-order-independent by
   construction, so "the skip list keeps O(log n) on the reverse-sorted input
   that turns a naive BST into an O(n) chain" holds with no RNG caveat — and it
   holds for a structure that never rotates. That is what earns it a line beside
   the AVL: same outcome, opposite mechanism.

**The honest caveat.** The probabilistic guarantee has moved from the coin to
the data. A key set adversarially chosen to collide in
`trailing_zeros(splitmix64(...))` would build a degenerate list — the same class
of statement as "sorted input kills a naive BST", and on-theme for a tool whose
premise is measuring the user's own data. No *ordering* of keys can do it, which
is why `src/registry.ts` leaves `shapeSensitive` false: that flag is about input
order, and cannot carry a claim about distribution.

One knock-on worth stating: the salt exists because `splitmix64(0) == 0` and
`trailing_zeros(0)` is 64, so hashing the raw bits would hand the key `0` a
full-height tower. `0` is one of the commonest keys real data contains, and a
stray 24-level express lane costs every later descent an extra inspection per
level — a doubled constant on every measured operation, from one key. Salting
moves the fixed point onto a key nobody has.

### 2.7 A structure with two size axes (the graph)

Every other structure in the catalogue is measured against one number: `n`, the
count of keys. A graph has **two** — the number of vertices `V` and the number
of edges `E` — and its one operation, a whole-graph traversal (breadth-first via
a queue, depth-first via an explicit stack), costs a function of **both**:

```text
BFS cost = DFS cost = V + 2E   (on a connected undirected graph)
```

`V` vertex-visits — each reached vertex taken off the frontier exactly once — plus
`2E` edge-visits — each undirected edge examined from both of its endpoints. That
identity is exact and clock-free (`structures::methodology::
graph_traversal_costs_exactly_v_plus_2e_and_bfs_equals_dfs`), so it is pinned on
op-counts, not left to the noisy wall clock.

Three consequences shape how the graph is measured:

1. **The op set is different, so it stays off the shared charts.** A graph has no
   insert/search/delete of a *key* (PLAN §4.1), so — like the heap — it is
   `!isCanonical`, compared only within its own group and drawn in its own Compare
   section. `isCanonical` excludes `'graph'` as well as `'heap'`, `CANONICAL_STRUCTURES`
   filters through it, the graph's registry entry is its own `GraphStructureInfo` (no
   key-structure theory slots), and `theoreticalClass('graph', …)` throws rather than
   invent a class (`src/registry.test.ts`). `BFS` and `DFS` cost the same and visit in
   **different orders**; that equal-cost / different-order pair is the graph's
   headline, the counterpart to "the array and the linked list are both O(n) by
   different mechanisms" (§1).

2. **One sweep cannot separate `O(V)` from `O(V + E)`.** If you grow `V` at a
   *fixed average degree* `d`, then `E = dV/2` and the cost is `(1 + d)V` — a
   straight line in `V`, from which the `+E` term is unreadable, because both
   terms scale together. So the Compare section runs **two** sweeps: a **V-sweep**
   at fixed degree (which shows both traversals are linear and that BFS ≡ DFS in
   class) and a **degree-sweep** at fixed `V` (which grows `E` alone, so the cost
   moves by *exactly* two per added edge — the `+E` term made visible). Both halves
   of that argument are pinned clock-free
   (`graph_plus_e_term_is_only_visible_when_degree_grows_at_fixed_v`), and an `O(V)`
   cost reading slope 1 on the V-sweep and flat on the degree-sweep is pinned with a
   fake engine (`src/compare/runGraphSweeps.test.ts`). The axis is labelled
   `V′ + 2E′`, never `n`.

3. **The cost is `O(V + E)`, not `O(E)`, and that is a real term.** An isolated or
   barely-connected vertex still costs its visit, so an almost-edgeless graph pays
   for its vertices — which is why the `V` is counted separately rather than folded
   into the edge scan. On a **disconnected** graph a traversal from one source
   reaches only that component and costs *that* component's `V' + 2E'`, strictly
   less than the whole — pinned by the corpus's `disconnected` case and the
   union-find proptest.

**Where the edges come from.** Every other structure is fed the user's own keys;
a graph needs *edges*, which a list of keys does not carry, so the graph section
never reads the shared key dataset. Seeded synthetic generators
(`src/data/graphs.ts`: a connected random graph at a chosen average degree, a path,
a square grid) drive the sweeps, labelled synthetic on screen so no invented graph
is passed off as "your data". A user's **own edge list** (`src/data/edgeList.ts`, a
paste of `u,v` pairs) is a real graph and is accepted as such. What the tool
deliberately does **not** do is fabricate edges out of the keys (linking key *i* to
key *i+1*), which would present a made-up structure as measured reality.

**Two implementation decisions that are correctness, not tuning.** DFS is
**iterative with an explicit stack**, never recursion: a traversal of a
10⁵-vertex path would otherwise overflow the WASM stack, the same hazard that
forced the BST's index arena. And the traversal reuses a **generation-stamped**
visited array and a preallocated frontier, so nothing is allocated inside the
timed region — otherwise the curve would measure the allocator warming up rather
than the walk. The graph is a **multigraph** (parallel edges and self-loops kept,
a self-loop counting twice toward degree), matching the project's "never dedupe"
rule and keeping `add_edge` genuinely O(1). The no-allocation claim is pinned on a
dense multigraph (every ordered pair, so parallel edges and a loop on every vertex):
same scratch capacity and the same heap pointers after 400 timed traversals
(`graph::tests::the_timed_traversals_never_grow_their_scratch`).

**The measured half.** The graph's Compare section (`src/compare/runGraphSweeps.ts`,
`src/ui/GraphCompareSection.tsx`) runs **on request** — its own button, never on page
load, so the key runs' default auto-run is untouched — and shares the bench worker, so
a graph run queues behind a key run rather than racing it for the clock. Two sweeps,
both plotted against `V′ + 2E′`, the vertex-visits plus edge-visits of vertex 0's
connected component:

- **V-sweep** — random connected graphs at a fixed average degree (default 4),
  `V` = 1k … 50k on the 1-2-5 ladder; or a path, or a square grid; or, for a user's
  edge list, its first 10, 20, 50, … edges (capped at 500k, at least 20 needed).
- **Degree-sweep** — always synthetic (no given file can hold `V` fixed while adding
  only edges): one random connected graph on `V = 5,000` at average degree 2, 4, 8,
  16, 32, 64. The generator is *nested*: one seed draws the same spanning tree and then
  the same extra edges in the same order, so a lower degree's edge list is an exact
  prefix of a higher one's. `V` is not merely equal across the sweep, it is the same
  graph plus edges (`src/data/graphs.test.ts`, "nests across degrees").

**The x-coordinate is computed, then checked.** The orchestrator derives `V′` (BFS
reach on the TS twin) and `E′` (edges with an endpoint in the reach) from the edges
themselves, plots each point there, and checks that both bench-twin op-counts equal it
(`countsMatchComponent`), that BFS ops = DFS ops (`bfsEqualsDfs`), and that both
traversals reached exactly `V′`. So "op-count = `V′ + 2E′`" is re-verified on every
point of every run on the real WASM twin, not only on the corpus, and the op-count
chart is a check rather than a tautology. Plotting against the engine's own op-count
would make that check vacuous; plotting against the nominal `V + E` would put a walk
that touched 3 vertices of a disconnected file at the x of the whole file.

**Imported edge lists.** Labels are text, numbered in **first-seen order** — so
vertex 0, the traversal's source, is always the first endpoint of the first edge, and
every prefix of the file is itself a dense graph on ids `0..k−1`. `02134` and `2134`
are two vertices; repeated lines are parallel edges and `a,a` a self-loop, all kept; a
header row and `#` comments are explicit options, never guessed. A prefix may be
disconnected — the per-point table shows "reached x of V" and the x-coordinate is the
reached component's (`src/data/edgeList.test.ts`, `runGraphSweeps.test.ts`).

**On the real clock** (the gate's fourth pass, on its passing run): the V-sweep reads
slope **1.33–1.34** for both traversals, inside the 0.7..1.6 band with thin headroom,
and the fitter can label it `O(n log n)`. That is memory, not the walk: in a random
graph almost every step is a jump to an unpredictable place (the next vertex's
`visited` mark and its separately allocated neighbour list), the sweep takes the graph
from cache-resident to not, and the per-point "ns per visit" column rises with it (an
off-browser Node run read ~2.3 → ~7.4 ns per unit of `V′ + 2E′`). The op-count is
exactly linear. Same call as the string array's and the trie's: assert the band, show
the ns-per-visit column, say why beside the chart. The degree-sweep, at a fixed 5k
vertices, is much less exposed and read slopes **1.01 / 1.08** (band 0.4..1.4, rise
> 3× required). The Node run had read it a little *below* 1 (0.88 / 0.85) and offered
a mechanism for that; Chromium did not reproduce it, so no mechanism is claimed. If the
V-sweep band ever flakes, read the ns-per-visit column first — a rising column argues
for widening the band, not for re-tuning the graphs.

### 2.8 Three hash sets, one hash (open addressing vs chaining, and a delete with no tombstone)

The open-addressing set (`hash_set_oa.rs`, linear probing, set semantics) is held to
the chaining set's hash (`mix_f64`), 4-slot start, 0.75 threshold and doubling
(`grows_at_exactly_the_chaining_sets_points`). Both tables therefore have the **same
capacity and the same load factor α at every n**, and the only difference between the
two curves is where a colliding key goes — the next free slot of one flat array, where
neighbouring homes' collisions merge into one run (**primary clustering**).

**Counting convention.** One tick for the hash, one per *occupied* slot examined (a
live key compared, or a tombstone stepped over). The **empty slot that ends a walk is
free**, exactly as reaching the end of a chain is free in the chaining set — in both, a
header read says "stop". That makes the two op-counts comparable unit for unit; it also
means Knuth's probe counts (which include the final empty slot) read one higher than
this metric, and the hash tick puts the one back: here a miss costs ½(1 + 1/(1−α)²) and
a hit 1 + ½(1 + 1/(1−α)), against chaining's 1 + α and 2 + α/2.

**Clustering, clock-free.** Measured on 20 000 absent and n present keys
(`open_addressing_probe_counts_follow_knuths_clustering_formulas`):

| n | α | OA miss (Knuth) | chained miss | OA hit (Knuth) | chained hit |
|---|---|---|---|---|---|
| 3 000 | 0.73 | 7.70 (7.48) | 1.72 | 3.48 (3.37) | 2.38 |
| 5 000 | 0.61 | 3.66 (3.79) | 1.61 | 2.82 (2.78) | 2.32 |
| 12 000 | 0.73 | 7.14 (7.48) | 1.74 | 3.33 (3.37) | 2.37 |

Misses pay the most, so the probe mix (§2.2) moves this structure's constant more than
the chaining set's (misses-only is its dear end; class unchanged).

**The sawtooth.** A doubling table's α swings between ~0.38 and 0.75 as n climbs, and
linear probing's cost is steep in α, so its search op-count saws: 2.02 … 3.89 per probe
on the 10 … 100 000 ladder at the default mix (1.92× swing) against chaining's
1.62 … 2.05 (1.27×). Neither has a trend (log-log slopes 0.013 and 0.012,
`open_addressing_search_saws_with_the_load_factor_but_has_no_trend_in_n`), so the gate
asserts the slope band, not the label.

**Tombstones — the landmine and the policy.** Linear probing cannot empty a deleted slot
(a key whose walk passed through it would become unreachable), so delete leaves a
tombstone. Churn — thousands of insert+delete pairs at fixed n — is exactly the workload
that breaks a naive tombstone policy. Four rules, each pinned:

1. *Without reuse*, each pair strands one more tombstone in the churn key's run, so the
   walk grows a slot per pair until a rehash. The mean cost per pair then depends on how
   many pairs the adaptive batcher chose to run, and since the headroom before a purge
   scales with the table, the drift reads as **growth in n** — an O(1) structure charted
   as rising (`without_tombstone_reuse_churn_drifts_with_repetition_count`). **Rule: insert
   reuses the first tombstone on its path**, after walking on to an empty slot to confirm
   absence.
2. *If tombstones did not count toward the load*, a delete-heavy sequence could leave no
   empty slot, and a miss — which stops only at one — would never return (a hung worker).
   **Rule: rehash when live + tombstones > 0.75·cap**, purging in place when live ≤
   0.375·cap, otherwise doubling
   (`tombstones_count_toward_the_load_factor_so_a_miss_always_terminates`).
3. *Even with reuse*, the first pair is cheaper than the rest: it lands on an empty slot,
   while every later insert finds the key's own tombstone and must walk past it to an empty
   slot before reusing it (`an_unprimed_first_pair_is_cheaper_than_the_steady_state`).
   **Rule: `set_churn_key` primes** each churn key with untimed pairs, repeating whole
   passes until one causes no rehash and no new tombstone (a mid-block rehash purges earlier
   keys' tombstones — found by the proptest). From that fixed point every pair restores the
   table exactly, so a counted pair is the same after 0, 1, 7, 100 or 100 000 timed ones
   (`churn_cost_does_not_drift_with_repetition_count`,
   `proptest_hash_oa::churn_restores_size_and_layout`).
4. *One churn key samples one cluster.* A single key's churn cost is the length of
   whichever run its home lands in — heavy-tailed — so a one-key curve jumped 6.5× and
   2.75× between neighbouring sweep points on two key sets. **Rule: churn a block** of
   `clamp(⌊len/32⌋, 1, 16)` consecutive keys `max + 1, max + 2, …` and report the mean per
   pair; the block's swing was 1.47× and 1.55×, and its tombstones add at most ~3 % to the
   load (`a_single_churn_key_samples_one_cluster`). The **chaining set churns the same
   block**, for a milder form of the same problem: one key's cost is whatever chain its
   bucket holds, and on the same ladder a one-key curve stepped by up to 2.33× between sweep
   points where the block stayed within 1.40× and the 64-key mean within 1.13×
   (`hash_set::tests::a_single_churn_key_samples_one_bucket`). It needs no priming — a pair
   appends to a chain and removes that last entry, so the table is restored exactly — and
   its churn now sits within 8 % of its FD sum, where one key needed a 50 % slack.

**Watching it (Explore).** The open-addressing tab animates the counting convention
literally: `hoa.hash` and `hoa.probe` are the only cost events, the empty slot that ends a
walk is drawn as its own step and captioned free, and a rebuild's re-placement walks are
drawn but never counted (`insert` has finished counting before the rebuild runs). All three
ops' streams are checked against `corpus-hoa.txt`'s Rust op-counts, and the folded drawing
against its slot layouts (`src/viz/trace.hoa.test.ts`).

**Regime 12 — churn overshoots the FD sum, and the overshoot is the tombstone.** Churn's
insert is a miss walk and its delete a hit — the same two walks the build and teardown
average — so on a fresh table they agree (unprimed pair 5.81 vs FD sum 6.06). After
priming, the churn keys' tombstones never revert to empty: each bridges its run to the
next, and every later insert walks the merged run. At n = 4 000 over 64 tables: insert_fd
3.54, delete_fd 2.52, sum 6.06, primed churn 7.69 — a ~27 % overshoot, class agreement
O(1) (`open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone`). Against
the chaining set's churn on the same 64 tables, each churning its own block (3.94), the OA line sits higher for two causes of
about equal size, pinned in the same test: clustering (+1.87) and the tombstones (+1.88);
the churn chart's copy says exactly that. The same test pins one more trap: a finite
difference across a doubling (1 500 → 1 600) reads a **negative** marginal delete for
linear probing (−10.77; chaining +2.00), because every stored key's walk shortens at once.
A finite difference of a doubling table is a marginal cost only between equal load
factors; the browser's 1-2-5 ladder doubles n with the table, so its endpoints sit at
equal α (for distinct keys — a de-duplicated prefix can shift it, hurdle 8).

**On the real clock** (passing gate run): search slope 0.02, churn |slope| 0.11 — both
flat, both flatter than the array's. Which hash set is faster on the clock is a machine
fact (one flat array against chain pointers) and deliberately not asserted; the UI says
only that the order can flip.

**A third hash set: backward shift, no tombstones (regime 13).** `hash_set_bs.rs` /
`hashSetBs.ts` is the same linear-probing table with Knuth's Algorithm R delete: the hole a
removed key leaves is filled by sliding back each later key of its run whose home does not
lie strictly between the hole and itself (moved when `(j − home) mod cap ≥ (j − hole) mod
cap`), so nothing is left behind and every churn pair restores the table bit for bit. The
control is exact: **a delete-free build is the tombstone table slot for slot**
(`methodology_hbs::a_delete_free_build_is_the_tombstone_sets_table_slot_for_slot`), so the
two search lines are one on the op-count signal. Each slot the shift scan examines costs a
probe *and* a hash — no hashes are stored, so every candidate's home is recomputed;
counting the probe alone would halve that term, so comparisons are stated term by term,
never as "cheaper". Churn uses the tombstone set's block (`clamp(⌊len/32⌋, 1, 16)` keys from
`max + 1`) with **no priming**; `set_churn_key` runs one untimed capacity settle, which
matters only when the set sits exactly at its load threshold (6 keys in 8 slots), where the
first churn insert would otherwise double the table inside the first counted pair.

| clock-free, 64 tables at n = 4 000 | insert_fd | delete_fd | FD sum | churn |
|---|---|---|---|---|
| tombstones (regime 12) | 3.54 | 2.52 | 6.06 | 7.69 (+27 %) |
| backward shift (regime 13) | 3.54 | 3.80 | 7.34 | 7.39 (+0.7 %) |

The answer to "how much of regime 12 is the tombstone?" is **all of the overshoot and almost
none of the cost**: the shift scan walks the very run a tombstone would have made the next
insert walk, so the work moves from the next insert into the delete
(`backward_shift_churn_is_the_unprimed_pair_plus_its_shift_scan`: 5.81 + 1.50 = 7.31, table by
table). A finite difference across a doubling reads −38.75 against the tombstone set's
−10.77, the same trap as above. It is measured after every existing series — last on search,
after the heap on mutation — so it moved no calibrated condition; it has no Explore tab yet.

**The load-factor control.** The open-addressing set's rehash threshold L is an opt-in
control (0.5 / 0.75 / 0.9); the chaining and backward-shift sets stay at 0.75. Every
tombstone rule reads L where it read 0.75 (rehash when live + tombs > L·cap, purge in place
when live ≤ L·cap/2, else double), threaded through all four build/teardown statics
(`*_at`) so churn and the split share a threshold. L is restricted to [0.25, 1): below 0.25
one doubling cannot restore the limit, and at 1 a miss could find no empty slot to stop at.
At the top of each sawtooth the counts follow Knuth — at α 0.499 a miss costs 2.54 (Knuth
2.49) and a hit 2.51 (2.50); at α 0.899, 54.98 (49.44) and 6.60 (6.45). Two cautions.
First, the browser's ladders sample the sawtooth at fixed points: on distinct keys 0.9
reaches α ≤ 0.78 on the search ladder and builds the same tables as 0.875 would, so the page
reports the α reached and how many sizes' tables differed, never the setting alone. Second,
a linear-probing table's occupied pattern depends only on its keys and capacity, so wherever
the final table is the 0.75 size, churn and teardown op-counts *equal* the default's exactly
(every mutation-ladder point at 0.9; all but n = 500 at 0.5, where priming doubles the table;
`a_threshold_that_ends_at_the_same_size_draws_the_same_churn_line`). Only the cumulative-build
insert half always moves. At any L ≠ 0.75 the pair is not like for like, and the page, the
PNG caption, the CSV (`max_load`) and the JSON say so; the two "same table at every n"
sentences are shown only at the default.

### 2.9 Two balancing schemes, one metric (the red-black tree)

The red-black tree answers one question (PLAN §13): what does a *balancing scheme* cost?
The AVL keeps every node's subtrees within one level, so its height is ≤ ≈1.44·log₂ n —
but a delete may rebalance at every level on the way up. A red-black tree promises only
that no root-to-leaf path is more than twice another (height ≤ 2·log₂(n+1)), and in
exchange **never rotates more than twice on an insert or three times on a delete**. Ours
(`rbt.rs`, `src/structures/rbt.ts`) is classic CLRS, not left-leaning, on the AVL's exact
semantics (multiset, equal keys right, value-copy delete — proven shape- and colour-equal
to CLRS's transplant delete, `rbt::tests::value_copy_delete_matches_the_clrs_transplant_delete`)
and the AVL's exact metric — **comparisons + rotations** — so the two differ only by the
scheme.

**What the metric leaves out, on purpose.** Where the AVL rotates, a red-black tree mostly
*recolours*. The AVL has no colour, so charging recolours would put a cost on the chart
only one line can pay; they are counted on a separate counter (a recolour = a write that
*changes* a node's colour) and reported here, so "fewer rotations" is never read as "less
work".

**What the op-counts say** (n = 4000, the same key sequences for both trees; the AVL's
comparisons and rotations are separated by subtracting a pre-op search count, valid for
distinct keys):

| | AVL | red-black |
|---|---|---|
| rotations, shuffled build | 2830 (0.71 / insert) | **2311 (0.58 / insert)** |
| rotations, ascending build | 3988 | 3979 |
| rotations, shuffled teardown / random-order delete | 2761 / 1466 | 2690 / 1501 |
| **most rotations in one delete** | **10** (teardown), 6 (random order) | **3** (the bound) |
| recolours, shuffled build | — | 9223 (4× its rotations) |
| comparisons, shuffled build | 43 069 | 43 122 |
| comparisons, ascending build | 43 905 | **73 809** |
| height, shuffled / ascending | 15 / 12 | 15 / **21** (bound 23.9) |
| average search (IPL), ascending | 43 917 | 45 586 (+3.8 %) |

Three readings, each pinned:

1. **The guarantee is per operation.** On every insert and delete of every sequence, and
   after every op of the proptest, the red-black tree stays within 2 / 3 rotations; one AVL
   delete on the same shuffled teardown took 10
   (`rbt_bounds_rotations_per_operation_where_the_avl_does_not`). That is the scheme's real
   advantage, and it is a statement about the *worst single operation*, which no per-op
   average on a chart can show (hurdle 13). The AVL's 10 is an observation on one fixed
   sequence, asserted as `> 3` — deterministic, but a property of that sequence.
2. **In totals the saving is narrow.** ~18 % fewer rotations on random inserts; the same on
   sorted inserts (about one per insert, both); a wash on deletes, the red-black tree's
   slightly higher (`rbt_rotates_less_on_random_inserts_and_about_as_much_everywhere_else`).
3. **The looser bound costs comparisons where sorted input inserts.** On shuffled keys both
   trees end the same height. On sorted keys the AVL builds a near-perfect tree while the
   red-black tree's edges grow toward its bound — and the edge is exactly where every
   sorted insert lands, so the sorted build costs 68 % more comparisons although the
   finished tree's average search is only ~4 % dearer
   (`rbt_pays_its_looser_bound_in_comparisons_on_sorted_input`). A constant, not a class:
   on reverse-sorted input it searches the far end in 19 against the AVL's 11 and the
   BST's 2000 (`rbt_keeps_its_class_on_the_input_that_degenerates_a_bst`).

Regime 10 (§2.3) follows the AVL's direction and is wider for reason 3.

**Every number above is an op-count, and that is the only signal on which the gap is "the
scheme and nothing else".** The two twins store nodes differently — the AVL is a recursive
`Box` tree that allocates and frees a node per build key and per churn pair; the red-black
tree is a pre-sized arena (NIL sentinel in slot 0, parent links, free-list reuse) — so on
the wall clock the gap also carries allocator and layout effects, and the red-black churn
line can sit *below* the AVL's while doing more comparisons. Read the two wall-clock lines
for shape, the op-count lines for the scheme. On the passing gate run: search slope 0.25
(the AVL's own search line now sits beside it — 0.19–0.22 on the same run — so the
comparison is on the clock as well as in the op-counts, with the storage caveat above),
churn 0.14 uniform and 0.16 reverse-sorted, all sub-linear. The gate asserts class only, never "below
the AVL" or "above" — the op-counts say the order flips with input order.

**Watching it (Explore).** The red-black tab animates the same convention: `rbt.compare` and
`rbt.rotate` are the cost events, and `rbt.recolour` is emitted exactly where the separate
recolour counter ticks, so a stream yields both numbers without folding one into the other.
The tracer's counts, totals and the drawn pre-order shape with colours are checked against
`corpus-rbt.txt` (`src/viz/trace.rbt.test.ts`), and a 3 000-op stream checks the
per-operation bound — the scheme's real difference — rather than any total.

### 2.10 Equal work, fewer hops (the B-tree)

The B-tree (`btree.rs`, `src/structures/btree.ts`, minimum degree **t = 16**, ≤ 31 keys a
node) is the structure where the two signals of §1 are *expected* to tell different stories
about the constant. Its cost metric is **comparisons + splits/merges/borrows** (one each,
the counterpart of the AVL's rotations), and on that axis it is indistinguishable from the
AVL and the sorted array — ≈ log₂ n comparisons whether the keys sit in one array, a binary
tree, or a few 31-key nodes
(`methodology_btree::btree_matches_the_avl_on_comparisons_but_takes_a_quarter_of_the_node_visits`):

| n | B-tree comparisons | AVL comparisons | sorted array | B-tree node-visits | AVL node-visits |
|---|---|---|---|---|---|
| 4 000 | 12.1 | 11.7 | 11.1 | 3 | 11.7 |
| 10 000 | 13.2 | 12.6 | 12.6 | 3 | 12.6 |
| 100 000 | 16.5 | 15.3 | 15.8 | 4 | 15.3 |

What it does not do is take one *dependent pointer hop* per comparison: a search visits
exactly its height and binary-searches inside each node's contiguous key block. The
op-count cannot see that; node-visits can, and are reported clock-free rather than charted,
because a node-visit is a proxy for a cache miss, not a measurement of one. **The
wall-clock advantage is a hypothesis, not a finding.** The gate prints the B-tree's
top-of-sweep search time against the sorted array's, and its churn against the AVL's, as
`btree hypothesis (info only)` lines, and asserts neither. Reasons to expect the gap to be
small here: the search sweep tops out at 100 000 keys (≈ 800 KB, near L2/L3 sizes), the
churn sweep at 4 000, and the AVL's churn allocates a `Box` per pair where a settled B-tree
pair allocates nothing — so a churn gap would be confounded by the allocator. If the lines
coincide on the clock, that is a result about this machine's memory at these sizes, not a
failure of the structure. On the passing gate run: search slope **0.20 ± 0.02**, churn
0.04 uniform and 0.18 reverse-sorted — all sub-linear, the class bands the sorted array and
skip list get.

**Why t = 16.** A node is 31 keys = 248 bytes, about four cache lines (its child array a
separate block) — wide enough that 100 000 keys need four levels, small enough that the
in-node search stays one short contiguous run. The claim is *fewer dependent hops*, not
"one cache line per node".

**Search defers the equality test.** Each node is binary-searched for the first key ≥ k
using `<` only, the candidate is remembered, and the descent always continues to a leaf; one
equality test at the end decides membership. That makes comparisons ≈ log₂ n with no
per-node equality overhead and node-visits = height exactly, and it makes a missing key
cost within one comparison of a present one — so the shared `max + 1 …` absent probes carry
no bias for this structure at any mix (contrast the skip list, hurdle 9). The internal-key
delete takes the predecessor from the leaf the descent already reached.

**The delete is not CLRS's, and that is a measurement decision.** CLRS's single-pass delete
pre-fills every node it enters that holds exactly t − 1 keys. With the proactive split
(which leaves both halves at exactly t − 1), a churn pair can split a node on the way down
and merge it straight back, every pair. Hand trace at t = 2: root `[20]`, left child
`[5 10 15]` (full; leaves `[1] [7] [12] [17]`), right child `[30]` (leaves `[25] [35]`).
Insert 0: the full child splits to `[5]`, `[15]` with 10 lifted (root `[10 20]`), leaf
`[0 1]`. CLRS delete 0: `[5]` has t − 1 keys and so does its sibling, so they merge back to
`[5 10 15]` and the root returns to `[20]` — the start state. On sorted input the whole left
spine sits at t − 1 and it thrashes at every level, so the churn curve would time the
allocator and O(t) key moves rather than the descent. The bench twin therefore keeps the
CLRS proactive split for insert but repairs only **underflow** (< t − 1 keys) on the way
back up — borrow left, else borrow right, else merge (left first) — which has hysteresis: a
split yields t − 1 (not underflow), a merge at most 2t − 2 (not full). After a few warm-up
pairs a churn pair restructures and allocates **nothing**, on ascending, descending and
shuffled builds at t = 2 and 16
(`btree::tests::churn_settles_into_zero_restructures_and_zero_allocation` and its TS mirror);
`measure.ts` reads the op-count after the auto-grow and timed batches, i.e. settled. A
delete of an absent key never touches the tree (`deleting_an_absent_key_changes_nothing`).

**Input order moves a constant, not the class.** Sorted input leaves each split's left half
at minimum fill, so an ascending build has ~40 % more nodes (66 vs 48 at n = 1 000) and is
sometimes a level deeper (4 vs 3 at n = 10 000), while a search still costs ≈ log₂ n
comparisons (`methodology_btree::sorted_input_builds_half_full_nodes_without_changing_the_class`).
`shapeSensitive` stays false; the constant is stated beside the chart. Regime 11 (§2.3) is
tight because every leaf is at one depth (`btree_churn_and_finite_differences_agree_tightly`).

**Watching it (Explore).** The B-tree tab animates the counting convention at t = 3 (the
benchmark's t = 16 would not fit; the corpus covers both): each in-node probe, the deferred
equality test, a non-root split's median comparison and each split / borrow / merge is a cost
event; choosing a child, key moves and the root growing or collapsing are free. Two
invariants are chained to `corpus-btree.txt` (`src/viz/trace.btree.test.ts`): cost events
equal `ops`, and structural events by kind equal the twin's `eventCounts()` deltas. Nodes
visited are drawn as a separate tally — the hop count this section's hypothesis is about,
which the op-count does not contain.

### 2.11 A second pointer that buys nothing (the doubly linked list)

The doubly linked list (`doubly_linked_list.rs`, StructureId `'dll'`) is the singly list
with one more link per node, pointing back, in the same `Option<u32>` index arena.
Textbooks list "O(1) delete" among its virtues, and that is true of exactly one operation:
unlinking a node *you already hold*. The canonical op set (PLAN §4.1) deletes **by key**,
so a delete must first find its node, and finding is the singly list's head-first walk,
node for node; the splice `prev` shortens was never counted on either list. So the claim is
not "about the same": it is **equal**.

- Every op-count signal the sweeps read — `search_counted`, `churn_counted`, cumulative
  build (0) and teardown (Σ i = n(n+1)/2 on distinct keys) — equals the singly list's at
  n ∈ {250, 1000, 2000, 4000} on sorted and shuffled builds
  (`structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set`), and
  per op over random streams (`tests/proptest_doubly_linked_list.rs`, which uses the singly
  list as the reference — two independently linked implementations, not a model of one).
- What `prev` *does* buy is pinned on the test surface only: `unlink_handle_counted` costs 0
  visits at every position, while deleting the same key by value costs its position on both
  lists (`unlink_given_a_handle_is_free_but_delete_by_value_still_walks`). No chart measures
  it, because nothing in this project hands a structure a node.
- What `prev` costs: **24 bytes a node against 16** (`node_is_half_again_the_singly_node`).
  Both twins use `Option<u32>` links (a 4-byte tag padded to 8), so the difference is
  exactly the pointer; a `u32::MAX` sentinel encoding would make both nodes 16 bytes and the
  extra pointer free. The figure is a statement about this shared encoding.
- On the wall clock the doubly line should differ from the singly one by a **constant, not a
  slope**. One off-browser Node probe read the doubly search ≈ 1.24× the singly at n = 1 000,
  10 000 and 100 000 alike, with identical op-counts; nothing asserts that ratio. On the
  passing gate run its search read slope **1.01 ± 0.006**, tail 1.03, and the first real run
  labelled it **O(n log n)** — a tail drifting just above 1, the string array's pattern
  (§2.5), most plausibly the bigger node's memory footprint, though the constant Node ratio
  across L1→L3 sizes leaves the mechanism unestablished. The gate now holds it to the string
  array's rule: band and rise asserted, either neighbouring label accepted.

**Churn: regime 7, unchanged.** Head insert fixes the churn key's position at the head
whatever its value, so above-max, below-min and stored keys all cost exactly one visit
(`no_churn_key_recovers_the_linear_delete`); the engine passes the singly list's `max + 1`
so the two churn curves are one experiment. The finite-difference teardown deletes the
current tail **by value** from the head. A doubly list *could* unlink its tail through the
`tail` handle in O(1) — and that is the trap: the teardown would read O(1) per delete, the
class disagreement would vanish, and the chart would time unlink-given-a-handle under the
name "delete". Every honesty rule bound to the singly list's flat curve (caveat box
`src/ui/DoublyListNotes.tsx`, the O(n) delete row, the PNG legend row and caption line
`dllSheetNote`, the gate pins) binds this one.

**The back-link blind spot.** No canonical op reads `prev` on its walk, so a list with
corrupt back-links answers every membership query, delete result and op-count correctly and
only misbehaves on a later splice. The corpus (`conformance/corpus-dll.txt`) therefore pins
the **tail→head order** before and after the delete sequence and after a mixed
insert/delete stream (where free-list reuse would expose a stale `prev`), and the proptest
checks it after every op — the doubly list's counterpart to the skip list's per-level
dimension (§2.6). The TS teaching twin `DoublyLinkedListF64` holds **real links** too —
an index arena mirroring the Rust one (head/tail handles, freed slots reused) — so its
`keysReversed()` follows `prev`, and those corpus lines bite on both sides: a stale back
link injected into the TS twin fails the corpus's backward lines, the twin's own seeded
random-stream test (backward = reversed forward after every op, with deletes at the head,
the tail, the middle and the only node) and the animation's fold check. *(Until the doubly
animation slice the TS twin was array-backed and those lines pinned agreement only.)*

**The doubly animation draws the links, and its extra steps are free.** The twin traces
every pointer write as a `dll.relink` step — three per insert (new `next`, old head's
`prev` or the tail handle, the head handle), two per hit delete (the neighbours' links or
the handles, written past the found node) — and **none of them is a cost event**, so the
animation's visit count is the singly list's on the same sequence, as the bench op-counts
are. Its display model stores real links rather than deriving arrows from order, because
the subject is the in-between frames: a removed node still drawn but already bypassed, a
new node drawn before anything points at it. The fold is compared to the twin's own
positional links after every op, not only to its key order.

## 3. Reading a curve — the fitter (`src/bench/fit.ts`)

The **log-log slope** is the headline (PLAN §2.3): on log-log axes `y ∝ nᵏ` is a
straight line of slope k. The auto-label is secondary. Every fit reports:

1. **Class score** — squared cosine similarity between the basis vector
   `f(nᵢ)` and the data `yᵢ`, for each basis in {1, log n, n, n log n, n²}.
   This is the R² of the best through-origin fit `y ≈ a·f(n)`; unlike centred
   R² it lets O(1) score ≈ 1 on a flat curve (it reduces to `1 / (1 + CV²)`).
   The best class is the label; if the runner-up is within 0.02 and both sit
   in the soft band {log n, n, n log n}, the result is flagged *ambiguous*.
2. **Slope ± standard error, and a 95 % CI** — ordinary least squares of
   `ln y` on `ln n`, residual-based standard error, t-distribution with m − 2
   degrees of freedom. "0.98 ± 0.05" instead of "0.98".
3. **Local slopes** — the empirical exponent `Δln y / Δln n` on each interval
   between consecutive sweep points, plotted in the UI's local-slope panel.
   A clean power law is a horizontal line; a regime change (cache cliff,
   onset of the asymptotic term) is a step or a bump that the overall slope
   averages away.
4. **Tail slope** — OLS over the upper half of the sweep. Complexity is a
   large-n statement; the small-n end is where constants dominate.
5. **Trend** of the local slope with `ln n`, called *rising* / *falling* only
   when the drift is both material (> 0.05 across the sweep) and statistically
   significant (|t| > 2 on the regression of local slope on `ln n`), else
   *steady*. This is what separates the flat-ish cases the overall slope
   cannot:
   - **falling** → the logarithm's signature (`d ln(ln n) / d ln n = 1 / ln n`);
     "slope 0.2 and falling" is O(log n), not O(1);
   - **rising** → a fixed per-op overhead is masking the growth term; the true
     class is at least as steep as the tail slope;
   - **steady** → a clean power law at the reported exponent.

**Why log n / n / n log n stay hard.** Over the sweep 10 → 100 000, `log₂ n`
rises 3.3 → 16.6 (×5, average log-log slope ≈ 0.17 and falling), `n log n` is
only ×5 steeper than `n` (slope ≈ 1.08 vs 1.00). Timing noise of ±10 % per point
is a ±0.1 wobble in a local slope over a 1-2-5 step. So: constant vs linear vs
quadratic separate reliably; the soft band separates only with the trend and
the CI, and the UI says so (PLAN §7.2, risk R3).

Pinned by `src/bench/fit.test.ts`: exact power laws (zero stderr, tight CI),
noise widens the CI around the true exponent, one local slope per interval,
the logarithm's falling trend, a `2000 + n` curve's rising trend with a tail
slope above the overall slope, and graceful degradation at two points.

## 4. Known hurdles and limits (open, honest)

Ordered by how much they can mislead a reader today.

1. **Churn-key position bias (trees) — the class is fixed, the constant is
   not.** A tree's churn cost depends on *where* in the key range the spare key
   lands. Until this was fixed, churn used one key (`max + 1`) and the teardown
   deleted the maximum, so both rode the *right spine* only — and on
   **reverse-sorted** input, where the BST is a *left* chain whose right spine
   is a single node, the measured mutation read **O(1)** while search read
   **O(n)**: a wrong complexity class. Both trees now churn on **two** keys,
   `min − 1` and `max + 1`, alternating pair by pair and reporting their mean,
   and tear down by alternating delete-max / delete-min. Whichever way a
   degenerate input leans, one of the two keys walks the whole chain, so the
   class is right either way (pinned by
   `bst_reverse_sorted_two_key_churn_recovers_the_linear_class`).

   What this does **not** fix: both spines are still cheaper than a random key
   (≈ ln n against an average depth of ≈ 2 ln n), so a tree's measured mutation
   *magnitude* still runs low. Read a tree's churn curve for its **shape**, not
   its absolute nanoseconds. Averaging two ends also costs the chain regime its
   tight churn-vs-FD match (§2.3) — an honest trade: a constant that no longer
   lines up, in exchange for a class that is never wrong.
2. **Churn-key position bias (min-heap) — the same bias, pointing the other
   way.** Hurdle 1 says a tree's churn constant runs *low*. The heap's runs
   **high**, for the mirror-image reason, and this one cannot be tuned away. A
   heap has no delete-by-value, so a size-preserving churn pair must be insert
   then extract-**min** — and only a key strictly below everything stored is the
   key that extract then takes back. Any higher key and the extract removes a
   *real* key: the structure drains, and after n pairs there is nothing left to
   measure (pinned by
   `heap::tests::a_high_churn_key_would_drain_the_heap`). So churn's insert is
   forced to be the **worst-case** insert, a new global minimum climbing all
   ⌊log₂ n⌋ levels, while an ordinary insert sifts O(1) levels in expectation
   because most of a heap is leaves. The reported **class is right** (Θ(log n),
   which is the textbook worst case and what the extract half costs anyway), but
   the **constant sits above** an average workload's. Read the heap's churn curve
   for its shape, not its nanoseconds — the same instruction as for the trees, in
   the opposite direction.

   Two consequences worth naming. First, this is what puts the heap's *insert
   halves* in different classes in the §2.3 table: churn's is Θ(log n) by
   construction, the finite-difference build's is O(1). Second, the finite-
   difference insert is the honest *average* reading, so the two curves together
   bracket the truth rather than either being wrong — which is why both are shown.

   **What no instrument here can show, and what the gate settles for.** The
   registry states the textbook split for a heap insert, O(1) average against
   O(log n) worst. The churn probe is structurally pinned to the worst case (above),
   and the only average-case reading — the finite-difference insert — is
   noise-dominated on the wall clock at these sizes: its standard error arrives the
   same size as the slope itself (two runs on the same machine: 0.31 ± 0.20 at
   R² 0.93, and 0.26 ± 0.28 at R² 0.89). That is hurdle 7 below in the wild, and a
   slope that wide cannot separate O(1) from O(log n) — so **the heap's O(1) average
   insert is a theory claim this project states but does not measure**; only the
   clock-free op-count proof in Rust pins it.

   The heap's finite-difference *extract* side is unstable in the same way, and
   loudly enough to mislabel itself: the second run above fitted it as **O(n log n)**
   (slope 0.89 ± 0.27, tail 1.30) when the true class is Θ(log n), pinned by
   `heap_search_is_linear_while_extract_min_is_log_n`. **Read the heap's two
   finite-difference halves for their relative magnitude, not for their class
   labels.** The churn curve, which is not a difference of two timings, stays stable
   and correct across runs (slope ≈ 0.13).

   That is why `scripts/verify-browser.mjs` asserts the insert-vs-extract-min
   asymmetry on per-op **magnitude at the largest swept size** (extract-min > 1.3×
   insert; measured 7.5× and 10.6× on the two runs) rather than on a growth-rate
   comparison: both series are sub-linear in truth, so there is no class gap for a
   slope test to catch, and the noisy slopes' ordering flips between runs. Read that
   check as a statement about *cost*, not about *growth*.

   A separate order-sensitivity, deliberately **not** encoded as shape-sensitivity:
   a heap's *build* is Θ(n) on ascending input (every insert appends after one
   failed comparison) and Θ(n log n) on descending (every insert climbs to the
   root), so the finite-difference insert series moves with input order. Churn
   does not — it always rides the full height. The registry flag stays false
   because `inputShapeOf` collapses both sort directions into one `sorted` shape,
   and overlaying the worst case would then be wrong on ascending input, which is
   the heap's *best* case. Pinned by
   `structures::methodology::heap_build_is_order_sensitive_but_churn_is_not`.
3. **Fixed per-op overhead at small n.** The batch loop, probe cycling, and the
   WASM call itself add a constant that flattens the low-n end of every
   wall-clock curve. Mitigated by the tail slope and the rising-trend flag,
   not removed. Op-counts are unaffected.
4. **Cache and memory regimes.** A hash set whose table outgrows L2/L3 shows a
   wall-clock step that is a *machine* effect, not a class change. The
   local-slope panel makes it visible; the label may still wobble. Op-counts
   are unaffected.
5. **Sequential structure order.** Structures are measured one after another,
   so later sweeps may run at a different CPU frequency or under a different
   background load. Interleaving structures per sweep point would remove the
   systematic part; not implemented. The rep spread captures the random part.
6. **Churn and teardown exercise different machine paths (array).** Churn's
   spare key is appended, so its delete is a *scan* with zero shifts; the
   teardown deletes the *front*, so each delete is a pure memmove of the tail.
   Their op-counts agree (§2.3, tight), but the wall-clock need not: on a shared
   cloud runner the array's finite-difference delete read log-log slope ≈ 2.9
   (per-shift cost rising ~10× from n = 250 to 4 000) while churn read 1.0 —
   same on sorted and uniform input, so a machine effect, not a data one. Read
   the FD split for class agreement with the op-count signal, and treat a
   wall-clock exponent above 1 on an O(n) delete as the machine's memmove
   regime, not the algorithm's.
7. **Finite-difference noise amplification.** Differencing two noisy cumulative
   timings amplifies noise, and subtracting build from build+teardown adds
   more; a wall-clock `insert_fd` for an O(1) append is mostly noise (the UI
   says so). The propagated spread is a conservative bound, not a variance.
   Two structures hit this hard enough to change what is asserted: the array's
   O(1) append (§2.3), and the **min-heap's** average-case insert, whose slope
   arrives with a standard error the same size as itself — which is why the
   runtime gate compares the heap's insert and extract-min on magnitude rather
   than on slope (hurdle 2).
8. **Input size vs stored size.** `n` — every chart's x-axis — is the number of
   *input* keys in the prefix. A set de-duplicates, so on data with repeats the
   hash sets and the trie hold fewer than n keys; the arrays, lists, trees, heap
   and skip list hold all n. This is not only a zipfian effect: the **default**
   uniform generator draws integers with replacement from `[0, n]`, so at the top
   of the default search sweep the hash set holds ~63 % (≈ 1 − 1/e) of its input.
   The curves are still honest per structure — each is the cost of answering
   after being handed n keys — and the axis stays input n. What changed is that
   the stored count is **measured and reported**: the worker reads each built
   structure's own `len()` (untimed) into `SweepPoint.storedN` for every search
   and churn point, and wherever it is below n the chart says so beneath the plot
   and in its hover read-out, the CSV carries `stored_n`, the JSON `storedN`, and
   the PNG caption the sentence. The finite-difference halves have no built
   instance, so they carry no stored count (and a hash set's FD "insert" of a
   repeated key is a lookup that finds it — read that curve with this hurdle in
   mind). A **stored-n x-axis** is offered as an opt-in view (`src/ui/storedAxis.ts`). It
   refits every reading on stored n — class scores, slope ± SE, local slopes, tail, trend,
   note and the theory twin — in the UI layer only; the gate's proofs stay on input n. Rules:
   (1) a series without a stored count at every point (the finite-difference halves) stays on
   input n, tagged so in its fit row, legend and PNG legend; (2) where `storedN === n`
   throughout, the input-n fit is kept exactly; (3) once a prefix holds every distinct key,
   stored sizes repeat — nested prefixes mean the same set and table — and those points stay
   in the fit as repeat measurements; a local slope is read only across a ≥ 10 % stored step,
   the tail is taken over the upper half of the *distinct* sizes (a point-count tail across a
   plateau has no x spread and reads a false slope 0), and a series at one stored size
   throughout gets no slope, tagged "one stored size — no slope".
9. **The probe mix is a choice, and it moves constants — classes only for the BST
   (hurdle 15).** The
   default is 64 present + 64 absent; the UI also offers 0 / 25 / 75 / 100 %
   present (§2.2). Per structure, on the same shared probe set:
   - **unsorted array, linked lists, min-heap** — a scan stops at a hit, so the
     per-probe cost runs from ≈ n/2 (hits only) to exactly n (misses only). Both
     are O(n);
   - **chaining hash set** — flat at every mix (a miss walks a whole chain, a hit
     part of one); the **open-addressing set** is flat too, but its misses are its
     dear query (Knuth's ½(1 + 1/(1−α)²), §2.8), so more misses raise its constant
     more;
   - **sorted array, red-black tree, AVL** — O(log n) either way; the **B-tree** costs
     within one comparison either way (its deferred equality test, §2.10);
   - **BST** — the one exception to "never classes", and the reason hurdle 15 exists:
     an above-max miss walks only the right spine, so on a reverse-sorted (left-chain)
     BST every miss costs one comparison and a **misses-only** run reads O(1) for an
     O(n) chain. Any mix with hits in it keeps the O(n) slope;
   - **trie** — unchanged by the mix (§2.5): its derived misses cost what hits cost;
   - **skip list** — the absent block is `max + 1 … max + a`, and that is the skip
     list's *cheap* end rather than its dear one: an above-max probe walks the
     rightmost staircase and pays **nothing** for running out of forward links (the
     loop breaks on a null, not on a failed comparison), where a mid-range absent
     key fails one comparison per level on the way down. The committed corpus shows
     the size of it — in the `deep` case, probe `200` (above max) costs 1 node-visit
     and probe `3` (mid-range absent) costs 12 — and the same asymmetry is measured
     from the other side by
     `skip_list::tests::neither_churn_end_changes_the_reported_class` (29 ops at the
     low end vs 17 at the high). So the absent share of the skip list's workload
     (half, by default) is its best case, and raising it lowers the skip list's
     constant against the sorted array it shares a class with. The **slope is
     unaffected** — a fixed per-level saving, not a function of n. The opt-in
     **mid-range** miss form (below) closes the gap: a between-keys miss costs the skip
     list about what a hit does (0.8–1.25×, `probeMix.midRange.test.ts`). No gate band is
     calibrated on it.

   **The mid-range miss form** (`midRangeAbsent`, opt-in, numeric keys only) places each
   absent key strictly between two adjacent distinct stored keys: spread evenly by rank over
   the interior gaps (Knuth's unsuccessful-search model), at the gap's midpoint, or evenly
   inside it when gaps are scarce (half-integers on dense integer keys); absent by
   construction; shuffled with a fixed seed; the same count at every mix; falling back to
   `max + 1 …` only when the prefix has no interior gap. The default stays `max + 1`, and the
   form is recorded wherever the run goes (the provenance caption, JSON `probeMix.missForm`,
   CSV `search_misses`). Text probes ignore it (they are already derived, §2.5).

   The probes stay shared regardless, for the reason hurdle 11 gives for the trie:
   a chart where each line gets a workload tuned to suit it stops being a
   comparison. The mix applies to search only — churn keys are a separate,
   per-structure decision. The gate's slope bands were calibrated on the default
   only, and the gate asserts the default run reported it (`__compareMeta.probeMix`).
10. **No cross-machine comparability.** Wall-clock results are labelled as
   measured on *this* machine and browser; nothing is normalised across
   machines (PLAN §13, by choice).
11. **The trie's height is a pessimistic constant.** All three string structures
   are probed with one shared derived key set, which for a trie is its *deepest*
   absent case (§2.5). That keeps the chart a comparison, at the cost of a
   constant no real workload would pay in full. It moves the line up, never its
   slope.
12. **The skip list's guarantee is over the key distribution, not a coin.** Its
   node heights are derived from each key's hash (§2.6), which buys determinism
   and order-independence and costs the classical "expected over the algorithm's
   own randomness" guarantee. For any *fixed* key set the structure is fixed;
   there is no re-roll. A distribution engineered against the hash would
   degenerate it, exactly as sorted input degenerates a naive BST.
13. **A per-operation guarantee measured by per-operation averages.** The
   red-black tree's defining property is a bound on the *worst single*
   insert/delete (≤ 2 / ≤ 3 rotations, against an AVL delete measured at 10).
   Every Compare curve is a mean over a batch, so that bound is invisible on the
   chart, on either signal; it lives in the Rust tests and the proptest. What the
   chart *can* show — the two trees' mean costs — is close on shuffled data and
   favours the AVL on sorted data, which read alone undersells the scheme. And
   that holds for the **op-count** signal only: on wall-clock the AVL pays an
   allocation per insert that the red-black tree's slot-reusing arena does not,
   so the timed gap mixes the scheme with storage (§2.9). **Answered by a separate
   view, clock-free:** Compare's *worst single operation* section (`maxop.rs`,
   `src/ui/MaxOpSection.tsx`, on its own button, never on page load) replays one
   workload one operation at a time — build from the n-key prefix in dataset order, then
   delete largest-then-smallest, identical for every structure — and keeps, per pass, each
   counter's maximum on its own: the structure's op-count, rotations (AVL, red-black),
   recolours (red-black, never in ops) and keys re-placed by a grow-and-copy (arrays, hash
   sets — work outside every op-count metric, seen from outside via capacity changes;
   arena growth in the linked twins is a storage detail and is not reported). A single op
   is far too short for the browser's clock, so nothing there is timed. What it shows: the
   red-black tree's ≤ 2 / ≤ 3 holds per operation on every input order; the AVL's insert is
   also ≤ 2; the AVL's worst delete reaches 10 at n = 4 000 on the Rust tests' shuffled and
   duplicate-heavy keys (9 on the default page's dataset; ≤ 2·height either way) but stays at 2 on sorted input, where its tree is near-perfect and the
   red-black tree's worst op-count is the higher one (height 21 vs 12). Totals are
   unchanged (§2.9). A maximum is a property of one key sequence, so the tests assert
   bands, not growth curves.
14. **Open addressing's curves are samples of clusters.** Its search op-count saws
   with the load factor (§2.8), and its churn — even averaged over a 16-key block —
   is a mean over a handful of runs, so both its lines are bumpier than the
   chaining set's at the same α. Neither carries a trend in n. Read its *slope*,
   not its fitted label and not the point-to-point jumps. Its wall-clock constant
   against the chaining set is a machine fact, not a claim this project makes
   either way.
15. **The BST's search line can report the wrong class on a misses-only run.** The
   BST and the AVL share the search chart, on the shared probe set, whose misses are
   `max + 1 …`. For a BST an above-max key walks the *right* spine and nothing else.
   On reverse-sorted input the tree is a left chain whose right spine is the root
   alone, so every miss costs exactly **one** comparison at every n
   (`bst::tests::above_max_misses_cost_one_comparison_on_a_left_chain`): at 0 %
   present the purple line reads flat for an O(n) chain — the failure §4.1 fixed for
   churn, now on the read side. The default and every mix with hits keep the class,
   because a found key walks the real path (reverse-sorted gate pass: BST search slope
   1.07, the AVL's 0.27 on the same keys). Not fixed by BST-specific probes — one probe
   set for every line is what makes the chart a comparison (hurdles 9, 11) — but
   labelled: a caveat box under the search chart turns loud on any misses-only run with
   the BST on it, and the same warning travels as a PNG caption line
   (`src/ui/BstNotes.tsx`). The opt-in mid-range miss form (hurdle 9) closes it: on the
   left chain a miss between j and j + 1 costs n − j comparisons, about n/2 on average, so
   a misses-only run keeps the O(n) class
   (`bst::tests::mid_range_misses_walk_the_whole_left_chain`); under that form the caveat
   box and PNG caption are not shown. The cost of the line itself: on sorted input the BST's
   search sweep builds a chain up to 100 k keys, Θ(n²) comparisons, untimed but
   seconds of wall time before the first point is measured.

16. **A threshold's name overstates what a fixed size ladder shows.** The
   open-addressing load-factor control (§2.8) names a ceiling the table may reach, but the
   1-2-5 ladder samples each fill-and-double cycle at the same few points, so "0.9" reached
   α ≤ 0.78 on the default search sweep. Report the α reached per point, never the setting
   alone — which is what the page does.

## 5. Proof map — which test pins which claim

| claim | where it is proven | clock |
|---|---|---|
| auto-grow, median/stddev/min/max, adaptive reps | `src/bench/measure.test.ts` | virtual |
| `churn ≈ insert_fd + delete_fd` for array / hash-set cost shapes; both methods infer the same class | `src/bench/methodology.test.ts` | virtual |
| two-key churn recovers the O(n) class on a reverse-sorted BST (a one-keyed churn read O(1)) | `structures::methodology::bst_reverse_sorted_two_key_churn_recovers_the_linear_class` | none (op-counts) |
| delete-min never takes the two-child path, so the alternating teardown is safe | `structures::bst::tests::delete_min_never_hits_the_two_child_path` | none (op-counts) |
| the churn unit stays *one* pair — the two keys are averaged, not summed | `structures::bst::tests::churn_holds_size_and_averages_the_two_spine_round_trips` | none (op-counts) |
| the thirteen churn-vs-FD regimes on the *real* structures (§2.3 table) | `bench-engine/src/structures/mod.rs` `mod methodology` (regime 11, the B-tree's, in `structures/methodology_btree.rs`; regime 13, the backward-shift set's, in `structures/methodology_hbs.rs`) | none (exact op-counts) |
| AVL stays O(log n) on the sorted input that makes the BST an O(n) chain | same | none |
| sorted array: O(log n) search vs O(n) mutation on the same structure | same | none |
| min-heap: O(n) search vs Θ(log n) extract-min on the same structure (the sorted array's split inverted) | `structures::methodology::heap_search_is_linear_while_extract_min_is_log_n` | none |
| a heap's build is order-sensitive (Θ(n) ascending, Θ(n log n) descending) while its churn is not | `structures::methodology::heap_build_is_order_sensitive_but_churn_is_not` | none |
| a `max + 1` churn key would drain a heap instead of holding its size — why the low key is forced | `structures::heap::tests::a_high_churn_key_would_drain_the_heap` | none |
| the heap's six op-counting rules match the TS twin (layout, tie-breaks, the 0-op emptying extract) | `conformance/corpus-heap.txt` + `src/structures/conformance-heap.test.ts` | none |
| an above-max miss costs a reverse-sorted (left-chain) BST exactly one comparison at every n, while its hits walk the chain — why a misses-only search run can chart it flat (§4 hurdle 15) | `structures::bst::tests::above_max_misses_cost_one_comparison_on_a_left_chain` | none (op-counts) |
| the BST's misses-only caveat appears exactly when it can bite, loud on that run, and travels as a PNG caption | `src/ui/BstNotes.test.ts` | — |
| **BST and AVL search on the real clock:** both sub-linear on the shuffled default (slopes 0.23 / 0.19–0.22); on the **reverse-sorted** pass the BST's search reads **O(n)** (slope 1.07, ratio ≈ 24 000×) while the AVL's stays sub-linear (0.27) — "sorted data kills a naive BST" on the read side | `scripts/verify-browser.mjs`, both passes (the second clears and re-reads `__sweepProof`) | real |
| the skip list keeps O(log n) on the reverse-sorted input that makes the BST an O(n) chain — with no rotations, because its heights come from the keys | `structures::methodology::skip_list_keeps_its_class_on_the_input_that_degenerates_a_bst` | none |
| the same key set builds the same skip list however the keys arrive (the claim §2.6 rests on) | `structures::skip_list::tests::the_list_is_a_function_of_the_key_set_not_the_insertion_order` | none |
| *both* skip-list churn ends stay in the same class — the check the sorted array fails, and the reason its key position is a documented decision | `structures::skip_list::tests::neither_churn_end_changes_the_reported_class` | none |
| a mis-linked express lane cannot pass conformance: the corpus pins the keys visible at *each* level, before and after a delete sequence | `conformance/corpus-skip.txt` + `src/structures/conformance-skip.test.ts` | none |
| fitter: classes, slope ± SE, CI, local slopes, tail slope, trend | `src/bench/fit.test.ts` | — |
| TS twin ≡ Rust twin (iteration order, shape, per-op counts) | `conformance/*.txt` + `src/structures/conformance-*.test.ts` + Rust `conformance.rs` | — |
| animation shows exactly what the benchmark counts | `src/viz/trace*.test.ts` | — |
| dataset → sizes → engine → fit → `window` proofs plumbing | `src/compare/runSweeps.test.ts` (fake engine) | — |
| the real browser clock yields array O(n) / hash O(1) / sorted-array sub-linear / list O(n) search, array O(n) vs hash O(1) churn, sub-linear tree churn, finite slope uncertainties | `scripts/verify-browser.mjs` (headless Chromium, non-blocking in CI) | real |
| **sorted array on the real clock:** churn rises O(n) (slope ≈ 0.84, ratio ≈ 5.7×) while its *search* on the same run is sub-linear (≈ 0.24) — cheap to read, expensive to write. Regime 6, previously proven only on op-counts | `scripts/verify-browser.mjs` | real |
| **linked list on the real clock — the class disagreement of regime 7:** churn reads flat O(1) while the finite-difference delete-by-value reads O(n) (slope ≈ 1.15, ratio ≈ 11.5×) on the *same* run, the two costs 562× apart at the top of the sweep. The only place in this project where the two methods land in different classes, now visible on the clock and not just in op-counts | `scripts/verify-browser.mjs` | real |
| **partly resolution-limited, and labelled as such:** the *flat* half of that pair is a ~9 ns/op series sitting on the timer's quantization floor — one run reported `firstNanos === lastNanos` to sixteen digits (R² 1.0, slope stderr 5.7e-9), and across five runs the fitted slope wandered over 0.00 / −0.35 / −0.05 / −0.05 / 0.00 on a curve whose true slope is 0. So the gate asserts it two-sided and loose (`\|slope\| < 0.6`, the same threshold the tree/heap churn checks use) and the UI says the wall-clock reading is at the clock's floor. §4 hurdle 2 again — the O(1) class itself is carried by the op-counts, where a churn pair is exactly one node visit at every n. The *rising* half needs no such hedge: it is the robust check, and the 500×+ cost gap is what actually pins the disagreement | `scripts/verify-browser.mjs`, `structures::methodology` | real + none |
| on **reverse-sorted** input the BST's *measured* churn curve reads O(n) (slope ≈ 1.00, R² 1.000) while the AVL stays sub-linear (≈ 0.16) — the wall-clock half of §4.1, which a right-spine-only probe read as flat | `scripts/verify-browser.mjs`, second pass (drives the picker to reverse-sorted) | real |
| **the skip list on the real clock:** search sub-linear *and* churn sub-linear on the same run (slopes 0.23 and 0.02) — the sorted array's read cost (0.25) without its write cost (0.82) — and churn stays sub-linear on the reverse-sorted pass (0.09) where the BST's reads O(n) (1.02) | `scripts/verify-browser.mjs`, both passes | real |
| the min-heap on the real clock: search reads **O(n)** (slope ≈ 0.97, ratio ≈ 6400×) with no lookup shortcut, and churn stays **sub-linear** (≈ 0.13 uniform, ≈ 0.11 reverse-sorted — a heap cannot degenerate) | `scripts/verify-browser.mjs`, both passes | real |
| extract-min costs **more per operation** than insert at the top of the sweep (asserted > 1.3×; measured 7.5× and 10.6×) — a *cost* claim, not a growth claim, for the reason in §4 hurdle 2 | `scripts/verify-browser.mjs` | real |
| the absent probe/churn key is genuinely absent, **length-preserving**, and takes its length from a median key rather than from `keys[0]` — the guard against reintroducing the sentinel bias of §2.5 | `src/bench/stringWorkload.test.ts` | none |
| `prefixOf`'s two-buffer views round-trip to exactly the first n keys, and share the caller's buffer (no copy) | same | none |
| **string keys on the real clock:** array search rises O(n) (slope ≈ 1.02 ± 0.03, R² 0.9995, ratio ≈ 2000×) while hash-set search stays O(1) (≈ 0.04); array churn rises (≈ 0.94), hash-set churn flat (≈ 0.05) | `scripts/verify-browser.mjs`, third pass (drives the picker to `string-corpus`) | real |
| **the second cost axis:** hashing a *string* key costs more per op than hashing a number (14.1 ns vs 4.2 ns on one run) **while both stay flat** — O(1) in the number of keys, O(L) in the size of one | `scripts/verify-browser.mjs` | real |
| the trie's cost is **flat in the number of keys** with no clock at all: the same probe costs the same char-steps in a 100-key trie and a 100 000-key one | `structures::trie::tests::cost_is_flat_in_the_number_of_keys` + `src/structures/trie.test.ts` | none (op-counts) |
| a **prefix-free** churn key would allocate a whole L-node branch per insert+delete pair instead of one node — the trie's counterpart to the heap's drain hazard, and why the derived key is forced | `structures::trie::tests::a_prefix_free_churn_key_allocates_a_whole_branch` + its TS mirror | none |
| the trie's prune-on-delete matches the TS twin key-for-key, including a key that is a *prefix* of another (the one miss neither a scan nor a hash can have) | `conformance/corpus-str.txt` case `prefixes` + `src/structures/conformance-str.test.ts` | none |
| the trie's **animation** shows exactly the char-steps the benchmark counts, for search, insert *and* delete. For **search and delete** the check runs over the *Rust corpus's own* keys and probes, so the picture is chained to counts generated by the bench twin rather than to a hand-written list; the same runs prove the tracer perturbs no counter (traced and untraced agree). **Insert is not chained**, because the corpus has no insert column — its `1 + L` is asserted directly against the formula, which is forced by construction: an insert never falls off the tree, so it always walks the whole key (`insert_generic::<true>` counts the same way). Closing that gap means a new corpus column regenerated from Rust, which is its own slice | `src/viz/trace.trie.test.ts` (search/delete keys+probes from `conformance/corpus-str.txt`) | none (op-counts) |
| the trie's animation **folds to the structure, node for node** — the folded picture is compared to `snapshot()` *and* to `nodeCount()`, not only to the key set, because a dropped prune event leaves litter nodes that every membership question would still answer correctly | `src/viz/model.test.ts` | none |
| the skip list's **animation shows exactly the node-visits the benchmark counts**, for search, insert *and* delete — its one cost event is `skip.inspect`, so a hit's level-0 **double comparison** (`< key?` then `= key?` on the same node) is counted, not deduped. Search and delete run the *Rust corpus's own* keys/probes/delete-sequences (chained to counts generated by the bench twin); insert is self-consistent only, as the corpus has no insert column, and the same runs prove the tracer perturbs no counter | `src/viz/trace.skip.test.ts` (search/delete from `conformance/corpus-skip.txt`) | none (op-counts) |
| the skip list's animation **folds to the structure, express lanes and all** — the folded picture's lanes, *derived* from the node heights + order (`skipLevelKeys`, no stored links), are compared to `SkipListF64.levelKeys()`, not only to the value order, because level 0 alone is a sorted list and a mis-linked express lane answers every membership query correctly while being O(n) | `src/viz/model.test.ts` | none |
| **the trie on the real clock:** search stays flat (slope ≈ 0.17, ratio ≈ 3.8× over a 20× ladder) and beats the string scan by ~500× at the top of the sweep; churn stays flat (\|slope\| ≈ 0.00) — a second O(1)-in-n line beside the hash set's, reached without hashing anything | `scripts/verify-browser.mjs`, third pass | real |
| **asserted only loosely:** the trie's *class label*, which comes out O(log n) as often as O(1). The char-steps are provably identical across the ladder, so the wall-clock bend is the memory hierarchy — ~6 dependent pointer hops per lookup against a tree that outgrows the caches (§2.5). The gate accepts either label and carries the claim on the slope band and the rise limit | `scripts/verify-browser.mjs`, third pass | real |
| **asserted only loosely:** the string array's *class label*, which comes out O(n log n) as often as O(n) because its tail slope runs above 1 (pointer-chasing, §2.5). The gate accepts either of those two labels and carries the claim on the slope band and the rise — and even the loose label check has failed once: a Phase 6 run labelled it **O(n²)** at slope 1.04, band held (see the label-check row below) | `scripts/verify-browser.mjs`, third pass | real |
| **deliberately not asserted:** the *class labels* on the heap's two finite-difference halves. They are noise-dominated and have been seen to mislabel (§4 hurdles 2 and 7); the clock-free op-count proofs carry those claims instead | — | — |
| the graph's traversal costs **exactly `V + 2E`, and BFS ≡ DFS**, at every swept size — the exact identity the wall clock can only see as a noisy linear slope (§2.7) | `structures::methodology::graph_traversal_costs_exactly_v_plus_2e_and_bfs_equals_dfs` | none (op-counts) |
| **why the graph needs two sweeps:** a V-sweep at fixed degree cannot separate `O(V)` from `O(V+E)` (both scale together), while a degree-sweep at fixed `V` moves the cost by exactly 2 per edge — the `+E` term isolated (§2.7) | `structures::methodology::graph_plus_e_term_is_only_visible_when_degree_grows_at_fixed_v` | none (op-counts) |
| the graph's traversal reaches **exactly the source's connected component** and costs `\|C\| + Σ deg`, for random graphs, against a union-find reference — and BFS and DFS agree | `bench-engine/tests/proptest_graph.rs` | none |
| the graph's two traversal **orders** (BFS by distance, DFS mark-on-push) and the multigraph rules (both directions, parallel edges, self-loop counts twice, disconnected reachability) match the TS twin | `conformance/corpus-graph.txt` + `src/structures/conformance-graph.test.ts` | none |
| the graph's **animation shows exactly the vertex-visits + edge-visits the benchmark counts**, for BFS *and* DFS — every corpus case run traced and held to the corpus's own `ops`, `reached` and visit order (no self-consistent-only half: a traversal is the graph's whole op set), traced and untraced runs agreeing, and each stream checked structurally (each visit followed by that vertex's whole list, in order; a mark after an examine iff it discovers) | `src/viz/trace.graph.test.ts` (from `conformance/corpus-graph.txt`) | none (op-counts) |
| the graph's animation **folds to the traversal, frontier discipline and all** — every visit takes the folded frontier's real out-end (queue front / stack top), the per-frame tally equals the cost events folded so far, and each drawn adjacency entry maps to the edge copy `GraphAdj` stores there (`graphAdjacency ≡ adjacency()`, every edge id in exactly two entries) | `src/viz/model.test.ts` | none |
| the graph is never canonical, has its own info shape, and has no key-structure theory (`theoreticalClass('graph', …)` throws) | `src/registry.test.ts` | none |
| edge-list labels → dense ids in **first-seen order** (vertex 0 always real, every prefix dense); labels are strings (`02134 ≠ 2134`), ids handed to the twin are integers | `src/data/edgeList.test.ts`, `src/data/graphs.test.ts` | none |
| the degree-sweep holds V fixed and only adds edges — the random generator is nested across degrees | `src/data/graphs.test.ts` | none |
| disconnected graphs plot at the reached component's `V′ + 2E′`; an engine reporting the nominal size is caught (`countsMatchComponent`); an O(V) cost reads linear on the V-sweep and flat on the degree-sweep | `src/compare/runGraphSweeps.test.ts` (fake engine) | — |
| no allocation inside the timed traversals (same capacity, same heap pointers after 400 timed runs on a dense multigraph) | `graph::tests::the_timed_traversals_never_grow_their_scratch` | none |
| **the graph on the real clock:** op-count = `V′ + 2E′` and BFS = DFS at every point of both sweeps, all reached; V-sweep slope 1.33–1.34 (band 0.7..1.6 — thin headroom, cache, §2.7); degree-sweep slopes 1.01 / 1.08 (band 0.4..1.4, rise > 3×) | `scripts/verify-browser.mjs`, fourth pass (its own button; reads only `__graphProof`) | real |
| the **default probe mix reproduces the calibrated 64 + 64 workload byte for byte** — numeric and string, on the default dataset's full ladder, the string preset's ladder, and edge sizes over seven input shapes; every other mix differs (negative control) | `src/bench/probeMix.test.ts` (frozen copies of the 7450254 builders) | none |
| at every mix the present probes are stored keys, numeric misses are above the max and distinct, and every string miss is a stored seed with its last character changed (never invented — the case the old cycling rule got wrong on a misses-only run) | `src/bench/probeMix.test.ts` | none |
| what the mix does: unsorted-array miss = exactly n, hit ≈ n/2; hash set flat at both extremes; skip-list above-max misses cheaper than hits; trie mean char-steps **identical** at misses-only and hits-only | `src/bench/probeMix.test.ts` (TS twins, op-counts) | none |
| the mix reaches the engine as **one** value per run (a required parameter of every search runner factory) and is reported on the result and on `__compareMeta` | `src/compare/runSweeps.test.ts`; typecheck | — |
| stored size is read back per point and carried into the proof (`lastStoredN`), the CSV (`stored_n`), the JSON (`storedN`) and the notes | `src/bench/measure.test.ts`, `src/compare/runSweeps.test.ts`, `src/ui/export.test.ts`, `src/ui/storedSize.test.ts` | none |
| **on the real build:** the default run measured 64 + 64 (numeric and string passes); the array's `len()` equals input n and the hash set's is 50–75 % of it at the top of the default sweep | `scripts/verify-browser.mjs` | none (deterministic) |
| the doubly linked list's op-counts **equal** the singly list's — search, churn, cumulative build and teardown — at every swept size, sorted and shuffled; regime 7 holds for it (churn 1, FD delete ≈ 3n/4) | `structures::methodology::doubly_linked_list_buys_nothing_on_the_canonical_op_set` | none (op-counts) |
| …and per op, `(result, node-visits)`, over random streams with the singly list as reference; the tail→head walk mirrors head→tail after every op | `bench-engine/tests/proptest_doubly_linked_list.rs` | none |
| no churn key recovers the O(n) delete on a head-inserting list: above-max, below-min and stored keys all cost exactly 1 visit | `structures::doubly_linked_list::tests::no_churn_key_recovers_the_linear_delete` | none |
| what `prev` buys (unlink-given-a-handle, 0 visits anywhere) vs delete-by-value (its position, same on both lists), and what it costs (24 B vs 16 B a node) | `doubly_linked_list::tests::unlink_given_a_handle_is_free_but_delete_by_value_still_walks`, `…::node_is_half_again_the_singly_node` | none |
| a corrupt back-link cannot pass conformance: the corpus pins tail→head order after deletes and after a mixed stream — biting on **both** twins, since the TS teaching twin holds real `prev` links (a stale back link injected into it fails 14 tests across the corpus, the twin's own stream test and the fold check) | `conformance/corpus-dll.txt` + `src/structures/conformance-dll.test.ts` (+ `corpus_dll_matches_committed`), `src/structures/linkedList.test.ts` (backward = reversed forward after every op of a seeded stream that deletes at the head, tail, middle and only node) | none |
| the doubly list's **animation** shows the singly list's visits and draws the real links: pointer writes (`dll.relink`, 3 per insert, 2 per hit delete, none on a search or miss) are steps but not cost events, so its cost events equal the singly list's per op; its fold, which stores links rather than deriving them from order, equals the twin's positional `snapshot()` after every op and draws no link to an undrawn node at any frame; its captions call every write free and every visit the singly walk | `src/viz/trace.linear.test.ts`, `src/viz/model.test.ts`, `src/viz/VizPanel.test.ts` | none |
| **the doubly list on the real clock:** search slope 1.01 ± 0.006 (band 0.7..1.4, ratio > 20, label O(n) or O(n log n)); churn flat (\|slope\| < 0.6); delete-by-value O(n) (slope > 0.6, ratio > 3); the two in different classes, > 20× apart. Deliberately **no** doubly-vs-singly wall-clock ratio | `scripts/verify-browser.mjs`, first pass | real |
| the red-black tree never rotates more than **2 times per insert or 3 per delete**, on every op of shuffled / ascending / descending builds, alternating teardowns and random-order deletes — while one AVL delete on the same shuffled teardown rotates 10 times | `structures::methodology::rbt_bounds_rotations_per_operation_where_the_avl_does_not` + `bench-engine/tests/proptest_rbt.rs` (after every op) | none (op-counts) |
| in **totals** the red-black tree rotates ~18 % less on shuffled inserts at equal comparisons, about the same on sorted inserts and on deletes, and recolours far more than it rotates | `structures::methodology::rbt_rotates_less_on_random_inserts_and_about_as_much_everywhere_else` | none |
| the looser bound shows on sorted input: red-black height ≥ 1.5× the AVL's and a > 1.5× dearer sorted build, yet the finished tree's average search within 6 % | `structures::methodology::rbt_pays_its_looser_bound_in_comparisons_on_sorted_input` | none |
| regime 10: red-black churn ≥ FD sum, within 25 %, both O(log n); and O(log n) kept on the reverse-sorted input that makes the BST a chain (search-min 19 vs 2000) | `structures::methodology::rbt_churn_exceeds_finite_difference_sum_like_the_avl_but_wider`, `…::rbt_keeps_its_class_on_the_input_that_degenerates_a_bst` | none |
| value-copy delete leaves the same values and colours in the same places as CLRS's RB-TRANSPLANT delete | `structures::rbt::tests::value_copy_delete_matches_the_clrs_transplant_delete` | none |
| TS red-black twin ≡ Rust: per-insert ops, per-probe search, shape **with colours**, per-delete ops, rotation and recolour totals; the cases reach every fix-up branch | `conformance/corpus-rbt.txt` + `src/structures/conformance-rbt.test.ts` + `conformance_rbt::corpus_rbt_reaches_every_rotation_count` | none |
| **the red-black tree on the real clock:** search sub-linear (slope 0.25); churn sub-linear on uniform (0.14) *and* reverse-sorted (0.16) input. Class only — never "below/above the AVL" | `scripts/verify-browser.mjs`, both passes | real |
| the B-tree makes about **as many comparisons** per search as the AVL and the sorted array (within ~8 %) while visiting only its **height** — a third to a quarter of the AVL's node-visits | `structures::methodology_btree::btree_matches_the_avl_on_comparisons_but_takes_a_quarter_of_the_node_visits` | none (op-counts) |
| regime 11: B-tree churn ≈ its FD sum (tight) on shuffled, ascending and descending input | `structures::methodology_btree::btree_churn_and_finite_differences_agree_tightly` | none |
| after warm-up a B-tree churn pair performs **zero** splits/merges/borrows and allocates nothing — why CLRS's single-pass delete was replaced | `structures::btree::tests::churn_settles_into_zero_restructures_and_zero_allocation` + `src/structures/btree.test.ts` | none |
| the B-tree keeps O(log n) on reverse-sorted input; sorted input builds half-full nodes (~40 % more, sometimes a level deeper) without changing the class | `structures::methodology_btree::btree_keeps_its_class_on_the_input_that_degenerates_a_bst`, `…::sorted_input_builds_half_full_nodes_without_changing_the_class` | none |
| every B-tree invariant (occupancy, one leaf depth, inclusive separators, size, no leaked node) holds after every op of duplicate-heavy streams at t = 2, 3, 16 | `bench-engine/tests/proptest_btree.rs` | none |
| TS B-tree twin ≡ Rust: per-insert ops, order, per-probe counts, level-by-level shape, delete sequence and shape after, at t = 2, 3, 16 | `conformance/corpus-btree.txt` + `src/structures/conformance-btree.test.ts` | none |
| **the B-tree on the real clock:** search sub-linear and flatter than the array (slope 0.20 ± 0.02); churn sub-linear and near-flat (0.04 uniform, 0.18 reverse-sorted) | `scripts/verify-browser.mjs`, both passes | real |
| **deliberately not asserted:** any clock advantage of the B-tree over the sorted array (search) or the AVL (churn) — printed as `btree hypothesis (info only)` lines for a reader, never a check (§2.10) | — | — |
| at the same α (same hash, same table size) a linearly-probed miss costs Knuth's ½(1 + 1/(1−α)²) and a hit 1 + ½(1 + 1/(1−α)) on this metric — 7.70 vs chaining's 1.72 at α ≈ 0.73 | `structures::methodology::open_addressing_probe_counts_follow_knuths_clustering_formulas` | none (op-counts) |
| open addressing's search saws with α louder than chaining's (1.92× vs 1.27×) and neither trends in n (slopes 0.013 / 0.012) | `structures::methodology::open_addressing_search_saws_with_the_load_factor_but_has_no_trend_in_n` | none |
| regime 12: churn overshoots the FD sum by its own tombstones (primed 7.69, unprimed 5.81, sum 6.06), and an FD across a doubling reads a negative marginal delete for OA (−10.77) but not chaining (+2.00) | `structures::methodology::open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone` | none |
| the chaining set's churn cycles the open-addressing sets' block: one key steps up to 2.33× between sweep points, the block ≤ 1.40×, the 64-key mean ≤ 1.13×; every pair restores the chains exactly; churn within 8 % of the FD sum | `structures::hash_set::tests::{a_single_churn_key_samples_one_bucket, churn_cycles_the_block_and_restores_the_table_exactly, churn_block_is_the_open_addressing_sets}`, `structures::methodology::hashset_churn_matches_finite_differences` | none |
| the tombstone policy, rule by rule: without reuse churn drifts with the rep count and with n; with it a counted pair is identical after any number of timed pairs and the layout is restored; an unprimed first pair is cheaper (why priming exists); tombstones count toward the load so a miss always terminates; one churn key jumps several-fold between sweep points and the block does not | `structures::hash_set_oa::tests::{without_tombstone_reuse_churn_drifts_with_repetition_count, churn_cost_does_not_drift_with_repetition_count, an_unprimed_first_pair_is_cheaper_than_the_steady_state, tombstones_count_toward_the_load_factor_so_a_miss_always_terminates, a_single_churn_key_samples_one_cluster}` + `bench-engine/tests/proptest_hash_oa.rs` | none |
| interleaved insert/delete/search agree with `std::collections::HashSet`; `live + tombs ≤ 0.75·cap` after every op | `bench-engine/tests/proptest_hash_oa.rs` | none |
| TS open-addressing twin ≡ Rust: slot layout before/after deletes and re-inserts, purge, cluster, churn block and its primed layout | `conformance/corpus-hoa.txt` + `src/structures/conformance-hoa.test.ts` | none |
| **open addressing on the real clock:** search flat (slope 0.02 < 0.4, ratio < 10, flatter than the array); churn flat (\|slope\| 0.11 < 0.6) and flatter than the array's | `scripts/verify-browser.mjs`, first pass | real |
| empty storage ⇒ the default auto-run is unchanged (same dataset, same mix, no write, IndexedDB never opened) | `src/persist/session.test.ts` (counting fakes); gate first pass "session: a fresh context restored nothing" | none |
| a restored paste measures exactly the keys the original text built (leading zeros, duplicates, ids past 2^53, astral and combining characters, CRLF), checked on the way back by length + hash | `src/persist/session.test.ts` | none |
| nothing measured is persisted; a restored load says it re-measured | `src/persist/session.ts` (no results field, by construction); `src/persist/SessionNote.test.ts` | none |
| **the browser gate after the Phase 6 parallel batch:** 118/118 checks across four passes, on its third run on a quiet machine | `scripts/verify-browser.mjs` | real |
| a delete-free backward-shift build is the tombstone set's table slot for slot; its churn pair = the tombstone set's unprimed pair + its shift scan, exactly; churn ≈ FD sum within ~1 %; the shared churn block is steady across the ladder | `structures::methodology_hbs::{a_delete_free_build_is_the_tombstone_sets_table_slot_for_slot, backward_shift_churn_is_the_unprimed_pair_plus_its_shift_scan, backward_shift_churn_agrees_with_finite_differences_tightly, the_shared_churn_block_is_steady_across_the_ladder}` | none (op-counts) |
| the backward-shift set grows at the chaining set's points; its first churn pair is already the steady state; a threshold-straddling pair settles before counting; Algorithm R's move test (a key homed past the hole stays put; a whole run shifts) | `structures::hash_set_bs::tests::{grows_at_exactly_the_chaining_sets_points, the_first_pair_is_already_the_steady_state, a_churn_pair_at_the_threshold_settles_before_anything_is_counted, a_key_homed_past_the_hole_stays_put, a_corpus_delete_shifts_a_whole_run}` + `bench-engine/tests/proptest_hash_bs.rs` | none |
| TS backward-shift twin ≡ Rust, including wrap-around and at-threshold cases | `conformance/corpus-hbs.txt` + `src/structures/conformance-hbs.test.ts` | none |
| **the backward-shift set on the real clock:** search flat and flatter than the array; churn flat and flatter than the array's; its clock ratio against the tombstone set is printed, never asserted | `scripts/verify-browser.mjs`, first pass | real |
| the open-addressing load control: growth points at 0.5 and 0.9 in both twins; a threshold whose final table matches the 0.75 size draws the same churn line; the default run is at 0.75 with no caveat | `structures::hash_set_oa::tests::a_threshold_that_ends_at_the_same_size_draws_the_same_churn_line`, `src/structures/hashSetOa.test.ts`, `src/bench/oaLoad.test.ts`, `src/ui/HashOaNotes.test.ts`; gate first pass | none / real |
| per-operation maxima: red-black ≤ 2 rotations per insert, ≤ 3 per delete on every order; the AVL's insert ≤ 2 even with repeats, its worst delete past the red-black bound on uneven trees; a resize re-places a large fraction of n the op-count never sees; de-duplicating structures report their delete misses | `structures::maxop::tests::{rbt_rotates_at_most_twice_per_insert_and_three_times_per_delete, avl_inserts_rotate_at_most_twice_too_even_with_repeated_keys, avl_worst_delete_grows_with_height_past_the_red_black_bound_on_uneven_trees, a_resize_moves_a_large_fraction_of_n_that_the_op_count_never_sees, de_duplicating_structures_report_their_delete_misses, the_insert_maximum_never_falls_along_the_ladder}`; `src/compare/maxOp.test.ts`, `src/ui/MaxOpSection.test.ts` | none |
| a mid-range miss on a reverse-sorted BST costs n − j comparisons (≈ n/2), against 1 for `max + 1` | `structures::bst::tests::mid_range_misses_walk_the_whole_left_chain`, `src/bench/probeMix.midRange.test.ts` | none |
| mid-range misses are absent, interior, rank-spread, deterministic and count-equal to the default at every mix; fair to both hash sets; B-tree within one comparison of a hit; skip list dearer than above-max | `src/bench/probeMix.midRange.test.ts` | none |
| **mid-range misses on the real clock** (reverse-sorted, misses only): BST search > 0.6, AVL < 0.4 — bands reused from the reverse pass, not yet calibrated on this workload | `scripts/verify-browser.mjs`, fifth pass | real |
| a stored-n fit matches a hand-computed slope; toggle-off is byte-identical; FD rows stay on input n, tagged; the gate's proofs are unchanged by the toggle | `src/ui/storedAxis.test.ts`; gate first pass | none / real |
| text-key animations: counted events == ops for array search and hash-set search / insert / delete, counted events + `arr.shift` == ops for the array delete, chained to `corpus-str.txt` | `src/viz/trace.str.test.ts` | none |
| **the browser gate after the §13-extras batch:** 145/145 across five passes on a quiet machine. Its run-completion waits had passed `{ timeout }` as the page-function argument, so Playwright's 30 s default applied; fixed when the slower reverse-sorted pass first exceeded it | `scripts/verify-browser.mjs` | real |
| **label checks are the flaky kind.** The two runs before that each failed one pre-existing class-*label* check whose slope band held — run 1 the string array (labelled O(n²) at slope 1.04), run 2 the string hash set (labelled O(log n) at slope 0.07) — and the doubly list's new label check failed too on its first real run (O(n log n) at slope 1.01, since loosened to accept either neighbour). The bands and rise limits are the claims; a single failing label with its band green is the fitter's soft band (§3), not a regression — re-run before chasing it | `scripts/verify-browser.mjs` | real |
