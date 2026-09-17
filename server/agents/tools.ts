/**
 * server/agents/tools — real tool executor for the Enterprise Agents SDK.
 *
 * Mirrors Claude Code / Codex primitives (Read, Write, Edit, Bash, Glob, Grep,
 * WebSearch, WebFetch) against a per-session sandbox under the OS temp dir.
 * Never escapes the sandbox root. Tool failures return structured errors so
 * the agent loop can self-correct (Claude Code style).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from "fs"
import { join, resolve, relative, dirname, sep } from "path"
import { tmpdir } from "os"
import { createHash, randomBytes } from "crypto"
import { readResponseCapped, safeFetch } from "./safe-network"

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 512 * 1024
const MAX_GREP_HITS = 80
const MAX_GLOB_HITS = 200
const MAX_FETCH_BYTES = 120_000
const MAX_FETCH_MS = 12_000

export const AGENT_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "spawn_subagent",
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

export interface ToolResult {
  ok: boolean
  observation: string
  summary?: string
}

export interface AgentWorkspace {
  sessionId: string
  root: string
}

function safeId(raw?: string): string {
  const cleaned = String(raw || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48)
  if (cleaned.length >= 8) return cleaned
  return randomBytes(8).toString("hex")
}

export function createWorkspace(sessionId?: string, ownerId?: string): AgentWorkspace {
  const normalizedOwnerId = String(ownerId || "").trim()
  if (!normalizedOwnerId) throw new Error("workspace owner required")
  const ownerNamespace = createHash("sha256")
    .update("siragpt-agent-owner:v1\0")
    .update(normalizedOwnerId)
    .digest("hex")
    .slice(0, 32)
  let effectiveId = safeId(sessionId)
  const base = join(tmpdir(), "siragpt-agent-sessions")
  mkdirSync(base, { recursive: true })
  const ownerRoot = join(base, ownerNamespace)
  if (existsSync(ownerRoot) && (lstatSync(ownerRoot).isSymbolicLink() || !lstatSync(ownerRoot).isDirectory())) {
    throw new Error("unsafe workspace owner root")
  }
  mkdirSync(ownerRoot, { recursive: true })
  const baseReal = realpathSync(base)
  const ownerReal = realpathSync(ownerRoot)
  const expectedOwnerReal = join(baseReal, ownerNamespace)
  if (ownerReal !== expectedOwnerReal || (ownerReal !== baseReal && !ownerReal.startsWith(baseReal + sep))) {
    throw new Error("unsafe workspace owner root")
  }
  let root = join(ownerRoot, effectiveId)
  try {
    if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) {
      throw new Error("unsafe workspace root")
    }
    mkdirSync(root, { recursive: true })
    const rootReal = realpathSync(root)
    if (rootReal !== ownerReal && !rootReal.startsWith(ownerReal + sep)) throw new Error("workspace escaped owner")
    if (rootReal !== baseReal && !rootReal.startsWith(baseReal + sep)) throw new Error("workspace escaped base")
    root = rootReal
  } catch {
    // A user-controlled session id must never reuse a planted symlink or file.
    const fallbackId = randomBytes(12).toString("hex")
    effectiveId = fallbackId
    const fallbackRoot = join(ownerRoot, fallbackId)
    mkdirSync(fallbackRoot, { recursive: true })
    const fallbackReal = realpathSync(fallbackRoot)
    if (fallbackReal !== ownerReal && !fallbackReal.startsWith(ownerReal + sep)) throw new Error("workspace escaped owner")
    if (fallbackReal !== baseReal && !fallbackReal.startsWith(baseReal + sep)) throw new Error("workspace escaped base")
    root = fallbackReal
  }
  // Seed a tiny README so list/glob always have something.
  const readme = join(root, "README.md")
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# SiraGPT Agent Workspace",
        "",
        "Sandbox aislado para el Agents SDK empresarial.",
        "El agente solo puede usar las herramientas autorizadas dentro de este workspace.",
        "",
      ].join("\n"),
      "utf8",
    )
  }
  return { sessionId: effectiveId, root }
}

/** Resolve a user-supplied path strictly inside the workspace root. */
function resolveInRoot(root: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null
  const cleaned = filePath.replace(/\0/g, "").trim()
  if (!cleaned) return null
  // Treat absolute paths as relative to the sandbox root.
  const candidate = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, candidate)
  const rel = relative(rootAbs, abs)
  if (rel.startsWith("..") || rel === ".." || (rel !== "" && resolve(rootAbs, rel) !== abs)) return null
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null

  let rootReal: string
  try {
    rootReal = realpathSync(rootAbs)
    if (lstatSync(rootAbs).isSymbolicLink()) return null
  } catch {
    return null
  }

  // Inspect every existing component with lstat. realpath containment alone
  // would still allow a symlink that happens to point back inside the root.
  let cursor = rootAbs
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      return null
    }
  }

  // For a new write, resolve the nearest existing parent so a symlinked
  // parent cannot redirect mkdir/write outside the sandbox.
  let existing = abs
  while (existing !== rootAbs) {
    try {
      const real = realpathSync(existing)
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null
      existing = dirname(existing)
    }
  }
  return abs
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[+${text.length - max} chars]`
}

function walkFiles(root: string, dir: string, acc: string[], max: number): void {
  if (acc.length >= max) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (acc.length >= max) return
    if (name === "node_modules" || name === ".git" || name === ".next" || name === "dist") continue
    const full = join(dir, name)
    let st
    try {
      const lst = lstatSync(full)
      if (lst.isSymbolicLink()) continue
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(root, full, acc, max)
    else if (st.isFile()) acc.push(relative(root, full).split(sep).join("/"))
  }
}

function matchGlob(relPath: string, pattern: string): boolean {
  // Minimal glob: ** / * / ?
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "‹DG›")
    .replace(/\*\*/g, "‹D›")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/‹DG›/g, "(?:.*/)?")
    .replace(/‹D›/g, ".*")
  try {
    return new RegExp("^" + escaped + "$").test(relPath)
  } catch {
    return relPath.includes(pattern.replace(/\*/g, ""))
  }
}

async function webSearch(query: string): Promise<ToolResult> {
  const q = String(query || "").trim()
  if (!q) return { ok: false, observation: "Error: query vacío.", summary: "empty query" }

  // DuckDuckGo Instant Answer (no key). Best-effort research surface.
  const url =
    "https://api.duckduckgo.com/?q=" +
    encodeURIComponent(q) +
    "&format=json&no_html=1&skip_disambig=1"
  try {
    const { response: res } = await safeFetch(url, {
      headers: { "User-Agent": "SiraGPT-AgentsSDK/0.2 (+https://siragpt.com)" },
    }, { maxRedirects: 2, timeoutMs: MAX_FETCH_MS })
    if (!res.ok) {
      return {
        ok: false,
        summary: `http ${res.status}`,
        observation: `web_search falló con HTTP ${res.status}. Reformula la query o usa web_fetch con una URL conocida.`,
      }
    }
    const body = await readResponseCapped(res, MAX_FETCH_BYTES)
    if (body.truncated) {
      return { ok: false, summary: "response too large", observation: "web_search excedió el límite de respuesta." }
    }
    const data = JSON.parse(body.text) as {
      AbstractText?: string
      AbstractURL?: string
      Heading?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
      Results?: Array<{ Text?: string; FirstURL?: string }>
    }
    const lines: string[] = []
    if (data.Heading) lines.push(`# ${data.Heading}`)
    if (data.AbstractText) {
      lines.push(data.AbstractText)
      if (data.AbstractURL) lines.push(`Fuente: ${data.AbstractURL}`)
    }
    const related: string[] = []
    for (const t of data.RelatedTopics || []) {
      if (t.Text && t.FirstURL) related.push(`- ${t.Text} (${t.FirstURL})`)
      for (const st of t.Topics || []) {
        if (st.Text && st.FirstURL) related.push(`- ${st.Text} (${st.FirstURL})`)
      }
    }
    for (const r of data.Results || []) {
      if (r.Text && r.FirstURL) related.push(`- ${r.Text} (${r.FirstURL})`)
    }
    if (related.length) {
      lines.push("", "Resultados relacionados:")
      lines.push(...related.slice(0, 12))
    }
    if (!lines.length) {
      return {
        ok: true,
        summary: "sin resultados ricos",
        observation:
          `Sin abstracto para "${q}". Intenta web_fetch sobre una URL concreta o reformula la búsqueda.`,
      }
    }
    return { ok: true, summary: `${related.length} hits`, observation: lines.join("\n") }
  } catch (err) {
    return {
      ok: false,
      summary: "network error",
      observation: `web_search error: ${String((err as Error)?.message || err)}`,
    }
  }
}

