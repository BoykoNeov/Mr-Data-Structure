import { useState } from 'react';
import {
  generateGaussian,
  generateNearSorted,
  generateReverseSorted,
  generateSorted,
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

export type GeneratorKind = 'uniform' | 'sorted' | 'reverse-sorted' | 'near-sorted' | 'gaussian' | 'zipfian';

export interface PickerState {
  readonly source: 'generate' | 'paste';
  readonly kind: GeneratorKind;
  readonly n: number;
  readonly seed: number;
  /** Pasted CSV or JSON text (source = paste). */
  readonly text: string;
  /** Key field for multi-column pastes (blank ⇒ single-column default). */
  readonly keyField: string;
}

export const GENERATORS: ReadonlyArray<{ kind: GeneratorKind; label: string; hint: string }> = [
  { kind: 'uniform', label: 'uniform random integers', hint: 'the neutral baseline — every structure at its textbook average' },
  { kind: 'sorted', label: 'sorted (ascending)', hint: 'the classic worst case: a naive BST degenerates to a chain' },
  { kind: 'reverse-sorted', label: 'reverse-sorted (descending)', hint: 'the mirror worst case (a left-leaning chain)' },
  { kind: 'near-sorted', label: 'nearly sorted', hint: 'sorted with a few random swaps — real logs and ids often look like this' },
  { kind: 'gaussian', label: 'gaussian floats', hint: 'clustered around a mean; floats, not integers' },
  { kind: 'zipfian', label: 'zipfian (duplicate-heavy)', hint: 'a few keys dominate — how word counts and page hits are distributed' },
];

export const DEFAULT_PICKER: PickerState = {
  source: 'generate',
  kind: 'uniform',
  n: 100_000,
  seed: 7,
  text: '',
  keyField: '',
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
  }
}

/** A short human label for a dataset's provenance (chart captions, exports). */
export function describeDataset(d: Dataset): string {
  const o = d.order;
  if (o.kind === 'as-loaded') return `your data — ${d.size.toLocaleString()} ${d.keyType} keys, as loaded`;
  return `${o.kind} — ${d.size.toLocaleString()} ${d.keyType} keys` + ('seed' in o ? ` (seed ${o.seed})` : '');
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
            <select value={s.kind} onChange={(e) => patch({ kind: e.target.value as GeneratorKind })} style={input}>
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
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{hint}</div>
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
            Numeric keys only for now (string structures exist in the engine but aren’t wired into the sweep yet).
            Order is preserved — that’s the point: a sorted column behaves differently from a shuffled one.
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
