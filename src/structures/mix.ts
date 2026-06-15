/**
 * Key hashes for the teaching hash sets — bit-exact TypeScript ports of the Rust
 * bench engine's `mix_f64` / `mix_str` (bench-engine/src/structures/mod.rs).
 *
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
// 64-bit FNV-1a constants for the string hash (mirrors Rust `mix_str`).
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

// Reused for the f64 → bit-pattern reinterpret; endianness is internal and only
// has to be self-consistent (both writes/reads use big-endian) to recover the
// same integer value Rust's `f64::to_bits()` produces.
const reinterpret = new DataView(new ArrayBuffer(8));
// Encodes string keys to the same UTF-8 bytes Rust hashes (and that the marshal
// layer ships into WASM), so the two languages hash an identical byte sequence.
const utf8 = new TextEncoder();

/** The IEEE-754 bit pattern of `x` as a 64-bit unsigned `bigint` (Rust `to_bits`). */
export function toBits(x: number): bigint {
  reinterpret.setFloat64(0, x, false);
  return reinterpret.getBigUint64(0, false);
}

/**
 * SplitMix64 finalizer — the shared bit-avalanche both key hashes end on
 * (Rust `splitmix64`). Masked back to 64 bits at every step to mirror Rust's
 * wrapping arithmetic.
 */
export function splitMix64(z0: bigint): bigint {
  let z = z0 & MASK64;
  z = ((z ^ (z >> 30n)) * C1) & MASK64;
  z = ((z ^ (z >> 27n)) * C2) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/**
 * Numeric key hash: the SplitMix64 finalizer over the f64 bit pattern —
 * identical to the Rust `mix_f64`. Returns a full 64-bit `bigint`; callers mask
 * it down to a bucket index (masking *before* any `Number()` conversion to avoid
 * f64 precision loss past 2^53).
 */
export function mixF64(x: number): bigint {
  return splitMix64(toBits(x));
}

/**
 * String key hash: 64-bit FNV-1a over the UTF-8 bytes, then the SplitMix64
 * finalizer — identical to the Rust `mix_str`. Hashing the UTF-8 *bytes* (not
 * JS UTF-16 code units) is what keeps it bit-exact with Rust and tied to the
 * marshal layout (docs/PLAN.md §4.2, §12).
 */
export function mixStr(s: string): bigint {
  let h = FNV_OFFSET;
  for (const b of utf8.encode(s)) {
    h = (h ^ BigInt(b)) & MASK64;
    h = (h * FNV_PRIME) & MASK64;
  }
  return splitMix64(h);
}
