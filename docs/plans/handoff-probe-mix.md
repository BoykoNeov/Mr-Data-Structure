# Handoff — configurable probe mix + stored size next to input size

Slice owner: parallel agent (worktree `agent-ad439af97afd7109c`, branched from `main` @ 7450254).
Scope: docs/PLAN.md §13 last bullet; docs/METHODOLOGY.md §4 hurdles 8–9 (and §2.2).
This file holds the doc text the lead should merge; the living docs were deliberately not edited.

---

## 1. docs/PLAN.md

### §10 — new "Done" entry (append under Phase 6, after the graph entry)

  - **Done (the search workload becomes a choice, and stored size is said beside input size):**
    the §6.3 promise "mix of present/absent keys is configurable" is now true. A *Search
    workload — hits vs misses* control (`src/ui/ProbeMixControl.tsx`, radio buttons placed
    after the dataset panel) offers 0 / 25 / **50 (default)** / 75 / 100 % present probes for
    the next run. The builders moved out of the worker into `src/bench/probeMix.ts`
    (`buildNumericProbes`) and `src/bench/stringWorkload.ts` (`buildStringProbes(keys, mix)`),
    and **the default reproduces the calibrated 64 + 64 workload byte for byte** — pinned in
    `probeMix.test.ts` against frozen verbatim copies of the 7450254 builders, on the default
    dataset's whole sweep ladder, the string preset's ladder, and edge sizes (0, 1, 63, 64,
    65, 127, 128, …) over sorted / reverse / zipfian / gaussian / negative / multi-byte /
    alphabet-exhausted inputs, with a negative control that every other mix differs. The
    shared-probes rule holds by construction: the mix is one value per run, threaded to a
    **required** `mix` parameter of every search runner factory, so a structure added to
    `runSweep` without it fails to compile. What each mix does is pinned clock-free on the TS
    twins: the unsorted array's miss costs exactly n and its hit ≈ n/2 (a constant, the class
    unchanged); the hash set is flat at both extremes; the skip list's above-max misses are its
    cheaper query (hurdle 9); and the trie's mean char-steps are **exactly equal** at
    misses-only and hits-only, because a last-character miss walks the whole key like a hit.
    **Stored size:** each built structure's own `len()` is read back (untimed) into
    `SweepPoint.storedN` for every search and churn point — measured, not declared, so a new
    structure reports it with no registry flag to forget. The x-axis stays **input n**. Where a
    structure held fewer keys than it was given, the chart says so under the plot and in its
    hover read-out, the CSV gains a trailing `stored_n` column (JSON points carry `storedN`),
    and the PNG caption carries the same sentence. It shows on the **default** run: the
    uniform generator draws with replacement from `[0, n]`, so at n = 100 000 the hash set
    holds ~63 % of its input. Gate: `__compareMeta.probeMix` and `SweepProof.lastN` /
    `lastStoredN` (additive); three new assertions (UNRUN at handoff). **No new deps.**

### §13 — replace the last bullet with

- ~~Configurable present/absent probe mix (§6.3), and reporting *stored* size next to *input*
  size for de-duplicating structures (METHODOLOGY §4.8–4.9).~~ **Done** (Phase 6). Two
  narrower questions remain: (a) should the numeric absent block offer a **mid-range** form
  (keys between stored keys) as well as `max + 1 …`? It is the skip list's dearer miss and
  would close the hurdle-9 gap, but it is a different workload whose slope bands would need
  their own calibration; (b) should the charts offer an explicit **stored-n x-axis** for the
  de-duplicating structures? Today the axis is input n everywhere, and the stored count is
  reported beside it.

---

## 2. docs/METHODOLOGY.md

### §2.2 — replacement text

### 2.2 Size-preserving ops: `search`

