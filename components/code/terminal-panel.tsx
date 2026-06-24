"use client"

/**
 * TerminalPanel — bottom collapsible panel that emulates a Cursor-style
 * integrated terminal. It is intentionally a *sandboxed pseudo-shell*:
 * we cannot spawn a real OS process from the browser. Instead, the
 * panel runs a tiny built-in REPL with a handful of safe commands so
 * the surface feels alive:
 *
 *   - `help`            list commands
 *   - `ls` / `dir`      list files in the in-memory workspace
 *   - `cat <file>`      print the file contents
 *   - `pwd`             print the current logical folder
 *   - `clear`           reset history
 *   - `echo …`          echo back text
 *   - `node --version`  fakes a Node version string for parity
 *   - `js <expr>`       eval a JS expression in a Function() sandbox
 *
 * Any unknown command prints a `command not found` line, matching the
 * mental model of a real shell. The intent is explicitly NOT to
 * compete with a real terminal — wiring xterm.js + a backend PTY is
 * a separate, larger project.
 */

import * as React from "react"
import { ChevronDown, Search, Trash2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

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

  const print = React.useCallback((text: string, kind: Line["kind"] = "out") => {
    setLines((prev) => [...prev, { id: nextLineId(), kind, text }])
  }, [])

  const clearLines = React.useCallback(() => {
    setLines([])
  }, [])

  const runCommand = React.useCallback(
    (raw: string) => {
      const cmd = raw.trim()
      if (!cmd) return

      // Echo command first so the transcript reads naturally.
      setLines((prev) => [...prev, { id: nextLineId(), kind: "in", text: `${PROMPT} ${cmd}` }])

      const [head, ...rest] = cmd.split(/\s+/)
      const argLine = rest.join(" ")

      switch (head) {
        case "help":
          print(
            [
              "Comandos disponibles:",
              "  help                  muestra esta ayuda",
              "  ls | dir              lista archivos del workspace",
              "  cat <ruta>            muestra el contenido de un archivo",
              "  pwd                   muestra la carpeta lógica activa",
              "  echo <texto>          imprime texto",
              "  clear                 limpia la consola",
              "  node --version        imprime una versión simulada",
              "  js <expr>             evalúa una expresión JavaScript pura",
              "",
              "Aviso: esta vista ejecuta comandos simulados del workspace.",
            ].join("\n"),
            "info",
          )
          return
        case "ls":
        case "dir": {
          const paths = Object.keys(files).sort()
          if (!paths.length) {
            print("(workspace vacío)", "info")
          } else {
            print(paths.join("\n"), "out")
          }
          return
        }
        case "pwd":
          print(activeFolder?.name ? `~/workspace/${activeFolder.name}` : "~/workspace", "out")
          return
        case "clear":
          clearLines()
          return
        case "echo":
          print(argLine, "out")
          return
        case "node": {
          if (rest[0] === "--version" || rest[0] === "-v") {
            print("v22.0.0", "out")
            return
          }
          print(`comando \`node ${rest.join(" ")}\` no soportado en esta terminal`, "err")
          return
        }
        case "cat": {
          const target = rest[0]
          if (!target) return print("uso: cat <ruta>", "err")
          const file = files[target]
          if (!file) return print(`cat: ${target}: no existe`, "err")
          print(file.content, "out")
          return
        }
        case "js": {
          if (!argLine) return print("uso: js <expresión>", "err")
          try {
            // Function constructor isolates from the closure but not from
            // window.* — keep the evaluator strictly opt-in.
            // eslint-disable-next-line no-new-func
            const result = new Function(`"use strict"; return (${argLine});`)()
            print(formatJsResult(result), "out")
          } catch (err) {
            print((err as Error)?.message || "Error de evaluación", "err")
          }
          return
        }
        default:
          print(`command not found: ${head}`, "err")
      }
    },
    [activeFolder?.name, clearLines, files, print],
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    runCommand(input)
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
