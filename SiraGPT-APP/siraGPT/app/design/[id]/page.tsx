"use client"

/**
 * /design/[id] — canvas page. Chat on the left, iframe preview on
 * the right. The iframe swaps atomically when the generator emits
 * its `final` event with the full HTML document.
 *
 * Exports (top-right dropdown):
 *   - .html  download (working)
 *   - .pdf, .pptx, .zip, Canva — stubbed; we show a toast "próximamente"
 *     rather than silently pretending those paths work.
 */

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import {
  ArrowLeft, Download, MoreHorizontal, Trash2, Palette} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { CanvasIframe } from "@/components/design/canvas-iframe"
import { ChatPanel } from "@/components/design/chat-panel"
import { designService, type DesignDetail, type DesignQualityReport } from "@/lib/design-service"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function DesignCanvasPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [design, setDesign] = React.useState<DesignDetail | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    designService.get(id)
      .then(d => { if (!cancelled) setDesign(d) })
      .catch(err => toast.error(err?.message || "Could not load design"))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  function handleUpdated(html: string, updatedAt: string, instruction: string, quality?: DesignQualityReport | null) {
    setDesign(prev => prev ? {
      ...prev,
      html,
      updatedAt,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: instruction, at: new Date().toISOString() },
        {
          role: "assistant" as const,
          content: quality
            ? `HTML actualizado · revisión ${quality.score}/100`
            : "HTML actualizado",
          at: new Date().toISOString(),
          htmlChars: html.length,
          quality: quality || undefined,
        },
      ],
    } : prev)
  }

  async function handleDelete() {
    if (!design) return
    if (!confirm(`Delete "${design.name}"? This cannot be undone.`)) return
    try {
      await designService.remove(design.id)
      toast.success("Diseño eliminado")
      router.push("/design")
    } catch (err: any) {
      toast.error(err?.message || "Delete failed")
    }
  }

  function exportHtml() {
    if (!design?.html) return
    const blob = new Blob([design.html], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${design.name.replace(/\s+/g, "-").toLowerCase()}.html`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const stub = (what: string) => () => toast.info(`${what} · próximamente`)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ThinkingIndicator size="md" className="text-muted-foreground" />
      </div>
    )
  }
  if (!design) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Design not found.
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 bg-card">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/design")}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All designs
          </button>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5 text-[#C05621]" />
            <span className="text-xs font-medium">{design.name}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-8">
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Working
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={exportHtml} disabled={!design.html}>
                Download .html
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Coming soon
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={stub("Export ZIP")}>Download as .zip</DropdownMenuItem>
              <DropdownMenuItem onClick={stub("Export PDF")}>Export as PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={stub("Export PPTX")}>Export as PPTX</DropdownMenuItem>
              <DropdownMenuItem onClick={stub("Send to Canva")}>Send to Canva</DropdownMenuItem>
              <DropdownMenuItem onClick={stub("Hand off to Claude Code")}>Hand off to code</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleDelete} className="text-red-600 focus:text-red-600">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete design
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 flex min-h-0">
        <ChatPanel design={design} onUpdated={handleUpdated} />
        <CanvasIframe
          html={design.html}
          placeholder={
            design.kind === "prototype"
              ? `Describe el prototipo (${design.fidelity}) en el chat. La vista previa aparecerá aquí.`
              : design.kind === "slide_deck"
              ? "Describe la presentación en el chat. Las diapositivas aparecerán aquí."
              : "Describe el diseño en el chat."
          }
        />
      </div>
    </div>
  )
}
