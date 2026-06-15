//! Property tests for the BST bench twin (docs/PLAN.md §12, risk R1). Random key
//! sets and random insert/delete streams must keep the tree's observable behavior
//! in step with a trivial reference — a `Vec` multiset whose **sorted** form is what
//! the BST's in-order traversal must reproduce after every operation.
//!
//! Scope is **correctness only** (membership, multiset order, size). The cost
//! metric — comparison counts — is deliberately *not* checked here: a reference
//! able to reproduce BST comparison counts would just be a second BST (circular).
//! Op-counts are pinned by the hand-computed unit tests in `src/structures/bst.rs`
//! and the cross-language `conformance/corpus-bst.txt`.

use bench_engine::structures::bst::BstF64;
use proptest::prelude::*;

/// Reference membership over the raw inserted keys (multiplicity irrelevant).
fn reference_contains(keys: &[f64], target: f64) -> bool {
    keys.iter().any(|&k| k == target)
}

/// The sorted multiset — what a valid BST's in-order traversal must equal.
fn sorted_multiset(keys: &[f64]) -> Vec<f64> {
    let mut v = keys.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

proptest! {
    /// In-order is the sorted multiset (duplicates kept), and membership matches a
    /// linear scan over the inserted keys for both hits and misses.
    #[test]
    fn bst_membership_and_order_match_reference(
        keys in prop::collection::vec(-30i32..30, 0..150),
        queries in prop::collection::vec(-35i32..35, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let t = BstF64::new(&keys, keys.len());

        prop_assert_eq!(t.len(), keys.len()); // multiset keeps duplicates
        prop_assert_eq!(t.keys_in_order(), sorted_multiset(&keys));

        for q in queries {
            let q = q as f64;
            prop_assert_eq!(t.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    /// A mixed insert/delete stream must track a `Vec` multiset reference after
    /// *every* op: a delete removes one matching key (Hibbard value-copy), an insert
    /// adds one, `len` agrees, and the in-order traversal stays the sorted multiset
    /// (a wrong successor or splice would corrupt this). Interleaving inserts *after*
    /// deletes also fuzzes the arena free-list — slot reuse, which a build-then-delete
    /// sequence never reaches (in `new`, every insert precedes every delete).
    #[test]
    fn bst_mixed_ops_match_reference(
        keys in prop::collection::vec(-25i32..25, 0..60),
        ops in prop::collection::vec((any::<bool>(), -30i32..30), 0..120),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut t = BstF64::new(&keys, keys.len());
        let mut model = keys.clone();

        for (is_delete, key) in ops {
            let key = key as f64;
            if is_delete {
                let removed = t.delete_one_counted(key).0;
                let ref_removed = match model.iter().position(|&k| k == key) {
                    Some(i) => { model.remove(i); true }
                    None => false,
                };
                prop_assert_eq!(removed, ref_removed);
            } else {
                t.insert_one_counted(key);
                model.push(key);
            }
            prop_assert_eq!(t.len(), model.len());
            // The BST invariant held through the op: in-order == sorted multiset.
            prop_assert_eq!(t.keys_in_order(), sorted_multiset(&model));
        }
    }
}
