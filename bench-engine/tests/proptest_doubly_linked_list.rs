//! Property tests for the doubly-linked-list bench twin (docs/PLAN.md §12, risk R1;
//! docs/METHODOLOGY.md §2.11). Two references, for two different claims:
//!
//! - **Correctness** against a trivial `Vec` multiset used head→tail (head insert = prepend,
//!   delete = remove the head-most match), checked after *every* op — and, the dimension the
//!   singly proptest cannot have, the **backward** walk through `prev` must be the exact
//!   reverse of the forward walk after every op. No canonical op reads `prev` on its walk, so a
//!   corrupted back-link would otherwise pass every membership and op-count check.
//! - **Cost** against the singly list, `LinkedListF64`. The singly proptest deliberately does
//!   not check op-counts, because a reference able to reproduce them "would just be a second
//!   linked list (circular)". Here that second list is the point: two independently linked
//!   implementations, one with a `prev` field and one without, must report the **same**
//!   `(result, node-visits)` for every op of every random stream — the per-op form of "the
//!   second pointer buys nothing on the canonical op set".

use bench_engine::structures::doubly_linked_list::DoublyLinkedListF64;
use bench_engine::structures::linked_list::LinkedListF64;
use proptest::prelude::*;

fn head_inserted(keys: &[f64]) -> Vec<f64> {
    keys.iter().rev().copied().collect()
}

fn reversed(v: &[f64]) -> Vec<f64> {
    v.iter().rev().copied().collect()
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Insert(i32),
    Delete(i32),
    Search(i32),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (-30i32..30).prop_map(Op::Insert),
        (-30i32..30).prop_map(Op::Delete),
        (-35i32..35).prop_map(Op::Search),
    ]
}

proptest! {
    /// Every op tracks the `Vec` model, and the back-links mirror the forward links throughout.
    #[test]
    fn dll_mixed_ops_match_reference_in_both_directions(
        keys in prop::collection::vec(-25i32..25, 0..60),
        ops in prop::collection::vec(op(), 0..150),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut l = DoublyLinkedListF64::new(&keys, keys.len());
        let mut model = head_inserted(&keys);
        prop_assert_eq!(l.keys_in_reverse(), reversed(&model));

        for o in ops {
            match o {
                Op::Insert(k) => {
                    l.insert_one_counted(k as f64);
                    model.insert(0, k as f64);
                }
                Op::Delete(k) => {
                    let k = k as f64;
                    let removed = l.delete_one_counted(k).0;
                    let ref_removed = match model.iter().position(|&x| x == k) {
                        Some(i) => { model.remove(i); true }
                        None => false,
                    };
                    prop_assert_eq!(removed, ref_removed);
                }
                Op::Search(k) => {
                    let k = k as f64;
                    prop_assert_eq!(l.search_one_counted(k).0, model.contains(&k));
                }
            }
            prop_assert_eq!(l.len(), model.len());
            prop_assert_eq!(l.keys_in_order(), model.clone());
            prop_assert_eq!(l.keys_in_reverse(), reversed(&model));
        }
    }

    /// Op for op, the doubly list reports the singly list's `(result, node-visits)` — exactly.
    #[test]
    fn dll_op_counts_equal_the_singly_lists_on_every_op(
        keys in prop::collection::vec(-25i32..25, 0..80),
        ops in prop::collection::vec(op(), 0..200),
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let mut d = DoublyLinkedListF64::new(&keys, keys.len());
        let mut s = LinkedListF64::new(&keys, keys.len());

        for o in ops {
            match o {
                Op::Insert(k) => {
                    prop_assert_eq!(d.insert_one_counted(k as f64), s.insert_one_counted(k as f64));
                }
                Op::Delete(k) => {
                    prop_assert_eq!(d.delete_one_counted(k as f64), s.delete_one_counted(k as f64));
                }
                Op::Search(k) => {
                    prop_assert_eq!(d.search_one_counted(k as f64), s.search_one_counted(k as f64));
                }
            }
        }
        prop_assert_eq!(d.keys_in_order(), s.keys_in_order());
    }

    /// The batched signals the Compare sweeps read — `search_counted`, `churn_counted`, and the
    /// cumulative build/teardown counts — agree too, for any key set and any churn key (a churn
    /// key that collides with a stored one included: head insert makes it 1 visit regardless).
    #[test]
    fn dll_batched_signals_equal_the_singly_lists(
        keys in prop::collection::vec(-50i32..50, 0..120),
        probes in prop::collection::vec(-60i32..60, 1..40),
        churn_key in -60i32..60,
    ) {
        let keys: Vec<f64> = keys.into_iter().map(|k| k as f64).collect();
        let probes: Vec<f64> = probes.into_iter().map(|k| k as f64).collect();
        let n = keys.len();
        let mut d = DoublyLinkedListF64::new(&keys, n);
        let mut s = LinkedListF64::new(&keys, n);
        d.set_probes(&probes);
        s.set_probes(&probes);
        prop_assert_eq!(d.search_counted(), s.search_counted());
        d.set_churn_key(churn_key as f64);
        s.set_churn_key(churn_key as f64);
        prop_assert_eq!(d.churn_counted(), s.churn_counted());
        prop_assert_eq!(d.keys_in_order(), s.keys_in_order());
        prop_assert_eq!(
            DoublyLinkedListF64::build_insert_counted(&keys, n),
            LinkedListF64::build_insert_counted(&keys, n)
        );
        // Duplicates included: with them an earlier copy short-circuits the tail-by-value walk —
        // on both lists identically, which is the claim (the FD path itself feeds distinct keys).
        prop_assert_eq!(
            DoublyLinkedListF64::teardown_counted(&keys, n),
            LinkedListF64::teardown_counted(&keys, n)
        );
    }
}
