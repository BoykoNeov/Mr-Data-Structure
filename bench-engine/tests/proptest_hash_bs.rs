//! Property tests for the backward-shift hash set (docs/PLAN.md §12): random *interleaved*
//! insert / delete / search sequences checked against `std::collections::HashSet` after
//! every operation, plus the structural invariant a backward-shift delete must keep.
//!
//! Interleaving is the point, as for the tombstone set: the bugs live in what a delete
//! does to the keys stored after it — a key moved back that should have stayed (its home
//! lies past the hole), one left behind that should have moved (now unreachable), or a run
//! that wraps the end of the table. A small key range makes long, wrapping runs constant.
//! Keys are `i32` cast to `f64`, so no NaN / ±0 subtleties.
//!
//! The invariant asserted after every step is linear probing's own: **no stored key's probe
//! path crosses an empty slot** (every slot from a key's home to its position is occupied).
//! Membership alone cannot see a violation until the right key is searched for; this sees
//! it at once.

use bench_engine::structures::hash_set_bs::HashSetBsF64;
use bench_engine::structures::mix_f64;
use proptest::prelude::*;
use std::collections::HashSet;

#[derive(Debug, Clone)]
enum Op {
    Insert(i32),
    Delete(i32),
    Search(i32),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (-20i32..20).prop_map(Op::Insert),
        (-20i32..20).prop_map(Op::Delete),
        (-25i32..25).prop_map(Op::Search),
    ]
}

/// Every live key is reachable from its home without crossing an empty slot.
fn paths_unbroken(s: &HashSetBsF64) -> Result<(), String> {
    let slots = s.slots();
    let mask = slots.len() - 1;
    for (pos, sl) in slots.iter().enumerate() {
        if let Some(k) = sl {
            let mut i = (mix_f64(*k) as usize) & mask;
            while i != pos {
                if slots[i].is_none() {
                    return Err(format!("key {k} at slot {pos}: empty slot {i} on its path"));
                }
                i = (i + 1) & mask;
            }
        }
    }
    Ok(())
}

proptest! {
    #[test]
    fn interleaved_ops_match_std_hashset(
        build in prop::collection::vec(-20i32..20, 0..60),
        ops in prop::collection::vec(op(), 0..300),
    ) {
        let keys: Vec<f64> = build.iter().map(|&k| k as f64).collect();
        let mut s = HashSetBsF64::new(&keys, keys.len());
        let mut model: HashSet<i32> = build.iter().copied().collect();
        prop_assert_eq!(s.len(), model.len()); // set semantics: duplicates collapse

        for o in ops {
            match o {
                Op::Insert(k) => {
                    let (inserted, _) = s.insert_one_counted(k as f64);
                    prop_assert_eq!(inserted, model.insert(k), "insert {}", k);
                }
                Op::Delete(k) => {
                    let (removed, _) = s.delete_one_counted(k as f64);
                    prop_assert_eq!(removed, model.remove(&k), "delete {}", k);
                    prop_assert!(!s.search_one_counted(k as f64).0, "{} gone after delete", k);
                }
                Op::Search(k) => {
                    prop_assert_eq!(s.search_one_counted(k as f64).0, model.contains(&k), "search {}", k);
                }
            }
            prop_assert_eq!(s.len(), model.len());
            prop_assert_eq!(paths_unbroken(&s), Ok(()));
            // No tombstones: the occupied slots are exactly the live keys, under the threshold.
            prop_assert_eq!(s.slots().iter().filter(|sl| sl.is_some()).count(), s.len());
            prop_assert!(s.len() as f64 <= 0.75 * s.capacity() as f64);
        }

        let mut got: Vec<i32> = s.keys_in_order().iter().map(|&k| k as i32).collect();
        got.sort_unstable();
        let mut want: Vec<i32> = model.into_iter().collect();
        want.sort_unstable();
        prop_assert_eq!(got, want);
    }

    /// Churn at fixed size restores the table **as built** — not merely a primed state, as
    /// the tombstone set's does — after any number of pairs, partial block cycles included,
    /// and the counted pair never drifts (docs/METHODOLOGY.md §2.8, regime NEW). Up to 400
    /// keys, so blocks of one to twelve keys and the threshold settle are both exercised.
    #[test]
    fn churn_restores_the_built_table(
        build in prop::collection::vec(-500i32..500, 1..400),
        reps in 1u32..200,
    ) {
        let keys: Vec<f64> = build.iter().map(|&k| k as f64).collect();
        let mut s = HashSetBsF64::new(&keys, keys.len());
        let n = s.len();
        let cap = s.capacity();
        let built = s.slots();
        s.set_churn_key(1000.0);
        if s.capacity() == cap {
            prop_assert_eq!(s.slots(), built.clone(), "below the threshold the settle is a no-op");
        } else {
            prop_assert_eq!(n + 1, (0.75 * cap as f64) as usize + 1, "only the threshold doubles");
        }
        let settled = s.slots();
        let cost = s.churn_counted();
        s.churn_n(reps);
        prop_assert_eq!(s.len(), n);
        prop_assert_eq!(s.slots(), settled);
        prop_assert_eq!(s.churn_counted(), cost);
    }
}
