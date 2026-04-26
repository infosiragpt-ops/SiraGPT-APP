"use client"

import * as React from "react"
import { Check, Clipboard, Copy, Eraser, Languages, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

const MODES = [
  { id: "standard", label: "Standard" },
  { id: "humanize", label: "Humanize" },
  { id: "formal", label: "Formal" },
  { id: "academic", label: "Academic" },
  { id: "simple", label: "Simple" },
  { id: "creative", label: "Creative" },
  { id: "expand", label: "Expand" },
  { id: "shorten", label: "Shorten" },
  { id: "custom", label: "Custom" },
] as const

const LANGUAGES = ["Spanish", "English", "Portuguese", "French", "German", "Italian"] as const

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function countChars(text: string) {
  return text.length
}

export default function ParafraseoPage() {
  const [input, setInput] = React.useState("")
  const [output, setOutput] = React.useState("")
  const [mode, setMode] = React.useState<(typeof MODES)[number]["id"]>("standard")
  const [language, setLanguage] = React.useState<(typeof LANGUAGES)[number]>("Spanish")
  const [customInstruction, setCustomInstruction] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const inputWords = countWords(input)
  const outputWords = countWords(output)

  const paraphrase = React.useCallback(async () => {
    const text = input.trim()
    if (!text) {
      toast.error("Inserta texto para parafrasear")
      return
    }

    setLoading(true)
    setCopied(false)
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const response = await fetch(`${API_ROOT}/ai/paraphrase`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          text,
          mode,
          language,
          customInstruction: mode === "custom" ? customInstruction : undefined,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || "No se pudo parafrasear")
      setOutput(String(data.text || "").trim())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo parafrasear")
    } finally {
      setLoading(false)
    }
  }, [customInstruction, input, language, mode])

  const copyOutput = React.useCallback(async () => {
    if (!output.trim()) return
    await navigator.clipboard.writeText(output)
    setCopied(true)
    toast.success("Texto copiado")
    window.setTimeout(() => setCopied(false), 1600)
  }, [output])

  const clearAll = React.useCallback(() => {
    setInput("")
    setOutput("")
    setCopied(false)
  }, [])

  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-[66px] shrink-0 items-center gap-3 border-b border-border/60 bg-background px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight">Parafraseo</h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">DeepSeek V4 Pro</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
              <span className="truncate">Editor profesional</span>
            </div>
          </div>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <div className="hidden items-center rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground md:flex">
            <span>{inputWords} palabras</span>
            <span className="mx-2 h-3 w-px bg-border" />
            <span>{countChars(input)} caracteres</span>
          </div>
          <Button variant="ghost" size="icon" onClick={clearAll} title="Limpiar" aria-label="Limpiar">
            <Eraser className="h-4 w-4" />
          </Button>
          <Button onClick={paraphrase} disabled={loading || !input.trim()} className="h-9 rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            Parafrasear
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border/60 bg-background px-5">
        <span className="shrink-0 text-sm font-medium text-muted-foreground">Modes:</span>
        <div className="flex min-w-max items-center gap-1">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              className={cn(
                "relative h-12 px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                mode === item.id && "text-emerald-700 dark:text-emerald-300",
              )}
            >
              {item.label}
              {mode === item.id && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-emerald-600" />}
            </button>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="flex h-9 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm">
            <Languages className="h-4 w-4 text-muted-foreground" />
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as (typeof LANGUAGES)[number])}
              className="bg-transparent text-sm font-medium outline-none"
              aria-label="Idioma"
            >
              {LANGUAGES.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {mode === "custom" && (
        <div className="shrink-0 border-b border-border/60 px-5 py-3">
          <input
            value={customInstruction}
            onChange={(event) => setCustomInstruction(event.target.value)}
            placeholder="Indicación personalizada"
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none ring-0 transition focus:border-emerald-500"
          />
        </div>
      )}

      <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <div className="relative flex min-h-0 min-w-0 flex-col border-b border-border/60 md:border-b-0 md:border-r">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                paraphrase()
              }
            }}
            placeholder="Inserta tu texto aqui..."
            className="min-h-0 flex-1 resize-none bg-background px-10 py-8 text-[16px] leading-8 text-foreground outline-none placeholder:text-muted-foreground/55"
          />
          <div className="flex h-14 shrink-0 items-center justify-between border-t border-border/60 px-5">
            <span className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {inputWords} {inputWords === 1 ? "palabra" : "palabras"}
            </span>
            <Button onClick={paraphrase} disabled={loading || !input.trim()} className="h-9 rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-700">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Rephrase
            </Button>
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-col bg-muted/5">
          <div className="min-h-0 flex-1 overflow-auto px-10 py-8 text-[16px] leading-8">
            {output ? (
              <div className="whitespace-pre-wrap text-foreground">{output}</div>
            ) : (
              <div className="text-muted-foreground/55">Resultado parafraseado...</div>
            )}
          </div>
          <div className="flex h-14 shrink-0 items-center justify-between border-t border-border/60 px-5">
            <span className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {outputWords} {outputWords === 1 ? "palabra" : "palabras"}
            </span>
            <Button variant="ghost" size="icon" onClick={copyOutput} disabled={!output.trim()} title="Copiar" aria-label="Copiar">
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}
