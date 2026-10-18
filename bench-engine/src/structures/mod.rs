//! Production data-structure implementations for the benchmark engine
//! (docs/PLAN.md §8). Each structure is built once from a marshalled key buffer
//! (untimed), then answers a *batch* of queries inside a single WASM call so the
//! caller can time many ops at once — the timed region holds enough work to swamp
//! the browser clock clamp (docs/PLAN.md §6.2, risk R2).
//!
//! **Counting is a zero-overhead, type-level flag.** Every search is written
//! once, generic over `const COUNT: bool`. The timed hot path calls it with
//! `COUNT = false` (the increments compile away entirely); the op-count *signal*
//! (§6.4) calls the same code with `COUNT = true`. One algorithm, no drift
//! between what is timed and what is counted.
//!
//! Phase 2 implements both key paths: the number-key structures (`f64` —
//! `dyn_array::ArrayF64`, `hash_set::HashSetF64`) and the string-key structures
//! (`dyn_array_str::ArrayStr`, `hash_set_str::HashSetStr`), the latter built
//! from the offsets+UTF-8 marshal layout (docs/PLAN.md §4.2, risk R7). Each key
//! type carries its own portable hash (`mix_f64`, `mix_str`) with a bit-exact
//! TypeScript twin (`src/structures/mix.ts`) and a cross-language conformance
//! corpus (docs/PLAN.md §12), so the two languages stay in lockstep.
//!
//! Phase 4 begins the tree family: `bst::BstF64` is the bench twin of the
//! `src/structures/bst.ts` teaching impl (comparisons cost metric, Hibbard delete),
//! pinned to it by the `conformance/corpus-bst.txt` corpus; `avl::AvlF64` adds the
//! balanced twin (comparisons **+ rotations**), recursive rather than arena-backed
//! because the AVL invariant bounds its height and removes the BST's stack-overflow
//! hazard, pinned by `conformance/corpus-avl.txt`. `sorted_array::SortedArrayF64`
//! is the Linear-family bench twin of `src/structures/sortedArray.ts` — a sorted
//! multiset with **binary-search** lookup (the O(log n) "missing middle" between the
//! unsorted array's O(n) and the hash set's O(1)) and shift-based insert/delete (cost
//! metric **comparisons + shifts**), pinned by `conformance/corpus-sarr.txt`.
//! `linked_list::LinkedListF64` closes the Linear family — the bench twin of the singly
//! `src/structures/linkedList.ts` teaching twin (Phase 6 gave the doubly list its own,
//! `doubly_linked_list::DoublyLinkedListF64`, to *measure* the op-count equality rather than
//! claim it — METHODOLOGY §2.11), an index arena with O(1) head insert and O(n)
//! search/delete, pinned by `conformance/corpus-ll.txt`. `heap::MinHeapF64` closes the
//! Trees/heaps family — the bench twin of `src/structures/heap.ts`, an array-backed complete
//! tree (cost metric **comparisons + swaps**) pinned by `conformance/corpus-heap.txt`. It is
//! the one structure with a **different op set** (insert / peek / extract-min, with search as
//! a deliberate O(n) scan contrast), so it is compared only within its own group
//! (docs/PLAN.md §8, risk R6) — a separation enforced in the UI, not here.
//!
//! Phase 6 opens the "Specialized" catalogue. `trie::TrieStr` is the string-key prefix
//! tree (cost metric **char-steps**), pinned by the string corpus. `skip_list::SkipListF64`
//! is the numeric ordered structure that reaches O(log n) with **no balancing and no
//! rotations**: a tower of forward-linked lists whose node heights are derived from
//! `mix_f64` rather than from a coin, so the list is a pure function of its key *set*.
//! That determinism is what lets the op-count signal stay reproducible under adaptive
//! batching and the cross-language corpus stay exact — see the `skip_list` module doc for
//! why an RNG could not do either. Pinned by `conformance/corpus-skip.txt`.
//!
//! `graph::GraphAdj` is the third own-op-set structure (after the heap and, by data type,
//! the trie): an undirected adjacency-list **multigraph** whose operations are add-edge and
//! whole-graph **traversal** (BFS via a queue, DFS via an explicit stack). Its cost metric is
//! vertex-visits + edge-visits — exactly `V + 2E` on a connected graph — so it is measured and
//! compared only within its own group (docs/PLAN.md §8, risk R6), never on the key-structure
//! charts. Pinned by `conformance/corpus-graph.txt`.

pub mod avl;
pub mod bst;
pub mod btree;
pub mod dyn_array;
pub mod dyn_array_str;
pub mod graph;
pub mod hash_set;
pub mod hash_set_oa;
pub mod hash_set_bs;
pub mod hash_set_str;
pub mod heap;
pub mod linked_list;
pub mod skip_list;
pub mod sorted_array;
pub mod trie;
pub mod doubly_linked_list;
pub mod rbt;

#[cfg(test)]
mod conformance;
#[cfg(test)]
mod conformance_rbt;
#[cfg(test)]
mod conformance_btree;
#[cfg(test)]
mod methodology_btree;
#[cfg(test)]
mod methodology_hbs;

/// Decode the first `n` keys of an offsets+UTF-8-bytes marshal buffer
/// (docs/PLAN.md §4.2) into owned `String`s. `offsets` has length `count + 1`
/// with `offsets[i]..offsets[i+1]` bounding key `i` (`offsets[0] == 0`); `n` is
/// clamped to the available `count`. Shared by both string structures so each
/// builds from the *same* layout the TS marshaller (`src/data/marshal.ts`)
/// produces — the concrete exercise of risk R7.
pub(crate) fn decode_keys(offsets: &[u32], bytes: &[u8], n: usize) -> Vec<String> {
    let count = offsets.len().saturating_sub(1);
    let n = n.min(count);
    (0..n)
        .map(|i| {
            let (a, b) = (offsets[i] as usize, offsets[i + 1] as usize);
            std::str::from_utf8(&bytes[a..b])
                .expect("marshalled keys must be valid UTF-8")
                .to_owned()
        })
        .collect()
}

/// SplitMix64 finalizer — a cheap, strong bit-avalanche over a 64-bit value.
/// Both key hashes route their raw integer through this so chains stay short
/// (and hash-set search reads as O(1), docs/PLAN.md §8) regardless of how
/// clustered the inputs are.
#[inline]
pub fn splitmix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Hash for numeric keys: the SplitMix64 finalizer over the f64 bit pattern.
/// Consecutive integers (the `sorted` generator) have very different IEEE-754
/// bit patterns once mixed, so chains stay short and hash-set search reads as
/// O(1) (docs/PLAN.md §8).
#[inline]
pub fn mix_f64(x: f64) -> u64 {
    splitmix64(x.to_bits())
}

/// Hash for string keys: 64-bit FNV-1a over the UTF-8 bytes, then the SplitMix64
/// finalizer for avalanche (FNV-1a alone mixes its *low* bits — the ones the
/// bucket mask reads — poorly). FNV-1a is byte-oriented and uses only wrapping
/// xor/multiply, so the TypeScript twin (`src/structures/mix.ts`, `mixStr`) is
/// bit-exact. Hashing the UTF-8 *bytes* (not chars) is what binds the two
/// languages to the same marshal layout (docs/PLAN.md §4.2, §12).
#[inline]
pub fn mix_str(s: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = FNV_OFFSET;
    for &b in s.as_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    splitmix64(h)
}

#[cfg(test)]
mod tests {
    use super::{mix_f64, mix_str};

    /// Pinned anchors shared with the TypeScript port (src/structures/mix.ts).
    /// These are the contract the two hashes meet on; the TS unit test asserts
    /// the same values, so a drift on either side is caught locally before the
    /// full conformance corpus (docs/PLAN.md §12).
    #[test]
    fn mix_matches_pinned_anchors() {
        assert_eq!(mix_f64(0.0), 0); // bit pattern 0 → SplitMix64(0) = 0
        assert_eq!(mix_f64(1.0), 3035652100526550566);
        assert_eq!(mix_f64(2.0), 1360429390938723525);
        assert_eq!(mix_f64(3.0), 6732024472757944893);
        assert_eq!(mix_f64(0.5), 306524380890059637);
        assert_eq!(mix_f64(-1.0), 5045323167042602119);
        assert_eq!(mix_f64(1_000_000.0), 4119586053111418004);
    }

    /// Anchors for the string hash, shared with the TS port (`mixStr`). Inputs
    /// cover the empty string, ASCII, and multi-byte UTF-8 (an accent, CJK, and
    /// an emoji) so byte-length ≠ char-length is exercised. The TS unit test
    /// asserts the same values, catching a hash drift on either side before the
    /// full conformance corpus (docs/PLAN.md §12).
    #[test]
    fn mix_str_matches_pinned_anchors() {
        assert_eq!(mix_str(""), 17665956581633026203);
        assert_eq!(mix_str("a"), 198367012849983736);
        assert_eq!(mix_str("abc"), 996580060897260808);
        assert_eq!(mix_str("café"), 16195296087438488975);
        assert_eq!(mix_str("日本語"), 8638792154450581254);
        assert_eq!(mix_str("🍎"), 8145269713608364353);
    }
}

