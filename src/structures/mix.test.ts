import { describe, it, expect } from 'vitest';
import { mixF64, toBits } from './mix';

/**
 * Anchors captured directly from the Rust `mix_f64` (printed via a `cargo test`
 * scratch run). If the TS port drifts from Rust, the hash set's bucket layout
 * — and therefore its op-count and iteration order — diverge, so these pins are
 * the first line of defense before the full conformance corpus (docs/PLAN.md §12).
 */
const RUST_MIX: Array<[number, bigint]> = [
  [0.0, 0n], // bit pattern 0 → SplitMix64(0) = 0 (free anchor)
  [1.0, 3035652100526550566n],
  [2.0, 1360429390938723525n],
  [3.0, 6732024472757944893n],
  [0.5, 306524380890059637n],
  [-1.0, 5045323167042602119n],
  [1_000_000.0, 4119586053111418004n],
];

describe('mixF64 — bit-exact port of Rust mix_f64', () => {
  it.each(RUST_MIX)('mixF64(%f) matches Rust', (x, expected) => {
    expect(mixF64(x)).toBe(expected);
  });

  it('returns a full 64-bit value (never negative, never f64-lossy)', () => {
    for (const [x] of RUST_MIX) {
      const h = mixF64(x);
      expect(h).toBeGreaterThanOrEqual(0n);
      expect(h).toBeLessThan(1n << 64n);
    }
  });

  it('reinterprets the f64 bit pattern (1.0 → 0x3FF0000000000000)', () => {
    expect(toBits(1.0)).toBe(0x3ff0000000000000n);
    expect(toBits(0.0)).toBe(0n);
  });
});
