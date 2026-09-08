"use client"

/**
 * TerminalPanel — the integrated Shell. It has two modes:
 *
 *  REAL — when a host dev server is live (preview-pane broadcasts its runId via
 *  CODE_RUNNER_ACTIVE_EVENT), every command runs for real in that run's
 *  workspace dir on the server (POST /api/code-runner/:runId/exec, owner-gated,
 *  bounded: non-interactive, hard timeout, output capped). `ls`, `cat`,
 *  `npm run build`, `node -v`, `git status`, … all work against the actual
 *  installed project. A green "● real" badge marks this mode.
 *
 *  PSEUDO — with no live run, it falls back to a small client-side REPL over the
 *  in-memory workspace (ls/dir/cat/pwd/echo/node --version) so the surface still
 *  feels alive. `clear` and `js <expr>` (a Function() sandbox) are client-side
 *  in both modes. An "○ local" badge marks this mode.
 */

import * as React from "react"
import { ChevronDown, Search, Trash2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  CODE_ACTIVE_CODEX_PROJECT_EVENT,
  CODE_ACTIVE_DEPARTMENT_COMPUTER_EVENT,
  CODE_RUNNER_ACTIVE_EVENT,
  getActiveCodexProject,
  getActiveDepartmentComputer,
  getActiveHostRunId,
  setActiveHostRunId,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import { codexProjectIdFromWorkspaceId } from "@/lib/codex-workspace-identity"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"
import { buildRuntimeEnv } from "@/lib/code-secrets"
import { codexApi } from "@/lib/codex/codex-api"

export type TerminalPanelProps = {
  open: boolean
  onClose: () => void
}

type Line = { id: string; kind: "in" | "out" | "err" | "info"; text: string }

const PROMPT = "~/workspace$"
const TERMINAL_SURFACE = "#fbfbfa"
const TERMINAL_HEADER = "#f6f5f2"
const TERMINAL_TEXT = "#151515"
const TERMINAL_MUTED = "#4f5661"
const TERMINAL_BORDER = "#dddddd"
const TERMINAL_PROMPT = "#005cc5"

let lineCounter = 0
const nextLineId = () => `line-${Date.now().toString(36)}-${++lineCounter}`

export function TerminalPanel({ open, onClose }: TerminalPanelProps) {
  const { files, activeFolder } = useCodeWorkspace()
  const workspaceProjectId = React.useMemo(
    () => getActiveCodexProject() || codexProjectIdFromWorkspaceId(activeFolder?.id, { assumeProject: true }),
    [activeFolder?.id],
  )
  const [lines, setLines] = React.useState<Line[]>([])
  const [input, setInput] = React.useState("")
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchTerm, setSearchTerm] = React.useState("")
  const [history, setHistory] = React.useState<string[]>([])
  const [historyIdx, setHistoryIdx] = React.useState<number | null>(null)
  // Run id of the live host dev server, if any (broadcast by preview-pane). When
  // set, commands run for REAL in that run's workspace dir; otherwise the panel
  // falls back to the client-side pseudo-shell.
  // Seed from the module singleton so opening the Shell AFTER a run started
  // still picks it up (the CODE_RUNNER_ACTIVE_EVENT already fired by then).
  const [activeRunId, setActiveRunId] = React.useState<string | null>(() => getActiveHostRunId())
  const activeRunIdRef = React.useRef<string | null>(getActiveHostRunId())
  const [departmentComputer, setDepartmentComputer] = React.useState<{ runId: string | null; projectId: string | null }>(() => ({
    runId: getActiveDepartmentComputer(),
    projectId: getActiveCodexProject(),
  }))
  const departmentComputerRef = React.useRef(departmentComputer)
  const [codexProjectId, setCodexProjectId] = React.useState<string | null>(() => getActiveCodexProject())
  const codexProjectIdRef = React.useRef<string | null>(getActiveCodexProject())
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // Always scroll to the bottom on new output.
  React.useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [open, lines.length])

  // Auto-focus when the panel opens.
  React.useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  React.useEffect(() => {
    if (open && searchOpen) searchRef.current?.focus()
  }, [open, searchOpen])

  // Track the live host run so the shell can exec for real.
  React.useEffect(() => {
    const onActive = (e: Event) => {
      const id = (e as CustomEvent<{ runId: string | null }>).detail?.runId ?? null
      activeRunIdRef.current = id
      setActiveRunId(id)
    }
    window.addEventListener(CODE_RUNNER_ACTIVE_EVENT, onActive as EventListener)
    return () => window.removeEventListener(CODE_RUNNER_ACTIVE_EVENT, onActive as EventListener)
  }, [])

  React.useEffect(() => {
    const refresh = () => {
      const next = { runId: getActiveDepartmentComputer(), projectId: getActiveCodexProject() }
      departmentComputerRef.current = next
      setDepartmentComputer(next)
    }
    refresh()
    window.addEventListener(CODE_ACTIVE_DEPARTMENT_COMPUTER_EVENT, refresh)
    return () => window.removeEventListener(CODE_ACTIVE_DEPARTMENT_COMPUTER_EVENT, refresh)
  }, [])

  React.useEffect(() => {
    const refresh = () => {
      const id = getActiveCodexProject() || workspaceProjectId
      codexProjectIdRef.current = id
      setCodexProjectId(id)
    }
    refresh()
    window.addEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, refresh)
    return () => window.removeEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, refresh)
  }, [workspaceProjectId])

  const filesRef = React.useRef(files)
  filesRef.current = files
  const folderIdRef = React.useRef(activeFolder?.id ?? null)
  folderIdRef.current = activeFolder?.id ?? null

  const ensureHostSession = React.useCallback(async (): Promise<{ runId: string | null; error?: string }> => {
    const existing = getActiveHostRunId() || activeRunIdRef.current
    if (existing) {
      const st = await hostRunnerService.status(existing)
      if (st.running || st.ready || (st.phase && st.phase !== "error")) {
        activeRunIdRef.current = existing
        setActiveRunId(existing)
        return { runId: existing }
      }
    }
    let runId: string
    try {
      runId = crypto.randomUUID()
    } catch {
      runId = `run-${Math.random().toString(36).slice(2)}`
    }
    const fileMap: Record<string, string> = {}
    for (const [path, file] of Object.entries(filesRef.current || {})) {
      fileMap[path] = file?.content ?? ""
    }
    const started = await hostRunnerService.start(
      fileMap,
      runId,
      buildRuntimeEnv(folderIdRef.current, filesRef.current),
    )
    if (started.disabled) {
      return {
        runId: null,
        error: started.error || "El motor de ejecución está desactivado en este entorno (CODE_HOST_RUNNER).",
      }
    }
    if (started.error) {
      return { runId: null, error: started.error }
    }
    const id = started.runId || runId
    setActiveHostRunId(id)
    activeRunIdRef.current = id
    setActiveRunId(id)
    return { runId: id }
  }, [])

  const scrollKey = React.useMemo(() => {
    const id = departmentComputer.runId || codexProjectId || activeFolder?.id || "local"
    return `siragpt:code-shell:${id}`
  }, [activeFolder?.id, codexProjectId, departmentComputer.runId])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const raw = window.sessionStorage.getItem(scrollKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as Line[]
      if (Array.isArray(parsed) && parsed.length) setLines(parsed.slice(-200))
    } catch {
      /* ignore */
    }
  }, [scrollKey])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.sessionStorage.setItem(scrollKey, JSON.stringify(lines.slice(-200)))
    } catch {
      /* ignore */
    }
  }, [lines, scrollKey])

  const print = React.useCallback((text: string, kind: Line["kind"] = "out") => {
    setLines((prev) => [...prev, { id: nextLineId(), kind, text }])
  }, [])

  React.useEffect(() => {
    if (!open) return
    if (departmentComputerRef.current.runId || codexProjectIdRef.current) return
    if (getActiveHostRunId() || activeRunIdRef.current) return
    let cancelled = false
    void (async () => {
      busyRef.current = true
      setBusy(true)
      print("Iniciando sesión de terminal…", "info")
      const session = await ensureHostSession()
      if (cancelled) return
      if (session.error) print(session.error, "err")
      else if (session.runId) print("Sesión lista. Los comandos se ejecutan en el workspace del servidor.", "info")
      busyRef.current = false
      setBusy(false)
    })()
    return () => {
      cancelled = true
    }
  }, [ensureHostSession, open, print])


  const clearLines = React.useCallback(() => {
    setLines([])
  }, [])

  // Pure client-side pseudo-shell (no live run): a handful of safe builtins over
  // the in-memory workspace. Used as a fallback when no host dev server is up.
  const runPseudo = React.useCallback(
    (cmd: string) => {
      const [head, ...rest] = cmd.split(/\s+/)
      const argLine = rest.join(" ")
      switch (head) {
        case "ls":
        case "dir": {
          const paths = Object.keys(files).sort()
          print(paths.length ? paths.join("\n") : "(workspace vacío)", paths.length ? "out" : "info")
          return
        }
        case "pwd":
          print(activeFolder?.name ? `~/workspace/${activeFolder.name}` : "~/workspace", "out")
          return
        case "echo":
          print(argLine, "out")
          return
        case "node":
          if (rest[0] === "--version" || rest[0] === "-v") return print("v22.0.0", "out")
          print(`comando \`node ${rest.join(" ")}\` no soportado sin un servidor activo — pulsa ▶ Ejecutar`, "err")
          return
        case "cat": {
          const target = rest[0]
          if (!target) return print("uso: cat <ruta>", "err")
          const file = files[target]
          if (!file) return print(`cat: ${target}: no existe`, "err")
          print(file.content, "out")
          return
        }
        default:
          print(`command not found: ${head} — arranca la app (▶ Ejecutar) para una terminal real`, "err")
      }
    },
    [activeFolder?.name, files, print],
  )

  void runPseudo
  const runCommand = React.useCallback(
    async (raw: string) => {
      const cmd = raw.trim()
      if (!cmd) return

      // Echo command first so the transcript reads naturally.
      setLines((prev) => [...prev, { id: nextLineId(), kind: "in", text: `${PROMPT} ${cmd}` }])

      const [head, ...rest] = cmd.split(/\s+/)
      const argLine = rest.join(" ")

      // Client-side conveniences regardless of run state.
      if (head === "clear") return clearLines()
      if (head === "help") {
        print(
          [
            "Terminal — los comandos se ejecutan en el workspace del servidor.",
            "Si el motor rechaza la sesion, se muestra el error real.",
            "  help                  muestra esta ayuda",
            "  clear                 limpia la consola",
            "  js <expr>             evalua JS en el navegador",
          ].join("\n"),
          "info",
        )
        return
      }
      if (head === "js") {
        if (!argLine) return print("uso: js <expresión>", "err")
        try {
          // eslint-disable-next-line no-new-func
          const result = new Function(`"use strict"; return (${argLine});`)()
          print(formatJsResult(result), "out")
        } catch (err) {
          print((err as Error)?.message || "Error de evaluación", "err")
        }
        return
      }

      // Workspace / department computer: exec in the Codex sandbox (not the host).
      const dept = departmentComputerRef.current
      const projectId = dept.projectId || codexProjectIdRef.current || workspaceProjectId
      if (projectId) {
        busyRef.current = true
        setBusy(true)
        try {
          const res = await codexApi.execInProject(projectId, cmd, dept.runId)
          const body = `${res.stdout || ""}${res.stderr ? (res.stdout ? "\n" : "") + res.stderr : ""}`.replace(/\s+$/, "")
          if (body) print(body, res.ok === false ? "err" : "out")
          if (res.timedOut) print("⏱ el comando excedió el tiempo límite", "err")
          if (!res.ok && typeof res.exitCode === "number" && res.exitCode !== 0) {
            print(`exit code ${res.exitCode}`, "err")
          }
        } catch (err) {
          print(err instanceof Error ? err.message : "No se pudo ejecutar el comando.", "err")
        } finally {
          busyRef.current = false
          setBusy(false)
        }
        return
      }

      busyRef.current = true
      setBusy(true)
      try {
        let runId = activeRunIdRef.current || getActiveHostRunId()
        if (!runId) {
          const session = await ensureHostSession()
          if (session.error || !session.runId) {
            print(session.error || "No se pudo iniciar la sesión de terminal.", "err")
            return
          }
          runId = session.runId
        }
        const res = await hostRunnerService.exec(runId, cmd)
        if (res.unavailable) {
          const session = await ensureHostSession()
          if (session.error || !session.runId) {
            print(session.error || res.error || "No hay un servidor activo para ejecutar comandos.", "err")
            return
          }
          const retry = await hostRunnerService.exec(session.runId, cmd)
          const retryBody = (retry.output || "").replace(/\s+$/, "")
          if (retryBody) print(retryBody, retry.ok ? "out" : "err")
          if (retry.timedOut) print("⏱ el comando excedió el tiempo límite", "err")
          if (!retry.ok && typeof retry.exitCode === "number" && retry.exitCode !== 0) {
            print(`exit code ${retry.exitCode}`, "err")
          } else if (!retry.ok && retry.error && !retryBody) {
            print(retry.error, "err")
          }
          return
        }
        const body = (res.output || "").replace(/\s+$/, "")
        if (body) print(body, res.ok ? "out" : "err")
        if (res.timedOut) print("⏱ el comando excedió el tiempo límite", "err")
        if (!res.ok && typeof res.exitCode === "number" && res.exitCode !== 0) {
          print(`exit code ${res.exitCode}`, "err")
        } else if (!res.ok && res.error && !body) {
          print(res.error, "err")
        }
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [clearLines, ensureHostSession, print, workspaceProjectId],
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || busyRef.current) return
    void runCommand(input)
    setHistory((h) => [...h, input])
    setHistoryIdx(null)
    setInput("")
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      if (!history.length) return
      e.preventDefault()
      const next = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      setInput(history[next])
      return
    }
    if (e.key === "ArrowDown") {
      if (historyIdx === null) return
      e.preventDefault()
      const next = historyIdx + 1
      if (next >= history.length) {
        setHistoryIdx(null)
        setInput("")
      } else {
        setHistoryIdx(next)
        setInput(history[next])
      }
      return
    }
    if (e.key === "l" && (e.metaKey || e.ctrlKey)) {
      // ⌘L / ⌃L → clear (Cursor + macOS convention)
      e.preventDefault()
      clearLines()
    }
  }

  if (!open) return null

  const normalizedSearch = searchTerm.trim().toLowerCase()

  return (
    <section
      aria-label="Shell - Terminal integrada"
      data-workspace-shell={departmentComputer.runId || activeRunId || codexProjectId || workspaceProjectId ? "real" : "local"}
      data-testid="workspace-shell-panel"
      className="flex h-full min-h-0 flex-col border-t border-[#d8d8d8] bg-[#fbfbfa]"
      style={{
        backgroundColor: TERMINAL_SURFACE,
        borderTopColor: "#d8d8d8",
        color: TERMINAL_TEXT,
      }}
    >
      <header
        className="flex h-[30px] shrink-0 items-center justify-between border-b border-[#dddddd] bg-[#f6f5f2] px-2 text-[#4f5661]"
        style={{
          backgroundColor: TERMINAL_HEADER,
          borderBottomColor: TERMINAL_BORDER,
          color: TERMINAL_MUTED,
          height: "30px",
          minHeight: "30px",
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: "#7a7f87" }} />
          <span
            className="truncate font-mono text-[13px] leading-none"
            style={{ color: "#3f4650", fontSize: "13px" }}
          >
            ~/workspace: bash
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] leading-none"
            style={
              activeRunId
                ? { backgroundColor: "#e3f4e8", color: "#1a7f37" }
                : { backgroundColor: "#efefec", color: "#7a7f87" }
            }
            title={departmentComputer.runId || activeRunId || codexProjectId || workspaceProjectId ? "Terminal real: comandos en el workspace / computador del departamento" : "Pseudo-shell: abre un proyecto o departamento para una terminal real"}
          >
            {busy ? "ejecutando…" : departmentComputer.runId || activeRunId || codexProjectId || workspaceProjectId ? "● real" : "○ local"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {searchOpen ? (
            <input
              ref={searchRef}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false)
                  setSearchTerm("")
                  inputRef.current?.focus()
                }
              }}
              className="h-6 w-36 rounded border border-[#d5d5d5] bg-white px-2 font-mono text-[12px] text-[#151515] outline-none focus:border-[#9aa8bd]"
              style={{
                backgroundColor: "#ffffff",
                borderColor: "#d5d5d5",
                color: TERMINAL_TEXT,
                fontSize: "12px",
                outline: "none",
              }}
              placeholder="Buscar"
              aria-label="Buscar en terminal"
            />
          ) : null}
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded text-[#555b64] hover:bg-[#e9e9e7] hover:text-[#14171c]"
            style={{ color: "#555b64" }}
            title="Buscar"
            aria-label="Buscar en terminal"
            onClick={() => setSearchOpen((value) => !value)}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded text-[#555b64] hover:bg-[#e9e9e7] hover:text-[#14171c]"
            style={{ color: "#555b64" }}
            title="Limpiar"
            aria-label="Limpiar terminal"
            onClick={clearLines}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded text-[#555b64] hover:bg-[#e9e9e7] hover:text-[#14171c]"
            style={{ color: "#555b64" }}
            title="Cerrar"
            aria-label="Cerrar terminal"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-[#fbfbfa] px-3 py-2 font-mono text-[13px] leading-[1.45] text-[#151515]"
        style={{
          backgroundColor: TERMINAL_SURFACE,
          color: TERMINAL_TEXT,
          fontSize: "13px",
          lineHeight: 1.45,
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line) => {
          const matchesSearch =
            normalizedSearch.length > 0 && line.text.toLowerCase().includes(normalizedSearch)
          const inputLine = line.kind === "in" && line.text.startsWith(PROMPT)
          return (
            <pre
              key={line.id}
              className={cn(
                "whitespace-pre-wrap rounded-sm text-[#151515]",
                line.kind === "err" && "text-[#c92a2a]",
                line.kind === "info" && "text-[#6b7280]",
                matchesSearch && "bg-[#fff3b0]",
              )}
              style={{
                backgroundColor: matchesSearch ? "#fff3b0" : "transparent",
                color:
                  line.kind === "err"
                    ? "#c92a2a"
                    : line.kind === "info"
                      ? "#6b7280"
                      : TERMINAL_TEXT,
              }}
            >
              {inputLine ? (
                <>
                  <span className="font-semibold" style={{ color: TERMINAL_PROMPT }}>
                    {PROMPT}
                  </span>
                  <span>{line.text.slice(PROMPT.length)}</span>
                </>
              ) : (
                line.text
              )}
            </pre>
          )
        })}

        <form onSubmit={handleSubmit} className="mt-0.5 flex items-center gap-1.5">
          <span className="select-none font-semibold" style={{ color: TERMINAL_PROMPT }}>
            {PROMPT}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 bg-transparent font-mono text-[13px] text-[#151515] caret-black outline-none"
            style={{
              color: TERMINAL_TEXT,
              caretColor: "#000000",
              fontSize: "13px",
              outline: "none",
            }}
            aria-label="Entrada de terminal"
          />
        </form>
      </div>
    </section>
  )
}

function formatJsResult(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
