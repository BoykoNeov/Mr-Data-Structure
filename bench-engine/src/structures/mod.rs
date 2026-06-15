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
//! pinned to it by the `conformance/corpus-bst.txt` corpus.

pub mod bst;
pub mod dyn_array;
pub mod dyn_array_str;
pub mod hash_set;
pub mod hash_set_str;

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
    use super::bst::BstF64;
    use super::dyn_array::ArrayF64;
    use super::hash_set::HashSetF64;

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
    // is a free append; any delete is O(n)). A tree breaks that symmetry: churn's key
    // (`max + 1`) rides the **right spine** (depth ≈ ln n random / n sorted), while the
    // build inserts dataset keys at their **average depth** (≈ 2 ln n random / n sorted).
    // So the answer is regime-dependent, and the slice owns reporting *both* halves.

    /// Sorted input ⇒ the degenerate right **chain** (the headline demo, and a stack-safety
    /// exercise). On a chain the right spine *is* the whole tree, so churn's probe costs the
    /// same as the marginal insert/delete — the array-like regime where the identity holds
    /// **tight**, exactly like `array_churn_matches_finite_differences`.
    #[test]
    fn bst_chain_churn_matches_finite_differences() {
        let ks = keys(1001); // 0..1000, ascending ⇒ right chain
        let (n1, n2) = (999usize, 1000usize);
        let insert_fd = (BstF64::build_insert_counted(&ks, n2)
            - BstF64::build_insert_counted(&ks, n1))
            / (n2 - n1) as f64;
        let delete_fd = (BstF64::teardown_counted(&ks, n2) - BstF64::teardown_counted(&ks, n1))
            / (n2 - n1) as f64;

        let mut t = BstF64::new(&ks, n2);
        t.set_churn_key(n2 as f64 + 1.0); // absent, > all keys ⇒ descends the full chain
        let churn = t.churn_counted();

        // insert_fd = 999 (depth of the 1000th key), delete_fd = 1000 (delete-max find),
        // churn = 2001 — agreement to within ~0.1%.
        let rel = (churn - (insert_fd + delete_fd)).abs() / churn;
        assert!(rel < 0.05, "chain churn {churn} vs fd sum {} (rel {rel})", insert_fd + delete_fd);
    }

    /// Shuffled input ⇒ a **balanced** random tree. Here the array identity **fails**: the
    /// finite-difference sum *overshoots* churn, because churn probes only the cheap right
    /// spine (≈ 2 ln n round-trip) while insert_fd alone already reflects the average key
    /// depth (≈ 2 ln n) and delete_fd (≈ ln n) is added on top. The two methods agree only
    /// in **complexity class** (both O(log n) ≪ n), not in constant — the honest finding
    /// (docs/PLAN.md §2.3, §6.3). Op-counts are deterministic (fixed-seed `shuffled`), so
    /// the wide-margin inequalities below never flake.
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
        t.set_churn_key(n2 as f64 + 1.0); // 4000.0: absent and the new maximum
        let churn = t.churn_counted();
        let sum = insert_fd + delete_fd;

        // (1) The overshoot: the FD sum double-counts relative to the right-spine probe.
        assert!(sum > churn, "balanced: expected fd sum {sum} > churn {churn} (the overshoot)");
        // (2) Both are O(log n), nowhere near the chain's O(n): far below n/10 = 400.
        assert!(churn < 400.0, "balanced churn {churn} must stay O(log n) ≪ n");
        assert!(sum < 400.0, "balanced fd sum {sum} must stay O(log n) ≪ n");
    }
}
