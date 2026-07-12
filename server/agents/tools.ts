/**
 * server/agents/tools — real tool executor for the Enterprise Agents SDK.
 *
 * Mirrors Claude Code / Codex primitives (Read, Write, Edit, Bash, Glob, Grep,
 * WebSearch, WebFetch) against a per-session sandbox under the OS temp dir.
 * Never escapes the sandbox root. Tool failures return structured errors so
 * the agent loop can self-correct (Claude Code style).
 */

import { spawn } from "child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs"
import { join, resolve, relative, dirname, sep } from "path"
import { tmpdir } from "os"
import { createHash, randomBytes } from "crypto"

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 512 * 1024
const MAX_BASH_MS = 20_000
const MAX_BASH_OUTPUT = 64 * 1024
const MAX_GREP_HITS = 80
const MAX_GLOB_HITS = 200
const MAX_FETCH_BYTES = 120_000
const MAX_FETCH_MS = 12_000

const BASH_BLOCKLIST =
  /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|shutdown|reboot|halt|poweroff|useradd|userdel|passwd|chown\s+-R\s+\/|chmod\s+-R\s+777\s+\/|curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh|:\(\)\s*\{\s*:\|:&\s*\})/i

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

export function createWorkspace(sessionId?: string): AgentWorkspace {
  const id = safeId(sessionId)
  const root = join(tmpdir(), "siragpt-agent-sessions", id)
  mkdirSync(root, { recursive: true })
  // Seed a tiny README so list/glob always have something.
  const readme = join(root, "README.md")
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# SiraGPT Agent Workspace",
        "",
        "Sandbox aislado para el Agents SDK empresarial.",
        "El agente puede leer, escribir, editar y ejecutar comandos aquí.",
        "",
      ].join("\n"),
      "utf8",
    )
  }
  return { sessionId: id, root }
}

/** Resolve a user-supplied path strictly inside the workspace root. */
function resolveInRoot(root: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null
  const cleaned = filePath.replace(/\0/g, "").trim()
  if (!cleaned) return null
  // Treat absolute paths as relative to the sandbox root.
  const candidate = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned
  const abs = resolve(root, candidate)
  const rel = relative(root, abs)
  if (rel.startsWith("..") || rel === ".." || (rel !== "" && resolve(root, rel) !== abs)) return null
  if (abs !== root && !abs.startsWith(root + sep)) return null
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

async function runBash(command: string, cwd: string): Promise<ToolResult> {
  if (!command || !command.trim()) {
    return { ok: false, observation: "Error: command vacío.", summary: "empty command" }
  }
  if (BASH_BLOCKLIST.test(command)) {
    return {
      ok: false,
      observation: "Error: comando bloqueado por política de seguridad del sandbox.",
      summary: "blocked",
    }
  }

  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=512",
      PYTHONDONTWRITEBYTECODE: "1",
    }
    // Drop secrets from the sandboxed shell.
    for (const key of Object.keys(env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|PRIVATE/i.test(key) && key !== "PATH") {
        delete env[key]
      }
    }

    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"] as const,
    })

    let stdout = ""
    let stderr = ""
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }, MAX_BASH_MS)

    const onChunk = (buf: Buffer, which: "out" | "err") => {
      const s = buf.toString("utf8")
      if (which === "out") stdout = truncate(stdout + s, MAX_BASH_OUTPUT)
      else stderr = truncate(stderr + s, MAX_BASH_OUTPUT)
    }
    child.stdout?.on("data", (b: Buffer) => onChunk(b, "out"))
    child.stderr?.on("data", (b: Buffer) => onChunk(b, "err"))

    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      const body = [stdout, stderr].filter(Boolean).join("\n")
      const ok = !killed && code === 0
      resolvePromise({
        ok,
        summary: killed ? "timeout" : `exit ${code}`,
        observation: killed
          ? `Timeout (${MAX_BASH_MS}ms).\n${body}`
          : `exitCode=${code}\n${body || "(sin salida)"}`,
      })
    })
    child.on("error", (err: Error) => {
      clearTimeout(timer)
      resolvePromise({
        ok: false,
        summary: "spawn error",
        observation: `Error ejecutando bash: ${err.message}`,
      })
    })
  })
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
    const res = await fetch(url, {
      headers: { "User-Agent": "SiraGPT-AgentsSDK/0.2 (+https://siragpt.com)" },
      signal: AbortSignal.timeout(MAX_FETCH_MS),
    })
    if (!res.ok) {
      return {
        ok: false,
        summary: `http ${res.status}`,
        observation: `web_search falló con HTTP ${res.status}. Reformula la query o usa web_fetch con una URL conocida.`,
      }
    }
    const data = (await res.json()) as {
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
    const res = await fetch(u, {
      headers: { "User-Agent": "SiraGPT-AgentsSDK/0.2 (+https://siragpt.com)", Accept: "text/html,application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(MAX_FETCH_MS),
      redirect: "follow",
    })
    const ctype = res.headers.get("content-type") || ""
    const buf = Buffer.from(await res.arrayBuffer())
    const sliced = buf.subarray(0, MAX_FETCH_BYTES).toString("utf8")
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
      summary: `HTTP ${res.status} · ${ctype.split(";")[0] || "unknown"}`,
      observation: `HTTP ${res.status} ${res.statusText}\nContent-Type: ${ctype}\n\n${truncate(text, MAX_FETCH_BYTES)}`,
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
): Promise<ToolResult> {
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
        mkdirSync(dirname(abs), { recursive: true })
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
      return runBash(String(args.command || ""), workspace.root)
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
      const searchRoot = resolveInRoot(workspace.root, String(args.path || ".")) || workspace.root
      const files: string[] = []
      if (existsSync(searchRoot) && statSync(searchRoot).isFile()) {
        files.push(relative(workspace.root, searchRoot).split(sep).join("/"))
      } else {
        walkFiles(workspace.root, searchRoot, files, 500)
      }
      const hits: string[] = []
      for (const rel of files) {
        if (hits.length >= MAX_GREP_HITS) break
        const abs = join(workspace.root, rel)
        try {
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
      // Handled by the run loop (subagent.ts). Should not reach here.
      return {
        ok: false,
        observation: "spawn_subagent se gestiona en el loop principal.",
        summary: "delegated",
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

export function listWorkspaceFiles(workspace: AgentWorkspace, max = 100): string[] {
  const files: string[] = []
  walkFiles(workspace.root, workspace.root, files, max)
  return files
}
