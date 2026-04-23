"use client"

/**
 * SynthesisPreview — renders the final markdown answer once the
 * executor's synthesis step completes (or streams, if we wire that
 * up later). Reuses react-markdown + remark-gfm to match the
 * rendering other parts of the app use, so code fences, tables,
 * task lists, etc. look consistent.
 */

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Sparkles, Copy, Check } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"

interface Props {
  markdown: string | null
  state: "idle" | "waiting" | "synthesizing" | "done" | "error"
  stoppedReason?: string
}

export function SynthesisPreview({ markdown, state, stoppedReason }: Props) {
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    if (!markdown) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      toast.error("No se pudo copiar")
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Final answer</span>
          {state === "synthesizing" && (
            <span className="text-[11px] text-muted-foreground animate-pulse">
              synthesising…
            </span>
          )}
          {state === "done" && stoppedReason && (
            <span className="text-[11px] text-muted-foreground">
              {stoppedReason}
            </span>
          )}
        </div>
        {markdown && (
          <Button size="sm" variant="outline" onClick={copy} className="h-7 gap-1.5">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>

      <div className="flex-1 p-5 overflow-y-auto">
        {!markdown && state === "idle" && (
          <div className="h-full flex items-center justify-center text-center text-sm text-muted-foreground">
            Pulsa <span className="mx-1 font-mono text-foreground/80">Run</span> para iniciar.
          </div>
        )}
        {!markdown && (state === "waiting" || state === "synthesizing") && (
          <div className="text-sm text-muted-foreground animate-pulse">
            The model is working…
          </div>
        )}
        {markdown && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
