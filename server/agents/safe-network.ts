import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const DEFAULT_MAX_REDIRECTS = 4

export type HostResolver = (hostname: string) => Promise<ReadonlyArray<string>>

export interface SafeFetchOptions {
  maxRedirects?: number
  timeoutMs?: number
  resolveHost?: HostResolver
}

export interface CappedBody {
  text: string
  truncated: boolean
}

function ipv4IsBlocked(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  )
}

function ipv6Bytes(address: string): number[] | null {
  const normalized = address.toLowerCase().split("%")[0]
  const groups = normalized.split("::")
  if (groups.length > 2) return null

  const parseGroups = (value: string): number[] => {
    if (!value) return []
    const result: number[] = []
    for (const group of value.split(":")) {
      if (group.includes(".")) {
        const octets = group.split(".").map(Number)
        if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return []
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return []
        result.push(parseInt(group, 16))
      }
    }
    return result
  }

  const left = parseGroups(groups[0])
  const right = groups.length === 2 ? parseGroups(groups[1]) : []
  if ((!left.length && groups[0]) || (!right.length && groups.length === 2 && groups[1])) return null
  if (groups.length === 1 && left.length !== 8) return null
  if (groups.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 1) return null
    return [...left, ...Array.from({ length: missing }, () => 0), ...right].flatMap((group) => [group >> 8, group & 0xff])
  }
  return left.flatMap((group) => [group >> 8, group & 0xff])
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]
  if (isIP(normalized) === 4) return ipv4IsBlocked(normalized)
  if (isIP(normalized) !== 6) return true

  const bytes = ipv6Bytes(normalized)
  if (!bytes || bytes.length !== 16) return true
  const mappedV4 = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 255 && bytes[11] === 255
  if (mappedV4) return ipv4IsBlocked(bytes.slice(12).join("."))

  const first = (bytes[0] << 8) | bytes[1]
  return (
    bytes.every((value) => value === 0) ||
    (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) ||
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link local
    (bytes[0] & 0xff) === 0xff // multicast
  )
}

function hostnameIsBlocked(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home.arpa")
  )
}

export async function validateSafeUrl(rawUrl: string, resolveHost: HostResolver = defaultResolveHost): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("URL inválida")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Solo se permiten URLs http(s)")
  if (url.username || url.password) throw new Error("La URL no puede incluir credenciales")

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (hostnameIsBlocked(hostname) || (isIP(hostname) !== 0 && isBlockedAddress(hostname))) {
    throw new Error("Destino de red bloqueado")
  }

  const addresses = await resolveHost(hostname)
  if (!addresses.length || addresses.some((address) => isBlockedAddress(address))) {
    throw new Error("Destino de red bloqueado")
  }
  return url
}

async function defaultResolveHost(hostname: string): Promise<ReadonlyArray<string>> {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

function redirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<{ response: Response; finalUrl: string; redirects: number }> {
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 8))
  const resolveHost = options.resolveHost || defaultResolveHost
  let current = await validateSafeUrl(rawUrl, resolveHost)
  let redirects = 0
  let requestInit: RequestInit = { ...init, redirect: "manual" }

  while (true) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000)
    const response = await fetch(current, { ...requestInit, signal: timeout })
    if (!redirectStatus(response.status)) return { response, finalUrl: current.toString(), redirects }

    const location = response.headers.get("location")
    if (!location) return { response, finalUrl: current.toString(), redirects }
    if (redirects >= maxRedirects) throw new Error("Demasiados redirects")

    const next = new URL(location, current)
    try { await response.body?.cancel() } catch { /* best effort */ }
    const method = String(requestInit.method || "GET").toUpperCase()
    const becomesGet = (response.status === 301 || response.status === 302 || response.status === 303) && method !== "GET" && method !== "HEAD"
    requestInit = becomesGet
      ? { ...requestInit, method: "GET", body: undefined, headers: (() => { const headers = new Headers(requestInit.headers); headers.delete("content-length"); return headers })() }
      : requestInit
    current = await validateSafeUrl(next.toString(), resolveHost)
    redirects += 1
  }
}

export async function readResponseCapped(response: Response, maxBytes: number): Promise<CappedBody> {
  const cap = Math.max(1, Math.floor(maxBytes))
  const contentLength = Number(response.headers.get("content-length") || 0)
  if (contentLength > cap) {
    try { await response.body?.cancel() } catch { /* best effort */ }
    return { text: "", truncated: true }
  }

  if (!response.body) return { text: "", truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      const remaining = cap - total
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(Buffer.from(value))
      total += value.byteLength
    }
  } finally {
    try { reader.releaseLock() } catch { /* best effort */ }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated }
}
