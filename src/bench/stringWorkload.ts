import { decodeStringKeys } from '../data/marshal';

/**
 * The **string** measurement workload (docs/PLAN.md §6.3, docs/METHODOLOGY.md §2.5):
 * deriving the probe set, the churn key, and the per-point buffer views the string bench
 * twins are measured on.
 *
 * These live outside `engine.worker.ts` because they are pure and load-bearing: they carry
 * two measurement decisions that a later "simplification" would quietly reverse, and a
 * worker module cannot be unit-tested (it imports WASM and calls `Comlink.expose` at module
 * scope). The worker keeps the timing; this keeps the decisions.
 */

/** Views of a marshalled offsets+UTF-8 buffer covering exactly the first `n` keys. */
export interface KeyPrefix {
  readonly offsets: Uint32Array;
  readonly bytes: Uint8Array;
}

/**
 * The first `n` keys as their own offsets+bytes pair, without copying.
 *
 * This is not a tidiness detail: `build_insert_n` and its siblings are **timed**, and
 * wasm-bindgen copies whatever slice it is handed into WASM memory on every call. Passing
 * the whole corpus while measuring n = 250 would put a constant, full-corpus copy inside
 * every timed region and flatten the curve into noise. The numeric side avoids it with
 * `keys.subarray(0, n)`; this is the two-buffer equivalent — keys are contiguous and
 * `offsets[0] === 0`, so the first `n` occupy `bytes[0 .. offsets[n]]`.
 */
export function prefixOf(offsets: Uint32Array, bytes: Uint8Array, n: number): KeyPrefix {
  const count = Math.max(0, Math.min(n, offsets.length - 1));
  return {
    offsets: offsets.subarray(0, count + 1),
    bytes: bytes.subarray(0, offsets[count]),
  };
}

/** Characters used to mutate a present key into an absent one. */
const MUTATION_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A key **provably absent** from `taken`, derived from a stored key by changing its last
 * character — so it keeps the corpus's own length and shape.
 *
 * The obvious alternative is a key longer than every stored key, absent by construction and
 * needing no set. It is also **wrong for this measurement**, in two directions at once:
 * Rust compares strings by byte slice and slice equality tests the *length* first, so a
 * uniquely-long key makes every array comparison bail out in O(1) — understating exactly
 * the per-byte scan cost the string section exists to show — while making the hash set's
 * FNV pass read more bytes than a real key would, overstating its constant. Two structures
 * biased opposite ways on the one chart that compares them.
 *
 * A length-preserving mutation costs a `Set` of the decoded prefix (untimed setup) and
 * keeps both constants honest. The long-key form survives only as the fallback for the
 * degenerate case where every mutation is already stored (a corpus that exhausts the
 * alphabet at that length — e.g. every one-character key).
 */
export function absentLike(seed: string, taken: ReadonlySet<string>, salt: number): string {
  if (seed.length > 0) {
    for (let t = 0; t < MUTATION_ALPHABET.length; t++) {
      const ch = MUTATION_ALPHABET[(salt + t) % MUTATION_ALPHABET.length];
      const candidate = seed.slice(0, -1) + ch;
      if (!taken.has(candidate)) return candidate;
    }
  }
  // Fallback: longer than any stored key ⇒ absent, with the length-check bias noted above.
  let candidate = seed + MUTATION_ALPHABET[salt % MUTATION_ALPHABET.length];
  while (taken.has(candidate)) candidate += 'z';
  return candidate;
}

/**
 * A key of **median length** for the corpus — the seed the churn key is derived from.
 *
 * Not `keys[0]`: the churn key inherits its seed's length, and on imported data the first
 * row is an accident of ordering. A corpus that happens to start with a one-character key
 * would then cycle a one-character key, and the measured mutation *constant* would move
 * with the row order rather than with the structure. The numeric side has no equivalent
 * exposure — `max + 1` and `min − 1` are properties of the whole prefix — so this restores
 * the same property here (docs/METHODOLOGY.md §2.5, §4.1).
 */
export function medianLengthKey(keys: readonly string[]): string {
  if (keys.length === 0) return '';
  const byLength = [...keys].sort((a, b) => a.length - b.length);
  return byLength[byLength.length >> 1];
}

/** Present probes per sweep point (docs/PLAN.md §6.3 — the ~50/50 present/absent mix). */
export const PRESENT_STRING_PROBES = 64;
/** Absent probes per sweep point, all derived from present keys by {@link absentLike}. */
export const ABSENT_STRING_PROBES = 64;

/**
 * The string query workload for one sweep point: a spread of keys that are present, plus a
 * block of absent ones derived from those same keys, so both halves cost what a real key
 * costs. Untimed setup.
 */
export function buildStringProbes(keys: readonly string[]): string[] {
  const n = keys.length;
  const present = Math.min(PRESENT_STRING_PROBES, n);
  const probes: string[] = [];
  for (let i = 0; i < present; i++) probes.push(keys[Math.floor((i * n) / present)]);

  const taken = new Set(keys);
  for (let i = 0; i < ABSENT_STRING_PROBES; i++) {
    const absent = absentLike(present > 0 ? probes[i % present] : '', taken, i);
    taken.add(absent); // keep the absent block distinct from itself, too
    probes.push(absent);
  }
  return probes;
}

/** The churn key for a prefix: absent from it, and of typical length for it. */
export function churnKeyFor(keys: readonly string[]): string {
  return absentLike(medianLengthKey(keys), new Set(keys), 0);
}

/** Decode the first `n` keys of a marshalled buffer — re-exported so the worker has one import. */
export { decodeStringKeys };
