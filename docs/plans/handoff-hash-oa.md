# Handoff — open-addressing hash set, measured end to end

Slice owner: parallel agent (worktree `agent-afd3d7c074855b891`, branched from `main` @ 7450254,
then merged with local `main` @ 94a3168 before the final commit).
Scope: docs/PLAN.md §13's first open question (a second hash table, open addressing), the
measured half only — the animation is a later slice.
This file holds the doc text the lead should merge; the living docs were deliberately not edited.

StructureId `'hashoa'`, colour `#aec7e8`, METHODOLOGY **§2.8**.

---

## 1. docs/PLAN.md §10 — new "Done" entry (append under Phase 6)

  - **Done (a second hash set — open addressing, measured against chaining on equal terms):**
    `HashSetOaF64` in Rust (`bench-engine/src/structures/hash_set_oa.rs`) and its TypeScript
    teaching twin (`src/structures/hashSetOa.ts`), pinned slot for slot by
    `conformance/corpus-hoa.txt`, wired onto the numeric Compare search and churn charts as a
    fifth flat structure (no new engine call — it rides `runSweep` and `runMutationSweep`).
    **Linear probing, set semantics, tombstone delete.** It is held to the chaining set's hash
    (`mix_f64`), 4-slot start, 0.75 threshold and doubling, so at every n the two tables have
    the **same capacity and load factor** and the pair of lines isolates the collision strategy.
    Cost metric **hashes + slot probes**, on the chaining set's convention (one per occupied
    slot examined; the empty slot that ends a walk is free, as the end of a chain is), so the
    two op-counts line up unit for unit.

    **The tombstone policy is the measurement decision.** Four rules, each pinned: (1) insert
    reuses the *first* tombstone on its path, after walking on to an empty slot to dedupe;
    (2) tombstones count toward the load (`live + tombs > 0.75·cap` ⇒ rehash; purge in place
    when `live ≤ 0.375·cap`, else double) — otherwise a delete-heavy sequence can leave no empty
    slot and a miss never terminates; (3) `set_churn_key` **primes** the churn keys with untimed
    insert+delete pairs, repeating passes to a fixed point, because even with reuse the first
    pair is cheaper than every later one; (4) churn cycles a **block** of `clamp(⌊len/32⌋, 1, 16)`
    keys `max + 1, max + 2, …`, because one key under linear probing samples one cluster and the
    curve jumped several-fold between neighbouring sweep points. With the naive policy (no
    reuse) churn's mean per-pair cost climbs with the *number of reps the batcher picks* and,
    because the headroom before a purge scales with the table, masquerades as growth in n
    (`without_tombstone_reuse_churn_drifts_with_repetition_count`); with the real one, a
    counted pair is identical after 0, 1, 7, 100 or 100 000 timed pairs and the layout is
    restored exactly (`churn_cost_does_not_drift_with_repetition_count`, plus a proptest).

    **What the charts now say.** Same hash, same table, more probes: a linearly-probed miss
    costs Knuth's ½(1 + 1/(1−α)²) (7.70 measured vs 7.48 at α ≈ 0.73, against chaining's 1.72) —
    primary clustering, clock-free (`open_addressing_probe_counts_follow_knuths_clustering_formulas`).
    Its probe count saws with α as the table doubles, louder than chaining's (1.92× vs 1.27×
    swing over the 10 … 100 000 ladder) with no trend in n (slopes 0.013 / 0.012). The **tenth
    churn-vs-finite-difference regime**: churn overshoots the FD sum by ~27 % (7.69 vs 6.06),
    and an unprimed pair (5.81) shows the overshoot is the churn keys' own tombstones bridging
    runs, not a key position. Corpus dimension: the **slot layout** (every key and tombstone)
    before deletes, after them and after re-inserts, plus the churn block and its primed
    layout — the only thing that tells a twin with a different tombstone rule apart. Gates:
    cargo test (212 lib + proptests) green, vitest 1024 green, typecheck + build clean;
    verify:browser **UNRUN** (five new checks). **No new deps.**

## 2. docs/PLAN.md §8 and §13

### §8 Hashing table — add a row under the chaining one

