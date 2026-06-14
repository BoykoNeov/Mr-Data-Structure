import type { Dataset } from './dataset';

/**
 * Marshal a {@link Dataset}'s keys into typed arrays for transfer into the WASM
 * bench engine (docs/PLAN.md §4.2, risk R7). The goal is a compact,
 * zero-(extra-)copy hand-off: every output is backed by a transferable
 * `ArrayBuffer`, so the structure is built *inside* WASM from a single passed
 * buffer rather than crossing the JS↔WASM boundary per element.
 *
 * - **Numbers → `Float64Array`.** f64 represents every integer up to 2^53
 *   exactly, and detection (`./detect`) already keeps anything larger as a
 *   string, so this is lossless for every key we accept. (An `Int32Array` fast
 *   path is a Phase-4 memory optimization — deferred until there's a WASM
 *   consumer to validate the two-type contract against.)
 * - **Strings → offsets + UTF-8 bytes.** All keys are concatenated into one
 *   UTF-8 `Uint8Array`; `offsets[i]..offsets[i+1]` bounds key `i` (an
 *   Arrow-style layout — equivalent to, and friendlier than, interleaved
 *   length prefixes). `offsets` has length `n + 1`.
 */
export interface NumberKeyBuffer {
  readonly keyType: 'number';
  readonly values: Float64Array;
}

export interface StringKeyBuffer {
  readonly keyType: 'string';
  readonly offsets: Uint32Array; // length n + 1; offsets[0] === 0
  readonly bytes: Uint8Array;
}

export type MarshalledKeys = NumberKeyBuffer | StringKeyBuffer;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function marshalKeys(dataset: Dataset): MarshalledKeys {
  if (dataset.keyType === 'number') {
    return { keyType: 'number', values: Float64Array.from(dataset.keys) };
  }

  const encoded = dataset.keys.map((k) => encoder.encode(k));
  const total = encoded.reduce((sum, b) => sum + b.length, 0);
  const offsets = new Uint32Array(encoded.length + 1);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (let i = 0; i < encoded.length; i++) {
    bytes.set(encoded[i], cursor);
    cursor += encoded[i].length;
    offsets[i + 1] = cursor;
  }
  return { keyType: 'string', offsets, bytes };
}

/**
 * Inverse of {@link marshalKeys}, used to prove the byte layout round-trips
 * (the WASM side performs the equivalent decode). Returns plain JS keys.
 */
export function unmarshalKeys(m: MarshalledKeys): number[] | string[] {
  if (m.keyType === 'number') return Array.from(m.values);
  const out: string[] = [];
  for (let i = 0; i + 1 < m.offsets.length; i++) {
    out.push(decoder.decode(m.bytes.subarray(m.offsets[i], m.offsets[i + 1])));
  }
  return out;
}

/**
 * The transferable `ArrayBuffer`s backing a marshalled payload, for passing as
 * the second argument to `postMessage` / Comlink's `transfer` (avoids copying
 * large buffers into the worker).
 */
export function transferables(m: MarshalledKeys): ArrayBuffer[] {
  // The buffers are always plain ArrayBuffers we allocated here; the cast just
  // narrows the lib's `ArrayBufferLike` (which also admits SharedArrayBuffer).
  return m.keyType === 'number'
    ? [m.values.buffer as ArrayBuffer]
    : [m.offsets.buffer as ArrayBuffer, m.bytes.buffer as ArrayBuffer];
}
