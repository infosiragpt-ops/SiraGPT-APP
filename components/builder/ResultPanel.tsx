"use client"

import { useState, type ReactNode } from "react"
import { Check, Copy, Eye, FileCode2, Layers, ListChecks, RotateCcw, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { BuildResult } from "@/lib/builder/useIntake"

const accent = "hsl(var(--accent-violet))"

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web", mobile: "Móvil", desktop: "Desktop", landing: "Landing",
}

interface ResultPanelProps {
  result: BuildResult
  onReset: () => void
}

export function ResultPanel({ result, onReset }: ResultPanelProps) {
  const { brief, blueprint, files } = result
  const previewFile = files.find((f) => f.path === "preview.html")
  // Code viewer defaults to the first non-preview file (preview has its own tab).
  const codeFiles = files.filter((f) => f.path !== "preview.html")
  const [activeFile, setActiveFile] = useState(codeFiles[0]?.path ?? files[0]?.path ?? "")
  const [copied, setCopied] = useState(false)

  const current = codeFiles.find((f) => f.path === activeFile) ?? codeFiles[0]

  async function copy() {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="animate-in fade-in zoom-in-95 duration-500">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4" style={{ color: accent }} />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Proyecto generado
            </span>
          </div>
          <h2 className="max-w-xl text-balance text-2xl font-semibold leading-tight text-foreground">
            {brief.purpose || "Tu proyecto"}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="outline" className="border-border font-mono text-xs">
              {PLATFORM_LABEL[brief.platform] ?? brief.platform}
            </Badge>
            <Badge variant="outline" className="border-border font-mono text-xs capitalize">
              {blueprint.estimate.complexity} · {blueprint.estimate.screens} pantallas
            </Badge>
            {brief.audience && (
              <Badge variant="outline" className="border-border text-xs">
                {brief.audience}
              </Badge>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onReset} className="gap-2 border-border">
          <RotateCcw className="h-3.5 w-3.5" />
          Nuevo
        </Button>
      </div>

      <Tabs defaultValue={previewFile ? "preview" : "plan"} className="w-full">
        <TabsList className="bg-card">
          {previewFile && (
            <TabsTrigger value="preview" className="gap-1.5 data-[state=active]:text-foreground">
              <Eye className="h-3.5 w-3.5" /> Preview
            </TabsTrigger>
          )}
          <TabsTrigger value="plan" className="gap-1.5 data-[state=active]:text-foreground">
            <Layers className="h-3.5 w-3.5" /> Plan
          </TabsTrigger>
          <TabsTrigger value="code" className="gap-1.5 data-[state=active]:text-foreground">
            <FileCode2 className="h-3.5 w-3.5" /> Código
            <span className="ml-1 rounded bg-muted px-1.5 text-[10px] tabular-nums">{codeFiles.length}</span>
          </TabsTrigger>
        </TabsList>

        {/* PREVIEW — rendered mockup of the generated app */}
        {previewFile && (
          <TabsContent value="preview" className="mt-5">
            <div className="overflow-hidden rounded-lg border border-border bg-white">
              <iframe
                title="Vista previa del proyecto"
                srcDoc={previewFile.content}
                sandbox=""
                className="h-[560px] w-full"
              />
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Mockup estático generado del brief · la vista previa interactiva (app real corriendo) llega en E5
            </p>
          </TabsContent>
        )}

        {/* PLAN */}
        <TabsContent value="plan" className="mt-5 space-y-6">
          {/* Stack */}
          <Section title="Stack">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ["Frontend", blueprint.stack.frontend],
                ["Backend", blueprint.stack.backend],
                ["Base de datos", blueprint.stack.database],
                ["Hosting", blueprint.stack.hosting],
              ] as const).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-card p-3">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{k}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{v}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* Pages */}
          <Section title={`Pantallas (${blueprint.pages.length})`}>
            <div className="grid gap-2 sm:grid-cols-2">
              {blueprint.pages.map((p) => (
                <div key={p.name} className="rounded-lg border border-border bg-card p-3">
                  <p className="text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.purpose}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.components.map((c) => (
                      <span key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Data model */}
          {blueprint.dataModel.length > 0 && (
            <Section title="Modelo de datos">
              <div className="grid gap-2 sm:grid-cols-2">
                {blueprint.dataModel.map((m) => (
                  <div key={m.entity} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-sm font-semibold" style={{ color: accent }}>{m.entity}</p>
                    <div className="mt-2 space-y-1">
                      {m.fields.map((f) => (
                        <div key={f.name} className="flex items-center justify-between font-mono text-xs">
                          <span className="text-foreground">{f.name}</span>
                          <span className="text-muted-foreground">{f.type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Milestones */}
          <Section title="Plan de construcción">
            <div className="space-y-4">
              {blueprint.milestones.map((m, i) => (
                <div key={m.title}>
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-white"
                      style={{ background: accent }}
                    >
                      {i + 1}
                    </span>
                    <p className="text-sm font-semibold text-foreground">{m.title}</p>
                  </div>
                  <ul className="ml-7 space-y-1">
                    {m.tasks.map((t) => (
                      <li key={t} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
        </TabsContent>

        {/* CODE */}
        <TabsContent value="code" className="mt-5">
          <div className="grid gap-3 md:grid-cols-[220px_1fr]">
            {/* file list */}
            <div className="space-y-1">
              {codeFiles.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setActiveFile(f.path)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left font-mono text-xs transition-colors",
                    f.path === current?.path
                      ? "border-border bg-card text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-card/60",
                  )}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{f.path}</span>
                </button>
              ))}
            </div>

            {/* viewer */}
            <div className="overflow-hidden rounded-lg border border-border bg-[hsl(var(--card))]">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">{current?.path}</span>
                <button onClick={copy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  {copied ? <Check className="h-3.5 w-3.5" style={{ color: accent }} /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </div>
              <pre className="max-h-[460px] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-foreground/90">
                <code>{current?.content}</code>
              </pre>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}
