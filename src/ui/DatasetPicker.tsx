import { useState } from 'react';
import {
  generateGaussian,
  generateNearSorted,
  generateReverseSorted,
  generateSorted,
  generateStringCorpus,
  generateUniform,
  generateZipfian,
  importCsv,
  importJson,
  type Dataset,
} from '../data';

/**
 * The dataset panel for Compare (docs/PLAN.md §3 layer 1, §4.3, Phase 5): pick a
 * synthetic generator — including the order-sensitive ones (`sorted`,
 * `reverse-sorted`, `near-sorted`) that are the built-in "sorted data kills a
 * naive BST" demo — or paste your own CSV / JSON and choose the key field. The
 * result is the one normalized {@link Dataset} every sweep then runs on.
 *
 * {@link buildDataset} is the pure core (state → dataset), so the choice logic
 * is unit-testable without a DOM; the component is a thin form over it.
 */

export type GeneratorKind =
  | 'uniform'
  | 'sorted'
  | 'reverse-sorted'
  | 'near-sorted'
  | 'gaussian'
  | 'zipfian'
  | 'string-corpus';

export interface PickerState {
  readonly source: 'generate' | 'paste';
  readonly kind: GeneratorKind;
  readonly n: number;
  readonly seed: number;
  /** Pasted CSV or JSON text (source = paste). */
  readonly text: string;
  /** Key field for multi-column pastes (blank ⇒ single-column default). */
  readonly keyField: string;
  /** Shortest generated key, in characters (string-corpus only). */
  readonly minLen: number;
  /** Longest generated key, in characters (string-corpus only) — the run's second cost axis. */
  readonly maxLen: number;
}

export const GENERATORS: ReadonlyArray<{
  kind: GeneratorKind;
  label: string;
  hint: string;
  /** Which structures this dataset can drive — the numeric catalogue, or the string twins. */
  keyType: 'number' | 'string';
}> = [
  { kind: 'uniform', label: 'uniform random integers', hint: 'the neutral baseline — every structure at its textbook average', keyType: 'number' },
  { kind: 'sorted', label: 'sorted (ascending)', hint: 'the classic worst case: a naive BST degenerates to a chain', keyType: 'number' },
  { kind: 'reverse-sorted', label: 'reverse-sorted (descending)', hint: 'the mirror worst case (a left-leaning chain)', keyType: 'number' },
  { kind: 'near-sorted', label: 'nearly sorted', hint: 'sorted with a few random swaps — real logs and ids often look like this', keyType: 'number' },
  { kind: 'gaussian', label: 'gaussian floats', hint: 'clustered around a mean; floats, not integers', keyType: 'number' },
  { kind: 'zipfian', label: 'zipfian (duplicate-heavy)', hint: 'a few keys dominate — how word counts and page hits are distributed', keyType: 'number' },
  {
    kind: 'string-corpus',
    label: 'random string keys',
    hint: 'text keys, like ids and names — runs the string array and string hash set; key length is a second cost axis',
    keyType: 'string',
  },
];

/** The generator's declared key type — which sweep the run will take. */
export function keyTypeOf(kind: GeneratorKind): 'number' | 'string' {
  return GENERATORS.find((g) => g.kind === kind)?.keyType ?? 'number';
}

/**
 * A string corpus is heavier per key than an f64 one (every comparison walks bytes, and
 * marshalling copies the text), and its sweep caps out lower anyway
 * (`STRING_SWEEP_MAX`), so switching to string keys trims an oversized `n` rather than
 * generating a hundred thousand keys the sweep will never reach.
 */
export const STRING_CORPUS_N = 20_000;

export const DEFAULT_PICKER: PickerState = {
  source: 'generate',
  kind: 'uniform',
  n: 100_000,
  seed: 7,
  text: '',
  keyField: '',
  minLen: 3,
  maxLen: 8,
};

/** Build the dataset the picker describes. Throws with a user-readable message. */
export function buildDataset(s: PickerState): Dataset {
  if (s.source === 'paste') {
    const text = s.text.trim();
    if (!text) throw new Error('paste some CSV or JSON first');
    const keyField = s.keyField.trim() || undefined;
    const looksJson = text.startsWith('[') || text.startsWith('{');
    return looksJson ? importJson(text, { keyField }) : importCsv(text, { keyField });
  }
  const n = Math.max(1, Math.floor(s.n));
  switch (s.kind) {
    case 'uniform': return generateUniform(n, 0, n, true, s.seed);
    case 'sorted': return generateSorted(n);
    case 'reverse-sorted': return generateReverseSorted(n);
    case 'near-sorted': return generateNearSorted(n, Math.ceil(n / 20), 0, s.seed);
    case 'gaussian': return generateGaussian(n, 0, 1000, s.seed);
    case 'zipfian': return generateZipfian(n, Math.max(1, Math.ceil(n / 10)), 1, s.seed);
    case 'string-corpus': {
      const min = Math.max(1, Math.floor(s.minLen));
      return generateStringCorpus(n, min, Math.max(min, Math.floor(s.maxLen)), undefined, s.seed);
    }
  }
}

