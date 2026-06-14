//! Property tests (docs/PLAN.md §12): random key sets + random queries run
//! through both structures must agree with a trivial reference model — linear
//! membership over the inserted keys. This catches algorithm-level bugs that
//! fixed examples miss (e.g. a hash/mask off-by-one or a chain-walk that stops
//! early). Keys are `i32` cast to `f64` so there is no NaN/inf and queries hit
//! and miss in roughly equal measure.

use bench_engine::structures::dyn_array::ArrayF64;
use bench_engine::structures::hash_set::HashSetF64;
use proptest::prelude::*;

/// Reference: membership over the raw inserted keys (multiplicity irrelevant).
fn reference_contains(keys: &[f64], target: f64) -> bool {
    keys.iter().any(|&k| k == target)
}

proptest! {
    #[test]
    fn array_membership_matches_reference(
        keys in prop::collection::vec(-50i32..50, 0..200),
        queries in prop::collection::vec(-60i32..60, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let a = ArrayF64::new(&keys, keys.len());
        prop_assert_eq!(a.len(), keys.len()); // array keeps duplicates
        for q in queries {
            let q = q as f64;
            prop_assert_eq!(a.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    #[test]
    fn hashset_membership_matches_reference(
        keys in prop::collection::vec(-50i32..50, 0..200),
        queries in prop::collection::vec(-60i32..60, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let s = HashSetF64::new(&keys, keys.len());

        // Set semantics: stored count equals the number of distinct keys.
        let mut distinct = keys.clone();
        distinct.sort_by(|a, b| a.partial_cmp(b).unwrap());
        distinct.dedup();
        prop_assert_eq!(s.len(), distinct.len());

        // Load-factor policy must keep chains short regardless of input.
        prop_assert!(s.max_chain() <= 8, "max chain {}", s.max_chain());

        for q in queries {
            let q = q as f64;
            prop_assert_eq!(s.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    /// The two structures must agree with each other on every query — the
    /// result-equality precursor to the cross-language conformance corpus
    /// (docs/PLAN.md §12, Phase 2 batch 4).
    #[test]
    fn array_and_hashset_agree(
        keys in prop::collection::vec(-50i32..50, 0..200),
        queries in prop::collection::vec(-60i32..60, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let a = ArrayF64::new(&keys, keys.len());
        let s = HashSetF64::new(&keys, keys.len());
        for q in queries {
            let q = q as f64;
            prop_assert_eq!(a.search_one_counted(q).0, s.search_one_counted(q).0);
        }
    }
}
