/**
 * Native storage wrapper.
 *
 * Resolution order:
 *   1. `@capacitor/preferences` — durable on iOS/Android (survives WKWebView purges)
 *   2. `window.localStorage` (web)
 *   3. In-memory Map fallback (SSR / privacy modes)
 *
 * The API is intentionally async (Capacitor Preferences is async) — callers
 * that previously used localStorage synchronously should `await` these calls.
 */

type Backend = {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
  keys: () => Promise<string[]>
  clear: () => Promise<void>
}

let cachedBackend: Backend | null = null
const memoryStore = new Map<string, string>()

function isCapacitorNative(): boolean {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    return !!g.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

async function loadCapacitorBackend(): Promise<Backend | null> {
  if (!isCapacitorNative()) return null
  try {
    const spec = "@capacitor/preferences"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    const Preferences = mod?.Preferences
    if (!Preferences) return null
    return {
      async get(key) {
        const r = await Preferences.get({ key })
        return r?.value ?? null
      },
      async set(key, value) {
        await Preferences.set({ key, value })
      },
      async remove(key) {
        await Preferences.remove({ key })
      },
      async keys() {
        const r = await Preferences.keys()
        return Array.isArray(r?.keys) ? r.keys : []
      },
      async clear() {
        await Preferences.clear()
      },
    }
  } catch {
    return null
  }
}

function localStorageBackend(): Backend | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null
    // probe — privacy mode can throw on first write
    const probe = "__siragpt_native_storage_probe__"
    window.localStorage.setItem(probe, "1")
    window.localStorage.removeItem(probe)
    return {
      async get(key) {
        return window.localStorage.getItem(key)
      },
      async set(key, value) {
        window.localStorage.setItem(key, value)
      },
      async remove(key) {
        window.localStorage.removeItem(key)
      },
      async keys() {
        const out: string[] = []
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i)
          if (k != null) out.push(k)
        }
        return out
      },
      async clear() {
        window.localStorage.clear()
      },
    }
  } catch {
    return null
  }
}

function memoryBackend(): Backend {
  return {
    async get(key) {
      return memoryStore.has(key) ? memoryStore.get(key)! : null
    },
    async set(key, value) {
      memoryStore.set(key, value)
    },
    async remove(key) {
      memoryStore.delete(key)
    },
    async keys() {
      return Array.from(memoryStore.keys())
    },
    async clear() {
      memoryStore.clear()
    },
  }
}

async function getBackend(): Promise<Backend> {
  if (cachedBackend) return cachedBackend
  const cap = await loadCapacitorBackend()
  if (cap) {
    cachedBackend = cap
    return cap
  }
  const ls = localStorageBackend()
  if (ls) {
    cachedBackend = ls
    return ls
  }
  cachedBackend = memoryBackend()
  return cachedBackend
}

export async function getItem(key: string): Promise<string | null> {
  return (await getBackend()).get(key)
}

export async function setItem(key: string, value: string): Promise<void> {
  return (await getBackend()).set(key, value)
}

export async function removeItem(key: string): Promise<void> {
  return (await getBackend()).remove(key)
}

export async function keys(): Promise<string[]> {
  return (await getBackend()).keys()
}

export async function clear(): Promise<void> {
  return (await getBackend()).clear()
}

export async function getJSON<T>(key: string): Promise<T | null> {
  const raw = await getItem(key)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function setJSON<T>(key: string, value: T): Promise<void> {
  await setItem(key, JSON.stringify(value))
}

/** Test-only — force re-resolution on next call. */
export function _resetBackendForTests(): void {
  cachedBackend = null
  memoryStore.clear()
}
