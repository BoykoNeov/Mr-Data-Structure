//! Property tests for the open-addressing hash set (docs/PLAN.md §12): random
//! *interleaved* insert / delete / search sequences checked against
//! `std::collections::HashSet` after every operation.
//!
//! Interleaving is the point. The chaining set's properties build once and then query or
//! delete; here the bugs live in what deletes leave behind — tombstones a later search must
//! step over, a tombstone a later insert must reuse (and must not reuse *before* confirming
//! the key is absent further along), and the purge-or-double rehash a tombstone-heavy table
//! triggers. A small key range makes all of that happen constantly. Keys are `i32` cast to
//! `f64`, so no NaN / ±0 subtleties (and `f64` is not `Hash`; the reference holds the `i32`).
//!
//! No `max_chain`-style bound is copied from the chaining tests: a linear-probing run at
//! load 0.75 is legitimately much longer than a chain, so the invariant asserted instead is
//! the one that keeps every miss terminating — live + tombstones stay at or under 0.75 of
//! the capacity, so an empty slot always exists.

use bench_engine::structures::hash_set_oa::{churn_block, HashSetOaF64};
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

proptest! {
    #[test]
    fn interleaved_ops_match_std_hashset(
        build in prop::collection::vec(-20i32..20, 0..60),
        ops in prop::collection::vec(op(), 0..300),
    ) {
        let keys: Vec<f64> = build.iter().map(|&k| k as f64).collect();
        let mut s = HashSetOaF64::new(&keys, keys.len());
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
            // The termination invariant: an empty slot always remains.
            prop_assert!(
                (s.len() + s.tombstones()) as f64 <= 0.75 * s.capacity() as f64,
                "live {} + tombs {} over 0.75 of {}", s.len(), s.tombstones(), s.capacity()
            );
        }

        // Iteration order holds exactly the reference's keys, each once.
        let mut got: Vec<i32> = s.keys_in_order().iter().map(|&k| k as i32).collect();
        got.sort_unstable();
        let mut want: Vec<i32> = model.into_iter().collect();
        want.sort_unstable();
        prop_assert_eq!(got, want);
    }

    /// Churn at fixed size holds size *and* layout: after the priming pairs, any number of
    /// insert+delete pairs of the churn block leaves the table exactly as it found it —
    /// partial cycles included — the property the no-drift claim (docs/METHODOLOGY.md §2.8)
    /// rests on. Up to 400 keys, so blocks of one to twelve keys are exercised.
    #[test]
    fn churn_restores_size_and_layout(
        build in prop::collection::vec(-500i32..500, 1..400),
        reps in 1u32..200,
    ) {
        let keys: Vec<f64> = build.iter().map(|&k| k as f64).collect();
        let mut s = HashSetOaF64::new(&keys, keys.len());
        let n = s.len();
        s.set_churn_key(1000.0);
        let primed = s.slots();
        let tombs = s.tombstones();
        prop_assert!(tombs >= 1 && tombs <= churn_block(n), "{} tombstones for n = {}", tombs, n);
        let cost = s.churn_counted();
        s.churn_n(reps);
        prop_assert_eq!(s.len(), n);
        prop_assert_eq!(s.slots(), primed);
        prop_assert_eq!(s.tombstones(), tombs);
        prop_assert_eq!(s.churn_counted(), cost);
    }
}
