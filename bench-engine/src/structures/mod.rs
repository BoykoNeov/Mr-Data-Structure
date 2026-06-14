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