| Hash set (open addressing) | O(1) avg, O(n) worst | O(1) avg, O(n) worst | O(1) avg | hashes + slot probes | **Built (Phase 6).** Linear probing, same hash / start size / 0.75 threshold / doubling as the chaining set, so both tables share a load factor at every n. Delete leaves a **tombstone**; insert reuses the first one on its path; tombstones count toward the load (purge in place or double). Cost counted on the chaining convention — occupied slots examined, the empty slot that ends a walk free (METHODOLOGY §2.8) |

### §13 — replace the first bullet with

- ~~Hash table: stay with separate chaining, or add open-addressing as a *second* selectable
  variant?~~ **Done** (Phase 6) — both are measured on the same charts, held to the same hash
  and table sizes (METHODOLOGY §2.8). Remaining: (a) a **backward-shift-delete** variant (no
  tombstones at all; a churn pair would restore the table by construction, with no priming
  and no tombstone overshoot) as a third line — the cleanest test of how much of regime 10 is
  the tombstone; (b) a **load-factor control** (0.5 is the usual linear-probing ceiling;
  0.75 was kept to match chaining, which makes OA's miss cost ~4.5× chaining's near the top
  of each sawtooth); (c) its animation.

## 3. docs/METHODOLOGY.md

### New §2.8 (after §2.7)

### 2.8 Two hash sets, one hash (open addressing vs chaining)

The open-addressing set (`hash_set_oa.rs`, linear probing) is held to the chaining set's
hash (`mix_f64`), 4-slot start, 0.75 threshold and doubling. Both tables therefore have the
**same capacity and the same load factor α at every n**, and the only difference between the
two curves is where a colliding key goes — the next free slot of one flat array, where
neighbouring homes' collisions merge into one run (**primary clustering**).

