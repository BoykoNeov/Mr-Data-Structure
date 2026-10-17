import { afterEach, describe, it, expect } from 'vitest';
import { browserKv, indexedDbTextStore, memoryText } from './storage';

/**
 * The real adapters, on the failure modes a browser actually produces (docs/PLAN.md §13):
 * a missing API, a property access that throws (blocked site data), methods that throw
 * (quota), and an IndexedDB open that errors. The contract under test is "never throws,
 * never rejects" — that is what lets the app work exactly as before when storage is gone.
 */

const g = globalThis as Record<string, unknown>;
const saved = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
};
const stub = (name: 'localStorage' | 'indexedDB', d: PropertyDescriptor) =>
  Object.defineProperty(globalThis, name, { configurable: true, ...d });

afterEach(() => {
  for (const name of ['localStorage', 'indexedDB'] as const) {
    const d = saved[name];
    if (d) Object.defineProperty(globalThis, name, d);
    else delete g[name];
  }
});

/** A minimal working `Storage`. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('browserKv', () => {
  it('round-trips through a working localStorage', () => {
    stub('localStorage', { value: fakeStorage() });
    const kv = browserKv();
    expect(kv.available()).toBe(true);
    kv.set('k', '02134');
    expect(kv.get('k')).toBe('02134');
    kv.remove('k');
    expect(kv.get('k')).toBeNull();
  });

  it('degrades silently when localStorage is missing', () => {
    stub('localStorage', { value: undefined });
    const kv = browserKv();
    expect(kv.available()).toBe(false);
    expect(kv.get('k')).toBeNull();
    expect(() => kv.set('k', 'v')).not.toThrow();
    expect(() => kv.remove('k')).not.toThrow();
  });

  it('degrades silently when the property access itself throws (blocked site data)', () => {
    stub('localStorage', {
      get() {
        throw new Error('SecurityError: the operation is insecure');
      },
    });
    const kv = browserKv();
    expect(kv.available()).toBe(false);
    expect(kv.get('k')).toBeNull();
    expect(() => kv.set('k', 'v')).not.toThrow();
    expect(() => kv.remove('k')).not.toThrow();
  });

  it('degrades silently when every method throws (quota exceeded, a poisoned object)', () => {
    const boom = () => {
      throw new Error('QuotaExceededError');
    };
    stub('localStorage', {
      value: {
        get length(): number {
          throw new Error('blocked');
        },
        getItem: boom,
        setItem: boom,
        removeItem: boom,
      },
    });
    const kv = browserKv();
    expect(kv.available()).toBe(false);
    expect(kv.get('k')).toBeNull();
    expect(() => kv.set('k', 'v')).not.toThrow();
    expect(() => kv.remove('k')).not.toThrow();
  });
});

describe('indexedDbTextStore', () => {
  const expectQuiet = async () => {
    const store = indexedDbTextStore();
    await expect(store.get('k')).resolves.toBeUndefined();
    await expect(store.put('k', 'v')).resolves.toBeUndefined();
    await expect(store.delete('k')).resolves.toBeUndefined();
  };

  it('resolves empty when IndexedDB does not exist', async () => {
    stub('indexedDB', { value: undefined });
    await expectQuiet();
  });

  it('resolves empty when the property access throws', async () => {
    stub('indexedDB', {
      get() {
        throw new Error('SecurityError');
      },
    });
    await expectQuiet();
  });

  it('resolves empty when open() throws or its request errors', async () => {
    stub('indexedDB', {
      value: {
        open() {
          throw new Error('InvalidStateError');
        },
      },
    });
    await expectQuiet();

    stub('indexedDB', {
      value: {
        open() {
          const req: Record<string, unknown> = { error: new Error('UnknownError') };
          queueMicrotask(() => (req.onerror as (() => void) | undefined)?.());
          return req;
        },
      },
    });
    await expectQuiet();
  });

  it('resolves empty when open() is blocked by another tab', async () => {
    stub('indexedDB', {
      value: {
        open() {
          const req: Record<string, unknown> = {};
          queueMicrotask(() => (req.onblocked as (() => void) | undefined)?.());
          return req;
        },
      },
    });
    await expectQuiet();
  });
});

describe('memoryText', () => {
  it('stores copies (structured clone, as IndexedDB does) and counts every call', async () => {
    const t = memoryText();
    await t.put('k', '😀 02134');
    expect(await t.get('k')).toBe('😀 02134');
    expect(await t.get('missing')).toBeUndefined();
    await t.delete('k');
    expect(t.data.size).toBe(0);
    expect(t.calls).toBe(4);
  });
});
