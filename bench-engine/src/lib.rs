//! Mr Data Structure — WASM benchmark engine.
//!
//! Phase 0 contains only the round-trip proof (`ping`) and a build identifier
//! (`engine_version`). The production data-structure implementations, the
//! per-operation timing harness (see docs/PLAN.md §6) and the op-counters
//! (§6.4) land in Phase 2+.

use wasm_bindgen::prelude::*;

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