async function webFetch(url: string): Promise<ToolResult> {
  const u = String(url || "").trim()
  if (!/^https?:\/\//i.test(u)) {
    return { ok: false, observation: "Error: URL debe ser http(s).", summary: "bad url" }
  }
  try {
    const { response: res, finalUrl, redirects } = await safeFetch(u, {
      headers: { "User-Agent": "SiraGPT-AgentsSDK/0.2 (+https://siragpt.com)", Accept: "text/html,application/json,text/plain,*/*" },
    }, { maxRedirects: 4, timeoutMs: MAX_FETCH_MS })
    const ctype = res.headers.get("content-type") || ""
    const body = await readResponseCapped(res, MAX_FETCH_BYTES)
    const sliced = body.text
    // Strip tags for HTML to keep token cost down.
    let text = sliced
    if (ctype.includes("html")) {
      text = sliced
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    }
    return {
      ok: res.ok,
      summary: `HTTP ${res.status} · ${ctype.split(";")[0] || "unknown"}${redirects ? ` · ${redirects} redirects` : ""}`,
      observation: `HTTP ${res.status} ${res.statusText}\nURL final: ${finalUrl}\nContent-Type: ${ctype}\n\n${truncate(text, MAX_FETCH_BYTES)}${body.truncated ? `\n…[respuesta limitada a ${MAX_FETCH_BYTES} bytes]` : ""}`,
    }
  } catch (err) {
    return {
      ok: false,
      summary: "fetch error",
      observation: `web_fetch error: ${String((err as Error)?.message || err)}`,
    }
  }
}

