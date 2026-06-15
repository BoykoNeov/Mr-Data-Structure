//! Property tests for the sorted-array bench twin (docs/PLAN.md §12, risk R1). Random key
//! sets and random insert/delete streams must keep the structure's observable behavior in
//! step with a trivial reference — a `Vec` multiset whose **sorted** form is what the
//! array's iteration order must reproduce after every operation.
//!
//! Scope is **correctness only** (membership, multiset order, size). The cost metric —
//! comparison + shift counts — is deliberately *not* checked here: a reference able to
//! reproduce them would just be a second sorted array (circular). Op-counts are pinned by
//! the hand-computed unit tests in `src/structures/sorted_array.rs` and the cross-language
//! `conformance/corpus-sarr.txt`.

use bench_engine::structures::sorted_array::SortedArrayF64;
use proptest::prelude::*;

/// Reference membership over the raw inserted keys (multiplicity irrelevant).
fn reference_contains(keys: &[f64], target: f64) -> bool {
    keys.iter().any(|&k| k == target)
}

/// The sorted multiset — what a valid sorted array's iteration order must equal.
fn sorted_multiset(keys: &[f64]) -> Vec<f64> {
    let mut v = keys.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

proptest! {
    /// Iteration order is the sorted multiset (duplicates kept), and membership matches a
    /// linear scan over the inserted keys for both hits and misses — i.e. the binary search
    /// finds exactly the keys present, regardless of insertion order.
    #[test]
    fn sarr_membership_and_order_match_reference(
        keys in prop::collection::vec(-30i32..30, 0..150),
        queries in prop::collection::vec(-35i32..35, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let a = SortedArrayF64::new(&keys, keys.len());

        prop_assert_eq!(a.len(), keys.len()); // multiset keeps duplicates
        prop_assert_eq!(a.keys_in_order(), sorted_multiset(&keys));

        for q in queries {
            let q = q as f64;
            prop_assert_eq!(a.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    /// A mixed insert/delete stream must track a `Vec` multiset reference after *every* op:
    /// a delete removes one matching key, an insert adds one, `len` agrees, and the iteration
    /// order stays the sorted multiset (a wrong shift or insertion point would corrupt this).
    /// Removing *any* occurrence of a duplicated value leaves the same sorted multiset, so the
    /// reference's "remove first match" matches the array's "remove the binary-search hit".
    #[test]
    fn sarr_mixed_ops_match_reference(
        keys in prop::collection::vec(-25i32..25, 0..60),
        ops in prop::collection::vec((any::<bool>(), -30i32..30), 0..120),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut a = SortedArrayF64::new(&keys, keys.len());
        let mut model = keys.clone();

        for (is_delete, key) in ops {
            let key = key as f64;
            if is_delete {
                let removed = a.delete_one_counted(key).0;
                let ref_removed = match model.iter().position(|&k| k == key) {
                    Some(i) => { model.remove(i); true }
                    None => false,
                };
                prop_assert_eq!(removed, ref_removed);
            } else {
                a.insert_one_counted(key);
                model.push(key);
            }
            prop_assert_eq!(a.len(), model.len());
            // Sorted invariant held through the op: iteration order == sorted multiset.
            prop_assert_eq!(a.keys_in_order(), sorted_multiset(&model));
        }
    }
}
