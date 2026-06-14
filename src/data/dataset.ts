/**
 * The normalized dataset (docs/PLAN.md §4.2) — the single shared product of the
 * data layer. Every input path (CSV / JSON / paste / file import, and the
 * synthetic generators of §4.3) converges on this one shape, so the
 * visualization and benchmark engines never care where the data came from.
 *
 * Keys are the comparison/lookup identity for `insert`/`search`/`delete`
 * (§4.1). For key–value records the user picks a key field and the whole row is
 * the value (`values[i]` is the payload for `keys[i]`).
 */

export type KeyType = 'number' | 'string';

/**
 * How a dataset's keys came to be — named `order` to stay faithful to §4.2,
 * where it doubles as provenance. Imported data arrives `{ kind: 'as-loaded' }`
 * (whatever order the source had). Synthetic data instead carries the full
 * {@link GeneratorDescriptor} that produced it: that descriptor is a complete,
 * reproducible spec, and the *order/distribution* it records is exactly what
 * makes the empirical curves meaningful (e.g. `sorted` input degenerates a
 * naive BST to O(n) — §4.3).
 */
export type DataOrder = { readonly kind: 'as-loaded' } | GeneratorDescriptor;

/** Reproducible spec for each synthetic generator (docs/PLAN.md §4.3). */
export type GeneratorDescriptor =
  | { readonly kind: 'uniform'; readonly n: number; readonly min: number; readonly max: number; readonly integer: boolean; readonly seed: number }
  | { readonly kind: 'sorted'; readonly n: number; readonly start: number }
  | { readonly kind: 'reverse-sorted'; readonly n: number; readonly start: number }
  | { readonly kind: 'near-sorted'; readonly n: number; readonly start: number; readonly swaps: number; readonly seed: number }
  | { readonly kind: 'gaussian'; readonly n: number; readonly mean: number; readonly stddev: number; readonly seed: number }
  | { readonly kind: 'zipfian'; readonly n: number; readonly distinct: number; readonly skew: number; readonly seed: number }
  | { readonly kind: 'string-corpus'; readonly n: number; readonly minLen: number; readonly maxLen: number; readonly alphabet: string; readonly seed: number };

interface DatasetBase {
  /** Optional KV payloads, index-aligned with {@link Dataset.keys} (§4.1). */
  readonly values?: readonly unknown[];
  readonly order: DataOrder;
  /** `n`; always equal to `keys.length`. */
  readonly size: number;
}

/** A dataset whose keys are numeric. */
export interface NumberDataset extends DatasetBase {
  readonly keyType: 'number';
  readonly keys: readonly number[];
}

/** A dataset whose keys are strings. */
export interface StringDataset extends DatasetBase {
  readonly keyType: 'string';
  readonly keys: readonly string[];
}

/**
 * Discriminated on `keyType` so consumers narrow `keys` to a concrete element
 * type without casts. The field set matches §4.2 exactly.
 */
export type Dataset = NumberDataset | StringDataset;

/**
 * Build a {@link Dataset}, enforcing the invariants the rest of the app relies
 * on: `size === keys.length`, and (when present) `values` is index-aligned with
 * `keys` and of equal length. Keys are **never** de-duplicated — duplicate
 * multiplicity is real data (and the whole point of the `zipfian` generator,
 * §4.3); the structures decide dedup semantics, not the data layer.
 */
export function makeDataset(
  keys: readonly number[] | readonly string[],
  keyType: KeyType,
  order: DataOrder,
  values?: readonly unknown[],
): Dataset {
  if (values && values.length !== keys.length) {
    throw new Error(
      `values length (${values.length}) must match keys length (${keys.length})`,
    );
  }
  const base = { order, size: keys.length, ...(values ? { values } : {}) };
  return keyType === 'number'
    ? { ...base, keyType: 'number', keys: keys as readonly number[] }
    : { ...base, keyType: 'string', keys: keys as readonly string[] };
}
