/**
 * ChatGPT-style @ mentions for Apps in the /agentes composer.
 *
 * Pure helpers: detect the live `@query` token, resolve catalog apps,
 * group Conectadas vs Conectar vs no-disponibles, and build the
 * generate payload. Tokens never leave this layer.
 */

import {
  isHealthConnected,
  resolveFirstPartyProvider,
  type ConnectableApp,
} from "@/lib/gpts-apps-connect"
import { GPT_STORE_APPS, type GptStoreApp } from "@/lib/gpts-apps-catalog"

export const MENTION_COPY = {
  connectedGroup: "Conectadas",
  connectGroup: "Conectar",
  unavailableGroup: "Aún no disponibles",
  empty: "No hay apps para esta búsqueda",
  hint: "↑↓ navegar · Enter seleccionar · Esc cerrar",
  connected: "Conectada",
  connect: "Conectar",
  unavailable: "No disponible todavía",
  unavailableDetail: (name: string) =>
    `${name} todavía no se puede conectar. No abre el navegador ni queda marcada como Conectada.`,
  connectPrompt: (name: string) =>
    `${name} no está conectada. Conéctala con la autorización oficial para usarla en este chat.`,
} as const

/** Phase-1 OAuth connectors. Facebook stays in this set but is key-gated server-side. */
export const REAL_CONNECTOR_IDS = Object.freeze(["github", "linkedin", "x", "facebook"] as const)

const ALIASES: Record<string, string> = {
  github: "github",
  gh: "github",
  git: "github",
  linkedin: "linkedin",
  "linked-in": "linkedin",
  li: "linkedin",
  x: "x",
  twitter: "x",
  tweet: "x",
  facebook: "facebook",
  fb: "facebook",
  meta: "facebook",
}

export type MentionTrigger = {
  start: number
  query: string
}

export type MentionAppStatus = "connected" | "connect" | "unavailable"

export type MentionPickerApp = {
  id: string
  name: string
  description: string
  domain: string
  status: MentionAppStatus
  healthStatus: string | null
}

export type MentionedAppPayload = {
  mentionedApps: string[]
  connectedAppIds: string[]
  needsConnect: Array<{ id: string; name: string }>
  unavailable: Array<{ id: string; name: string }>
}

export function normalizeMentionKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
}

export function canonicalAppId(value: string): string | null {
  const raw = String(value || "").trim().toLowerCase()
  if (!raw) return null
  if (ALIASES[raw]) return ALIASES[raw]
  const compact = normalizeMentionKey(raw)
  if (ALIASES[compact]) return ALIASES[compact]
  const fromCatalog = GPT_STORE_APPS.find((app) => (
    normalizeMentionKey(app.id) === compact
    || normalizeMentionKey(app.name) === compact
  ))
  if (fromCatalog) {
    const provider = resolveFirstPartyProvider(fromCatalog)
    if (provider === "x" || provider === "linkedin" || provider === "github" || provider === "facebook") {
      return provider
    }
    return fromCatalog.id
  }
  return compact || null
}

export function isRealConnector(app: ConnectableApp): boolean {
  const provider = resolveFirstPartyProvider(app)
  if (provider === "github" || provider === "linkedin" || provider === "x" || provider === "facebook") {
    return true
  }
  const id = canonicalAppId(app.id)
  return Boolean(id && (REAL_CONNECTOR_IDS as readonly string[]).includes(id))
}

/**
 * Live `@query` token at the caret. Ignores emails (`luis@siragpt.com`)
 * because `@` must start a token (start of input or after whitespace).
 */
export function detectAtMention(input: string, caret?: number): MentionTrigger | null {
  const text = String(input || "")
  const pos = Number.isFinite(caret) ? Math.max(0, Math.min(text.length, Number(caret))) : text.length
  const before = text.slice(0, pos)
  const match = before.match(/(^|[\s\u00A0])@([^\s@]*)$/)
  if (!match) return null
  const atIndex = before.lastIndexOf("@")
  if (atIndex < 0) return null
  return { start: atIndex, query: match[2] || "" }
}

export function parseMentionedNames(input: string): string[] {
  const names: string[] = []
  const re = /(^|[\s\u00A0])@([A-Za-z0-9][A-Za-z0-9._-]*)/g
  let match: RegExpExecArray | null
  const text = String(input || "")
  while ((match = re.exec(text))) {
    names.push(match[2])
  }
  return names
}

