//! Property tests for the linked-list bench twin (docs/PLAN.md §12, risk R1). Random key
//! sets and random insert/delete streams must keep the structure's observable behavior in
//! step with a trivial reference — a `Vec` multiset used head→tail, where a head insert is a
//! prepend and a delete removes the **head-most** matching key.
//!
//! Scope is **correctness only** (membership, head→tail multiset order, size). The cost
//! metric — node-visit counts — is deliberately *not* checked here: a reference able to
//! reproduce them would just be a second linked list (circular). Op-counts are pinned by the
//! hand-computed unit tests in `src/structures/linked_list.rs` and the cross-language
//! `conformance/corpus-ll.txt`.

use bench_engine::structures::linked_list::LinkedListF64;
use proptest::prelude::*;

/// Reference membership over the inserted keys (multiplicity irrelevant).
fn reference_contains(keys: &[f64], target: f64) -> bool {
    keys.iter().any(|&k| k == target)
}

/// Head→tail order after head-inserting `keys` in turn — the reverse of insertion order.
fn head_inserted(keys: &[f64]) -> Vec<f64> {
    keys.iter().rev().copied().collect()
}

proptest! {
    /// Head→tail iteration order is the reverse of insertion order (duplicates kept), and
    /// membership matches a scan over the inserted keys for both hits and misses.
    #[test]
    fn ll_membership_and_order_match_reference(
        keys in prop::collection::vec(-30i32..30, 0..150),
        queries in prop::collection::vec(-35i32..35, 1..50),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let l = LinkedListF64::new(&keys, keys.len());

        prop_assert_eq!(l.len(), keys.len()); // multiset keeps duplicates
        prop_assert_eq!(l.keys_in_order(), head_inserted(&keys));

        for q in queries {
            let q = q as f64;
            prop_assert_eq!(l.search_one_counted(q).0, reference_contains(&keys, q));
        }
    }

    /// A mixed insert/delete stream must track a `Vec` model after *every* op: an insert
    /// prepends at the head, a delete removes the head-most match, `len` agrees, and the
    /// head→tail order stays the model (a wrong link splice or tail fix-up would corrupt this).
    #[test]
    fn ll_mixed_ops_match_reference(
        keys in prop::collection::vec(-25i32..25, 0..60),
        ops in prop::collection::vec((any::<bool>(), -30i32..30), 0..120),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut l = LinkedListF64::new(&keys, keys.len());
        // The model is the live list head→tail; the constructor head-inserts, so start reversed.
        let mut model: Vec<f64> = head_inserted(&keys);

        for (is_delete, key) in ops {
            let key = key as f64;
            if is_delete {
                let removed = l.delete_one_counted(key).0;
                let ref_removed = match model.iter().position(|&k| k == key) {
                    Some(i) => { model.remove(i); true } // remove the head-most match
                    None => false,
                };
                prop_assert_eq!(removed, ref_removed);
            } else {
                l.insert_one_counted(key);
                model.insert(0, key); // head insert == prepend
            }
            prop_assert_eq!(l.len(), model.len());
            prop_assert_eq!(l.keys_in_order(), model.clone());
        }
    }
}
