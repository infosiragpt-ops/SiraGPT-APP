type HeaderRecord = Record<string, string>

function isValidHeader(name: string, value: string): boolean {
  if (!name) return false
  if (/[\0\r\n]/.test(name) || /[\0\r\n]/.test(value)) return false

  if (typeof Headers !== 'undefined') {
    try {
      const probe = new Headers()
      probe.set(name, value)
      return true
    } catch {
      return false
    }
  }

  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
}

function putHeader(target: HeaderRecord, key: unknown, value: unknown) {
  if (key == null || typeof key === 'symbol') return
  if (value == null || typeof value === 'symbol') return

  const name = String(key).trim()
  const stringValue = typeof value === 'string' ? value : String(value)
  if (!isValidHeader(name, stringValue)) return
  target[name] = stringValue
}

function putEntries(target: HeaderRecord, entries: Iterable<unknown>) {
  for (const entry of entries) {
    if (!entry || typeof (entry as any)[Symbol.iterator] !== 'function') continue
    const pair = Array.from(entry as Iterable<unknown>)
    if (pair.length < 2) continue
    putHeader(target, pair[0], pair[1])
  }
}

export function sanitizeFetchHeaders(headers: HeadersInit | Record<PropertyKey, unknown> | null | undefined): HeaderRecord | undefined {
  if (headers == null) return undefined

  const sanitized: HeaderRecord = {}

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => putHeader(sanitized, key, value))
    return sanitized
  }

  if (Array.isArray(headers)) {
    putEntries(sanitized, headers)
    return sanitized
  }

  if (typeof (headers as any).forEach === 'function') {
    ;(headers as any).forEach((value: unknown, key: unknown) => putHeader(sanitized, key, value))
    return sanitized
  }

  if (typeof (headers as any)[Symbol.iterator] === 'function') {
    putEntries(sanitized, headers as Iterable<unknown>)
    return sanitized
  }

  if (typeof headers === 'object') {
    for (const key of Object.getOwnPropertyNames(headers)) {
      putHeader(sanitized, key, (headers as Record<string, unknown>)[key])
    }
    return sanitized
  }

  return undefined
}

export function sanitizeFetchInit(init: RequestInit | null | undefined): RequestInit {
  if (!init || typeof init !== 'object' || Array.isArray(init)) return {}

  const sanitized: RequestInit = { ...init }
  for (const key of Object.getOwnPropertySymbols(sanitized)) {
    delete (sanitized as any)[key]
  }

  if (sanitized.headers != null) {
    sanitized.headers = sanitizeFetchHeaders(sanitized.headers as any)
  }

  return sanitized
}