**Counting convention.** One tick for the hash, one per *occupied* slot examined (a live key
compared, or a tombstone stepped over). The **empty slot that ends a walk is free**, exactly as
reaching the end of a chain is free in the chaining set — in both, a header read (the slot's
state byte, the bucket's length) says "stop". That makes the two op-counts comparable unit for
unit; it also means Knuth's probe counts (which include the final empty slot) read one higher
than this metric, and the hash tick puts the one back: on this metric a miss costs
½(1 + 1/(1−α)²) and a hit 1 + ½(1 + 1/(1−α)), against chaining's 1 + α and 2 + α/2.

**Clustering, clock-free.** Measured on 20 000 absent and n present keys
(`open_addressing_probe_counts_follow_knuths_clustering_formulas`):

| n | α | OA miss (Knuth) | chained miss | OA hit (Knuth) | chained hit |
|---|---|---|---|---|---|
| 3 000 | 0.73 | 7.70 (7.48) | 1.72 | 3.48 (3.37) | 2.38 |
| 5 000 | 0.61 | 3.66 (3.79) | 1.61 | 2.82 (2.78) | 2.32 |
| 12 000 | 0.73 | 7.14 (7.48) | 1.74 | 3.33 (3.37) | 2.37 |

Misses pay the most, so the **probe mix** moves this structure's constant more than the
chaining set's (misses-only is its dear end; class unchanged).

**The sawtooth.** A doubling table's α swings between ~0.38 and 0.75 as n climbs the ladder,
and linear probing's cost is steep in α, so its search op-count saws: 2.02 … 3.89 per probe
on the 10 … 100 000 ladder with the default mix (1.92× swing) against chaining's 1.62 … 2.05
(1.27×). Neither has a trend (log-log slopes 0.013 and 0.012,
`open_addressing_search_saws_with_the_load_factor_but_has_no_trend_in_n`). The gate therefore
asserts the slope band, not the fitter's label.

**Tombstones — the landmine and the policy.** Linear probing cannot empty a deleted slot (a key
whose walk passed through it would become unreachable), so delete leaves a tombstone. Churn —
thousands of insert+delete pairs of one key at fixed n — is exactly the workload that breaks a
naive tombstone policy:

1. *Without reuse*, each pair strands one more tombstone in the churn key's own run, so the walk
   grows a slot per pair until a rehash. The mean cost per pair then depends on how many pairs
   were run — which the adaptive batcher varies — and since the headroom before the purge is
   proportional to the table, the drift reads as growth in n: an O(1) structure charted as
   rising (`without_tombstone_reuse_churn_drifts_with_repetition_count`). **Rule: insert reuses
   the first tombstone on its path** (after walking on to an empty slot to confirm absence).
2. *If tombstones did not count toward the load*, a delete-heavy sequence could leave no empty
   slot at all, and a miss — which stops only at an empty slot — would never return (a hung
   worker). **Rule: rehash when live + tombstones > 0.75·cap**, purging in place when the live
   keys alone are ≤ 0.375·cap, otherwise doubling (`tombstones_count_toward_the_load_factor_so_a_miss_always_terminates`).
3. *Even with reuse*, the first pair is cheaper than the rest: it lands on an empty slot, while
   every later insert finds the key's own tombstone and must walk on past it to an empty slot
   before reusing it (`an_unprimed_first_pair_is_cheaper_than_the_steady_state`). **Rule:
   `set_churn_key` primes** each churn key with an untimed pair, repeating whole passes until one
   causes no rehash and no new tombstone (a mid-block rehash purges earlier keys' tombstones —
   caught by the proptest). From that fixed point every pair restores the table exactly, so a
   counted pair is the same after 0, 1, 7, 100 or 100 000 timed ones
   (`churn_cost_does_not_drift_with_repetition_count`, `proptest_hash_oa::churn_restores_size_and_layout`).
4. *One churn key samples one cluster.* Under linear probing a single key's churn cost is the
   length of whichever run its home slot lands in — heavy-tailed — so a one-key curve jumped
   6.5× (9, 8, 4, 26, 13) and 2.75× between neighbouring sweep points on two key sets.
   **Rule: churn a block** of `clamp(⌊len/32⌋, 1, 16)` consecutive keys `max + 1, max + 2, …`
   and report the mean per pair (one pair stays one unit, as the trees' two-key churn averages).
   The block's swing was 1.47× and 1.55×; its tombstones add at most ~3 % to the load
   (`a_single_churn_key_samples_one_cluster`). This is the one place the OA set's recipe
   deliberately differs from the chaining set's single key.

**Regime 10 — churn overshoots the FD sum, and the overshoot is the tombstone.** Churn's insert
is a miss walk and its delete a hit — the same two walks the build and teardown average — so on
a fresh table they agree (unprimed pair 5.81 vs FD sum 6.06). After priming, the churn keys'
tombstones never revert to empty: each bridges its run to the next, and every later insert walks
the merged run. Measured at n = 4 000 over 64 tables: insert_fd 3.54, delete_fd 2.52, sum 6.06,
primed churn 7.69 — a ~27 % overshoot, class agreement O(1)
(`open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone`). One more trap the
same test pins: the chaining row's endpoints (1 500 → 1 600) straddle a doubling, and for linear
probing that makes the "marginal delete" **negative** (−10.77; chaining +2.00), because every
stored key's walk shortens at once. A finite difference of a doubling table is a marginal cost
only between equal load factors — the browser's 1-2-5 mutation ladder doubles n with the table,
so its endpoints sit at equal α (for distinct keys; a de-duplicated prefix can shift it).

### §2.3 table — add a row

| open-addressing hash set | **churn overshoots sum** (~27 %: 7.69 vs 6.06) | churn's own tombstones bridge runs; an unprimed pair (5.81) matches the FD sum (§2.8) | yes, O(1) |

…and change "Nine regimes" to "Ten regimes" in the paragraph under the table (and PLAN §6.6's
"nine pinned regimes" to "ten").

### §4 — new hurdle (next free number)

N. **Open addressing's curves are samples of clusters.** Its search op-count saws with the load
   factor (§2.8) and its churn — even averaged over a 16-key block — is a mean over a handful of
   runs, so its wall-clock and op-count lines are bumpier than the chaining set's at the same α.
   Neither carries a trend in n. Read its *slope*, not its fitted label, and not the point-to-point
   jumps. Its wall-clock constant against the chaining set is a machine fact (one flat array vs
   chain pointers), not a claim this project makes either way.

### §5 proof map — new rows

| claim | where it is proven | clock |
|---|---|---|
| at the same α (same hash, same table size), a linearly-probed miss costs Knuth's ½(1 + 1/(1−α)²) and a hit 1 + ½(1 + 1/(1−α)) on this metric — 7.70 vs chaining's 1.72 at α ≈ 0.73 | `structures::methodology::open_addressing_probe_counts_follow_knuths_clustering_formulas` | none (op-counts) |
| open addressing's search saws with α louder than chaining's (1.92× vs 1.27×) and neither trends in n (slopes 0.013 / 0.012) | `structures::methodology::open_addressing_search_saws_with_the_load_factor_but_has_no_trend_in_n` | none |
| regime 10: churn overshoots the FD sum by its own tombstones (primed 7.69, unprimed 5.81, sum 6.06), and an FD across a doubling reads a negative marginal delete for OA (−10.77) but not chaining (+2.00) | `structures::methodology::open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone` | none |
| without tombstone reuse, churn's mean cost drifts with the rep count and with n — the landmine | `structures::hash_set_oa::tests::without_tombstone_reuse_churn_drifts_with_repetition_count` | none |
| with the real policy a counted churn pair is identical after any number of timed pairs, and the layout is restored | `structures::hash_set_oa::tests::churn_cost_does_not_drift_with_repetition_count` + `bench-engine/tests/proptest_hash_oa.rs` | none |
| an unprimed first pair is cheaper than the steady state — why priming exists | `structures::hash_set_oa::tests::an_unprimed_first_pair_is_cheaper_than_the_steady_state` | none |
| tombstones count toward the load, so a miss always terminates and a delete-heavy table purges instead of growing | `structures::hash_set_oa::tests::tombstones_count_toward_the_load_factor_so_a_miss_always_terminates` + the proptest's `live + tombs ≤ 0.75·cap` after every op | none |
| one churn key jumps several-fold between sweep points; the block recipe does not | `structures::hash_set_oa::tests::a_single_churn_key_samples_one_cluster` | none |
| interleaved insert/delete/search agree with `std::collections::HashSet` | `bench-engine/tests/proptest_hash_oa.rs` | none |
| TS twin ≡ Rust twin: slot layout before/after deletes and re-inserts, purge, cluster, churn block and its primed layout | `conformance/corpus-hoa.txt` + `src/structures/conformance-hoa.test.ts` | none |
| **UNRUN:** on the real clock OA search stays flat (slope < 0.4, ratio < 10) and its churn stays flat (\|slope\| < 0.6) and flatter than the array's | `scripts/verify-browser.mjs`, first pass | real |

## 4. CLAUDE.md gotchas (proposed)

- **The open-addressing set's tombstone policy is a measurement decision, not an
  implementation detail.** Four rules, all mirrored by the TS twin and pinned by
  `corpus-hoa.txt`: insert reuses the *first* tombstone on its path (after walking on to an
  empty slot to dedupe); tombstones count toward the load (`live + tombs > 0.75·cap` ⇒ purge
  in place if `live ≤ 0.375·cap`, else double); `set_churn_key` primes its keys to a fixed
  point; churn cycles a `clamp(⌊len/32⌋, 1, 16)`-key block. Drop the reuse and churn drifts with
  the batcher's rep count (and reads as growth in n); stop counting tombstones and a miss can
  loop forever; drop the priming and the first pair is cheaper than the rest; drop the block and
  the curve jumps several-fold between sweep points. Don't "simplify" any of them away
  (METHODOLOGY §2.8).
- **The OA set must keep the chaining set's hash, start size, 0.75 threshold and doubling.**
  That equality is what lets the two lines be read as "same table, different collision
  strategy" — `grows_at_exactly_the_chaining_sets_points` pins it. Tuning OA's load factor to
  0.5 would make it look better and end the comparison; if it is wanted, add it as a control.
- **Its slot-probe count is on the chaining convention** — the empty slot that ends a walk is
  free. Don't "fix" it to Knuth's count (which charges that slot): the units would stop lining
  up with the chaining set's chain-steps.
- **A finite difference of a doubling table is a marginal cost only between equal load
  factors.** For OA, the 1 500 → 1 600 step straddles a doubling and the marginal delete reads
  negative. Keep doubling-step endpoints when differencing hash-set costs.

## 5. README status suggestion

> Phase 6 adds a **second hash set — open addressing (linear probing)** — held to the chaining
> set's hash and table sizes so the two lines isolate the collision strategy: more probes per
> lookup (primary clustering, matching Knuth's formulas), both flat, and a tombstone policy that
> keeps its churn from drifting with the timer's repetition count.

## 6. UNRUN, follow-ups, and judgement calls a reviewer might disagree with

**UNRUN**
- `npm run verify:browser` (forbidden for this slice). Added/changed in
  `scripts/verify-browser.mjs`: search-series count **6 → 7**, mutation-series count
  **12 → 15** (merge-collision points: other slices bump the same numbers — the merged value is
  the sum); new checks *open-addressing search flat (slope < 0.4)*, *… stays flat (ratio < 10)*,
  *… flatter than array*, *open-addressing churn stays flat (|slope| < 0.6)*, *… flatter than
  array churn*. Bands are borrowed from neighbours, not calibrated on this structure.
- The wall-clock relationship between the two hash sets (which one is faster on this machine)
  is deliberately **not asserted** and the UI copy only says the order "can flip". Measure it
  once the gate runs before saying more.

**Merge-collision points (all additive)**: `StructureId` union (after `'skiplist'`),
`REGISTRY` entry (after `skiplist`), `STRUCTURES` (appended), `registry.test.ts` id list,
`runSweeps.test.ts` fake engine + four expectation lists, the worker's `runSweep` return list
and `runMutationSweep` tuple list (appended), the worker's wasm import list,
`structures/index.ts` (one export line), `mod.rs` (`pub mod hash_set_oa;` + an appended block at
the end of `mod methodology`), the `runSweeps.ts` mutation status string, two sentences
appended in `CompareSection.tsx` callouts, the gate counts above.

**Judgement calls**
1. **Tombstones, not backward-shift deletion.** Tombstones are the textbook teaching choice and
   produce the methodology finding; backward-shift would make churn exactly state-restoring with
   no priming and no overshoot. A third line with backward-shift would quantify the difference
   (PLAN §13 follow-up).
2. **0.75 load factor**, matching chaining, rather than linear probing's usual 0.5. This keeps
   the comparison "same table" and is why OA's miss cost reaches ~7.7 near the top of each
   sawtooth. A reviewer may prefer 0.5 as the fairer OA configuration.
3. **Counting convention** (terminating empty slot free) mirrors chaining rather than Knuth.
   Asymmetry worth knowing: reading that empty slot is a real memory touch in OA, as reading the
   bucket's length is in chaining; neither is counted.
4. **Churn block instead of the chaining set's single key.** Justified by variance (6.5× point
   jumps with one key), but it is a recipe difference between the two hash lines. Expected value
   is the same; the block's tombstones add ≤ ~3 % load. The chaining set has the same one-bucket
   sampling problem in milder form (single-key churn 3, 3, 5, 7, 3 on one key set) — consider
   giving it a block too, in its own slice, for symmetry.
5. **Priming to a fixed point** (repeated passes) rather than a single pass — needed because a
   mid-block priming insert can trigger a rehash that purges earlier keys' tombstones (found by
   the proptest; its seed is committed in `bench-engine/tests/proptest_hash_oa.proptest-regressions`).
6. **Purge-or-double threshold `live > 0.375·cap` ⇒ double.** Guarantees build-only growth is
   identical to chaining while a tombstone-heavy table is cleaned rather than grown; the table
   never shrinks, as chaining's never does.
7. **The corpus generator lives in `hash_set_oa.rs`** (`mod corpus`, `#[cfg(test)]`), not in
   `conformance.rs`, to keep the hotspot untouched; regenerate with
   `cargo test -- --ignored regen_corpus_hoa`.
8. **Inherited quirks, not fixed here:** `-0.0` and `0.0` hash differently but compare equal, so
   both can be stored (as in chaining); `NaN` never dedupes. And `aboveMax` = `max + 1` equals
   `max` once keys pass 2^53, making the churn key *present* — the chaining set would then delete
   a real key on every pair; this set drops a present key from its block instead (`a_present_churn_key_is_not_primed_away`).
   Worth a project-wide guard on `aboveMax`.
9. **De-duplicated input shifts α.** The default uniform generator draws with replacement, so
   the stored count is below n (the probe-mix slice's stored-size note reads this structure's
   `len()` too) and the equal-α property of the doubling ladder holds only approximately.

**Follow-ups**: the OA animation (slot strip with tombstones, probe walk, purge/double); a
backward-shift variant; a load-factor control; calibrate the gate bands on a real run.
