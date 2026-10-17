//! Property tests for the red-black tree bench twin (docs/PLAN.md §12, risk R1). Random key
//! sets and random insert/delete streams must keep the tree's observable behaviour in step
//! with a trivial reference — a `BTreeMap<key, multiplicity>` multiset whose expansion is
//! what the in-order traversal must reproduce after every operation — and, the
//! red-black-specific properties, after **every** operation:
//!
//! - every red-black invariant holds (`check_rb`: black root, no red-red edge, equal black
//!   height on every path, parent links consistent, height ≤ 2·log₂(n+1));
//! - the operation stayed inside the scheme's rotation budget — **≤ 2 rotations per insert,
//!   ≤ 3 per delete** — the guarantee the comparison with the AVL turns on
//!   (docs/METHODOLOGY.md §2.9).
//!
//! The op-count *values* are not checked here (a reference able to reproduce them would be a
//! second red-black tree); they are pinned by the hand-computed unit tests in
//! `src/structures/rbt.rs` and the cross-language `conformance/corpus-rbt.txt`.

use bench_engine::structures::rbt::RbtF64;
use proptest::prelude::*;
use std::collections::BTreeMap;

/// Integer keys stand in for f64 so the reference can be an ordered map.
fn expand(model: &BTreeMap<i32, usize>) -> Vec<f64> {
    model
        .iter()
        .flat_map(|(&k, &m)| std::iter::repeat(k as f64).take(m))
        .collect()
}

proptest! {
    /// Bulk build: in-order is the sorted multiset (duplicates kept), membership matches the
    /// reference for hits and misses, the invariants hold.
    #[test]
    fn rbt_membership_order_and_invariants_match_reference(
        keys in prop::collection::vec(-30i32..30, 0..200),
        queries in prop::collection::vec(-35i32..35, 1..50),
    ) {
        let mut model: BTreeMap<i32, usize> = BTreeMap::new();
        for &k in &keys {
            *model.entry(k).or_default() += 1;
        }
        let fkeys: Vec<f64> = keys.iter().map(|&k| k as f64).collect();
        let t = RbtF64::new(&fkeys, fkeys.len());
        prop_assert_eq!(t.len(), keys.len());
        prop_assert_eq!(t.keys_in_order(), expand(&model));
        prop_assert!(t.check_rb(), "red-black invariants must hold after a bulk build");
        for q in queries {
            prop_assert_eq!(t.search_one_counted(q as f64).0, model.contains_key(&q));
        }
    }

    /// A mixed insert/delete stream tracks the multiset reference after every op — a delete
    /// removes exactly one occurrence, an insert adds one — and every op keeps the
    /// invariants and stays inside the rotation budget.
    #[test]
    fn rbt_mixed_ops_match_reference_and_respect_the_rotation_budget(
        keys in prop::collection::vec(-25i32..25, 0..80),
        ops in prop::collection::vec((any::<bool>(), -30i32..30), 0..200),
    ) {
        let mut model: BTreeMap<i32, usize> = BTreeMap::new();
        for &k in &keys {
            *model.entry(k).or_default() += 1;
        }
        let fkeys: Vec<f64> = keys.iter().map(|&k| k as f64).collect();
        let mut t = RbtF64::new(&fkeys, fkeys.len());

        for (is_delete, key) in ops {
            if is_delete {
                let (removed, cost) = t.delete_one_detail(key as f64);
                let ref_removed = match model.get_mut(&key) {
                    Some(m) => {
                        *m -= 1;
                        if *m == 0 {
                            model.remove(&key);
                        }
                        true
                    }
                    None => false,
                };
                prop_assert_eq!(removed, ref_removed);
                prop_assert!(cost.rotations <= 3, "a delete rotated {} times", cost.rotations);
            } else {
                let cost = t.insert_one_detail(key as f64);
                *model.entry(key).or_default() += 1;
                prop_assert!(cost.rotations <= 2, "an insert rotated {} times", cost.rotations);
            }
            let size: usize = model.values().sum();
            prop_assert_eq!(t.len(), size);
            prop_assert_eq!(t.keys_in_order(), expand(&model));
            prop_assert!(t.check_rb(), "red-black invariants must hold after every op");
        }
    }
}
