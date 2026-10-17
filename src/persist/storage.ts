/**
 * The two storage adapters session persistence is written against (docs/PLAN.md §13 —
 * resolved **local only**: this browser, nothing shareable, nothing uploaded).
 *
 * - {@link KvStore} is `localStorage`-shaped and synchronous: small settings that the first
 *   render needs before anything async can finish.
 * - {@link TextStore} is IndexedDB-shaped and asynchronous: the user's pasted CSV / JSON,
 *   which can be megabytes and would not fit `localStorage`'s few-MB quota.
 *
 * Every real implementation **never throws and never rejects**: storage that is missing,
 * blocked (private mode, a SecurityError on the property access itself), full, or broken
 * reads as empty and writes as a no-op, so the app behaves exactly as it did before
 * persistence existed. The memory implementations are what the unit tests run on (vitest's
 * node environment has neither API, and the project adds no `fake-indexeddb` dependency).
 */

/** Synchronous string key–value store — the slice of `Storage` persistence uses. */
export interface KvStore {
  /** Whether the backing store could be reached at all (read-only check; writes nothing). */
  available(): boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Asynchronous large-text store. Resolves `undefined` for a missing or unreadable entry. */
export interface TextStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------------------

/**
 * `window.localStorage`, wrapped so that *every* touch — including the property access,
 * which throws a SecurityError when site data is blocked — is caught.
 */
export function browserKv(): KvStore {
  const storage = (): Storage | null => {
    try {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    available() {
      try {
        const s = storage();
        if (!s) return false;
        void s.length; // some blocked modes hand out an object that throws on use
        return true;
      } catch {
        return false;
      }
    },
    get(key) {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(key, value);
      } catch {
        /* quota exceeded or blocked: degrade silently */
      }
    },
    remove(key) {
      try {
        storage()?.removeItem(key);
      } catch {
        /* blocked: nothing to remove */
      }
    },
  };
}

/**
 * One IndexedDB object store holding string values. The database is opened lazily on first
 * use — a page load that never needs the pasted text never opens it — and closed on a
 * `versionchange` so a future schema upgrade in another tab is not blocked by this one.
 */
export function indexedDbTextStore(dbName = 'mr-data-structure', storeName = 'session'): TextStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!factory) throw new Error('IndexedDB unavailable');
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const handle = req.result;
        handle.onversionchange = () => handle.close();
        resolve(handle);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch((err: unknown) => {
      db = null; // let a later call retry rather than caching the failure forever
      throw err;
    });
    return db;
  };
  const request = async <T>(
    mode: IDBTransactionMode,
    make: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const handle = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = handle.transaction(storeName, mode);
      const req = make(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    async get(key) {
      try {
        const v: unknown = await request('readonly', (s) => s.get(key));
        return typeof v === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    },
    async put(key, value) {
      try {
        await request('readwrite', (s) => s.put(value, key));
      } catch {
        /* quota or blocked: degrade silently */
      }
    },
    async delete(key) {
      try {
        await request('readwrite', (s) => s.delete(key));
      } catch {
        /* nothing to delete */
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Test implementations
// ---------------------------------------------------------------------------------------

/** An in-memory {@link KvStore} that counts writes, so a test can pin "no write on load". */
export interface MemoryKv extends KvStore {
  readonly data: Map<string, string>;
  writes: number;
}

export function memoryKv(initial: Record<string, string> = {}): MemoryKv {
  const data = new Map(Object.entries(initial));
  const kv: MemoryKv = {
    data,
    writes: 0,
    available: () => true,
    get: (key) => data.get(key) ?? null,
    set(key, value) {
      kv.writes++;
      data.set(key, value);
    },
    remove(key) {
      kv.writes++;
      data.delete(key);
    },
  };
  return kv;
}

/**
 * An in-memory {@link TextStore}. Values pass through `structuredClone` on the way in and
 * out, the algorithm IndexedDB itself uses, so a round-trip test exercises the same copy
 * semantics the real store applies. `calls` counts every operation (reads included).
 * `hold()` makes the next `put` wait until the returned release function is called — for
 * ordering tests (a "forget" racing an in-flight save).
 */
export interface MemoryText extends TextStore {
  readonly data: Map<string, string>;
  calls: number;
  hold(): () => void;
}

export function memoryText(initial: Record<string, string> = {}): MemoryText {
  const data = new Map(Object.entries(initial));
  let gate: Promise<void> | null = null;
  const store: MemoryText = {
    data,
    calls: 0,
    hold() {
      let release = () => {};
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
    async get(key) {
      store.calls++;
      const v = data.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key, value) {
      store.calls++;
      const g = gate;
      gate = null;
      if (g) await g;
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      store.calls++;
      data.delete(key);
    },
  };
  return store;
}

/** A {@link KvStore} for "storage is blocked": unavailable, reads empty, writes vanish. */
export function unavailableKv(): KvStore {
  return { available: () => false, get: () => null, set: () => {}, remove: () => {} };
}
