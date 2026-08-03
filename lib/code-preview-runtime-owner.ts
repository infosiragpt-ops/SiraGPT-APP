import { getNormalizedApiBaseUrl } from "./api-base-url"

export type PreviewRuntimeOwner =
  | { kind: "codex"; id: string }
  | { kind: "github"; id: string }
  | { kind: "host"; id: string }

export type PreviewRuntimeStops = {
  codex: (id: string) => unknown | Promise<unknown>
  github: (id: string) => unknown | Promise<unknown>
  host: (id: string) => unknown | Promise<unknown>
}

export function samePreviewRuntimeOwner(
  left: PreviewRuntimeOwner | null | undefined,
  right: PreviewRuntimeOwner | null | undefined,
): boolean {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id)
}

export async function stopPreviewRuntimeOwner(
  owner: PreviewRuntimeOwner | null | undefined,
  stops: PreviewRuntimeStops,
): Promise<void> {
  if (!owner) return
  await stops[owner.kind](owner.id)
}

export async function transitionPreviewRuntimeOwner(
  current: PreviewRuntimeOwner | null | undefined,
  next: PreviewRuntimeOwner,
  stops: PreviewRuntimeStops,
): Promise<PreviewRuntimeOwner> {
  if (current && !samePreviewRuntimeOwner(current, next)) {
    await stopPreviewRuntimeOwner(current, stops)
  }
  return next
}

export function previewRuntimeStopUrl(
  owner: PreviewRuntimeOwner,
  apiBaseUrl = getNormalizedApiBaseUrl(),
): string {
  const base = apiBaseUrl.replace(/\/+$/, "")
  const id = encodeURIComponent(owner.id)
  if (owner.kind === "codex") return `${base}/codex/projects/${id}/preview/stop`
  if (owner.kind === "github") return `${base}/github/connected/${id}/stop`
  return `${base}/code-runner/${id}/stop`
}

function readBrowserBearer(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem("auth-token")
  } catch {
    return null
  }
}

function readBrowserCsrf(): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export type PreviewRuntimeKeepaliveOptions = {
  apiBaseUrl?: string
  fetchImpl?: typeof fetch
  bearerToken?: string | null
  csrfToken?: string | null
}

export async function stopPreviewRuntimeOwnerKeepalive(
  owner: PreviewRuntimeOwner | null | undefined,
  options: PreviewRuntimeKeepaliveOptions = {},
): Promise<void> {
  if (!owner) return
  const headers = new Headers({ Accept: "application/json" })
  const bearer = options.bearerToken === undefined ? readBrowserBearer() : options.bearerToken
  const csrf = options.csrfToken === undefined ? readBrowserCsrf() : options.csrfToken
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
  else if (csrf) headers.set("X-CSRF-Token", csrf)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  await fetchImpl(previewRuntimeStopUrl(owner, options.apiBaseUrl), {
    method: "POST",
    credentials: "include",
    headers,
    keepalive: true,
  })
}
