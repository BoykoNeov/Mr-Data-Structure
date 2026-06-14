/**
 * The benchmark engine boundary.
 *
 * Phase 0 defines only the lifecycle plus a round-trip probe. The sweep API
 * (`runSweep`, op-counters, per-operation timing — see docs/PLAN.md §6) lands
 * in Phase 4. Keeping the engine behind this interface is deliberate: it lets a
 * pure-TS implementation stand in if the WASM + Worker toolchain ever proves
 * too heavy (docs/PLAN.md risk R5), without the rest of the app caring which
 * implementation it talks to.
 */
export interface BenchEngine {
  /** Resolves once the underlying engine (WASM module) is loaded and usable. */
  ready(): Promise<void>;

  /** Build identifier; a successful call proves real WASM loaded, not a fallback. */
  version(): Promise<string>;

  /** Round-trip probe: returns `x + 1`, computed inside the engine. */
  ping(x: number): Promise<number>;

  /** Release the worker / underlying resources. */
  dispose(): void;
}
