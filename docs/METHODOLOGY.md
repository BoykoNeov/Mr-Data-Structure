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

Build to n (untimed), then time `k` lookups over a stored probe workload: 64
present keys spread evenly through the prefix + 64 keys guaranteed absent (past
the maximum). The 50/50 mix keeps the array's expected scan at ~n/2 + n and the
hash set's at O(1). (Configurable mixes are a PLAN §6.3 item not yet exposed.)

### 2.3 Size-mutating ops: churn and the finite-difference cross-check

You cannot time "inserts at size n" because each insert changes n. Two methods,
each on the same structure (PLAN §6.3):

- **Churn (primary).** Build to n, then time `k` insert+delete *pairs* of a
  spare key (absent by construction: `max + 1`, or `min − 1` for the sorted
  array). Size stays at n; the pair cost is the combined mutation cost. **The
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
`bench-engine/src/structures/mod.rs` (`mod methodology`):

| structure | regime | why | class agreement |
|---|---|---|---|
| unsorted array | **tight** (< 2 %) | costs are position-uniform: insert is a free append, any delete is O(n) | yes, O(n) |
| hash set | **loose** (< 50 %) | both sides are tiny O(1) counts; the churn key's chain vs the swept average | yes, O(1) |
| BST, sorted input (chain) | **FD sum overshoots churn** on the insert side (1500 vs 1002) | the *delete* halves match exactly (both alternate the two ends), but churn's insert averages a full-chain descent with a root-adjacent one (≈ n/2) while the build drops every key at the chain's bottom (≈ n) | class only, O(n) |
| BST, shuffled (balanced) | **FD sum overshoots churn** (~32 %: 23.7 vs 18) | churn rides the two cheap spines (≈ ln n each) while `insert_fd` reflects the average depth (≈ 2 ln n) and `delete_fd` is added on top | class only, O(log n) |
| AVL | **close** (~10 %), churn ≥ sum | height and average depth differ by only ~1.44×, so the spine probes and the average insert nearly coincide | yes, O(log n) |
| sorted array (front churn) | **churn overshoots sum** (≈ 2n vs ≈ 3n/2) | front churn shifts the whole array twice; the shuffled build inserts at average position n/2 | yes, O(n) — and *tail* churn would have read O(log n): the key position sets the class |
| linked list | **class disagreement** (churn O(1), FD delete O(n)) | head insert puts the churn key where deletion is O(1); the canonical delete-by-value (teardown of the oldest) walks the list | **no** — reported, not hidden |

Both BST rows moved with the two-key change (they were "tight" and
"overshoot"): alternating the ends is what fixes the *class* on reverse-sorted
input, and the price is that the chain's constants no longer coincide. The
direction of every tree row is now the same — the finite-difference sum sits at
or above churn, because a build inserts at average depth and churn rides spines.

Consequence for the UI: churn is shown as *the* mutation curve, the FD split as
the cross-check, and both are read for **shape** (PLAN §2.3). Where the churn
key's position biases the constant (trees, sorted array) or even the class
(linked list), the bias is stated next to the chart and in §4 below.

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
2. **Fixed per-op overhead at small n.** The batch loop, probe cycling, and the
   WASM call itself add a constant that flattens the low-n end of every
   wall-clock curve. Mitigated by the tail slope and the rising-trend flag,
   not removed. Op-counts are unaffected.
3. **Cache and memory regimes.** A hash set whose table outgrows L2/L3 shows a
   wall-clock step that is a *machine* effect, not a class change. The
   local-slope panel makes it visible; the label may still wobble. Op-counts
   are unaffected.
4. **Sequential structure order.** Structures are measured one after another,
   so later sweeps may run at a different CPU frequency or under a different
   background load. Interleaving structures per sweep point would remove the
   systematic part; not implemented. The rep spread captures the random part.
5. **Churn and teardown exercise different machine paths (array).** Churn's
   spare key is appended, so its delete is a *scan* with zero shifts; the
   teardown deletes the *front*, so each delete is a pure memmove of the tail.
   Their op-counts agree (§2.3, tight), but the wall-clock need not: on a shared
   cloud runner the array's finite-difference delete read log-log slope ≈ 2.9
   (per-shift cost rising ~10× from n = 250 to 4 000) while churn read 1.0 —
   same on sorted and uniform input, so a machine effect, not a data one. Read
   the FD split for class agreement with the op-count signal, and treat a
   wall-clock exponent above 1 on an O(n) delete as the machine's memmove
   regime, not the algorithm's.
6. **Finite-difference noise amplification.** Differencing two noisy cumulative
   timings amplifies noise, and subtracting build from build+teardown adds
   more; a wall-clock `insert_fd` for an O(1) append is mostly noise (the UI
   says so). The propagated spread is a conservative bound, not a variance.
7. **Input size vs stored size.** `n` is the number of *input* keys in the
   prefix. A set de-duplicates, so on duplicate-heavy (zipfian) data the hash
   set holds fewer than n keys; the array and multiset structures hold all n.
   The curves are still honest per structure, but "n" means input size.
8. **Probe mix is fixed** at 64 present + 64 absent. A present-only or
   absent-only workload changes the array's constant (n/2 vs n) and the
   chain-walk length in the hash set, not the class.
9. **No cross-machine comparability.** Wall-clock results are labelled as
   measured on *this* machine and browser; nothing is normalised across
   machines (PLAN §13, by choice).
10. **String-key structures** exist and are conformance-pinned in the engine but
   are not wired into the sweep; the Compare panel is numeric-only.

## 5. Proof map — which test pins which claim

| claim | where it is proven | clock |
|---|---|---|
| auto-grow, median/stddev/min/max, adaptive reps | `src/bench/measure.test.ts` | virtual |
| `churn ≈ insert_fd + delete_fd` for array / hash-set cost shapes; both methods infer the same class | `src/bench/methodology.test.ts` | virtual |
| two-key churn recovers the O(n) class on a reverse-sorted BST (a one-keyed churn read O(1)) | `structures::methodology::bst_reverse_sorted_two_key_churn_recovers_the_linear_class` | none (op-counts) |
| delete-min never takes the two-child path, so the alternating teardown is safe | `structures::bst::tests::delete_min_never_hits_the_two_child_path` | none (op-counts) |
| the churn unit stays *one* pair — the two keys are averaged, not summed | `structures::bst::tests::churn_holds_size_and_averages_the_two_spine_round_trips` | none (op-counts) |
| the seven churn-vs-FD regimes on the *real* structures (§2.3 table) | `bench-engine/src/structures/mod.rs` `mod methodology` | none (exact op-counts) |
| AVL stays O(log n) on the sorted input that makes the BST an O(n) chain | same | none |
| sorted array: O(log n) search vs O(n) mutation on the same structure | same | none |
| fitter: classes, slope ± SE, CI, local slopes, tail slope, trend | `src/bench/fit.test.ts` | — |
| TS twin ≡ Rust twin (iteration order, shape, per-op counts) | `conformance/*.txt` + `src/structures/conformance-*.test.ts` + Rust `conformance.rs` | — |
| animation shows exactly what the benchmark counts | `src/viz/trace*.test.ts` | — |
| dataset → sizes → engine → fit → `window` proofs plumbing | `src/compare/runSweeps.test.ts` (fake engine) | — |
| the real browser clock yields array O(n) / hash O(1) / sorted-array sub-linear / list O(n) search, array O(n) vs hash O(1) churn, sub-linear tree churn, finite slope uncertainties | `scripts/verify-browser.mjs` (headless Chromium, non-blocking in CI) | real |