/**
 * A short human label for a dataset's provenance (chart captions, exports).
 *
 * String datasets carry their **key length** too. It is the string run's second cost axis
 * (docs/METHODOLOGY.md §2.5) — the same structures on 3–8 character keys and on 30–40
 * character ones produce two flat lines at different heights — so without it two exported
 * runs are indistinguishable in the one field a reader uses to tell them apart.
 */
export function describeDataset(d: Dataset): string {
  const o = d.order;
  const lengths = d.keyType === 'string' ? `, ${keyLengthNote(d.keys)}` : '';
  if (o.kind === 'as-loaded') {
    return `your data — ${d.size.toLocaleString()} ${d.keyType} keys${lengths}, as loaded`;
  }
  return (
    `${o.kind} — ${d.size.toLocaleString()} ${d.keyType} keys${lengths}` +
    ('seed' in o ? ` (seed ${o.seed})` : '')
  );
}

/** `3–8 chars` for a varied corpus, `4 chars` when every key is the same length. */
function keyLengthNote(keys: readonly string[]): string {
  let min = Infinity;
  let max = 0;
  for (const k of keys) {
    if (k.length < min) min = k.length;
    if (k.length > max) max = k.length;
  }
  if (!Number.isFinite(min)) return '0 chars';
  return min === max ? `${max} chars` : `${min}–${max} chars`;
}

const field: React.CSSProperties = { fontSize: 13, marginRight: 12 };
const input: React.CSSProperties = { fontSize: 13, padding: '2px 6px' };

export function DatasetPicker({
  initial = DEFAULT_PICKER,
  busy,
  onRun,
}: {
  readonly initial?: PickerState;
  readonly busy: boolean;
  readonly onRun: (dataset: Dataset, state: PickerState) => void;
}) {
  const [s, setS] = useState<PickerState>(initial);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<PickerState>) => setS((prev) => ({ ...prev, ...p }));

  const run = () => {
    try {
      setError(null);
      onRun(buildDataset(s), s);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const hint = GENERATORS.find((g) => g.kind === s.kind)?.hint ?? '';

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: '10px 14px', margin: '8px 0', background: '#fafafa' }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Dataset</div>
      <div style={{ marginBottom: 6 }}>
        <label style={field}>
          <input type="radio" checked={s.source === 'generate'} onChange={() => patch({ source: 'generate' })} /> generate
        </label>
        <label style={field}>
          <input type="radio" checked={s.source === 'paste'} onChange={() => patch({ source: 'paste' })} /> paste CSV / JSON
        </label>
      </div>

      {s.source === 'generate' ? (
        <div>
          <label style={field}>
            kind{' '}
            <select
              value={s.kind}
              onChange={(e) => {
                const kind = e.target.value as GeneratorKind;
                // Switching to string keys also trims an oversized n — see STRING_CORPUS_N.
                patch(
                  keyTypeOf(kind) === 'string'
                    ? { kind, n: Math.min(s.n, STRING_CORPUS_N) }
                    : { kind },
                );
              }}
              style={input}
            >
              {GENERATORS.map((g) => (
                <option key={g.kind} value={g.kind}>{g.label}</option>
              ))}
            </select>
          </label>
          <label style={field}>
            n{' '}
            <input type="number" min={10} max={1_000_000} step={1000} value={s.n} style={{ ...input, width: 90 }}
              onChange={(e) => patch({ n: Number(e.target.value) })} />
          </label>
          <label style={field}>
            seed{' '}
            <input type="number" value={s.seed} style={{ ...input, width: 60 }}
              onChange={(e) => patch({ seed: Number(e.target.value) })} />
          </label>
          {keyTypeOf(s.kind) === 'string' && (
            <label style={field}>
              key length{' '}
              <input type="number" min={1} max={64} value={s.minLen} style={{ ...input, width: 55 }}
                onChange={(e) => patch({ minLen: Number(e.target.value) })} />
              {' – '}
              <input type="number" min={1} max={64} value={s.maxLen} style={{ ...input, width: 55 }}
                onChange={(e) => patch({ maxLen: Number(e.target.value) })} />
              {' chars'}
            </label>
          )}
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{hint}</div>
          {keyTypeOf(s.kind) === 'string' && (
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              Try running once at 3–8 characters and again at 30–40: the hash set’s line stays just as
              flat — it is still O(1) in the number of keys — but the whole line <em>lifts</em>, because
              hashing reads every byte. That gap is the cost the textbook class doesn’t mention.
            </div>
          )}
        </div>
      ) : (
        <div>
          <textarea
            value={s.text}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder={'id,name\n42,alice\n7,bob\n…   or   [{"id": 42}, {"id": 7}]'}
            rows={5}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' }}
          />
          <label style={field}>
            key field (multi-column){' '}
            <input value={s.keyField} onChange={(e) => patch({ keyField: e.target.value })} style={{ ...input, width: 120 }} />
          </label>
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            Numeric <em>or</em> text keys — a numeric column runs the seven numeric structures, a text
            column runs the string array and string hash set. Order is preserved — that’s the point: a
            sorted column behaves differently from a shuffled one.
          </div>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button onClick={run} disabled={busy} style={{ fontSize: 13, padding: '4px 12px', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'measuring…' : 'run the sweeps on this dataset'}
        </button>
        {error && <span style={{ color: '#b00', fontSize: 13, marginLeft: 10 }}>{error}</span>}
      </div>
    </div>
  );
}