export function insertMention(input: string, trigger: MentionTrigger | null, name: string): string {
  const token = `@${name}`
  if (!trigger) {
    const trimmed = String(input || "")
    if (!trimmed) return `${token} `
    return /[\s\u00A0]$/.test(trimmed) ? `${trimmed}${token} ` : `${trimmed} ${token} `
  }
  const before = input.slice(0, trigger.start)
  const after = input.slice(trigger.start + 1 + trigger.query.length)
  const spacer = after.startsWith(" ") || after.startsWith("\n") ? "" : " "
  return `${before}${token}${spacer}${after}`
}

export function mentionStatusFor(
  app: ConnectableApp,
  healthById: Record<string, string | null | undefined> = {},
): MentionAppStatus {
  const id = canonicalAppId(app.id) || app.id
  if (isHealthConnected(healthById[id] || healthById[app.id])) return "connected"
  if (isRealConnector(app)) return "connect"
  return "unavailable"
}

export function toPickerApp(
  app: GptStoreApp,
  healthById: Record<string, string | null | undefined> = {},
): MentionPickerApp {
  const id = canonicalAppId(app.id) || app.id
  const health = healthById[id] || healthById[app.id] || null
  return {
    id,
    name: app.name,
    description: app.description,
    domain: app.domain,
    status: mentionStatusFor({ id, name: app.name, domain: app.domain }, healthById),
    healthStatus: health,
  }
}

export function buildPickerApps(
  healthById: Record<string, string | null | undefined> = {},
  catalog: GptStoreApp[] = GPT_STORE_APPS,
): MentionPickerApp[] {
  const seen = new Set<string>()
  const items: MentionPickerApp[] = []
  for (const app of catalog) {
    const item = toPickerApp(app, healthById)
    if (seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return items
}

export function filterPickerApps(apps: MentionPickerApp[], query: string): MentionPickerApp[] {
  const q = normalizeMentionKey(query)
  if (!q) return apps
  return apps.filter((app) => (
    normalizeMentionKey(app.name).includes(q)
    || normalizeMentionKey(app.id).includes(q)
    || normalizeMentionKey(app.description).includes(q)
  ))
}

export function groupPickerApps(apps: MentionPickerApp[]): {
  connected: MentionPickerApp[]
  connect: MentionPickerApp[]
  unavailable: MentionPickerApp[]
  flat: MentionPickerApp[]
} {
  const connected = apps.filter((app) => app.status === "connected")
  const connect = apps.filter((app) => app.status === "connect")
  const unavailable = apps.filter((app) => app.status === "unavailable")
  return {
    connected,
    connect,
    unavailable,
    flat: [...connected, ...connect, ...unavailable],
  }
}

export function resolveMentionedApps(
  prompt: string,
  selectedIds: string[] = [],
  healthById: Record<string, string | null | undefined> = {},
  catalog: GptStoreApp[] = GPT_STORE_APPS,
): MentionedAppPayload {
  const picker = buildPickerApps(healthById, catalog)
  const byId = new Map(picker.map((app) => [app.id, app]))
  const byName = new Map(picker.map((app) => [normalizeMentionKey(app.name), app]))

  const ids = new Set<string>()
  for (const raw of selectedIds) {
    const id = canonicalAppId(raw)
    if (id) ids.add(id)
  }
  for (const name of parseMentionedNames(prompt)) {
    const id = canonicalAppId(name)
    const fromName = byName.get(normalizeMentionKey(name))
    if (fromName) ids.add(fromName.id)
    else if (id && byId.has(id)) ids.add(id)
    else if (id) ids.add(id)
  }

  const mentionedApps = [...ids]
  const connectedAppIds: string[] = []
  const needsConnect: Array<{ id: string; name: string }> = []
  const unavailable: Array<{ id: string; name: string }> = []

  for (const id of mentionedApps) {
    const app = byId.get(id)
    const name = app?.name || id
    const status = app?.status || mentionStatusFor({ id, name, domain: "" }, healthById)
    if (status === "connected") connectedAppIds.push(id)
    else if (status === "connect") needsConnect.push({ id, name })
    else unavailable.push({ id, name })
  }

  return { mentionedApps, connectedAppIds, needsConnect, unavailable }
}

export function mentionPayloadForGenerate(
  prompt: string,
  selectedIds: string[] = [],
  healthById: Record<string, string | null | undefined> = {},
): { mentionedApps: string[] } {
  return { mentionedApps: resolveMentionedApps(prompt, selectedIds, healthById).mentionedApps }
}
