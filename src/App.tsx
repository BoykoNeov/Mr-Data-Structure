import { useEffect, useState } from 'react';
import { createBenchEngine } from './bench/wasmBenchEngine';
import type { BenchEngine } from './bench/BenchEngine';

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
    </main>
  );
}
