//! Clock-free methodology pins for the **backward-shift hash set** (docs/METHODOLOGY.md
//! §2.8, regime NEW) — the third hash set, read against the tombstone one. Kept in its own
//! file, as the B-tree's are, so the structure's measurement claims travel together.
//!
//! The question it answers is PLAN §13's: *how much of regime 12 (the open-addressing set's
//! churn overshooting its finite-difference sum) is the tombstone?* The answer rests on one
//! exact identity, pinned below table by table rather than as a band:
//!
//! - a delete-free build of the two sets is the **same table, slot for slot** (same hash,
//!   same probe step, same doubling points, same re-placement order), so their search
//!   op-counts coincide and the churn insert of an absent key walks the same run to the same
//!   empty slot in both;
//! - the churn delete's *find walk* is then the same walk too, so
//!   **backward-shift pair = tombstone set's unprimed pair + the shift scan**,
//!   exactly, where the shift scan walks the run *after* the churn key's slot — the very run
//!   a primed tombstone bridges into, which the tombstone set's next insert walks instead.
//!
//! So the backward shift does not remove regime 12's extra walk; it **moves** it from the
//! next insert into this delete, and on the declared metric pays a hash per slot for it
//! (this twin stores no hashes). The overshoot disappears; the churn line barely moves.

use super::hash_set_bs::HashSetBsF64;
use super::hash_set_oa::HashSetOaF64;

fn keys(n: usize) -> Vec<f64> {
    (0..n).map(|i| i as f64).collect()
}

