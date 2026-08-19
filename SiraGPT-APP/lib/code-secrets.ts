"use client"

import type { CodeFiles } from "./code-workspace-utils"

export type CodeSecretEntry = {
  id: string
  key: string
  value: string
  scope: "app" | "account"
  updatedAt: number
  linked?: boolean
  source?: "manual" | "detected" | "env-file"
}

export type EnvKeyHint = {
  key: string
  source: "env-file" | "env-template" | "code-reference"
  path?: string
  hasValue: boolean
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_TOOL_SUFFIX = "secrets"
const ENV_FILE_RE = /(^|\/)\.env(?:\.(?!example$|sample$|template$|defaults$)[A-Za-z0-9_-]+)*$/i
const ENV_TEMPLATE_RE = /(^|\/)\.env(?:\.(?:example|sample|template|defaults))?$|(^|\/)env\.example$/i
const CODE_ENV_PATTERNS = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
  /\bprocess\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
  /\bimport\.meta\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
]

function makeSecretId(prefix = "secret") {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function codeSecretsStorageKey(folderId?: string | null) {
  return `siragpt:code-tool:${folderId || "default"}:${SECRET_TOOL_SUFFIX}`
}

export function normalizeEnvKey(raw: string) {
  const key = String(raw || "").trim()
  return ENV_KEY_RE.test(key) ? key.toUpperCase() : ""
}

/** Parse pasted .env text into {key,value} (handles `export`, #comments, quotes). */
export function parseDotenvText(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice(7).trim()
    const eq = line.indexOf("=")
    if (eq < 1) continue
    const key = normalizeEnvKey(line.slice(0, eq))
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    const commentIdx = value.search(/\s+#/)
    if (commentIdx >= 0 && !/^['"]/.test(value)) value = value.slice(0, commentIdx).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out.push({ key, value })
  }
  return out
}

export function isRuntimeEnvFile(path: string) {
  return ENV_FILE_RE.test(path.replace(/\\/g, "/"))
}

export function isEnvTemplateFile(path: string) {
  return ENV_TEMPLATE_RE.test(path.replace(/\\/g, "/"))
}

export function detectEnvKeyHints(files: CodeFiles): EnvKeyHint[] {
  const hints = new Map<string, EnvKeyHint>()
  const add = (key: string, source: EnvKeyHint["source"], path: string | undefined, hasValue = false) => {
    const normal = normalizeEnvKey(key)
    if (!normal) return
    const prev = hints.get(normal)
    if (!prev || (source === "env-file" && prev.source !== "env-file")) {
      hints.set(normal, { key: normal, source, path, hasValue: prev?.hasValue || hasValue })
    } else if (hasValue && !prev.hasValue) {
      hints.set(normal, { ...prev, hasValue: true })
    }
  }

  for (const file of Object.values(files || {})) {
    const path = file?.path || ""
    const content = file?.content || ""
    if (!path || !content) continue

    if (isRuntimeEnvFile(path) || isEnvTemplateFile(path)) {
      for (const pair of parseDotenvText(content)) {
        add(pair.key, isRuntimeEnvFile(path) ? "env-file" : "env-template", path, Boolean(pair.value))
      }
      continue
    }

    if (!/\.(?:[cm]?[jt]sx?|tsx?|mjs|cjs|py|rb|go|java|kt|swift|php|mdx?)$/i.test(path)) continue
    for (const re of CODE_ENV_PATTERNS) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(content))) add(match[1], "code-reference", path)
    }
  }

  return Array.from(hints.values()).sort((a, b) => a.key.localeCompare(b.key))
}

export function detectDotenvSecrets(files: CodeFiles) {
  const entries: Array<{ key: string; value: string; path: string }> = []
  for (const file of Object.values(files || {})) {
    if (!file?.path || !isRuntimeEnvFile(file.path)) continue
    for (const pair of parseDotenvText(file.content || "")) {
      if (pair.value) entries.push({ ...pair, path: file.path })
    }
  }
  return entries
}

export function mergeSecretEntries(
  current: CodeSecretEntry[],
  detected: Array<{ key: string; value?: string; source?: CodeSecretEntry["source"] }>,
  opts: { overwrite?: boolean } = {},
) {
  const next = [...current]
  for (const item of detected) {
    const key = normalizeEnvKey(item.key)
    if (!key) continue
    const idx = next.findIndex((s) => s.key === key)
    if (idx >= 0) {
      const shouldWriteValue = item.value !== undefined && (opts.overwrite || !next[idx].value)
      next[idx] = {
        ...next[idx],
        value: shouldWriteValue ? item.value || "" : next[idx].value,
        source: item.source || next[idx].source,
        updatedAt: Date.now(),
      }
    } else {
      next.unshift({
        id: makeSecretId(item.value ? "env" : "detected"),
        key,
        value: item.value || "",
        scope: "app",
        updatedAt: Date.now(),
        source: item.source || (item.value ? "env-file" : "detected"),
      })
    }
  }
  return next
}

export function readWorkspaceSecrets(folderId?: string | null): CodeSecretEntry[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(codeSecretsStorageKey(folderId)) || "[]")
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.key === "string") : []
  } catch {
    return []
  }
}

export function workspaceSecretsStoreExists(folderId?: string | null) {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(codeSecretsStorageKey(folderId)) !== null
  } catch {
    return false
  }
}

export function buildRuntimeEnv(folderId: string | null | undefined, _files: CodeFiles) {
  const env: Record<string, string> = {}
  for (const s of readWorkspaceSecrets(folderId)) {
    const key = normalizeEnvKey(s.key)
    if (key && s.value) env[key] = String(s.value)
  }
  return env
}