Build to n (untimed), then time `k` lookups over a stored probe workload of **128 probes**:
a block of present keys spread evenly through the prefix (`keys[⌊i·n/p⌋]`), then a block
guaranteed absent. The split is the run's **probe mix** (`src/bench/probeMix.ts`), chosen in
the UI as 0 / 25 / 50 / 75 / 100 % present; the **default is 64 present + 64 absent**, the
workload every gate band was calibrated on, and is reproduced byte for byte. The present
block is capped at n (at n = 10 the default is 10 + 64, as it always was); the absent block
is not. Numeric absent keys are `max + 1 … max + a`. String absent keys are derived by
`absentLike` (§2.5) from `min(a, n)` stored seeds spread through the prefix — identical to the
old "cycle the present block" rule at the default, and the only rule that stays
derived-from-the-data on a misses-only run. Every structure in a run gets the same probe
set. A 50/50 mix keeps the array's expected scan at ~n/2 + n and the hash set's at O(1);
what other mixes do is hurdle 9.

### §2.5 — one sentence to add after "The probe set stays shared and unchanged anyway, …"

> The probe *mix* does not change this: a hit and a last-character miss both cost `1 + L`
> char-steps, so the trie's search cost is the same at every mix (exactly equal at the two
> extremes, `probeMix.test.ts`) — the one structure the mix control cannot move.

### §4 hurdle 8 — replacement text

8. **Input size vs stored size.** `n` — every chart's x-axis — is the number of *input* keys
   in the prefix. A set de-duplicates, so on data with repeats the hash sets and the trie hold
   fewer than n keys; the arrays, lists, trees, heap and skip list hold all n. This is not
   only a zipfian effect: the **default** uniform generator draws integers with replacement
   from `[0, n]`, so at the top of the default search sweep the hash set holds ~63 %
   (≈ 1 − 1/e) of its input. The curves are still honest per structure — each is the cost of
   answering after being handed n keys — and the axis stays input n. What changed is that
   the stored count is now **measured and reported**: the worker reads each built
   structure's own `len()` (untimed) into `SweepPoint.storedN` for every search and churn
   point, and wherever it is below n the chart says so beneath the plot and in its hover
   read-out, the CSV carries `stored_n`, the JSON carries `storedN`, and the PNG caption
   carries the sentence. The finite-difference halves have no built instance, so they carry
   no stored count (and a hash set's FD "insert" of a repeated key is a lookup that finds it —
   read that curve with this hurdle in mind).

### §4 hurdle 9 — replacement text

9. **The probe mix is a choice, and it moves constants, never classes.** The default is 64
   present + 64 absent; the UI also offers 0 / 25 / 75 / 100 % present (§2.2). Per structure,
   on the same shared probe set:
   - **unsorted array, linked list, min-heap** — a scan stops at a hit, so the per-probe cost
     runs from ≈ n/2 (hits only) to exactly n (misses only). Both are O(n);
   - **hash sets** — flat at every mix (a miss walks a whole chain, a hit part of one);
   - **sorted array** — O(log n) either way;
   - **trie** — unchanged by the mix (§2.5): its derived misses cost what hits cost;
   - **skip list** — the absent block is `max + 1 … max + a`, and that is the skip list's
     *cheap* end rather than its dear one: an above-max probe walks the rightmost staircase
     and pays **nothing** for running out of forward links (the loop breaks on a null, not on
     a failed comparison), where a mid-range absent key fails one comparison per level on the
     way down. The committed corpus shows the size of it — in the `deep` case, probe `200`
     (above max) costs 1 node-visit and probe `3` (mid-range absent) costs 12 — and the same
     asymmetry is measured from the other side by
     `skip_list::tests::neither_churn_end_changes_the_reported_class` (29 ops at the low end
     vs 17 at the high). So the absent share of the skip list's workload (half, by default)
     is its best case, and raising it lowers the skip list's constant against the sorted
     array it shares a class with. The **slope is unaffected** — the effect is a fixed
     per-level saving, not a function of n.

   The probes stay shared regardless, for the reason hurdle 11 gives for the trie: a chart
   where each line gets a workload tuned to suit it stops being a comparison. The gate's
   slope bands were calibrated on the default only, and the gate asserts the default run
   reported it (`__compareMeta.probeMix`).

