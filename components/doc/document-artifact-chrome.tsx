"use client"

import { FileCheck2, FileCode2 } from "lucide-react"
import { OfficeFileIcon, officeKindForName, officeKindLabel } from "@/components/office-file-icon"

export const DOCUMENT_CARD_CLASS = "w-full max-w-xl overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm"
export const DOCUMENT_ACTION_CLASS = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
export const DOCUMENT_ACTION_ICON_CLASS = "h-[18px] w-[18px] stroke-[1.75]"

/** One type identity for generated documents and all their edited versions. */
export function DocumentArtifactIcon({ format }: { format: string }) {
  const normalized = format.toLowerCase()
  const kind = officeKindForName(normalized)
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center" data-document-format={normalized}>
      {kind ? <OfficeFileIcon kind={kind} size={40} className="h-10 w-10" title={normalized === "csv" ? "CSV" : officeKindLabel(kind)} />
        : normalized === "svg" ? <FileCode2 className="h-8 w-8 text-violet-600" aria-label="SVG" />
          : <FileCheck2 className="h-8 w-8 text-muted-foreground" aria-label="Archivo" />}
    </span>
  )
}
