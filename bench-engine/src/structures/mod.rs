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