### §5 — proof-map rows to add

| claim | where it is proven | clock |
|---|---|---|
| the **default probe mix reproduces the calibrated 64 + 64 workload byte for byte** — numeric and string, on the default dataset's full sweep ladder, the string preset's ladder, and edge sizes over seven input shapes; any other mix differs (negative control) | `src/bench/probeMix.test.ts` (frozen copies of the 7450254 builders) | none |
| at every mix the present probes are stored keys, the numeric misses are above the max and distinct, and every string miss is a stored seed with its last character changed (never an invented string — the case the old cycling rule got wrong on a misses-only run) | `src/bench/probeMix.test.ts` | none |
| what the mix does: unsorted-array miss = exactly n, hit ≈ n/2, both ×10 over a ×10 ladder; hash set flat at both extremes; skip-list above-max misses cheaper than hits; trie mean char-steps **identical** at misses-only and hits-only | `src/bench/probeMix.test.ts` (TS twins, op-counts) | none |
| the mix reaches the engine as **one** value per run, and is reported on the result and on `__compareMeta` | `src/compare/runSweeps.test.ts` | — |
| the stored size is read back per point, carried into the proof (`lastStoredN`), the CSV (`stored_n`), the JSON (`storedN`) and the notes — and the default dataset really does give the hash set ~63 % of its input | `src/bench/measure.test.ts`, `src/compare/runSweeps.test.ts`, `src/ui/export.test.ts`, `src/ui/storedSize.test.ts` | none |
| **on the real build:** the default run measured 64 + 64 (numeric and string passes); the array's `len()` equals input n and the hash set's is 50–75 % of it at the top of the default sweep | `scripts/verify-browser.mjs` (UNRUN at handoff) | none (deterministic) |

---

## 3. CLAUDE.md — gotchas to add

- **The probe mix's default is a calibrated workload, not a starting value.** At 50 % the
  builders (`src/bench/probeMix.ts`, `buildStringProbes`) must return *exactly* the 64 + 64
  keys the gate's slope bands were tuned on — `probeMix.test.ts` pins it byte for byte against
  frozen copies of the old builders. Don't "simplify" those copies to import the new code (a
  reference that calls the code under test proves nothing), and don't change the default
  without recalibrating the gate. The search runner factories take `mix` as a **required**
  argument on purpose: a structure added to `runSweep` without the run's mix must fail to
  compile rather than silently measure the default (the shared-probes rule). String misses
  are seeded from `min(absent, n)` spread stored keys, not from the present block — the two
  agree only at the default, and the old rule invented one-character keys on a misses-only run.
- **The mix control is radio buttons, after the dataset panel, on purpose.** The gate drives
  the generator with `page.locator('select').first()`; a `<select>` placed above it would
  silently take that call.
- **`n` on every chart is input keys; `storedN` is what the structure holds.** Read back from
  each structure's own `len()`, never declared in the registry, so every bench twin must keep
  exporting `len()` (the search interfaces require it at compile time; the mutation ones ask at
  runtime because their constructors are cast). The default uniform dataset already makes the
  hash set hold ~63 % of its input at n = 100 000 — that note on the default page is a finding,
  not a bug. Don't switch the axis to stored n without an explicit user choice.

---

## 4. README Status — suggested addition

After "…with a theoretical overlay, error bars, slope uncertainty, a local-slope panel, and
CSV / JSON / PNG export;" add:

> the search workload's **hits-vs-misses mix is a user choice** (the default is the calibrated
> 50/50, reproduced exactly), and a structure that keeps one copy of each repeated key says how
> many it actually held beside the input size — on the chart, in the exports and in the PNG;

---

## 5. UNRUN, follow-ups, and judgement calls to review

### UNRUN (by instruction: no `npm run preview` / `verify:browser` on the shared machine)

