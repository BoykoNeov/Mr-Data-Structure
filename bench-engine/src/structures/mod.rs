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
//! `linked_list::LinkedListF64` closes the Linear family — the bench twin of *both*
//! `src/structures/linkedList.ts` teaching twins (singly and doubly are bench-identical
//! under the **node-visit** cost metric), an index arena with O(1) head insert and O(n)
//! search/delete, pinned by `conformance/corpus-ll.txt`. `heap::MinHeapF64` closes the
//! Trees/heaps family — the bench twin of `src/structures/heap.ts`, an array-backed complete
//! tree (cost metric **comparisons + swaps**) pinned by `conformance/corpus-heap.txt`. It is
//! the one structure with a **different op set** (insert / peek / extract-min, with search as
//! a deliberate O(n) scan contrast), so it is compared only within its own group
//! (docs/PLAN.md §8, risk R6) — a separation enforced in the UI, not here.

pub mod avl;
pub mod bst;
pub mod dyn_array;
pub mod dyn_array_str;
pub mod hash_set;
pub mod hash_set_str;
pub mod heap;
pub mod linked_list;
pub mod sorted_array;

#[cfg(test)]
mod conformance;

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
    use super::hash_set::HashSetF64;
    use super::heap::MinHeapF64;
    use super::linked_list::LinkedListF64;
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
}
