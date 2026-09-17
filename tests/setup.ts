import '@testing-library/jest-dom/vitest'

// Node ≥ 24 ships an inert native `localStorage`/`sessionStorage` stub on
// globalThis (usable only with --localstorage-file). Vitest's jsdom
// `populateGlobal` sees `'localStorage' in global` as true and therefore
// skips copying jsdom's working implementation, leaving tests with
// `typeof localStorage === 'undefined'`. Install a small in-memory Web
// Storage polyfill when the global one is missing or non-functional so
// suites stay deterministic across Node versions.
function storageNeedsPolyfill(kind: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const store = (globalThis as Record<string, unknown>)[kind] as Storage | undefined
    if (!store || typeof store.getItem !== 'function') return true
    store.getItem('__vitest_storage_probe__')
    return false
  } catch {
    return true
  }
}

function createMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    key(index: number): string | null {
      return [...data.keys()][index] ?? null
    },
    getItem(key: string): string | null {
      return data.has(String(key)) ? (data.get(String(key)) as string) : null
    },
    setItem(key: string, value: string): void {
      data.set(String(key), String(value))
    },
    removeItem(key: string): void {
      data.delete(String(key))
    },
    clear(): void {
      data.clear()
    },
  } as Storage
}

for (const kind of ['localStorage', 'sessionStorage'] as const) {
  if (storageNeedsPolyfill(kind)) {
    Object.defineProperty(globalThis, kind, {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    })
  }
}