/// A fixed-seed permutation of `0..n` (xorshift; the open-addressing tests' generator).
fn shuffled(n: usize) -> Vec<f64> {
    let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    for i in (1..n).rev() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let j = (state % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
    v
}

/// The tombstone set's layout with its tombstones mapped to `None` — only valid (and only
/// used) on a delete-free table, where it has none.
fn oa_layout(s: &HashSetOaF64) -> Vec<Option<f64>> {
    s.slots()
        .into_iter()
        .map(|sl| match sl {
            Some(Some(k)) => Some(k),
            Some(None) => panic!("a delete-free build has no tombstones"),
            None => None,
        })
        .collect()
}

/// **Equal footing, pinned.** Built from the same keys with no deletes, the backward-shift
/// set and the tombstone set are the same table, slot for slot, at every size — so the
/// search chart's two open-addressing lines coincide on the op-count signal by construction
/// (the wall clock may still separate them by noise; no ratio is asserted anywhere), and the
/// finite-difference *insert* halves are equal. Merge-sensitive: this reads the tombstone
/// set's public surface, so a change to its rehash order or probe step breaks it here.
#[test]
fn a_delete_free_build_is_the_tombstone_sets_table_slot_for_slot() {
    let ks: Vec<f64> = shuffled(20_000).iter().map(|k| k * 7.0 + 3.0).collect();
    for n in [0usize, 1, 5, 6, 7, 50, 1000, 3072, 3073, 20_000] {
        let bs = HashSetBsF64::new(&ks, n);
        let oa = HashSetOaF64::new(&ks, n);
        assert_eq!(bs.slots(), oa_layout(&oa), "n={n}");
        assert_eq!(
            HashSetBsF64::build_insert_counted(&ks, n),
            HashSetOaF64::build_insert_counted(&ks, n),
            "n={n}"
        );
        let present = (0..64).map(|i| ks[(i * n.max(1) / 64) % ks.len()]);
        let probes: Vec<f64> = present.chain((0..64).map(|i| 1e9 + i as f64)).collect();
        for &p in &probes {
            assert_eq!(bs.search_one_counted(p), oa.search_one_counted(p), "n={n} probe {p}");
        }
    }
}

/// **The identity regime NEW rests on, exact and per table.** On a fresh table at n = 4000,
/// for each of 64 absent keys: the backward-shift insert costs exactly the tombstone set's
/// (same walk to the same empty slot), the delete's find walk costs exactly the tombstone
/// set's whole delete, and what remains is the shift scan over the following run. So
/// backward-shift pair = tombstone set's unprimed pair + shift scan — no tolerance.
/// Measured (means over the 64 keys): unprimed 5.81 + shift 1.50 = 7.31.
#[test]
fn backward_shift_churn_is_the_unprimed_pair_plus_its_shift_scan() {
    let ks = keys(4000);
    let n = 4000;
    let mut shifted_somewhere = false;
    for j in 0..64 {
        let key = 1e6 + j as f64;
        let mut oa = HashSetOaF64::new(&ks, n);
        let (_, oa_ins) = oa.insert_one_counted(key);
        let (_, oa_del) = oa.delete_one_counted(key);
        let mut bs = HashSetBsF64::new(&ks, n);
        let built = bs.slots();
        let (_, bs_ins) = bs.insert_one_counted(key);
        let (removed, find, shift) = bs.delete_one_split(key);
        assert!(removed);
        assert_eq!(bs_ins, oa_ins, "key {key}: the same walk to the same empty slot");
        assert_eq!(find, oa_del, "key {key}: the find walk is the tombstone set's whole delete");
        assert_eq!(shift % 2, 0, "key {key}: a probe and a hash per slot scanned");
        assert_eq!(bs.slots(), built, "key {key}: nothing moved back, the table is as built");
        shifted_somewhere |= shift > 0;
    }
    assert!(shifted_somewhere, "some churn key's slot is followed by a run to scan");
}

/// **Regime NEW — churn and the finite-difference sum agree tightly once nothing is left
/// behind**, and that answers PLAN §13's question about regime 12. Same 64 tables, same
/// equal-α endpoints (2000 → 4000) and same 16-key blocks as the tombstone set's regime-12
/// test (`methodology::open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone`),
/// so the numbers sit side by side:
///
/// | | insert_fd | delete_fd | FD sum | churn |
/// |---|---|---|---|---|
/// | tombstones (regime 12) | 3.54 | 2.52 | 6.06 | 7.69 (+27 %) |
/// | backward shift (NEW)   | 3.54 | 3.80 | 7.34 | 7.39 (+0.7 %) |
///
/// Read the rows together: the overshoot vanishes, but the **churn line barely drops**
/// (7.69 → 7.39, −4 %). What moved is the *delete* half of the finite-difference sum. A
/// tombstone delete is cheap at the moment it happens (a hit, 2.52) and leaves its cost to
/// later walks — which churn's next insert makes and a teardown never does — so regime 12's
/// FD sum under-reads the tombstone set's mutation cost. The backward shift pays that walk
/// inside the delete (the scan over the run after the hole: 3.80), so both methods see it
/// and agree. All of regime 12's overshoot is the tombstone; almost none of the churn cost
/// is. On this metric the scan pays a hash per slot (no stored hashes — `hash_set_bs`'s
/// module doc); counted at a probe alone, the 1.50 shift term would halve and take ~0.75 off
/// this churn, which is why the comparison is stated per term, never as "cheaper". Class
/// agreement: O(1) on both sides. The straddle trap is louder here than for the tombstone
/// set (1500 → 1600 marginal delete −38.75 against its −10.77): every shift scan shortens at
/// once when the table doubles.
#[test]
fn backward_shift_churn_agrees_with_finite_differences_tightly() {
    let ks = keys(4000);
    let (n1, n2) = (2000usize, 4000usize);
    let fd = |build: fn(&[f64], usize) -> f64, tear: fn(&[f64], usize) -> f64| {
        let ins = (build(&ks, n2) - build(&ks, n1)) / (n2 - n1) as f64;
        let del = (tear(&ks, n2) - tear(&ks, n1)) / (n2 - n1) as f64;
        (ins, del)
    };
    let (bs_ins, bs_del) = fd(HashSetBsF64::build_insert_counted, HashSetBsF64::teardown_counted);
    let (oa_ins, oa_del) = fd(HashSetOaF64::build_insert_counted, HashSetOaF64::teardown_counted);
    let (bs_sum, oa_sum) = (bs_ins + bs_del, oa_ins + oa_del);

    let (mut bs_churn, mut oa_churn) = (0.0, 0.0);
    let tables = 64;
    for j in 0..tables {
        let key = 1e6 + j as f64; // absent (each table is independent)
        let mut b = HashSetBsF64::new(&ks, n2);
        b.set_churn_key(key);
        bs_churn += b.churn_counted();
        assert_eq!(b.len(), n2);
        let mut o = HashSetOaF64::new(&ks, n2);
        o.set_churn_key(key);
        oa_churn += o.churn_counted();
    }
    let (bs_churn, oa_churn) = (bs_churn / tables as f64, oa_churn / tables as f64);

    // (1) Equal builds ⇒ equal insert halves.
    assert_eq!(bs_ins, oa_ins, "a build has no deletes, so the insert halves are one number");
    // (2) The regime: tight, where the tombstone set overshoots.
    assert!((bs_churn - bs_sum).abs() / bs_sum < 0.03, "churn {bs_churn:.2} vs fd sum {bs_sum:.2}");
    assert!(oa_churn > 1.2 * oa_sum, "regime 12 for contrast: {oa_churn:.2} vs {oa_sum:.2}");
    // (3) Where the overshoot went: into the delete half, not out of the churn line.
    assert!(bs_del > 1.3 * oa_del, "shift-scan deletes {bs_del:.2} vs tombstone deletes {oa_del:.2}");
    assert!(
        bs_churn < oa_churn && bs_churn > 0.9 * oa_churn,
        "churn barely moves: {bs_churn:.2} vs the tombstone set's {oa_churn:.2}"
    );
    // (4) A constant, not a class.
    assert!(bs_churn < 20.0, "churn {bs_churn:.2} must stay O(1)");
    // (5) Across a doubling the marginal delete goes negative, louder than the tombstone set's.
    let straddle = |tear: fn(&[f64], usize) -> f64| (tear(&ks, 1600) - tear(&ks, 1500)) / 100.0;
    let (bs_straddle, oa_straddle) =
        (straddle(HashSetBsF64::teardown_counted), straddle(HashSetOaF64::teardown_counted));
    assert!(bs_straddle < oa_straddle && oa_straddle < 0.0, "{bs_straddle:.2} < {oa_straddle:.2} < 0");
}

/// **Why the block stays** although nothing needs priming: one churn key's cost is still
/// set by the runs around its slot (the insert walk, then the shift scan over the next
/// run), so the sampling argument of METHODOLOGY §2.8 rule 4 applies unchanged. The block
/// is steady across the mutation ladder and trendless in n, on the two key sets the
/// tombstone set's block test uses. Measured on the first: 6.14, 6.07, 6.63, 9.13, 5.38
/// (1.70×; the tombstone set's block on the same keys 5.86 … 9.00).
#[test]
fn the_shared_churn_block_is_steady_across_the_ladder() {
    let ladder = [250usize, 500, 1000, 2000, 4000];
    let base = shuffled(4000);
    let key_sets: [Vec<f64>; 2] = [base.clone(), base.iter().map(|k| k * 7.0 + 3.0).collect()];
    for ks in &key_sets {
        let pts: Vec<f64> = ladder
            .iter()
            .map(|&n| {
                let max = ks[..n].iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let mut s = HashSetBsF64::new(ks, n);
                s.set_churn_key(max + 1.0);
                s.churn_counted()
            })
            .collect();
        let hi = pts.iter().copied().fold(f64::MIN, f64::max);
        let lo = pts.iter().copied().fold(f64::MAX, f64::min);
        assert!(hi / lo < 2.0, "the block is steady: {pts:?}");
        let xs: Vec<f64> = ladder.iter().map(|&n| (n as f64).ln()).collect();
        let ys: Vec<f64> = pts.iter().map(|y| y.ln()).collect();
        let (mx, my) = (xs.iter().sum::<f64>() / 5.0, ys.iter().sum::<f64>() / 5.0);
        let cov: f64 = xs.iter().zip(&ys).map(|(x, y)| (x - mx) * (y - my)).sum();
        let var: f64 = xs.iter().map(|x| (x - mx) * (x - mx)).sum();
        assert!((cov / var).abs() < 0.2, "trendless in n: slope {:.3} over {pts:?}", cov / var);
    }
}