/// Methodology self-test on the **real** structures (docs/PLAN.md §6.3, §12).
///
/// Op-counts are deterministic, so the churn-vs-finite-difference agreement can be
/// checked with no clock at all — the clock-free counterpart to the TS stub
/// self-test (`src/bench/methodology.test.ts`), and a more literal reading of §12
/// ("the two methods must agree on known structures"). For a per-pair churn count
/// `churn(n)` and finite differences of the cumulative build / teardown op-counts:
/// `churn(n) ≈ insert_fd(n) + delete_fd(n)`.
#[cfg(test)]
mod methodology {
    use super::avl::AvlF64;
    use super::bst::BstF64;
    use super::dyn_array::ArrayF64;
    use super::graph::GraphAdj;
    use super::hash_set::HashSetF64;
    use super::heap::MinHeapF64;
    use super::linked_list::LinkedListF64;
    use super::skip_list::SkipListF64;
    use super::sorted_array::SortedArrayF64;

    fn keys(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64).collect()
    }

    /// A fixed-seed permutation of `0..n` (distinct keys ⇒ a balanced-ish random BST,
    /// the contrast to the sorted chain). Deterministic, so the op-counts below are
    /// reproducible — no RNG dependency, no flake.
    fn shuffled(n: usize) -> Vec<f64> {
        let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15; // fixed seed
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

    #[test]
    fn array_churn_matches_finite_differences() {
        let ks = keys(1001);
        let (n1, n2) = (999usize, 1000usize);
        let insert_fd = (ArrayF64::build_insert_counted(&ks, n2)
            - ArrayF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (ArrayF64::teardown_counted(&ks, n2)
            - ArrayF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut a = ArrayF64::new(&ks, n2);
        a.set_churn_key(n2 as f64 + 1.0); // absent from [0, n2)
        let churn = a.churn_counted();

        // Array insert is a zero-op append, so this is really delete-vs-teardown.
        assert_eq!(insert_fd, 0.0);
        let rel = (churn - (insert_fd + delete_fd)).abs() / churn;
        assert!(rel < 0.02, "churn {churn} vs fd {} (rel {rel})", insert_fd + delete_fd);
    }

    #[test]
    fn hashset_churn_matches_finite_differences() {
        let ks = keys(2000);
        let (n1, n2) = (1500usize, 1600usize);
        let insert_fd = (HashSetF64::build_insert_counted(&ks, n2)
            - HashSetF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (HashSetF64::teardown_counted(&ks, n2)
            - HashSetF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut s = HashSetF64::new(&ks, n2);
        s.set_churn_key(n2 as f64 + 1.0);
        let churn = s.churn_counted();

        // Both sides are small O(1) counts; allow generous slack for chain-length
        // variation between the churn key's bucket and the swept average.
        let rel = (churn - (insert_fd + delete_fd)).abs() / churn;
        assert!(rel < 0.5, "churn {churn} vs fd {} (rel {rel})", insert_fd + delete_fd);
    }

    // ── BST: the open question — does `churn ≈ insert_fd + delete_fd` hold for a tree?
    //
    // For the array the identity is tight because its costs are position-uniform (insert
    // is a free append; any delete is O(n)). A tree breaks that symmetry: churn's keys ride
    // the two **spines** — `min − 1` down the left, `max + 1` down the right, alternating
    // (docs/METHODOLOGY.md §4.1) — while the build inserts dataset keys at their **average
    // depth**. So the answer is regime-dependent, and the slice owns reporting *both*
    // halves. The teardown alternates delete-max / delete-min to stay on the same two
    // paths as churn's deletes, which is what keeps the *delete* sides comparable at all.

    /// Sorted input ⇒ the degenerate right **chain** (the headline demo, and a stack-safety
    /// exercise). Under the two-key recipe (docs/METHODOLOGY.md §4.1) this is no longer the
    /// tight match it was when churn probed the right spine alone. The **delete** sides
    /// still line up exactly — that is precisely what alternating the teardown buys — but
    /// the **insert** sides cannot: churn averages a full-chain insert with a root-adjacent
    /// one (≈ n/2), while the build drops every dataset key at the bottom of the chain
    /// (≈ n). So the finite-difference sum overshoots churn by that asymmetry, and the two
    /// methods agree on the **class** (both unmistakably O(n)) rather than the constant.
    /// Measured: churn 1002, insert_fd 999, delete_fd 501, sum 1500.
    #[test]
    fn bst_chain_finite_difference_sum_overshoots_churn_on_the_insert_side() {
        let ks = keys(1001); // 0..1000, ascending ⇒ right chain
        let (n1, n2) = (999usize, 1000usize);
        let insert_fd = (BstF64::build_insert_counted(&ks, n2)
            - BstF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (BstF64::teardown_counted(&ks, n2) - BstF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut t = BstF64::new(&ks, n2);
        t.set_churn_keys(-1.0, n2 as f64 + 1.0); // absent at both ends
        let churn = t.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) The delete sides agree: churn's two deletes average ≈ churn/2, and the
        //     alternating teardown's marginal delete matches it. This is the property the
        //     two-key teardown exists to preserve.
        assert!(
            (delete_fd - churn / 2.0).abs() / churn < 0.02,
            "chain delete_fd {delete_fd} should track churn/2 {} (churn {churn})",
            churn / 2.0
        );
        // (2) The insert sides cannot agree: the build's marginal insert is a *full*-chain
        //     descent, about twice churn's averaged one — the whole of the overshoot.
        assert!(
            insert_fd > 1.8 * (churn / 2.0),
            "chain insert_fd {insert_fd} should be ≈ 2× churn's averaged insert {}",
            churn / 2.0
        );
        assert!(sum > churn, "chain: expected fd sum {sum} > churn {churn} (the overshoot)");
        // (3) Both stay unmistakably O(n) — the class agreement that still holds.
        let quarter = n2 as f64 / 4.0;
        assert!(churn > quarter && sum > quarter, "chain churn {churn} / sum {sum} must read O(n)");
    }

    /// **The dishonesty the two-key churn removes** (docs/METHODOLOGY.md §4.1).
    /// Reverse-sorted input builds a *left* chain, whose **right** spine is a single node.
    /// The old one-keyed recipe churned at `max + 1` only, inserting and deleting just off
    /// the root — O(1) — so the chart reported a **flat** mutation curve for a structure
    /// whose search on the same data is O(n): a wrong complexity *class*, not merely a
    /// wrong constant. Alternating `min − 1` in makes the chain visible again. Simulating
    /// the old recipe by setting both churn keys to `max + 1` keeps the contrast in one
    /// deterministic test.
    #[test]
    fn bst_reverse_sorted_two_key_churn_recovers_the_linear_class() {
        let n = 1000usize;
        let ks: Vec<f64> = (0..n).map(|i| (n - 1 - i) as f64).collect(); // descending
        let mut t = BstF64::new(&ks, n);
        let max = (n - 1) as f64;

        // The old recipe: right spine only — one comparison down, two back.
        t.set_churn_keys(max + 1.0, max + 1.0);
        let hi_only = t.churn_counted();
        // The recipe the engine now uses: both ends, averaged.
        t.set_churn_keys(-1.0, max + 1.0);
        let two_key = t.churn_counted();

        assert!(
            hi_only <= 3.0,
            "a right-spine-only churn on a left chain reads O(1): {hi_only}"
        );
        assert!(
            two_key > n as f64 / 4.0,
            "two-key churn must walk the chain: {two_key} (n = {n})"
        );
        // Size and contents are restored by every churn pair.
        assert_eq!(t.len(), n);
    }

    /// Shuffled input ⇒ a **balanced** random tree. Here the array identity **fails**: the
    /// finite-difference sum *overshoots* churn, because churn probes only the cheap right
    /// spine (≈ 2 ln n round-trip) while insert_fd alone already reflects the average key
    /// depth (≈ 2 ln n) and delete_fd (≈ ln n) is added on top. The two methods agree only
    /// in **complexity class** (both O(log n) ≪ n), not in constant — the honest finding
    /// (docs/PLAN.md §2.3, §6.3). Measured under the two-key recipe: churn 18, insert_fd
    /// 15.0, delete_fd 8.7, sum 23.7 (~32% over). Op-counts are deterministic (fixed-seed
    /// `shuffled`), so the wide-margin inequalities below never flake.
    #[test]
    fn bst_balanced_finite_difference_sum_overshoots_churn() {
        let ks = shuffled(4000);
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (BstF64::build_insert_counted(&ks, n2)
            - BstF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (BstF64::teardown_counted(&ks, n2) - BstF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut t = BstF64::new(&ks, n2);
        t.set_churn_keys(-1.0, n2 as f64 + 1.0); // absent at both ends
        let churn = t.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) The overshoot: the FD sum double-counts relative to the right-spine probe.
        assert!(sum > churn, "balanced: expected fd sum {sum} > churn {churn} (the overshoot)");
        // (2) Both are O(log n), nowhere near the chain's O(n): far below n/10 = 400.
        assert!(churn < 400.0, "balanced churn {churn} must stay O(log n) ≪ n");
        assert!(sum < 400.0, "balanced fd sum {sum} must stay O(log n) ≪ n");
    }

    // ── AVL: balance changes the methodology story twice over.
    //
    // (a) The headline that motivates the structure: where the BST degenerates on sorted
    //     input to an O(n) chain, the AVL rotates and stays O(log n). That is a *deterministic
    //     op-count* claim, so it belongs here — the clock-free home for a numeric finding —
    //     not in the noisy browser proof (which only reads slope).
    // (b) The churn-vs-finite-difference question, answered a *third* way: unlike the array
    //     (tight) and the balanced BST (the FD sum overshoots), for the AVL the two methods
    //     agree closely AND churn marginally *exceeds* the FD sum — because churn's insert
    //     rides the full-height right spine while `insert_fd` reflects the shallower *average*
    //     depth. The gap is small because an AVL's height and average depth differ only by
    //     ~1.44×, not the random BST's ~2× (docs/PLAN.md §2.3, §6.3).

    /// The AVL defeats the exact input that kills the BST. Built from the *same* sorted keys:
    /// the BST is a right chain (search-max = n comparisons, build = Σ i = O(n²)); the AVL is
    /// balanced (search-max ≤ height = O(log n), build = O(n log n)). Deterministic, so the
    /// wide-margin inequalities never flake.
    #[test]
    fn avl_stays_log_n_where_the_bst_degenerates_on_sorted_input() {
        let n = 1023usize;
        let sorted = keys(n + 1); // 0..=1023, ascending
        let max = n as f64; // 1023.0, the rightmost key

        let bst = BstF64::new(&sorted, n + 1);
        let avl = AvlF64::new(&sorted, n + 1);

        // Search the maximum: the BST walks the whole chain; the AVL walks ≤ its height.
        let (bst_found, bst_ops) = bst.search_one_counted(max);
        let (avl_found, avl_ops) = avl.search_one_counted(max);
        assert!(bst_found && avl_found);
        assert_eq!(bst_ops, (n + 1) as u64, "sorted BST search-max is O(n) — the full chain");
        assert!(avl_ops <= 20, "AVL search-max {avl_ops} must be O(log n) ≪ {}", n + 1);

        // Build cost: the chain pays Σ i = O(n²); the balanced tree pays O(n log n). The AVL's
        // total build comparisons+rotations are an order of magnitude below the BST's.
        let bst_build = BstF64::build_insert_counted(&sorted, n + 1);
        let avl_build = AvlF64::build_insert_counted(&sorted, n + 1);
        assert!(
            avl_build * 10.0 < bst_build,
            "AVL build {avl_build} must be ≪ BST build {bst_build} on sorted input"
        );
    }

    /// On a balanced (shuffled) tree the churn primary and the finite-difference sum agree
    /// closely — both O(log n), within ~15% (measured ~10%: churn 26, sum 23.3) — with churn
    /// the larger, because its pairs ride full-height spines while `insert_fd` reflects the
    /// shallower average depth. The *opposite* direction from the balanced BST's overshoot,
    /// reported rather than buried.
    #[test]
    fn avl_churn_and_finite_differences_agree_closely() {
        let ks = shuffled(4000);
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (AvlF64::build_insert_counted(&ks, n2)
            - AvlF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (AvlF64::teardown_counted(&ks, n2) - AvlF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut t = AvlF64::new(&ks, n2);
        t.set_churn_keys(-1.0, n2 as f64 + 1.0); // absent at both ends
        let churn = t.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) Close agreement — far tighter than the random BST's overshoot.
        let rel = (churn - sum).abs() / churn;
        assert!(rel < 0.15, "AVL churn {churn} vs fd sum {sum} should agree (rel {rel})");
        // (2) churn rides the deepest (full-height) spine, so it is the marginally larger.
        assert!(churn >= sum, "AVL churn {churn} should be ≥ fd sum {sum} (full-spine probe)");
        // (3) Both are O(log n), nowhere near a chain's O(n): far below n/50 = 80.
        assert!(churn < 80.0 && sum < 80.0, "AVL churn {churn} / sum {sum} must stay O(log n)");
    }

    // ── Sorted array: a fourth churn-vs-finite-difference regime, and the structure's
    //    signature split (O(log n) search vs O(n) mutation).
    //
    // The sorted array's mutation cost is dominated by **shifts**, whose size depends on
    // *where* the key lands — so the churn-key choice sets the class the curve reports.
    // The engine uses the **front** key (`min − 1`): each insert/delete shifts the whole
    // array (O(n)). A *tail* key would append/pop with zero shifts and read O(log n) —
    // dishonest, since (unlike the BST's right spine, which is the same O(log n) class as
    // the average path) the tail of a sorted array is a *different class* than the average
    // position. Front churn shifts the whole array twice (≈ 2n); the finite-difference sum
    // is insert (≈ n/2, the average position of a shuffled build) + delete (≈ n, the
    // front teardown) ≈ 3n/2, so churn *overshoots* the sum — yet a fourth direction after
    // the array (tight), the balanced BST (sum overshoots), and the AVL (close, churn ≥ sum).

    /// Front churn overshoots the finite-difference sum, and both are unmistakably O(n)
    /// (≫ what a tail/best-case churn would read). Build is fed **shuffled** keys so its
    /// inserts land at average depth (≈ n/2 shifts) — on ascending input every insert would
    /// append (0 shifts) and `insert_fd` would read O(log n), contradicting the O(n) churn.
    /// Deterministic via the fixed-seed `shuffled`, so the wide-margin inequalities never flake.
    #[test]
    fn sorted_array_front_churn_overshoots_finite_difference_sum() {
        let ks = shuffled(4000); // keys 0..3999 in a fixed-seed scramble
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (SortedArrayF64::build_insert_counted(&ks, n2)
            - SortedArrayF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (SortedArrayF64::teardown_counted(&ks, n2)
            - SortedArrayF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut a = SortedArrayF64::new(&ks, n2);
        a.set_churn_key(-1.0); // min(0..3999) − 1: absent, < all ⇒ front insert/delete
        let churn = a.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) Front churn double-shifts the whole array, overshooting the FD sum.
        assert!(churn > sum, "sorted array: churn {churn} should overshoot fd sum {sum}");
        // (2) Same complexity class — the sum is within a factor of 2 of churn.
        assert!(sum > churn / 2.0, "sorted array: churn {churn} and sum {sum} same class");
        // (3) Unmistakably O(n): churn ≫ n (a tail/best-case churn would read ≈ 2·log n ≪ n).
        assert!(churn > n2 as f64, "sorted array churn {churn} must be O(n), not the tail's O(log n)");
        // (4) And O(n), not O(n²): bounded well below n².
        assert!(churn < 4.0 * n2 as f64, "sorted array churn {churn} must stay O(n) ≪ O(n²)");
    }

    /// The sorted array's signature: the *same* structure is O(log n) to **search** but O(n)
    /// to **mutate** — binary search vs shifts. A deterministic op-count contrast (the clock-
    /// free home for a numeric claim, like the AVL-beats-BST finding above), built on ascending
    /// keys so the binary search is exercised at full depth.
    #[test]
    fn sorted_array_search_is_log_n_while_mutation_is_linear() {
        let n = 4096usize;
        let ks = keys(n); // 0..4095 ascending
        let a = SortedArrayF64::new(&ks, n);

        // Search the maximum: binary search ⇒ ≈ log2(4096) = 12 comparisons, nowhere near n.
        let (found, ops) = a.search_one_counted((n - 1) as f64);
        assert!(found);
        assert!(ops <= 14, "sorted-array search-max {ops} must be O(log n) ≈ 12, not O(n)");

        // Front churn, by contrast, shifts the whole array ⇒ O(n) ≫ the search's log n.
        let mut b = SortedArrayF64::new(&ks, n);
        b.set_churn_key(-1.0);
        let churn = b.churn_counted();
        assert!(churn > n as f64, "sorted-array front churn {churn} must be O(n) — the shift cost");
        assert!(churn > 100.0 * ops as f64, "mutation {churn} ≫ search {ops}: the signature split");
    }

    // ── Linked list: a FIFTH churn-vs-finite-difference regime — a complexity-class
    //    DISAGREEMENT, not just a constant-factor gap.
    //
    // Head-insert structurally places the churn key where deletion is O(1), so there is no
    // size-preserving same-key churn that yields O(n): churn (insert + delete-of-the-newest)
    // is O(1) regardless of n. But the *canonical* delete-by-value is O(n) — a walk to find
    // the key — surfaced by the finite-difference teardown (delete the oldest/tail repeatedly,
    // a full walk each). So churn ≪ insert_fd + delete_fd land in different complexity classes,
    // because insert and the canonical delete live at opposite cost-ends. Unlike the array
    // (tight), balanced BST (FD overshoots, same class), AVL (close), and sorted array (front
    // churn overshoots, same class), here the two methods disagree on the class itself — the
    // honest finding (docs/PLAN.md §2.3, §6.3). A flat O(1) churn curve on the browser clock
    // would look identical to the hash set, so the finding lives here, clock-free.

    /// Churn is O(1) (head insert + delete-of-newest) while the finite-difference teardown
    /// reveals the canonical O(n) delete-by-value — the fifth regime, a class disagreement.
    /// Deterministic op-counts (insertion order, not values, sets the cost), so the
    /// wide-margin inequalities never flake.
    #[test]
    fn linked_list_churn_is_o1_while_canonical_delete_is_o_n() {
        let ks = keys(4000); // distinct; the values are irrelevant — insertion order sets the cost
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (LinkedListF64::build_insert_counted(&ks, n2)
            - LinkedListF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (LinkedListF64::teardown_counted(&ks, n2)
            - LinkedListF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut l = LinkedListF64::new(&ks, n2);
        l.set_churn_key(n2 as f64 + 1.0); // absent; inserted at and deleted from the head
        let churn = l.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) Head insert visits no nodes — the insert side is exactly zero (like the array's append).
        assert_eq!(insert_fd, 0.0, "head insert is O(1): zero node-visits");
        // (2) Churn is O(1): exactly one visit, the just-inserted head.
        assert_eq!(churn, 1.0, "linked-list churn is O(1): delete finds the newest at the head");
        // (3) The canonical delete is O(n): the FD teardown walks to the receding tail (≈ 3n/4).
        assert!(delete_fd > n2 as f64 / 2.0, "delete_fd {delete_fd} must be O(n) (≫ n/2)");
        assert!(delete_fd < n2 as f64, "delete_fd {delete_fd} ≈ 3n/4, bounded by n");
        // (4) The class DISAGREEMENT: the FD sum overshoots churn by an order of n, not a constant.
        assert!(
            sum > churn * 100.0,
            "fd sum {sum} ≫ churn {churn}: a complexity-class disagreement, the fifth regime"
        );
    }

    // ── Min-heap: an EIGHTH regime — the totals agree in class, the *insert halves* do not.
    //
    // A heap has no delete-by-value, so its churn pair must be insert + extract-**min**, and
    // the inserted key must therefore be `min − 1`: anything higher and the extract removes a
    // *real* key, draining the heap (pinned in `heap::tests::a_high_churn_key_would_drain_
    // the_heap`). That makes churn's insert the **worst-case** insert — a new global minimum
    // climbs the full ⌊log₂ n⌋ — while the build's inserts are ordinary keys that, on shuffled
    // input, sift O(1) levels in expectation because most of a heap is leaves. So `insert_fd`
    // reads ≈ flat (O(1)) where churn's insert half is Θ(log n): the two methods disagree on
    // the *class of the insert half* while their totals still agree (both Θ(log n), carried by
    // the extract). That is a narrower version of the linked list's class disagreement — there
    // the totals diverged too; here only the halves do.

    /// The eighth regime: churn overshoots the finite-difference sum by a constant factor
    /// (both Θ(log n)), while the **insert halves** disagree on class — `insert_fd` is O(1)
    /// on shuffled input, churn's insert half is Θ(log n). Measured at n = 4000: churn 53,
    /// insert_fd 3.6, delete_fd 31.3, sum 34.9 (churn ~1.5× the sum). Deterministic via the
    /// fixed-seed `shuffled`, so the wide-margin inequalities never flake.
    #[test]
    fn heap_churn_overshoots_finite_differences_on_the_insert_side() {
        let ks = shuffled(4000);
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (MinHeapF64::build_insert_counted(&ks, n2)
            - MinHeapF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (MinHeapF64::teardown_counted(&ks, n2)
            - MinHeapF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut h = MinHeapF64::new(&ks, n2);
        h.set_churn_key(-1.0); // min(0..3999) − 1: strictly below every key ⇒ sifts to the root
        let churn = h.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) Churn overshoots: its insert half rides the full height, the build's does not.
        assert!(churn > sum, "heap churn {churn} should overshoot fd sum {sum}");
        // (2) The insert halves disagree on CLASS: a shuffled build's marginal insert is O(1)
        //     (a handful of ops), nowhere near the ⌊log₂ 4000⌋ ≈ 12 levels churn's insert climbs.
        assert!(
            insert_fd < 6.0,
            "shuffled build's marginal insert {insert_fd} must read O(1) — most of a heap is leaves"
        );
        // (3) Yet the totals stay the same class: the extract half carries both, so the sum is
        //     within a small factor of churn.
        assert!(sum > churn / 4.0, "heap: churn {churn} and sum {sum} must stay the same class");
        // (4) Both are Θ(log n), nowhere near a linear structure's O(n): far below n/50 = 80.
        assert!(churn < 80.0 && sum < 80.0, "heap churn {churn} / sum {sum} must stay O(log n)");
        // (5) And the extract half really is the Θ(log n) one, well above the flat insert.
        assert!(delete_fd > 4.0 * insert_fd, "extract {delete_fd} ≫ insert {insert_fd}: the asymmetry");
    }

    /// The heap's signature: the *same* structure is Θ(log n) to **extract-min** but O(n) to
    /// **search**, because it is ordered for the root only — the deliberate contrast that
    /// makes the point a heap is not a lookup structure (docs/PLAN.md §8, risk R6). A
    /// deterministic op-count claim, the clock-free home for a numeric finding.
    #[test]
    fn heap_search_is_linear_while_extract_min_is_log_n() {
        let n = 4096usize;
        let ks = shuffled(n);
        let h = MinHeapF64::new(&ks, n);

        // An absent key costs the whole array — no better than scanning an unsorted array.
        let (found, scan_ops) = h.search_one_counted(-1.0);
        assert!(!found);
        assert_eq!(scan_ops, n as u64, "a heap scan examines every slot: O(n)");

        // Churn (insert + extract-min), by contrast, rides ⌊log₂ 4096⌋ = 12 levels ⇒ ≈ 3·12.
        let mut b = MinHeapF64::new(&ks, n);
        b.set_churn_key(-1.0);
        let churn = b.churn_counted();
        assert!(churn < 80.0, "heap churn {churn} must be O(log n), not O(n)");
        assert!(
            scan_ops as f64 > 50.0 * churn,
            "search {scan_ops} ≫ mutation {churn}: the signature split, inverted from the sorted array"
        );
    }

    /// The build's order-sensitivity, which the module doc warns about and which the gate's
    /// reverse-sorted pass will see: ascending input makes every insert a tail append (Θ(n)
    /// build, flat `insert_fd`), descending makes every insert climb to the root (Θ(n log n)
    /// build, `insert_fd` ≈ 2·log n). Churn is unaffected either way — it always rides the
    /// full height — which is why the heap is not registered as shape-sensitive.
    #[test]
    fn heap_build_is_order_sensitive_but_churn_is_not() {
        let n = 4000usize;
        let ascending: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let descending: Vec<f64> = (0..n).map(|i| (n - 1 - i) as f64).collect();

        let asc_build = MinHeapF64::build_insert_counted(&ascending, n);
        let desc_build = MinHeapF64::build_insert_counted(&descending, n);

        // Ascending: exactly one failed comparison per key after the first ⇒ n − 1.
        assert_eq!(asc_build, (n - 1) as f64, "ascending build is Θ(n): one comparison per key");
        // Descending: every key climbs to the root ⇒ Θ(n log n), an order above.
        assert!(
            desc_build > 5.0 * asc_build,
            "descending build {desc_build} must be Θ(n log n) ≫ ascending {asc_build}"
        );

        // Churn is order-insensitive: the same full-height cost on both inputs.
        let mut asc = MinHeapF64::new(&ascending, n);
        asc.set_churn_key(-1.0);
        let mut desc = MinHeapF64::new(&descending, n);
        desc.set_churn_key(-1.0);
        let (a, d) = (asc.churn_counted(), desc.churn_counted());
        assert!(
            (a - d).abs() < 0.35 * a,
            "churn must not move with input order: ascending {a} vs descending {d}"
        );
    }
    // ── Skip list: the ninth churn-vs-finite-difference regime, and the structure that
    //    reaches O(log n) without ever rebalancing.
    //
    // Its heights come from `mix_f64(key)` rather than a coin (see the `skip_list` module
    // doc), so every count below is deterministic and none of these assertions can flake.

    /// The churn-vs-finite-difference question, answered the way the **balanced BST**
    /// answers it: the finite-difference sum *overshoots* churn, and the two methods agree
    /// on the **class** rather than the constant. Churn's two keys sit just off either end
    /// of the key range, where a descent is cheap — running off the right-hand end costs no
    /// comparison at all, and the left-hand end fails its first inspection at every level —
    /// while `insert_fd` reflects the average key's full search path *and* `delete_fd` is
    /// added on top. Nothing here is about balance: the skip list never rebalances. It is
    /// the same end-vs-average asymmetry the trees have, in a structure that gets its shape
    /// from a hash.
    /// Measured: churn 22.5, insert_fd 22.0, delete_fd 13.2, sum 35.2 (~56% over).
    #[test]
    fn skip_list_finite_difference_sum_overshoots_churn() {
        let ks = shuffled(4000);
        let (n1, n2) = (2000usize, 4000usize); // wide span denoises the per-op estimate
        let insert_fd = (SkipListF64::build_insert_counted(&ks, n2)
            - SkipListF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (SkipListF64::teardown_counted(&ks, n2)
            - SkipListF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut s = SkipListF64::new(&ks, n2);
        s.set_churn_keys(-1.0, n2 as f64 + 1.0); // absent at both ends
        let churn = s.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) The overshoot: churn's end probes are cheaper than the build's average key.
        assert!(sum > churn, "skip list: expected fd sum {sum} > churn {churn} (the overshoot)");
        // (2) Both methods read O(log n): nowhere near a linear reading of 4000 keys.
        assert!(churn < 200.0, "skip-list churn {churn} must stay O(log n), far below n");
        assert!(sum < 200.0, "skip-list fd sum {sum} must stay O(log n), far below n");
        // (3) A churn pair leaves the list exactly as it found it.
        assert_eq!(s.len(), n2);
    }

    /// **The payoff, clock-free.** Reverse-sorted input is the input that turns a naive BST
    /// into an O(n) left chain (the headline demo, docs/PLAN.md §4.3). The skip list is
    /// built from the *same* keys and does not care: its node heights come from the keys'
    /// hashes, so the express lanes are identical however the keys arrived, and searching
    /// the far end costs O(log n). The AVL survives that input by *rotating*; the skip list
    /// survives it by never having had a shape to lose — the same outcome from opposite
    /// mechanisms, which is what earns it a place on the chart.
    #[test]
    fn skip_list_keeps_its_class_on_the_input_that_degenerates_a_bst() {
        let n = 2000usize;
        let descending: Vec<f64> = (0..n).map(|i| (n - 1 - i) as f64).collect();
        let min = 0.0; // the last key inserted, and the deepest one in the BST's chain

        let bst = BstF64::new(&descending, n);
        let skip = SkipListF64::new(&descending, n);

        let (bst_found, bst_ops) = bst.search_one_counted(min);
        let (skip_found, skip_ops) = skip.search_one_counted(min);
        assert!(bst_found && skip_found);
        assert_eq!(bst_ops, n as u64, "reverse-sorted BST search-min is O(n) — the full chain");
        assert!(skip_ops < 60, "skip-list search-min {skip_ops} must stay O(log n) ≪ {n}");

        // And the same key set built the other way round produces the same list, so the
        // number above is not a lucky ordering.
        let ascending: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let other = SkipListF64::new(&ascending, n);
        assert_eq!(other.search_one_counted(min), (true, skip_ops));
    }

    // ── Graph: a different kind of claim entirely. No churn / finite-difference here — the
    //    graph's operation *is* a whole traversal, size-preserving by nature. What the
    //    clock-free self-test pins instead is the exact cost identity and what the two
    //    sweeps can and cannot separate (docs/METHODOLOGY.md §2.7).

    /// A path `0–1–…–(n-1)` plus `chords` extra edges `(i, i + gap)` — connected by the path,
    /// with a controllable edge count. Deterministic, no RNG.
    fn connected_graph(n: usize, chords: &[(u32, u32)]) -> GraphAdj {
        let mut edges: Vec<u32> = Vec::new();
        for i in 0..n as u32 - 1 {
            edges.push(i);
            edges.push(i + 1);
        }
        for &(u, v) in chords {
            edges.push(u);
            edges.push(v);
        }
        GraphAdj::new(&edges, n)
    }

    /// **The headline, clock-free.** On a connected undirected graph a full traversal costs
    /// exactly `V + 2E` — `V` vertex-visits (each reached once) plus `2E` edge-visits (each
    /// edge examined from both ends) — and **BFS and DFS cost the same** while visiting in
    /// different orders. That exact identity is what the browser gate can only see as a noisy
    /// linear slope, so it lives here where the op-count is deterministic. This is also why
    /// the class is `O(V + E)` and not `O(E)`: the `V` term is a real, separately-counted cost,
    /// so an almost-edgeless graph still pays for its vertices.
    #[test]
    fn graph_traversal_costs_exactly_v_plus_2e_and_bfs_equals_dfs() {
        for &n in &[10usize, 100, 1000, 5000] {
            // A path (E = n − 1) and the path plus a few chords (still connected, more edges).
            let e_path = n - 1;
            let mut path = connected_graph(n, &[]);
            let (bfs_r, bfs_ops) = path.bfs_counted_from(0);
            let (dfs_r, dfs_ops) = path.dfs_counted_from(0);
            let expected = (n + 2 * e_path) as u64;
            assert_eq!(bfs_ops, expected, "path n={n}: BFS must be V + 2E");
            assert_eq!(dfs_ops, expected, "path n={n}: DFS must be the same V + 2E");
            assert_eq!(bfs_r, n, "BFS reaches every vertex of a connected graph");
            assert_eq!(dfs_r, n, "DFS reaches every vertex of a connected graph");

            // Add three chords: E = n − 1 + 3, so the count rises by exactly 2·3.
            let chords = [(0, (n / 2) as u32), (1, (n / 3) as u32), (2, (n - 1) as u32)];
            let mut denser = connected_graph(n, &chords);
            let (_, denser_ops) = denser.bfs_counted_from(0);
            assert_eq!(
                denser_ops,
                (n + 2 * (e_path + 3)) as u64,
                "n={n}: three chords add exactly 2·3 edge-visits"
            );
        }
    }

    /// **Why the design needs two sweeps** (docs/METHODOLOGY.md §2.7 — the reason the browser
    /// gate *will* run a V-sweep *and* a degree-sweep, once the measured half lands). A
    /// traversal's cost is `V + 2E`. If you sweep
    /// `V` at a *fixed average degree* `d`, then `E = dV/2` and the cost is `V + dV = (1 + d)V`
    /// — linear in `V`, but that single sweep **cannot tell `O(V)` from `O(V + E)`**, because
    /// both terms move together. Only holding `V` fixed and growing the degree isolates the
    /// `+E` term: there the cost moves by *exactly* `2` per added edge while `V` contributes a
    /// constant. This test pins both halves of that argument on deterministic op-counts.
    #[test]
    fn graph_plus_e_term_is_only_visible_when_degree_grows_at_fixed_v() {
        let n = 2000usize;

        // (a) Fixed V, growing E: the count is V + 2E, moving by exactly 2 per edge, so a
        //     degree-sweep sees the +E term directly.
        let base = connected_graph(n, &[]); // E = n − 1
        let base_e = n - 1;
        let mut g0 = base;
        let (_, ops0) = g0.bfs_counted_from(0);
        // Add 500 distinct chords (all within a connected path, so still connected).
        let chords: Vec<(u32, u32)> =
            (0..500u32).map(|k| (k, (k + (n as u32 / 4)) % n as u32)).collect();
        let mut g1 = connected_graph(n, &chords);
        let (_, ops1) = g1.bfs_counted_from(0);
        assert_eq!(ops0, (n + 2 * base_e) as u64);
        assert_eq!(ops1, (n + 2 * (base_e + 500)) as u64);
        assert_eq!(ops1 - ops0, 2 * 500, "each added edge is exactly two edge-visits");

        // (b) A V-sweep at fixed average degree cannot separate the terms: doubling V at the
        //     same degree simply doubles the cost, indistinguishable from a pure O(V) structure.
        //     A path has average degree ≈ 2 (E ≈ V); the cost (1 + ~2)V is just linear in V.
        let mut small = connected_graph(1000, &[]);
        let mut big = connected_graph(2000, &[]);
        let (_, small_ops) = small.bfs_counted_from(0);
        let (_, big_ops) = big.bfs_counted_from(0);
        // 2·V at the same shape ⇒ ≈ 2× the cost — a straight line, no way to read out the E term.
        let ratio = big_ops as f64 / small_ops as f64;
        assert!(
            (ratio - 2.0).abs() < 0.01,
            "doubling V at fixed degree just doubles the cost (ratio {ratio}) — a V-sweep alone \
             can't separate O(V) from O(V+E)"
        );
    }

    // ── Doubly linked list (docs/METHODOLOGY.md §2.11): regime 7 again, and a second pointer
    // that buys nothing on the canonical op set.
    //
    // The doubly list differs from the singly list by one `prev` link per node. On insert /
    // search / delete-by-key that link is only ever *written* — no walk reads it — and the one
    // place it shortens work (the splice after a delete's find) carries no node-visit on either
    // list. So the claim to pin is not "close": it is **equal**, op-count for op-count, on the
    // same sequences, across every signal the Compare sweeps read (search, churn, the cumulative
    // build and the cumulative teardown). If these ever differ, the twins have drifted apart or
    // the doubly list has started using `prev` in a way the op set does not allow (the trap:
    // unlinking the tail through its handle in the teardown, which reads O(1) and erases the
    // class disagreement the singly list is honest about).

    /// The doubly list's every op-count signal equals the singly list's, at several sizes and on
    /// both a sorted and a shuffled build — and the regime-7 class disagreement holds for it
    /// exactly as for the singly list (churn 1 visit, finite-difference delete ≈ 3n/4).
    #[test]
    fn doubly_linked_list_buys_nothing_on_the_canonical_op_set() {
        use super::doubly_linked_list::DoublyLinkedListF64 as Dll;

        for ks in [keys(4000), shuffled(4000)] {
            for n in [250usize, 1000, 2000, 4000] {
                // Search: the Compare workload's shape — present keys spread through the prefix
                // plus a block just past the max.
                let max = ks[..n].iter().cloned().fold(f64::MIN, f64::max);
                let probes: Vec<f64> = (0..64)
                    .map(|i| ks[i * n / 64])
                    .chain((0..64).map(|i| max + 1.0 + i as f64))
                    .collect();
                let mut d = Dll::new(&ks, n);
                let mut s = LinkedListF64::new(&ks, n);
                d.set_probes(&probes);
                s.set_probes(&probes);
                assert_eq!(d.search_counted(), s.search_counted(), "search ops at n {n}");

                // Churn: the engine's `max + 1` key, identical on both, and exactly 1.
                d.set_churn_key(max + 1.0);
                s.set_churn_key(max + 1.0);
                assert_eq!(d.churn_counted(), s.churn_counted(), "churn ops at n {n}");
                assert_eq!(d.churn_counted(), 1.0);

                // Cumulative build and teardown — what the finite-difference split differences.
                assert_eq!(Dll::build_insert_counted(&ks, n), LinkedListF64::build_insert_counted(&ks, n));
                assert_eq!(Dll::teardown_counted(&ks, n), LinkedListF64::teardown_counted(&ks, n));
                // Distinct keys, tail by value: Σ_{i=1..n} i, a full walk each — not 0, which a
                // tail-handle unlink would have reported.
                assert_eq!(Dll::teardown_counted(&ks, n), (n * (n + 1) / 2) as f64, "teardown at n {n}");
            }
        }

        // Regime 7 for the doubly list, the singly test's numbers verbatim.
        let ks = keys(4000);
        let (n1, n2) = (2000usize, 4000usize);
        let insert_fd = (Dll::build_insert_counted(&ks, n2) - Dll::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (Dll::teardown_counted(&ks, n2) - Dll::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;
        let mut l = Dll::new(&ks, n2);
        l.set_churn_key(n2 as f64 + 1.0);
        let churn = l.churn_counted();
        assert_eq!(insert_fd, 0.0, "head insert is O(1) on the doubly list too");
        assert_eq!(churn, 1.0, "doubly-list churn is O(1) for the singly list's reason");
        assert!(delete_fd > n2 as f64 / 2.0 && delete_fd < n2 as f64, "delete_fd {delete_fd} ≈ 3n/4");
        assert!(insert_fd + delete_fd > churn * 100.0, "the class disagreement survives the second pointer");
    }

    // ── Red-black tree vs AVL: the balancing-scheme comparison (docs/PLAN.md §13,
    //    docs/METHODOLOGY.md §2.9).
    //
    // The textbook trade: the red-black tree accepts a looser height bound
    // (≤ 2·log₂(n+1) against the AVL's ≈ 1.44·log₂ n) in exchange for **at most two
    // rotations per insert and three per delete**, where an AVL delete may rotate at every
    // level. The expected finding is "fewer rotations, slightly more comparisons". These
    // tests measure it on the same key sequences the AVL is measured on — shuffled,
    // ascending, descending — and pin what the op-counts *actually* say, which is narrower
    // than the slogan (each test's doc gives the measured numbers).
    //
    // **Splitting the AVL's single op-count into comparisons and rotations** needs no change
    // to `avl.rs`. For *distinct* keys, an insert descends exactly the path a failed search
    // for that key takes in the tree as it stood just before the insert, and a delete's find
    // phase stops at exactly the node a search stops at. So per operation:
    // `rotations = op-count − search_one_counted(key)` with the search taken first. Every
    // sequence below is a permutation of distinct keys, which is what keeps that valid.

    use super::rbt::{Cost, RbtF64};

    /// Per-operation tallies for one sequence of operations on one tree.
    #[derive(Default)]
    struct Tally {
        comparisons: u64,
        rotations: u64,
        recolours: u64,
        max_rotations: u64,
    }

    impl Tally {
        fn push(&mut self, comparisons: u64, rotations: u64, recolours: u64) {
            self.comparisons += comparisons;
            self.rotations += rotations;
            self.recolours += recolours;
            self.max_rotations = self.max_rotations.max(rotations);
        }
        fn push_rbt(&mut self, c: Cost) {
            self.push(c.comparisons, c.rotations, c.recolours);
        }
    }

    fn avl_build_tally(keys: &[f64]) -> (AvlF64, Tally) {
        let mut t = AvlF64::new_empty();
        let mut tally = Tally::default();
        for &k in keys {
            let (_, cmp) = t.search_one_counted(k); // the descent the insert is about to take
            let ops = t.insert_one_counted(k);
            tally.push(cmp, ops - cmp, 0);
        }
        (t, tally)
    }

    fn rbt_build_tally(keys: &[f64]) -> (RbtF64, Tally) {
        let mut t = RbtF64::new_empty();
        let mut tally = Tally::default();
        for &k in keys {
            tally.push_rbt(t.insert_one_detail(k));
        }
        (t, tally)
    }

    fn avl_delete_tally(t: &mut AvlF64, order: &[f64]) -> Tally {
        let mut tally = Tally::default();
        for &k in order {
            let (_, cmp) = t.search_one_counted(k); // the find phase the delete is about to take
            let (removed, ops) = t.delete_one_counted(k);
            assert!(removed, "every key in the order is stored");
            tally.push(cmp, ops - cmp, 0);
        }
        tally
    }

    fn rbt_delete_tally(t: &mut RbtF64, order: &[f64]) -> Tally {
        let mut tally = Tally::default();
        for &k in order {
            let (removed, c) = t.delete_one_detail(k);
            assert!(removed, "every key in the order is stored");
            tally.push_rbt(c);
        }
        tally
    }

    /// The engine's teardown order on distinct keys: current maximum, current minimum, in
    /// turn — computed from the sorted keys, so both trees get the identical sequence.
    fn alternating_extremes(keys: &[f64]) -> Vec<f64> {
        let mut sorted = keys.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let (mut lo, mut hi) = (0usize, sorted.len());
        let mut out = Vec::with_capacity(sorted.len());
        let mut take_hi = true;
        while lo < hi {
            if take_hi {
                hi -= 1;
                out.push(sorted[hi]);
            } else {
                out.push(sorted[lo]);
                lo += 1;
            }
            take_hi = !take_hi;
        }
        out
    }

    fn three_orders(n: usize) -> [(&'static str, Vec<f64>); 3] {
        [
            ("shuffled", shuffled(n)),
            ("ascending", keys(n)),
            ("descending", (0..n).map(|i| (n - 1 - i) as f64).collect()),
        ]
    }

    /// **The guarantee that holds, and the AVL breaking it on the same data.** On every
    /// single operation of every sequence — build, alternating teardown, and a deletion in
    /// an unrelated order, on shuffled, ascending and descending keys — the red-black tree
    /// rotates at most **twice** on an insert and **three times** on a delete. The AVL, on
    /// the same shuffled teardown, needed **ten** rotations for one delete (measured; the
    /// deletion in random order peaked at six), because its retrace can rebalance at every
    /// level on the way back up. This is the claim the slogan "fewer rotations" is really
    /// about: a bound on the *worst single operation*, not on the total (see the next test).
    #[test]
    fn rbt_bounds_rotations_per_operation_where_the_avl_does_not() {
        let n = 4000usize;
        for (name, ks) in three_orders(n) {
            let (mut t, build) = rbt_build_tally(&ks);
            assert!(build.max_rotations <= 2, "{name}: an RB insert rotated {} times", build.max_rotations);
            let teardown = rbt_delete_tally(&mut t, &alternating_extremes(&ks));
            assert!(teardown.max_rotations <= 3, "{name}: an RB delete rotated {} times", teardown.max_rotations);
            let mut t = RbtF64::new(&ks, n);
            let random = rbt_delete_tally(&mut t, &shuffled(n).iter().rev().copied().collect::<Vec<_>>());
            assert!(random.max_rotations <= 3, "{name}: an RB delete rotated {} times", random.max_rotations);
            assert!(t.is_empty() && t.check_rb());
        }
        // The AVL on the identical shuffled teardown: one delete rotates more than an RB
        // delete ever may. Measured: 10.
        let ks = shuffled(n);
        let mut avl = AvlF64::new(&ks, n);
        let avl_teardown = avl_delete_tally(&mut avl, &alternating_extremes(&ks));
        assert!(
            avl_teardown.max_rotations > 3,
            "AVL's worst teardown delete rotated {} times — expected past the RB bound of 3",
            avl_teardown.max_rotations
        );
    }

    /// **What the totals say — narrower than the slogan.** On *shuffled* inserts the
    /// red-black tree does clearly fewer rotations than the AVL (measured 2311 vs 2830 at
    /// n = 4000, 0.58 vs 0.71 per insert, ~18 % fewer) at essentially the same comparisons
    /// (43 122 vs 43 069, +0.1 %) — but it **recolours** 9223 times on the way, four times
    /// as often as it rotates, a cost the shared metric deliberately does not count (the
    /// AVL's height updates are not counted either). On *sorted* inserts the rotation totals
    /// are **the same** (3979 vs 3988 — about one per insert for both), and on deletes the
    /// totals are within a few percent, the red-black tree's slightly *higher* (2690 vs 2761
    /// on the shuffled teardown, 1501 vs 1466 deleting in random order). So "fewer
    /// rotations" is a per-operation bound (previous test) plus a random-insert effect, not
    /// a property of every total.
    #[test]
    fn rbt_rotates_less_on_random_inserts_and_about_as_much_everywhere_else() {
        let n = 4000usize;
        let ks = shuffled(n);
        let (_, avl) = avl_build_tally(&ks);
        let (_, rbt) = rbt_build_tally(&ks);
        assert!(
            (rbt.rotations as f64) < 0.9 * avl.rotations as f64,
            "shuffled build: RB rotations {} should be clearly below AVL {}",
            rbt.rotations,
            avl.rotations
        );
        let cmp_gap = (rbt.comparisons as f64 - avl.comparisons as f64).abs() / avl.comparisons as f64;
        assert!(cmp_gap < 0.02, "shuffled build: comparisons within 2 % ({} vs {})", rbt.comparisons, avl.comparisons);
        assert!(rbt.recolours > 2 * rbt.rotations, "RB recolours {} dwarf its rotations {}", rbt.recolours, rbt.rotations);

        // Sorted inserts: one rotation per insert for both schemes, give or take.
        let (_, avl_sorted) = avl_build_tally(&keys(n));
        let (_, rbt_sorted) = rbt_build_tally(&keys(n));
        let rot_gap = (rbt_sorted.rotations as f64 - avl_sorted.rotations as f64).abs() / avl_sorted.rotations as f64;
        assert!(rot_gap < 0.02, "sorted build: rotations within 2 % ({} vs {})", rbt_sorted.rotations, avl_sorted.rotations);

        // Deletes: totals within 15 % either way — no scheme-level saving in the totals.
        let mut a = AvlF64::new(&ks, n);
        let mut r = RbtF64::new(&ks, n);
        let order = alternating_extremes(&ks);
        let (ad, rd) = (avl_delete_tally(&mut a, &order), rbt_delete_tally(&mut r, &order));
        let del_gap = (rd.rotations as f64 - ad.rotations as f64).abs() / ad.rotations as f64;
        assert!(del_gap < 0.15, "teardown rotations within 15 % ({} vs {})", rd.rotations, ad.rotations);
    }

    /// **"Slightly more comparisons" — true where it was predicted, and larger than
    /// "slightly" on sorted input.** Shuffled: the two trees end up the same height (15) and
    /// within 0.4 % on internal path length, so a search costs the same. Ascending (and,
    /// mirrored, descending): the AVL builds a near-perfect tree (height 12) while the
    /// red-black tree's height reaches 21 — inside its 2·log₂(n+1) ≈ 23.9 bound, but the
    /// long path is exactly the spine sorted input keeps inserting down, so the sorted
    /// **build** costs the red-black tree 68 % more comparisons (73 809 vs 43 905). The
    /// finished tree is still nearly as good to *search* as the AVL's: internal path length
    /// only 3.8 % higher (45 586 vs 43 917). Both stay O(log n) — this is a constant, not a
    /// class — and it is why the RB churn line sits above the AVL's on sorted data.
    #[test]
    fn rbt_pays_its_looser_bound_in_comparisons_on_sorted_input() {
        let n = 4000usize;
        let bound = 2.0 * ((n + 1) as f64).log2();
        for (name, ks) in three_orders(n) {
            let (avl_tree, avl) = avl_build_tally(&ks);
            let (rbt_tree, rbt) = rbt_build_tally(&ks);
            assert!(rbt_tree.check_rb() && avl_tree.check_balanced());
            assert!((rbt_tree.tree_height() as f64) <= bound, "{name}: RB height within 2·log₂(n+1)");
            assert!(rbt_tree.tree_height() >= avl_tree.tree_height(), "{name}: RB never shallower here");
            // Average search cost = internal path length / n; for the AVL, the per-key search
            // count summed over the stored (distinct) keys is that same number.
            let avl_ipl: u64 = ks.iter().map(|&k| avl_tree.search_one_counted(k).1).sum();
            let rbt_ipl = rbt_tree.internal_path_length();
            let ipl_gap = (rbt_ipl as f64 - avl_ipl as f64) / avl_ipl as f64;
            assert!(ipl_gap >= 0.0 && ipl_gap < 0.06, "{name}: RB average search within 6 % above AVL ({ipl_gap})");
            if name != "shuffled" {
                assert!(
                    rbt_tree.tree_height() as f64 >= 1.5 * avl_tree.tree_height() as f64,
                    "{name}: RB height {} vs AVL {}",
                    rbt_tree.tree_height(),
                    avl_tree.tree_height()
                );
                assert!(
                    rbt.comparisons as f64 > 1.5 * avl.comparisons as f64,
                    "{name}: sorted build costs RB {} comparisons vs AVL {}",
                    rbt.comparisons,
                    avl.comparisons
                );
            }
        }
    }

    /// The **tenth churn-vs-finite-difference regime** (docs/METHODOLOGY.md §2.3). The AVL's
    /// direction again — churn above the sum, because churn's keys ride the spines while the
    /// build inserts at average depth — but twice as wide: measured churn 27, insert_fd 12.40,
    /// delete_fd 9.81, sum 22.21 (~18 % under churn, against the AVL's ~10 %). The looser
    /// height bound is exactly what widens it: an RB tree's spines can run longer than its
    /// average path by more than an AVL's can. Class agreement holds (both O(log n)).
    #[test]
    fn rbt_churn_exceeds_finite_difference_sum_like_the_avl_but_wider() {
        let ks = shuffled(4000);
        let (n1, n2) = (2000usize, 4000usize);
        let insert_fd = (RbtF64::build_insert_counted(&ks, n2) - RbtF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (RbtF64::teardown_counted(&ks, n2) - RbtF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;
        let mut t = RbtF64::new(&ks, n2);
        t.set_churn_keys(-1.0, n2 as f64 + 1.0);
        let churn = t.churn_counted();
        let sum = insert_fd + delete_fd;
        assert!(churn >= sum, "RB churn {churn} should be ≥ fd sum {sum} (spine probe)");
        let rel = (churn - sum) / churn;
        assert!(rel < 0.25, "RB churn {churn} vs fd sum {sum}: same class, rel {rel}");
        assert!(churn < 80.0 && sum < 80.0, "RB churn {churn} / sum {sum} must stay O(log n)");
        assert_eq!(t.len(), n2);
        assert!(t.check_rb());
    }

    /// **The red-black tree on the input that degenerates a BST.** Reverse-sorted keys build
    /// the naive BST into an O(n) left chain; the red-black tree built from the same keys
    /// searches the far end within its 2·log₂(n+1) bound (measured 19 against the AVL's 11
    /// and the BST's 2000), and its two-key churn stays O(log n) (measured 30 vs the AVL's
    /// 23). It rotates, like the AVL — the difference between the two is a constant, the
    /// difference from the BST is a class.
    #[test]
    fn rbt_keeps_its_class_on_the_input_that_degenerates_a_bst() {
        let n = 2000usize;
        let descending: Vec<f64> = (0..n).map(|i| (n - 1 - i) as f64).collect();
        let bst = BstF64::new(&descending, n);
        let rbt = RbtF64::new(&descending, n);
        let avl = AvlF64::new(&descending, n);
        let (bst_found, bst_ops) = bst.search_one_counted(0.0);
        let (rbt_found, rbt_ops) = rbt.search_one_counted(0.0);
        let (avl_found, avl_ops) = avl.search_one_counted(0.0);
        assert!(bst_found && rbt_found && avl_found);
        assert_eq!(bst_ops, n as u64, "reverse-sorted BST search-min is the full chain");
        let bound = 2.0 * ((n + 1) as f64).log2();
        assert!((rbt_ops as f64) <= bound, "RB search-min {rbt_ops} within 2·log₂(n+1) ≈ {bound:.1}");
        assert!(rbt_ops >= avl_ops, "RB {rbt_ops} vs AVL {avl_ops}: the looser bound shows at the spine");

        let mut r = RbtF64::new(&descending, n);
        r.set_churn_keys(-1.0, n as f64);
        let churn = r.churn_counted();
        assert!(churn < 60.0, "reverse-sorted RB churn {churn} must stay O(log n) ≪ {n}");
        assert_eq!(r.len(), n);
    }

    // ── Open-addressing hash set (docs/METHODOLOGY.md §2.8): the second hash set, held to
    //    the chaining one's hash, start size, threshold and doubling so that the only thing
    //    that differs between the two curves is where a colliding key goes.

    /// Mean (hashes + slot probes) over `queries` for both hash sets at size `n`.
    fn hash_pair_means(
        ks: &[f64],
        n: usize,
        queries: &[f64],
    ) -> (f64, f64) {
        use super::hash_set_oa::HashSetOaF64;
        let oa = HashSetOaF64::new(ks, n);
        let ch = HashSetF64::new(ks, n);
        let m = queries.len() as f64;
        let oa_ops: u64 = queries.iter().map(|&q| oa.search_one_counted(q).1).sum();
        let ch_ops: u64 = queries.iter().map(|&q| ch.search_one_counted(q).1).sum();
        (oa_ops as f64 / m, ch_ops as f64 / m)
    }

    /// **Primary clustering, clock-free.** At the *same* load factor α — guaranteed, since
    /// both tables grow at the same points — a linearly-probed miss costs what Knuth's
    /// analysis says, ½(1 + 1/(1−α)²) on this metric (his count includes the final empty
    /// slot, which this one does not charge, and the hash tick puts the one back), while a
    /// chained miss costs 1 + α. Hits: 1 + ½(1 + 1/(1−α)) against 1 + 1 + α/2. The gap is the
    /// price of keys from *neighbouring* homes piling into one run, and it widens fast with α:
    /// the reason this table's 0.75 ceiling is a real decision (§2.8), not a default.
    /// Measured at α ≈ 0.61 (n = 5000, 8192 slots): miss 3.66 vs Knuth 3.79 (chaining 1.61);
    /// hit 2.82 vs Knuth 2.78 (chaining 2.32). At α ≈ 0.73 (n = 3000): miss 7.70 vs Knuth
    /// 7.48 (chaining 1.72) — a 4.5× gap on the same hash and the same table size.
    #[test]
    fn open_addressing_probe_counts_follow_knuths_clustering_formulas() {
        use super::hash_set_oa::HashSetOaF64;
        let ks = shuffled(20_000);
        for n in [3_000usize, 5_000, 12_000] {
            let cap = HashSetOaF64::new(&ks, n).capacity() as f64;
            let alpha = n as f64 / cap;
            let absent: Vec<f64> = (0..20_000).map(|i| 1e6 + i as f64).collect();
            let present: Vec<f64> = ks[..n].to_vec();
            let (oa_miss, ch_miss) = hash_pair_means(&ks, n, &absent);
            let (oa_hit, ch_hit) = hash_pair_means(&ks, n, &present);
            let knuth_miss = 0.5 * (1.0 + 1.0 / ((1.0 - alpha) * (1.0 - alpha)));
            let knuth_hit = 1.0 + 0.5 * (1.0 + 1.0 / (1.0 - alpha));
            assert!(
                (oa_miss - knuth_miss).abs() / knuth_miss < 0.15,
                "n={n} α={alpha:.3}: OA miss {oa_miss:.2} vs Knuth {knuth_miss:.2}"
            );
            assert!(
                (oa_hit - knuth_hit).abs() / knuth_hit < 0.10,
                "n={n} α={alpha:.3}: OA hit {oa_hit:.2} vs Knuth {knuth_hit:.2}"
            );
            // Chaining at the same α: a miss walks one chain of expected length α.
            assert!((ch_miss - (1.0 + alpha)).abs() < 0.1, "n={n}: chained miss {ch_miss:.2}");
            // The clustering price: same hash, same α, more probes — for a miss most of all.
            assert!(oa_miss > ch_miss && oa_hit > ch_hit, "n={n}: OA must probe more");
            assert!(oa_miss / ch_miss > oa_hit / ch_hit, "n={n}: misses pay the most");
        }
    }

    /// **The sawtooth, and why it is not a slope.** A doubling table's load factor swings
    /// between ~0.38 and 0.75 as n climbs a geometric ladder, so the probe count of *both*
    /// hash sets saws up and down — but linear probing's miss cost is far more sensitive to α
    /// than chaining's, so its saw is louder. Neither has a trend in n: over the browser's
    /// own search ladder (10 … 100 000) and probe mix (64 present + 64 above-max absent),
    /// the fitted log-log slope stays near zero for both. The UI's flat-line claim for this
    /// structure therefore rests on this test plus the gate's slope band, not on the fitter's
    /// label, which a loud saw can wobble.
    /// Measured: OA 2.02 … 3.89 per probe (a 1.92× swing), chaining 1.62 … 2.05 (1.27×);
    /// log-log slopes 0.013 and 0.012.
    #[test]
    fn open_addressing_search_saws_with_the_load_factor_but_has_no_trend_in_n() {
        use super::hash_set_oa::HashSetOaF64;
        let ks: Vec<f64> = shuffled(100_000).iter().map(|k| k * 7.0 + 3.0).collect();
        let ladder = [10usize, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];
        let mut oa_pts = Vec::new();
        let mut ch_pts = Vec::new();
        for &n in &ladder {
            let max = ks[..n].iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let present = 64.min(n);
            let mut probes: Vec<f64> = (0..present).map(|i| ks[i * n / present]).collect();
            probes.extend((0..64).map(|i| max + 1.0 + i as f64));
            let mut oa = HashSetOaF64::new(&ks, n);
            let mut ch = HashSetF64::new(&ks, n);
            oa.set_probes(&probes);
            ch.set_probes(&probes);
            oa_pts.push(oa.search_counted() / probes.len() as f64);
            ch_pts.push(ch.search_counted() / probes.len() as f64);
        }
        let slope = |ys: &[f64]| -> f64 {
            let xs: Vec<f64> = ladder.iter().map(|&n| (n as f64).ln()).collect();
            let ly: Vec<f64> = ys.iter().map(|y| y.ln()).collect();
            let (mx, my) = (xs.iter().sum::<f64>() / xs.len() as f64, ly.iter().sum::<f64>() / ly.len() as f64);
            let cov: f64 = xs.iter().zip(&ly).map(|(x, y)| (x - mx) * (y - my)).sum();
            let var: f64 = xs.iter().map(|x| (x - mx) * (x - mx)).sum();
            cov / var
        };
        let swing = |ys: &[f64]| {
            ys.iter().copied().fold(f64::MIN, f64::max) / ys.iter().copied().fold(f64::MAX, f64::min)
        };
        let (oa_slope, ch_slope) = (slope(&oa_pts), slope(&ch_pts));
        assert!(oa_slope.abs() < 0.1, "OA search slope {oa_slope:.3} must be trendless: {oa_pts:?}");
        assert!(ch_slope.abs() < 0.1, "chained search slope {ch_slope:.3}: {ch_pts:?}");
        assert!(
            swing(&oa_pts) > swing(&ch_pts),
            "linear probing saws louder with α ({:.2}x) than chaining ({:.2}x)",
            swing(&oa_pts),
            swing(&ch_pts)
        );
        assert!(swing(&oa_pts) < 2.5, "but stays bounded: {oa_pts:?}");
    }

    /// The **twelfth churn-vs-finite-difference regime**, and the one whose overshoot is the
    /// tombstone policy rather than a key position. Churn's insert is a *miss* walk, and its
    /// delete a hit — the same two walks the finite-difference build (every insert is a new
    /// key) and teardown (every delete finds its key) average. So on a fresh table the two
    /// methods agree; what churn adds is **its own tombstone**. A tombstone never reverts to
    /// empty, so after priming the churn key's slot stays occupied for good: it bridges the
    /// key's run to whatever run follows, and every later insert walks the merged run to the
    /// next empty slot before reusing the tombstone. Churn therefore overshoots the FD sum,
    /// by what an *unprimed* first pair — no tombstone yet — does not pay. Averaged over 64
    /// tables (each churning its own 16-key block, the sweep's recipe) at n = 4000 so one
    /// cluster cannot decide the result (§2.8).
    /// Measured: insert_fd 3.54, delete_fd 2.52, sum 6.06; unprimed single pair 5.81; primed
    /// (the churn the sweep reports) 7.69 — a ~27% overshoot of the sum, which the unprimed
    /// pair shows is the tombstones' doing. The sweep's own single table (block from
    /// `n + 1`) reads 5.38 here: one table is still a sample. Against the chaining set's churn
    /// on the same 64 keys (3.94), the OA line sits higher for two roughly equal reasons:
    /// clustering (+1.87, chained → unprimed) and the tombstones (+1.88). Straddle check: OA's
    /// 1500 → 1600 marginal delete is −10.77 where the chaining set's is +2.00.
    #[test]
    fn open_addressing_churn_overshoots_finite_differences_by_its_own_tombstone() {
        use super::hash_set_oa::HashSetOaF64;
        let ks = keys(4000);
        // Equal-α endpoints (both tables at 2000/4096 = 4000/8192 ≈ 0.49), as on the browser's
        // doubling mutation ladder; see the straddle check at the end for why that matters.
        let (n1, n2) = (2000usize, 4000usize);
        let insert_fd = (HashSetOaF64::build_insert_counted(&ks, n2)
            - HashSetOaF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (HashSetOaF64::teardown_counted(&ks, n2)
            - HashSetOaF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;
        let sum = insert_fd + delete_fd;

        let (mut primed, mut unprimed, mut chained) = (0.0, 0.0, 0.0);
        let block = 64;
        for j in 0..block {
            let key = 1e6 + j as f64; // absent (each table is independent)
            let mut ch = HashSetF64::new(&ks, n2);
            ch.set_churn_key(key);
            chained += ch.churn_counted();
            let mut fresh = HashSetOaF64::new(&ks, n2);
            let (_, ins) = fresh.insert_one_counted(key);
            let (_, del) = fresh.delete_one_counted(key);
            unprimed += (ins + del) as f64;
            let mut s = HashSetOaF64::new(&ks, n2);
            s.set_churn_key(key);
            primed += s.churn_counted();
            assert_eq!(s.len(), n2);
        }
        let (primed, unprimed) = (primed / block as f64, unprimed / block as f64);
        let chained = chained / block as f64;
        // (0) Against the chaining set on the same keys and table size, the gap has two
        //     parts of about the same size here: clustering (chained → unprimed) and the
        //     tombstones (unprimed → primed). This is what the churn chart's copy says.
        assert!(chained < unprimed && unprimed < primed, "{chained:.2} < {unprimed:.2} < {primed:.2}");
        let (clustering, tombstones) = (unprimed - chained, primed - unprimed);
        assert!(
            clustering > 0.5 * tombstones && tombstones > 0.5 * clustering,
            "two comparable causes: clustering {clustering:.2}, tombstones {tombstones:.2}"
        );

        // (1) Before any tombstone exists, churn and the FD sum measure the same two walks.
        assert!((unprimed - sum).abs() / sum < 0.15, "unprimed {unprimed:.2} vs fd sum {sum:.2}");
        // (2) The steady state pays for the tombstone the churn key leaves behind.
        assert!(primed > unprimed, "primed {primed:.2} must exceed unprimed {unprimed:.2}");
        assert!(primed > sum, "churn {primed:.2} overshoots the fd sum {sum:.2}");
        // (3) A constant overshoot, not a class: everything stays O(1), nowhere near n.
        assert!(primed < 3.0 * sum && primed < 20.0, "churn {primed:.2} must stay O(1)");

        // (4) Why the endpoints are chosen at equal α. The chaining row differences 1500 →
        //     1600, which here straddles a doubling (2048 → 4096 slots): every stored key's walk
        //     shortens at once, the n = 1600 teardown is *cheaper in total* than the n = 1500
        //     one, and the "marginal delete" comes out negative. A finite difference of a
        //     doubling table is a marginal cost only between equal load factors.
        let straddle = (HashSetOaF64::teardown_counted(&ks, 1600)
            - HashSetOaF64::teardown_counted(&ks, 1500))
            / 100.0;
        assert!(straddle < 0.0, "across a rehash the marginal delete reads {straddle:.2}");
        // Chaining crosses the same doubling without going negative: its hit cost barely
        // depends on α (1 + 1 + α/2), linear probing's is steep in it (Knuth, above).
        let chained = (HashSetF64::teardown_counted(&ks, 1600)
            - HashSetF64::teardown_counted(&ks, 1500))
            / 100.0;
        assert!(chained > 0.0, "the chaining set's straddle {chained:.2} stays positive");
    }
}