- `scripts/verify-browser.mjs`: three new assertions — (1) the default run's
  `__compareMeta.probeMix` is 50 % / 64 + 64; (2) at the top of the default search sweep the
  array's `lastStoredN === lastN` and the hash set's `lastStoredN` is 50–75 % of `lastN`;
  (3) the string pass's `probeMix` is 64 + 64. All three are deterministic (seeded data, no
  clock), so a failure would be a real plumbing break, not noise. Only `node --check` was run.
- No visual check of the page: the radio control, the "Stored vs input size" line under each
  chart, the uPlot hover read-out (`value` formatter, only on series that dropped keys), and
  the PNG caption lines (`describeMix` + `storedSizeNotes` + `mixNotes`) were not seen
  rendered. `npm run build` passes.
- The real-clock effect of a non-default mix on the slope bands is unmeasured. Nothing in the
  gate runs a non-default mix, by design.

### Merge notes for the lead (parallel slices)

- **New structures must pass `mix`.** Anything added to `runSweep` / `runStringSweep` must call
  `searchRunnerFactory(Ctor, keys, mix)` / `stringSearchRunnerFactory(Ctor, offsets, bytes, mix)`;
  the merge will fail typecheck until it does — intended.
- **New search structures must export `len()`** (required by `SearchStruct` /
  `StringSearchStruct`). The open-addressing hash set will de-duplicate, so its stored-size note
  appears with no further work; the red-black tree / B-tree depend on their own semantics.
- `SweepProof` gained `lastN` / `lastStoredN`; `__compareMeta` gained `probeMix`; no new
  `window` globals, so the `Object.keys(win)` order assertions in `runSweeps.test.ts` are
  unchanged.
- `runAllSweeps` / `runStringSweeps` gained a trailing `mix` parameter (after `win`);
  `CompareResult` / `StringCompareResult` gained a required `probeMix` field.
- CSV gained a trailing `stored_n` column (column positions unchanged).

### Judgement calls a reviewer might disagree with

1. **Fixed budget of 128 probes; the fraction picks the split** (`round(128·f)`). Keeps the
   per-probe op-count an average over the same number of queries at every mix. The present
   half is capped at n, the absent half never — so at small n the realised mix leans absent,
   exactly as the default always did. Reported as counts at the top of the sweep
   (`ProbeMixSummary`) so the fraction alone is never mistaken for what was measured.
2. **Five discrete choices, not a slider.** Each is a nameable workload; a continuous slider
   invites reading meaning into 37 % vs 41 %.
3. **String absent seeds changed for non-default mixes** (spread by the absent count, not the
   present block cycled). Identical at the default; at other mixes the old rule either invented
   keys (misses-only) or seeded every miss from the first third of the data (75 % hits).
4. **Numeric absent construction kept as `max + 1 …`** (as instructed). More misses therefore
   widen the skip list's known hurdle-9 advantage; a mid-range absent mode is a §13 follow-up.
5. **The mix applies to search only.** Churn keys are untouched — they are a separate,
   per-structure measurement decision (CLAUDE.md).
6. **The mix is not part of `PickerState`**, so presets do not reset it and it persists across
   runs until changed. The results on screen report the mix they *ran* at, not the control's
   current value.
7. **Stored size is measured (`len()`), not a registry flag.** Generic and impossible to forget,
   at the cost of one untimed call per point. FD halves carry none.
8. **The x-axis stays input n**, with stored n reported beside it; no axis toggle was added
   (proposed in §13 instead) — two x ladders on one chart would need its own design.
9. **The stored-size note renders inside `SweepChart`** (below the plot, outside the
   `data-chart` host the PNG export reads), so every chart gets it, including future ones.
10. **The search callout's "half of every structure's query load" is now computed** from the
    run's mix (`shareWord`), the only edit to existing copy.
11. The trie "identical cost at every mix" claim is pinned **exactly** only at the two
    extremes; at 50 % the hit and seed spreads are 64 keys rather than 128, so the means agree
    to within rounding, not bit-for-bit.
