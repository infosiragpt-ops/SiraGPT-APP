"use client"

import Image from "next/image"
import { FileCheck2, FileCode2 } from "lucide-react"

export const DOCUMENT_CARD_CLASS = "w-full max-w-xl overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm"
export const DOCUMENT_ACTION_CLASS = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
export const DOCUMENT_ACTION_ICON_CLASS = "h-[18px] w-[18px] stroke-[1.75]"

const OFFICE_ICONS: Record<string, { src: string; label: string }> = {
  doc: { src: "/icons/Word.png", label: "Word" },
  docx: { src: "/icons/Word.png", label: "Word" },
  xls: { src: "/icons/Excel.png", label: "Excel" },
  xlsx: { src: "/icons/Excel.png", label: "Excel" },
  csv: { src: "/icons/Excel.png", label: "CSV" },
  ppt: { src: "/icons/Bigger P powerpoint.png", label: "PowerPoint" },
  pptx: { src: "/icons/Bigger P powerpoint.png", label: "PowerPoint" },
  pdf: { src: "/icons/pdf.png", label: "PDF" },
}

/** One type identity for generated documents and all their edited versions. */
export function DocumentArtifactIcon({ format }: { format: string }) {
  const normalized = format.toLowerCase()
  const icon = OFFICE_ICONS[normalized]
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center" data-document-format={normalized}>
      {icon ? <Image src={icon.src} alt={icon.label} width={40} height={40} className="h-10 w-10 object-contain" />
        : normalized === "svg" ? <FileCode2 className="h-8 w-8 text-violet-600" aria-label="SVG" />
          : <FileCheck2 className="h-8 w-8 text-muted-foreground" aria-label="Archivo" />}
    </span>
  )
}
