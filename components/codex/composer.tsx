"use client"

// codex/composer — the Replit-Agent-style composer for Codex V2 (feature 12):
// "Make, test, iterate..." placeholder, + attachments, Plan toggle, "Power"
// tier selector, mic dictation, send/stop. Mobile-first: anchored at the
// bottom, ≥44px touch targets, 16px textarea (no iOS zoom). Owns its own input
// state; the panel handles the actual run creation/cancel.

import React, { useRef, useState } from "react"
import clsx from "clsx"
import { toast } from "sonner"
import { Plus, Send, Square, Loader2, Paperclip, X } from "lucide-react"
import { PlanToggle } from "./plan-toggle"
import { PowerSelector } from "./power-selector"
import { DictationButton } from "./dictation-button"
import { DEFAULT_TIER, type CodexTier } from "@/lib/codex/model-tiers"

export interface ComposerAttachment { name: string; content: string }
export interface ComposerSendPayload { prompt: string; planOnly: boolean; tier: CodexTier; attachments: ComposerAttachment[] }

export interface ComposerProps {
  disabled?: boolean
  busy?: boolean
  /** A run is streaming → show Stop instead of Send. */
  active?: boolean
  locale?: string
  onSend: (payload: ComposerSendPayload) => void | Promise<void>
  onStop?: () => void | Promise<void>
}

const MAX_ATTACH_CHARS = 20_000

export function Composer({ disabled, busy, active, locale, onSend, onStop }: ComposerProps) {
  const [prompt, setPrompt] = useState("")
  const [planOnly, setPlanOnly] = useState(false)
  const [tier, setTier] = useState<CodexTier>(DEFAULT_TIER)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function autoResize() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    for (const f of files) {
      try {
        const text = (await f.text()).slice(0, MAX_ATTACH_CHARS)
        setAttachments((cur) => [...cur, { name: f.name, content: text }])
      } catch {
        toast.error(`No se pudo leer ${f.name}`)
      }
    }
    if (fileRef.current) fileRef.current.value = ""
  }

  function submit() {
    if (active) { onStop?.(); return }
    if (busy || disabled) return
    if (!prompt.trim() && attachments.length === 0) return
    void onSend({ prompt: prompt.trim(), planOnly, tier, attachments })
    setPrompt("")
    setAttachments([])
    if (taRef.current) taRef.current.style.height = "auto"
  }

  return (
    <div className="border-t border-white/10 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-xs text-zinc-300">
              <Paperclip className="h-3 w-3" /> {a.name}
              <button type="button" onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-zinc-200"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/5 p-2">
        <textarea
          ref={taRef}
          data-codex-composer
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); autoResize() }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder="Make, test, iterate..."
          rows={1}
          disabled={disabled}
          className="max-h-40 w-full resize-none bg-transparent px-1 text-zinc-100 outline-none placeholder:text-zinc-600"
          style={{ fontSize: 16 }}
        />

        <div className="mt-1 flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".txt,.md,.json,.csv,.js,.ts,.tsx,.py,.html,.css" multiple className="hidden" onChange={onFiles} />
          <button type="button" onClick={() => fileRef.current?.click()} aria-label="Adjuntar archivo" className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5">
            <Plus className="h-5 w-5" />
          </button>
          <PlanToggle active={planOnly} onToggle={setPlanOnly} />
          <PowerSelector value={tier} onChange={setTier} />
          <div className="ml-auto flex items-center gap-1.5">
            <DictationButton locale={locale} onTranscript={(t) => { setPrompt((p) => (p ? `${p} ${t}` : t)); autoResize() }} />
            <button
              type="button"
              onClick={submit}
              disabled={!active && (disabled || busy || (!prompt.trim() && attachments.length === 0))}
              aria-label={active ? "Detener" : "Enviar"}
              className={clsx("flex h-9 min-h-[44px] w-11 items-center justify-center rounded-xl text-white disabled:opacity-40 sm:min-h-0", active ? "bg-red-600 hover:bg-red-500" : "bg-violet-600 hover:bg-violet-500")}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
