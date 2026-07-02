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
import { CODE_RUNNER_ACTIVE_EVENT, useCodeWorkspace } from "@/lib/code-workspace-context"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"

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
  const [lines, setLines] = React.useState<Line[]>([])
  const [input, setInput] = React.useState("")
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchTerm, setSearchTerm] = React.useState("")
  const [history, setHistory] = React.useState<string[]>([])
  const [historyIdx, setHistoryIdx] = React.useState<number | null>(null)
  // Run id of the live host dev server, if any (broadcast by preview-pane). When
  // set, commands run for REAL in that run's workspace dir; otherwise the panel
  // falls back to the client-side pseudo-shell.
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null)
  const activeRunIdRef = React.useRef<string | null>(null)
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

  const print = React.useCallback((text: string, kind: Line["kind"] = "out") => {
    setLines((prev) => [...prev, { id: nextLineId(), kind, text }])
  }, [])

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
        const real = !!activeRunIdRef.current
        print(
          real
            ? [
                "Terminal REAL — se ejecuta en el workspace del servidor de desarrollo activo.",
                "Puedes usar cualquier comando de shell: ls, cat, npm run <script>, node -v, git status, etc.",
                "  clear                 limpia la consola",
                "  js <expr>             evalúa una expresión JS en el navegador",
              ].join("\n")
            : [
                "Comandos disponibles (pseudo-shell, sin servidor activo):",
                "  help                  muestra esta ayuda",
                "  ls | dir              lista archivos del workspace",
                "  cat <ruta>            muestra el contenido de un archivo",
                "  pwd                   carpeta lógica activa",
                "  echo <texto>          imprime texto",
                "  clear                 limpia la consola",
                "  js <expr>             evalúa una expresión JavaScript pura",
                "",
                "Pulsa ▶ Ejecutar para arrancar la app y obtener una TERMINAL REAL.",
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

      // REAL shell: a live host dev server exists → run the command for real in
      // its workspace dir. Falls back to the pseudo-shell if the run vanished.
      const runId = activeRunIdRef.current
      if (runId) {
        busyRef.current = true
        setBusy(true)
        try {
          const res = await hostRunnerService.exec(runId, cmd)
          if (res.unavailable) {
            activeRunIdRef.current = null
            setActiveRunId(null)
            runPseudo(cmd)
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
        return
      }

      // No live run → pseudo-shell.
      runPseudo(cmd)
    },
    [activeRunIdRef, clearLines, print, runPseudo],
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
            title={activeRunId ? "Terminal real: comandos en el servidor de desarrollo activo" : "Pseudo-shell: arranca la app (▶ Ejecutar) para una terminal real"}
          >
            {busy ? "ejecutando…" : activeRunId ? "● real" : "○ local"}
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
