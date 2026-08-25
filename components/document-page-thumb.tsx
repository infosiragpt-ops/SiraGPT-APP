"use client"

import * as React from "react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"
import {
  detectPageThumbKind,
  renderDocumentFirstPage,
  type DocumentFirstPage,
  type PageThumbKind,
} from "@/lib/document-first-page"

export type DocumentPageThumbSource = {
  id?: string | null
  name?: string
  mimeType?: string | null
  size?: number | null
  file?: File | null
  url?: string | null
}

interface DocumentPageThumbProps {
  source: DocumentPageThumbSource
  busy?: boolean
  progress?: number | null
  label?: string
  className?: string
}

const KIND_LABEL: Record<PageThumbKind, string> = {
  pdf: "PDF",
  docx: "Word",
  xlsx: "Excel",
  pptx: "PowerPoint",
  image: "Imagen",
  other: "Documento",
}

function PageShell({
  kind,
  children,
  className,
}: {
  kind: PageThumbKind
  children: React.ReactNode
  className?: string
}) {
  const accent =
    kind === "xlsx"
      ? "from-emerald-50 to-white dark:from-emerald-950/40"
      : kind === "pptx"
        ? "from-orange-50 to-white dark:from-orange-950/30"
        : kind === "pdf"
          ? "from-red-50 to-white dark:from-red-950/30"
          : "from-sky-50 to-white dark:from-sky-950/30"
  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-[0.65rem] border border-black/10 bg-gradient-to-b shadow-[0_8px_24px_rgba(15,23,42,0.12)] dark:border-white/10",
        accent,
        className,
      )}
    >
      {children}
    </div>
  )
}

function FallbackPage({ kind, name }: { kind: PageThumbKind; name?: string }) {
  return (
    <div className="flex h-full flex-col px-2.5 py-2.5">
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {KIND_LABEL[kind]}
      </span>
      <span className="mt-2 line-clamp-4 text-[11px] font-medium leading-snug text-zinc-800 dark:text-zinc-100">
        {name || "Documento"}
      </span>
      <div className="mt-3 space-y-1.5">
        <span className="block h-1.5 w-[92%] rounded-full bg-zinc-200/90 dark:bg-white/10" />
        <span className="block h-1.5 w-[84%] rounded-full bg-zinc-200/80 dark:bg-white/10" />
        <span className="block h-1.5 w-[76%] rounded-full bg-zinc-200/70 dark:bg-white/10" />
      </div>
    </div>
  )
}

export function DocumentPageThumb({
  source,
  busy = false,
  progress = null,
  label,
  className,
}: DocumentPageThumbProps) {
  const kind = detectPageThumbKind(source.name, source.mimeType)
  const [page, setPage] = React.useState<DocumentFirstPage | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setPage(null)
    void renderDocumentFirstPage(source).then((next) => {
      if (!cancelled) setPage(next)
    })
    return () => {
      cancelled = true
    }
  }, [source.id, source.name, source.url, source.file, source.size, source.mimeType])

  const pct = typeof progress === "number" && Number.isFinite(progress) && progress > 0
    ? Math.max(1, Math.min(99, Math.round(progress)))
    : null
  const caption = label || (busy ? "Generando vista previa…" : "")

  return (
    <PageShell kind={kind} className={className}>
      {page?.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={page.dataUrl} alt="" className="h-full w-full object-cover object-top" />
      ) : page?.html ? (
        <div
          className="origin-top-left scale-[0.34] px-3 py-3 text-[11px] leading-snug text-zinc-800 [&_h1]:mb-1 [&_h1]:text-[16px] [&_h1]:font-semibold [&_p]:mb-1"
          style={{ width: "294%", height: "294%" }}
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
      ) : page?.rows?.length ? (
        <table className="w-full border-collapse text-[8px] text-zinc-700 dark:text-zinc-200">
          <tbody>
            {page.rows.slice(0, 6).map((row, i) => (
              <tr key={i} className={i === 0 ? "font-semibold" : undefined}>
                {row.slice(0, 4).map((cell, j) => (
                  <td key={j} className="truncate border border-emerald-200/70 px-1 py-0.5 dark:border-emerald-900/50">
                    {cell || " "}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <FallbackPage kind={kind} name={source.name} />
      )}

      {busy || !page ? (
        <div
          className="absolute inset-0 flex items-end justify-center bg-black/35 px-1.5 pb-2"
          role="status"
          aria-live="polite"
          aria-label={caption || "Cargando documento"}
        >
          <div className="flex max-w-full flex-col items-center rounded-full bg-black/55 px-2 py-1 text-white">
            <ThinkingIndicator size="xs" className="text-sky-300" label={caption || "Cargando documento"} />
            {caption ? (
              <span className="mt-0.5 max-w-full truncate text-center text-[8.5px] font-medium leading-tight">
                {caption}
              </span>
            ) : null}
            {pct != null ? (
              <span className="tabular-nums text-[8.5px] text-white/80">{pct}%</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageShell>
  )
}

export default DocumentPageThumb
