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
import { Plus, SquareTerminal, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

export type TerminalPanelProps = {
  open: boolean
  onClose: () => void
}

type Line = { id: string; kind: "in" | "out" | "err" | "info"; text: string }

const PROMPT = "siragpt $"

let lineCounter = 0
const nextLineId = () => `line-${Date.now().toString(36)}-${++lineCounter}`

function nowGreeting() {
  return [
    `Cursor Workspace Terminal · sesión efímera`,
    `Sin acceso real al sistema. Escribe \`help\` para ver los comandos disponibles.`,
  ]
}

export function TerminalPanel({ open, onClose }: TerminalPanelProps) {
  const { files, activeFolder, workspaceSource } = useCodeWorkspace()
  const [lines, setLines] = React.useState<Line[]>(() =>
    nowGreeting().map((text) => ({ id: nextLineId(), kind: "info" as const, text })),
  )
  const [input, setInput] = React.useState("")
  const [history, setHistory] = React.useState<string[]>([])
  const [historyIdx, setHistoryIdx] = React.useState<number | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
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

  const print = React.useCallback((text: string, kind: Line["kind"] = "out") => {
    setLines((prev) => [...prev, { id: nextLineId(), kind, text }])
  }, [])

  const clearLines = React.useCallback(() => {
    setLines(nowGreeting().map((text) => ({ id: nextLineId(), kind: "info" as const, text })))
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
              "Comandos sandbox disponibles:",
              "  help                  muestra esta ayuda",
              "  ls | dir              lista archivos del workspace",
              "  cat <ruta>            muestra el contenido de un archivo",
              "  pwd                   muestra la carpeta lógica activa",
              "  echo <texto>          imprime texto",
              "  clear                 limpia la consola",
              "  node --version        imprime una versión simulada",
              "  js <expr>             evalúa una expresión JavaScript pura",
              "",
              "Aviso: este terminal no tiene acceso al sistema operativo.",
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
          print(activeFolder?.name || workspaceSource.name || "/workspace", "out")
          return
        case "clear":
          clearLines()
          return
        case "echo":
          print(argLine, "out")
          return
        case "node": {
          if (rest[0] === "--version" || rest[0] === "-v") {
            print("v22.0.0 (sandbox emulation)", "out")
            return
          }
          print(`comando \`node ${rest.join(" ")}\` no soportado en sandbox`, "err")
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
    [activeFolder?.name, clearLines, files, print, workspaceSource.name],
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

  return (
    <section
      aria-label="Terminal integrada"
      className="flex h-full min-h-0 flex-col border-t border-border/60 bg-background"
    >
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 bg-muted/40 px-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <SquareTerminal className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">Terminal</span>
          <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide">
            sandbox
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Nueva sesión"
            onClick={clearLines}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Limpiar"
            onClick={clearLines}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Cerrar terminal"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-[1.55]"
      >
        {lines.map((line) => (
          <pre
            key={line.id}
            className={cn(
              "whitespace-pre-wrap text-foreground/95",
              line.kind === "in" && "text-primary",
              line.kind === "err" && "text-rose-500",
              line.kind === "info" && "text-muted-foreground",
            )}
          >
            {line.text}
          </pre>
        ))}

        <form onSubmit={handleSubmit} className="mt-1 flex items-center gap-2">
          <span className="select-none text-emerald-500">{PROMPT}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="escribe un comando…"
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
