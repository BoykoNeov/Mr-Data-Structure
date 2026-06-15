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
//! Phase 2 implements the number-key path (`f64`) — the sweep/demo uses numeric
//! generators (`generateSorted`). String-key structures land with the TS
//! teaching impls + conformance corpus (docs/PLAN.md §10, Phase 2 batch 4),
//! where both languages exercise the offsets+UTF-8 marshal layout together.

pub mod dyn_array;
pub mod hash_set;

#[cfg(test)]
mod conformance;

/// SplitMix64 finalizer over the f64 bit pattern — a cheap, well-distributed
/// integer hash for numeric keys. Consecutive integers (the `sorted` generator)
/// have very different IEEE-754 bit patterns once mixed, so chains stay short and
/// hash-set search reads as O(1) (docs/PLAN.md §8).
#[inline]
pub fn mix_f64(x: f64) -> u64 {
    let mut z = x.to_bits();
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::mix_f64;

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
    use super::dyn_array::ArrayF64;
    use super::hash_set::HashSetF64;

    fn keys(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64).collect()
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
}