export async function executeTool(
  name: string,
  argsRaw: string | Record<string, unknown>,
  workspace: AgentWorkspace,
  allowedTools?: ReadonlySet<string>,
): Promise<ToolResult> {
  if (allowedTools && !allowedTools.has(name)) {
    return { ok: false, observation: `Error: herramienta no permitida para este agent role: "${name}".`, summary: "tool denied" }
  }
  let args: Record<string, unknown> = {}
  try {
    args = typeof argsRaw === "string" ? (JSON.parse(argsRaw || "{}") as Record<string, unknown>) : argsRaw || {}
  } catch {
    return { ok: false, observation: "Error: argumentos JSON inválidos.", summary: "bad json" }
  }

  switch (name) {
    case "read": {
      const abs = resolveInRoot(workspace.root, String(args.file_path || args.path || ""))
      if (!abs) return { ok: false, observation: "Error: ruta fuera del sandbox.", summary: "path denied" }
      if (!existsSync(abs)) return { ok: false, observation: `Error: no existe ${args.file_path}`, summary: "not found" }
      try {
        const st = statSync(abs)
        if (!st.isFile()) return { ok: false, observation: "Error: no es un archivo.", summary: "not a file" }
        const buf = readFileSync(abs)
        const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8")
        return {
          ok: true,
          summary: `${st.size} bytes`,
          observation: truncate(text, MAX_READ_BYTES),
        }
      } catch (err) {
        return { ok: false, observation: `read error: ${(err as Error).message}`, summary: "read error" }
      }
    }

    case "write": {
      const abs = resolveInRoot(workspace.root, String(args.file_path || args.path || ""))
      if (!abs) return { ok: false, observation: "Error: ruta fuera del sandbox.", summary: "path denied" }
      const content = String(args.content ?? "")
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return { ok: false, observation: `Error: contenido > ${MAX_WRITE_BYTES} bytes.`, summary: "too large" }
      }
      try {
        const expectedHash = readExpectedHash(args)
        const before = existsSync(abs) ? readFileSync(abs) : null
        const beforeHash = before ? sha256(before) : null
        if (expectedHash && beforeHash !== expectedHash) {
          return { ok: false, observation: "Error: hash de precondición no coincide; relee el archivo.", summary: "precondition failed" }
        }
        if (before && sha256(readFileSync(abs)) !== beforeHash) {
          return { ok: false, observation: "Error: el archivo cambió durante la lectura; reintenta con una lectura nueva.", summary: "concurrent change" }
        }
        mkdirSync(dirname(abs), { recursive: true })
        if (!resolveInRoot(workspace.root, String(args.file_path || args.path || ""))) {
          return { ok: false, observation: "Error: ruta fuera del sandbox o contiene symlink.", summary: "path denied" }
        }
        writeFileSync(abs, content, "utf8")
        return {
          ok: true,
          summary: `wrote ${Buffer.byteLength(content, "utf8")} bytes`,
          observation: `Archivo escrito: ${relative(workspace.root, abs).split(sep).join("/")} (${Buffer.byteLength(content, "utf8")} bytes)`,
        }
      } catch (err) {
        return { ok: false, observation: `write error: ${(err as Error).message}`, summary: "write error" }
      }
    }

    case "edit": {
      const abs = resolveInRoot(workspace.root, String(args.file_path || args.path || ""))
      if (!abs) return { ok: false, observation: "Error: ruta fuera del sandbox.", summary: "path denied" }
      if (!existsSync(abs)) return { ok: false, observation: `Error: no existe ${args.file_path}`, summary: "not found" }
      const oldStr = String(args.old_string ?? "")
      const newStr = String(args.new_string ?? "")
      if (!oldStr) return { ok: false, observation: "Error: old_string vacío.", summary: "empty old_string" }
      try {
        const current = readFileSync(abs, "utf8")
        const currentHash = sha256(Buffer.from(current, "utf8"))
        const expectedHash = readExpectedHash(args)
        if (expectedHash && expectedHash !== currentHash) {
          return { ok: false, observation: "Error: hash de precondición no coincide; relee el archivo.", summary: "precondition failed" }
        }
        const count = current.split(oldStr).length - 1
        if (count === 0) {
          return {
            ok: false,
            observation: "Error: old_string no encontrado en el archivo. Relee el archivo.",
            summary: "no match",
          }
        }
        if (count > 1) {
          return {
            ok: false,
            observation: `Error: old_string aparece ${count} veces; hazlo único.`,
            summary: "ambiguous match",
          }
        }
        const next = current.replace(oldStr, newStr)
        if (Buffer.byteLength(next, "utf8") > MAX_WRITE_BYTES) {
          return { ok: false, observation: `Error: contenido > ${MAX_WRITE_BYTES} bytes.`, summary: "too large" }
        }
        if (sha256(readFileSync(abs)) !== currentHash) {
          return { ok: false, observation: "Error: el archivo cambió durante la lectura; reintenta con una lectura nueva.", summary: "concurrent change" }
        }
        writeFileSync(abs, next, "utf8")
        return {
          ok: true,
          summary: "1 replacement",
          observation: `Editado: ${relative(workspace.root, abs).split(sep).join("/")}`,
        }
      } catch (err) {
        return { ok: false, observation: `edit error: ${(err as Error).message}`, summary: "edit error" }
      }
    }

    case "bash": {
      return { ok: false, observation: "Error: bash deshabilitado; no existe un boundary aislado atestado.", summary: "bash denied" }
    }

    case "glob": {
      const pattern = String(args.pattern || "**/*")
      const files: string[] = []
      walkFiles(workspace.root, workspace.root, files, MAX_GLOB_HITS * 4)
      const hits = files.filter((f) => matchGlob(f, pattern)).slice(0, MAX_GLOB_HITS)
      return {
        ok: true,
        summary: `${hits.length} files`,
        observation: hits.length ? hits.join("\n") : `(sin coincidencias para ${pattern})`,
      }
    }

    case "grep": {
      const pattern = String(args.pattern || "")
      if (!pattern) return { ok: false, observation: "Error: pattern vacío.", summary: "empty pattern" }
      let re: RegExp
      try {
        re = new RegExp(pattern, "i")
      } catch {
        return { ok: false, observation: "Error: regex inválido.", summary: "bad regex" }
      }
      const searchRoot = resolveInRoot(workspace.root, String(args.path || "."))
      if (!searchRoot) return { ok: false, observation: "Error: ruta fuera del sandbox o contiene symlink.", summary: "path denied" }
      const files: string[] = []
      if (existsSync(searchRoot) && !lstatSync(searchRoot).isSymbolicLink() && statSync(searchRoot).isFile()) {
        files.push(relative(workspace.root, searchRoot).split(sep).join("/"))
      } else {
        walkFiles(workspace.root, searchRoot, files, 500)
      }
      const hits: string[] = []
      for (const rel of files) {
        if (hits.length >= MAX_GREP_HITS) break
        const abs = join(workspace.root, rel)
        try {
          if (lstatSync(abs).isSymbolicLink()) continue
          const st = statSync(abs)
          if (st.size > MAX_READ_BYTES) continue
          const text = readFileSync(abs, "utf8")
          const lines = text.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= MAX_GREP_HITS) break
            if (re.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i].slice(0, 240)}`)
          }
        } catch {
          /* skip binary/unreadable */
        }
      }
      return {
        ok: true,
        summary: `${hits.length} hits`,
        observation: hits.length ? hits.join("\n") : `(sin coincidencias para /${pattern}/)`,
      }
    }

    case "web_search":
      return webSearch(String(args.query || ""))

    case "web_fetch":
      return webFetch(String(args.url || ""))

    case "spawn_subagent": {
      return {
        ok: false,
        observation: "Error: spawn_subagent deshabilitado; no existe un boundary aislado atestado.",
        summary: "subagent denied",
      }
    }

    default:
      return {
        ok: false,
        observation: `Error: herramienta desconocida "${name}".`,
        summary: "unknown tool",
      }
  }
}

export function workspaceFingerprint(workspace: AgentWorkspace): string {
  const files: string[] = []
  walkFiles(workspace.root, workspace.root, files, 50)
  return createHash("sha1").update(files.join("|")).digest("hex").slice(0, 12)
}

export function getEffectiveToolAllowSet(toolConfig: Record<string, boolean>): ReadonlySet<string> {
  return new Set(AGENT_TOOL_NAMES.filter((name) =>
    name !== "bash" && name !== "spawn_subagent" && toolConfig[name] === true,
  ))
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function readExpectedHash(args: Record<string, unknown>): string | null {
  const raw = args.expected_sha256 ?? args.expected_hash
  if (raw === undefined || raw === null || raw === "") return null
  const hash = String(raw).trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "invalid"
}

export function listWorkspaceFiles(workspace: AgentWorkspace, max = 100): string[] {
  const files: string[] = []
  walkFiles(workspace.root, workspace.root, files, max)
  return files
}
