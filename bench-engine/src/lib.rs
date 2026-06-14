//! Mr Data Structure — WASM benchmark engine.
//!
//! `ping` / `engine_version` are the Phase 0 round-trip proof. Phase 2 adds the
//! production data structures (`structures`): an unsorted dynamic array and a
//! separate-chaining hash set, each built from a marshalled key buffer and
//! search-timed in batch (docs/PLAN.md §6, §8). The per-op timing *orchestration*
//! (auto-grow / reps / variance) lives in TS (`src/bench/measure.ts`); WASM
//! provides the batched primitive it times.

use wasm_bindgen::prelude::*;

pub mod structures;

/// Phase 0 round-trip proof: TS -> Worker -> WASM -> back.
///
/// Returns the input incremented by one, so the UI can assert `ping(41) == 42`
/// and thereby confirm the whole pipeline (main thread -> Web Worker -> WASM)
/// is wired up.
#[wasm_bindgen]
pub fn ping(x: i32) -> i32 {
    x + 1
}

/// Human-readable engine build identifier.
///
/// A successful call proves the real WASM module loaded (rather than a TS
/// fallback — see docs/PLAN.md risk R5).
#[wasm_bindgen]
pub fn engine_version() -> String {
    format!("bench-engine {} (wasm)", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_increments() {
        assert_eq!(ping(41), 42);
    }

    #[test]
    fn version_identifies_engine() {
        assert!(engine_version().contains("bench-engine"));
    }
}
