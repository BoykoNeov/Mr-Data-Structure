import { useEffect, useMemo, useState } from 'react';
import { createBenchEngine } from './bench/wasmBenchEngine';
import type { BenchEngine } from './bench/BenchEngine';
import { generateSorted, importCsv, marshalKeys } from './data';
import type { Dataset } from './data';

/**
 * Phase 0 smoke screen: prove the main-thread -> Web Worker -> WASM round-trip
 * works in the browser. `ping(41)` must come back as 42.
 */
export function App() {
  const [status, setStatus] = useState('initializing…');
  const [version, setVersion] = useState('');
  const [pong, setPong] = useState<number | null>(null);

  useEffect(() => {
    let engine: BenchEngine | undefined;
    (async () => {
      try {
        engine = createBenchEngine();
        await engine.ready();
        setVersion(await engine.version());
        setPong(await engine.ping(41));
        setStatus('ready');
      } catch (err) {
        setStatus('error: ' + (err as Error).message);
      }
    })();
    return () => engine?.dispose();
  }, []);

  const ok = pong === 42;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.6 }}>
      <h1>Mr Data Structure</h1>
      <p style={{ color: '#666' }}>Phase 0 — WASM bench engine round-trip</p>
      <ul>
        <li>
          status: <strong>{status}</strong>
        </li>
        <li>
          engine: <code>{version || '—'}</code>
        </li>
        <li>
          ping(41) → <strong>{pong ?? '—'}</strong> {ok ? '✓' : ''}
        </li>
      </ul>

      <DataLayerDemo />
    </main>
  );
}

const SAMPLE_CSV = `id,name,city
3,Alice,NYC
1,Bob,LA
2,Cara,SF`;

/**
 * Phase 1 exit criterion (docs/PLAN.md §10): load a real CSV and a generated
 * `sorted` dataset, end to end in the browser. Both converge on the normalized
 * Dataset and marshal into the typed arrays the bench engine will consume.
 */
function DataLayerDemo() {
  const csv = useMemo(() => importCsv(SAMPLE_CSV, { keyField: 'id' }), []);
  const sorted = useMemo(() => generateSorted(16), []);

  return (
    <section style={{ marginTop: 24 }}>
      <p style={{ color: '#666' }}>Phase 1 — data layer</p>
      <ul>
        <DatasetLine label="CSV (key=id)" ds={csv} />
        <DatasetLine label="generated sorted(16)" ds={sorted} />
      </ul>
    </section>
  );
}

function DatasetLine({ label, ds }: { label: string; ds: Dataset }) {
  const marshalled = marshalKeys(ds);
  const bytes =
    marshalled.keyType === 'number'
      ? marshalled.values.byteLength
      : marshalled.bytes.byteLength + marshalled.offsets.byteLength;
  return (
    <li>
      {label}: <strong>{ds.size}</strong> {ds.keyType} keys —{' '}
      <code>[{ds.keys.slice(0, 6).join(', ')}{ds.keys.length > 6 ? ', …' : ''}]</code>{' '}
      <span style={{ color: '#666' }}>({bytes} B marshalled)</span>
    </li>
  );
}
