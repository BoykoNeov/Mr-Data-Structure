//! Property tests for the AVL bench twin (docs/PLAN.md §12, risk R1). Random key sets
//! and random insert/delete streams must keep the tree's observable behavior in step
//! with a trivial reference — a `Vec` multiset whose **sorted** form is what the AVL's
//! in-order traversal must reproduce after every operation — *and*, the AVL-specific
//! property, the height-balance invariant must hold at every node after every op.
//!
//! Scope is **correctness only** (membership, multiset order, size, balance). The cost
//! metric — comparison + rotation counts — is deliberately *not* checked here: a
//! reference able to reproduce them would just be a second AVL (circular). Op-counts are
//! pinned by the hand-computed unit tests in `src/structures/avl.rs` and the
//! cross-language `conformance/corpus-avl.txt`.

use bench_engine::structures::avl::AvlF64;
use proptest::prelude::*;

/// Reference membership over the raw inserted keys (multiplicity irrelevant).
fn reference_contains(keys: &[f64], target: f64) -> bool {
    keys.iter().any(|&k| k == target)
}

/// The sorted multiset — what a valid AVL's in-order traversal must equal.
fn sorted_multiset(keys: &[f64]) -> Vec<f64> {
    let mut v = keys.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

proptest! {
    /// In-order is the sorted multiset (duplicates kept), membership matches a linear scan
    /// for both hits and misses, and the tree is balanced after a bulk build.
    #[test]
    fn avl_membership_order_and_balance_match_reference(
        keys in prop::collection::vec(-30i32..30, 0..150),
        queries in prop::collection::vec(-35i32..35, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let t = AvlF64::new(&keys, keys.len());

        prop_assert_eq!(t.len(), keys.len()); // multiset keeps duplicates
        prop_assert_eq!(t.keys_in_order(), sorted_multiset(&keys));
        prop_assert!(t.check_balanced(), "AVL invariant must hold after a bulk build");

        for q in queries {
            let q = q as f64;
            prop_assert_eq!(t.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    /// A mixed insert/delete stream must track a `Vec` multiset reference after *every* op
    /// — a delete removes one matching key (Hibbard value-copy), an insert adds one, `len`
    /// agrees, the in-order traversal stays the sorted multiset — and, the AVL-specific
    /// property, the **height-balance invariant holds at every node after every op**. A
    /// rebalancing bug (a missed or mis-shaped rotation) corrupts the shape or the balance
    /// the fixed corpus cases would never reach.
    #[test]
    fn avl_mixed_ops_match_reference_and_stay_balanced(
        keys in prop::collection::vec(-25i32..25, 0..60),
        ops in prop::collection::vec((any::<bool>(), -30i32..30), 0..120),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut t = AvlF64::new(&keys, keys.len());
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
            // The BST ordering invariant held: in-order == sorted multiset.
            prop_assert_eq!(t.keys_in_order(), sorted_multiset(&model));
            // The AVL balance invariant held: every node's balance factor ∈ {-1,0,+1} and
            // its stored height is consistent. This is what makes it an AVL, not a BST.
            prop_assert!(t.check_balanced(), "AVL invariant must hold after every op");
        }
    }
}
