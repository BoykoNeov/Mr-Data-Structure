//! Property tests for the B-tree bench twin (docs/PLAN.md §12, risk R1; docs/METHODOLOGY.md
//! §2.10). Random key sets and random insert/delete streams must keep the tree in step with
//! a trivial reference — a sorted `Vec` multiset — after *every* operation, and every B-tree
//! invariant must hold after every operation: occupancy (`t − 1 ..= 2t − 1` keys off the
//! root), all leaves at one depth, keys inside their separators (inclusive — a multiset),
//! `len` equal to the stored keys, and no leaked or doubly-reachable node (`BTree::check`).
//!
//! **Duplicates are the point.** Keys are drawn from a handful of values, so most keys have
//! twins and runs of equal keys routinely straddle a separator — the classic B-tree bug
//! (a delete that finds the copy in a leaf but not the one in a separator, or a split that
//! puts an equal key on the wrong side). Most cases run at `t = 2` and `t = 3`, where a few
//! dozen keys already exercise every split, borrow and merge path; one runs at the shipped
//! `t = 16` with enough keys to reach depth 3.
//!
//! Correctness only. The op-counts are pinned by the hand-checked unit tests in
//! `src/structures/btree.rs` and the cross-language `conformance/corpus-btree.txt`.

use bench_engine::structures::btree::BTree;
use proptest::prelude::*;

fn sorted(v: &[f64]) -> Vec<f64> {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s
}

/// Run a stream of `(is_delete, key)` ops against both the tree and the reference.
fn run_stream(t: usize, keys: &[f64], ops: &[(bool, f64)]) -> Result<(), TestCaseError> {
    let mut b = BTree::from_keys(t, keys, keys.len());
    let mut model = keys.to_vec();
    prop_assert!(b.check().is_ok(), "after build: {:?}", b.check());
    prop_assert_eq!(b.keys_in_order(), sorted(&model));
    for &(is_delete, key) in ops {
        if is_delete {
            let removed = b.delete_one_counted(key).0;
            let reference = match model.iter().position(|&k| k == key) {
                Some(i) => {
                    model.remove(i);
                    true
                }
                None => false,
            };
            prop_assert_eq!(removed, reference, "delete {} (t = {})", key, t);
        } else {
            b.insert_one_counted(key);
            model.push(key);
        }
        prop_assert!(b.check().is_ok(), "t = {}: {:?}", t, b.check());
        prop_assert_eq!(b.len_keys(), model.len());
        prop_assert_eq!(b.keys_in_order(), sorted(&model));
    }
    // Membership agrees with the reference for every value in (and just around) the range.
    for q in -12..=12 {
        let q = q as f64;
        prop_assert_eq!(b.search_one_counted(q).0, model.contains(&q), "search {}", q);
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Tiny value range ⇒ duplicates everywhere, at the two smallest degrees.
    #[test]
    fn btree_dup_heavy_streams_match_reference(
        t in 2usize..=3,
        keys in prop::collection::vec(-5i32..5, 0..80),
        ops in prop::collection::vec((any::<bool>(), -6i32..6), 0..160),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let ops: Vec<(bool, f64)> = ops.into_iter().map(|(d, k)| (d, k as f64)).collect();
        run_stream(t, &keys, &ops)?;
    }

    /// Delete-heavy: build big, then mostly delete, so the tree shrinks through every
    /// merge cascade and root collapse down to (often) empty.
    #[test]
    fn btree_delete_heavy_streams_shrink_correctly(
        t in 2usize..=3,
        keys in prop::collection::vec(-10i32..10, 20..120),
        ops in prop::collection::vec((prop::bool::weighted(0.85), -11i32..11), 50..250),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let ops: Vec<(bool, f64)> = ops.into_iter().map(|(d, k)| (d, k as f64)).collect();
        run_stream(t, &keys, &ops)?;
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// The shipped degree, t = 16, with enough keys (up to ~2 000) to reach depth 3 and
    /// split/merge internal nodes, still drawn from a narrow range so duplicates abound.
    #[test]
    fn btree_shipped_degree_matches_reference(
        keys in prop::collection::vec(-8i32..8, 0..2000),
        ops in prop::collection::vec((any::<bool>(), -9i32..9), 0..400),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let ops: Vec<(bool, f64)> = ops.into_iter().map(|(d, k)| (d, k as f64)).collect();
        run_stream(16, &keys, &ops)?;
    }
}
