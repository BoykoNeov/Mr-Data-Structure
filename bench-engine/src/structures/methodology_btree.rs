//! Clock-free methodology proofs for the **B-tree** (docs/METHODOLOGY.md §2.10; docs/PLAN.md
//! §6.3, §12) — kept beside, not inside, `structures::methodology` so this slice adds a file
//! rather than editing a shared one. Same rules as there: op-counts are deterministic
//! (fixed-seed `shuffled`, no RNG), so every inequality below is reproducible and the wide
//! margins never flake.
//!
//! What these pin, in one line each:
//! - the B-tree makes about **as many comparisons** as the AVL per search, and about a
//!   **quarter of the node-visits** — the mechanism the op-count chart cannot show;
//! - its churn and its finite-difference sum agree **tightly** — the tenth regime, and the
//!   first tree whose churn probe is not a cheap spine, because every leaf is at one depth;
//! - it keeps O(log n) on the reverse-sorted input that makes a naive BST an O(n) chain;
//! - sorted input builds **half-full** nodes — more of them, sometimes one level deeper — a
//!   constant the input order moves, never the class.

use super::avl::AvlF64;
use super::bst::BstF64;
use super::btree::{BTree, BTreeF64, MIN_DEGREE};
use super::sorted_array::SortedArrayF64;

/// The fixed-seed permutation of `0..n` used across `structures::methodology`.
fn shuffled(n: usize) -> Vec<f64> {
    let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for i in (1..n).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
    v
}

/// The engine's search workload (`buildProbes` in `src/bench/engine.worker.ts`): 64 present
/// keys spread through the prefix plus 64 absent ones at `max + 1 …`.
fn engine_probes(keys: &[f64], n: usize) -> Vec<f64> {
    let present = 64.min(n);
    let max = keys[..n].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut p: Vec<f64> = (0..present).map(|i| keys[i * n / present]).collect();
    p.extend((0..64).map(|i| max + 1.0 + i as f64));
    p
}

fn fd(keys: &[f64], n1: usize, n2: usize) -> (f64, f64) {
    let d = (n2 - n1) as f64;
    let ins = (BTreeF64::build_insert_counted(keys, n2) - BTreeF64::build_insert_counted(keys, n1)) / d;
    let del = (BTreeF64::teardown_counted(keys, n2) - BTreeF64::teardown_counted(keys, n1)) / d;
    (ins, del)
}

/// **Equal comparisons, fewer node-visits — the finding the op-count chart cannot see.**
/// On the engine's own probe set, the B-tree's per-search *comparison* count lands within a
/// few percent of the AVL's and the sorted array's (binary search is binary search: ≈ log₂ n
/// however the keys are laid out), while its *node-visits* — dependent pointer hops, one per
/// level — are its height, 3–4 at these sizes, against the AVL's one node per comparison.
/// Measured (comparisons per search, B-tree / AVL / sorted array; B-tree node-visits):
/// n = 4 000: 12.1 / 11.7 / 11.1, visits 3; n = 10 000: 13.2 / 12.6 / 12.6, visits 3;
/// n = 100 000: 16.5 / 15.3 / 15.8, visits 4.
///
/// So the comparison-count curve the chart draws for the B-tree should sit almost on the
/// AVL's and the sorted array's. Whether the *clock* separates them is a hypothesis this
/// test cannot settle — node-visits are a proxy for cache misses, not a measurement of them
/// (docs/METHODOLOGY.md §2.10).
#[test]
fn btree_matches_the_avl_on_comparisons_but_takes_a_quarter_of_the_node_visits() {
    for n in [4_000usize, 10_000, 100_000] {
        let ks = shuffled(n);
        let probes = engine_probes(&ks, n);
        let m = probes.len() as f64;
        let b = BTree::from_keys(MIN_DEGREE, &ks, n);
        let avl = AvlF64::new(&ks, n);
        let mut sarr = SortedArrayF64::new(&ks, n);
        sarr.set_probes(&probes);

        let (mut b_cmp, mut b_vis, mut a_cmp) = (0u64, 0u64, 0u64);
        for &p in &probes {
            let (found, cmp, vis) = b.search_one_profiled(p);
            assert_eq!(found, avl.search_one_counted(p).0);
            assert_eq!(vis, b.height() as u64, "every B-tree search visits exactly `height` nodes");
            b_cmp += cmp;
            b_vis += vis;
            // The AVL compares once per node it visits, so this is its node-visit count too.
            a_cmp += avl.search_one_counted(p).1;
        }
        let (b_cmp, b_vis, a_cmp) = (b_cmp as f64 / m, b_vis as f64 / m, a_cmp as f64 / m);
        let s_cmp = sarr.search_counted() / m;

        // (1) Comparisons: the same ≈ log₂ n as the AVL and the sorted array.
        let r = b_cmp / a_cmp;
        assert!((0.9..1.2).contains(&r), "n={n}: B-tree {b_cmp} vs AVL {a_cmp} comparisons");
        let r = b_cmp / s_cmp;
        assert!((0.9..1.2).contains(&r), "n={n}: B-tree {b_cmp} vs sorted array {s_cmp}");
        // (2) Node-visits: at most a third of the AVL's — the mechanism, made explicit.
        assert!(
            b_vis * 3.0 <= a_cmp,
            "n={n}: B-tree visits {b_vis} should be ≤ a third of the AVL's {a_cmp}"
        );
        assert!(b_vis <= 4.0, "n={n}: a t = 16 B-tree is at most 4 levels here, got {b_vis}");
    }
}

