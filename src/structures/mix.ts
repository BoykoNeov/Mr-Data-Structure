/**
 * Numeric key hash for the teaching hash set — a bit-exact TypeScript port of
 * the Rust bench engine's `mix_f64` (bench-engine/src/structures/mod.rs).
 *
 * It is a SplitMix64 finalizer over the IEEE-754 bit pattern of the `f64` key.
 * The two implementations **must** agree bit-for-bit: the hash decides bucket
 * placement, which in turn decides chain order and the hash set's op-count, and
 * the cross-language conformance corpus (docs/PLAN.md §12) asserts those match.
 *
 * 64-bit wrapping arithmetic is done in `bigint` (a `number` is itself an `f64`
 * and cannot hold the intermediate products exactly). Every multiply is masked
 * back to 64 bits to mirror Rust's `wrapping_mul`.
 */

const MASK64 = (1n << 64n) - 1n;
const C1 = 0xbf58476d1ce4e5b9n;
const C2 = 0x94d049bb133111ebn;

// Reused for the f64 → bit-pattern reinterpret; endianness is internal and only
// has to be self-consistent (both writes/reads use big-endian) to recover the
// same integer value Rust's `f64::to_bits()` produces.
const reinterpret = new DataView(new ArrayBuffer(8));

/** The IEEE-754 bit pattern of `x` as a 64-bit unsigned `bigint` (Rust `to_bits`). */
export function toBits(x: number): bigint {
  reinterpret.setFloat64(0, x, false);
  return reinterpret.getBigUint64(0, false);
}

/**
 * SplitMix64 finalizer over the key's bit pattern — identical to the Rust
 * `mix_f64`. Returns a full 64-bit `bigint`; callers mask it down to a bucket
 * index (masking *before* any `Number()` conversion to avoid f64 precision loss
 * past 2^53).
 */
export function mixF64(x: number): bigint {
  let z = toBits(x);
  z = ((z ^ (z >> 30n)) * C1) & MASK64;
  z = ((z ^ (z >> 27n)) * C2) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}