/// **The tenth churn-vs-finite-difference regime: tight, for a tree.** Every other tree's
/// churn probe rides a spine whose depth differs from the average key's (METHODOLOGY §4.1):
/// the BST's and the skip list's are cheaper, so their FD sums overshoot churn. A B-tree has
/// no spine to be cheap on — all leaves sit at one depth, so `min − 1` and `max + 1` walk the
/// same number of levels as any stored key — and once the churn has settled (no split, no
/// merge: `btree::tests::churn_settles_into_zero_restructures_and_zero_allocation`) a pair is
/// one insert descent plus one delete descent, which is what the build's and the teardown's
/// marginal operations are too. Measured: shuffled churn 25.0 vs sum 24.5 (insert_fd 11.8 +
/// delete_fd 12.7, ~2 %); ascending 24.5 vs 24.7; descending 26.0 vs 27.5 (~6 %).
#[test]
fn btree_churn_and_finite_differences_agree_tightly() {
    let n1 = 2_000usize;
    let n2 = 4_000usize;
    let asc: Vec<f64> = (0..n2).map(|i| i as f64).collect();
    let desc: Vec<f64> = asc.iter().rev().copied().collect();
    for (name, ks, tol) in [("shuffled", shuffled(n2), 0.05), ("ascending", asc, 0.08), ("descending", desc, 0.08)] {
        let (ins, del) = fd(&ks, n1, n2);
        let mut w = BTreeF64::new(&ks, n2);
        let lo = ks[..n2].iter().cloned().fold(f64::INFINITY, f64::min) - 1.0;
        let hi = ks[..n2].iter().cloned().fold(f64::NEG_INFINITY, f64::max) + 1.0;
        w.set_churn_keys(lo, hi);
        w.churn_n(64); // settle, exactly as the timed batches do before `opCountPerOp`
        let churn = w.churn_counted();
        let sum = ins + del;
        let rel = (churn - sum).abs() / churn;
        assert!(rel < tol, "{name}: churn {churn} vs fd sum {sum} (rel {rel})");
        // Both O(log n): nowhere near a linear reading of 4 000 keys.
        assert!(churn < 60.0 && sum < 60.0, "{name}: churn {churn} / sum {sum} must stay O(log n)");
        // The two halves are each about one descent — neither is a cheap spine.
        assert!((0.7..1.4).contains(&(ins / del)), "{name}: insert_fd {ins} vs delete_fd {del}");
    }
}

/// **The payoff on the input that kills a naive BST.** Built from the same reverse-sorted
/// keys, the BST is a left chain (search-min = n comparisons) and the B-tree is balanced by
/// construction — it only ever grows at the root — so search-min costs O(log n) comparisons
/// over at most 4 node-visits. The AVL survives this input by rotating; the B-tree never had
/// a height to lose.
#[test]
fn btree_keeps_its_class_on_the_input_that_degenerates_a_bst() {
    let n = 2_000usize;
    let desc: Vec<f64> = (0..n).map(|i| (n - 1 - i) as f64).collect();
    let bst = BstF64::new(&desc, n);
    let b = BTree::from_keys(MIN_DEGREE, &desc, n);
    let (bst_found, bst_ops) = bst.search_one_counted(0.0);
    let (b_found, b_ops, b_vis) = b.search_one_profiled(0.0);
    assert!(bst_found && b_found);
    assert_eq!(bst_ops, n as u64, "reverse-sorted BST search-min is O(n) — the full chain");
    assert!(b_ops < 20, "B-tree search-min {b_ops} must stay O(log n) ≪ {n}");
    assert!(b_vis <= 4);
    b.check().unwrap();
}

/// **Input order moves the constant, never the class.** A proactive split on sorted input
/// leaves every left half at the minimum `t − 1` keys and never touches it again, so an
/// ascending build has ~40 % more nodes than a shuffled one (66 vs 48 at n = 1 000) and is
/// sometimes a level deeper (4 vs 3 at n = 10 000). Searches stay ≈ log₂ n comparisons —
/// the in-node binary search over fewer keys makes up most of the extra level — which is why
/// `shapeSensitive` is false in the registry while this is stated beside the chart.
#[test]
fn sorted_input_builds_half_full_nodes_without_changing_the_class() {
    for n in [1_000usize, 10_000] {
        let asc: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let shuf = shuffled(n);
        let s = BTree::from_keys(MIN_DEGREE, &asc, n);
        let r = BTree::from_keys(MIN_DEGREE, &shuf, n);
        assert!(
            s.node_count() as f64 >= 1.3 * r.node_count() as f64,
            "n={n}: sorted build {} nodes vs shuffled {}",
            s.node_count(),
            r.node_count()
        );
        assert!(s.height() >= r.height());
        let probes = engine_probes(&shuf, n);
        let cost = |b: &BTree| probes.iter().map(|&p| b.search_one_counted(p).1).sum::<u64>() as f64;
        let ratio = cost(&s) / cost(&r);
        assert!((0.85..1.25).contains(&ratio), "n={n}: sorted/shuffled search cost {ratio}");
    }
    // The extra level is real at 10 000.
    let asc: Vec<f64> = (0..10_000).map(|i| i as f64).collect();
    assert_eq!(BTree::from_keys(MIN_DEGREE, &asc, 10_000).height(), 4);
    assert_eq!(BTree::from_keys(MIN_DEGREE, &shuffled(10_000), 10_000).height(), 3);
}
