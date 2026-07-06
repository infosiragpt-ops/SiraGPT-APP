"use client"

/**
 * PapersResultCard — the rich, persistent render of a `/research` scientific
 * search. Driven by a ```scientific-papers``` fenced block that
 * chat-interface-enhanced injects into an assistant message after querying
 * /api/scientific-search (OpenAlex + CrossRef + arXiv + PubMed + Semantic
 * Scholar + CORE + 10 more sources). Papers arrive ranked by citations so a
 * student sees the most-cited work first, with impressive clarity: title,
 * authors, venue, a prominent citation badge, open-access PDF + DOI actions.
 */

import * as React from "react"
import { BookOpen, ExternalLink, FileText, Quote, Sparkles, TrendingUp } from "lucide-react"

export type ScientificPaper = {
  source?: string
  doi?: string | null
  title?: string
  abstract?: string | null
  authors?: Array<{ name?: string } | string> | null
  year?: number | null
  venue?: string | null
  citations?: number | null
  openAccess?: boolean | null
  pdfUrl?: string | null
  htmlUrl?: string | null
}

export type PapersPayload = {
  query?: string
  count?: number
  providers?: string[]
  papers?: ScientificPaper[]
}

const SOURCE_LABEL: Record<string, string> = {
  openalex: "OpenAlex",
  crossref: "CrossRef",
  arxiv: "arXiv",
  pubmed: "PubMed",
  europepmc: "Europe PMC",
  semanticscholar: "Semantic Scholar",
  core: "CORE",
  doaj: "DOAJ",
  dblp: "DBLP",
  datacite: "DataCite",
  scielo: "SciELO",
  redalyc: "Redalyc",
  scopus: "Scopus",
  wos: "Web of Science",
  biorxiv: "bioRxiv",
  medrxiv: "medRxiv",
}

function authorList(authors: ScientificPaper["authors"]): string {
  if (!Array.isArray(authors) || authors.length === 0) return ""
  const names = authors
    .map((a) => (typeof a === "string" ? a : a?.name || ""))
    .map((n) => n.trim())
    .filter(Boolean)
  if (names.length === 0) return ""
  if (names.length <= 3) return names.join(", ")
  return `${names.slice(0, 3).join(", ")} et al.`
}

function paperUrl(p: ScientificPaper): string | null {
  if (p.htmlUrl) return p.htmlUrl
  if (p.doi) return `https://doi.org/${String(p.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
  if (p.pdfUrl) return p.pdfUrl
  return null
}

function citationTone(c: number): { bg: string; fg: string } {
  // Gold for heavily-cited landmark work, then blue, then muted.
  if (c >= 1000) return { bg: "rgba(217,169,32,0.16)", fg: "#b7860b" }
  if (c >= 100) return { bg: "rgba(37,99,235,0.12)", fg: "#2563eb" }
  if (c >= 10) return { bg: "rgba(100,116,139,0.14)", fg: "#475569" }
  return { bg: "rgba(100,116,139,0.10)", fg: "#64748b" }
}

const clamp2: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
}

function PaperRow({ paper, rank }: { paper: ScientificPaper; rank: number }) {
  const url = paperUrl(paper)
  const cites = typeof paper.citations === "number" ? paper.citations : 0
  const tone = citationTone(cites)
  const authors = authorList(paper.authors)
  const meta = [authors, paper.year || null, paper.venue || null].filter(Boolean).join(" · ")
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null

  return (
    <li className="rounded-xl border border-border/60 bg-background/60 p-3.5 transition-colors hover:border-border">
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-[12px] font-semibold text-muted-foreground">
          {medal || rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-[14px] font-semibold leading-snug text-foreground hover:underline"
              >
                {paper.title || "(sin título)"}
              </a>
            ) : (
              <span className="text-[14px] font-semibold leading-snug text-foreground">
                {paper.title || "(sin título)"}
              </span>
            )}
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ backgroundColor: tone.bg, color: tone.fg }}
              title={`${cites.toLocaleString()} citas`}
            >
              <Quote className="h-3 w-3" />
              {cites.toLocaleString()}
            </span>
          </div>

          {meta ? <p className="mt-1 text-[12px] text-muted-foreground">{meta}</p> : null}

          {paper.abstract ? (
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground/90" style={clamp2}>
              {paper.abstract}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {paper.source ? (
              <span className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {SOURCE_LABEL[paper.source] || paper.source}
              </span>
            ) : null}
            {paper.openAccess ? (
              <span className="rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Open Access
              </span>
            ) : null}
            {paper.pdfUrl ? (
              <a
                href={paper.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted/40"
              >
                <FileText className="h-3 w-3" />
                PDF
              </a>
            ) : null}
            {paper.doi ? (
              <a
                href={`https://doi.org/${String(paper.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40"
              >
                DOI
              </a>
            ) : null}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-blue-600 transition-colors hover:underline dark:text-blue-400"
              >
                <ExternalLink className="h-3 w-3" />
                Ver fuente
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  )
}

export function PapersResultCard({ data }: { data: PapersPayload }) {
  const [showAll, setShowAll] = React.useState(false)
  const papers = Array.isArray(data?.papers) ? data.papers : []
  const providers = Array.isArray(data?.providers) ? data.providers : []
  const total = typeof data?.count === "number" ? data.count : papers.length
  const visible = showAll ? papers : papers.slice(0, 12)

  if (papers.length === 0) {
    return (
      <div className="my-2 rounded-2xl border border-border/60 bg-muted/20 p-4 text-[13px] text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <BookOpen className="h-4 w-4" />
          Sin resultados
        </div>
        <p className="mt-1">
          No encontré artículos para {data?.query ? <span className="font-medium">“{data.query}”</span> : "esa búsqueda"}.
          Prueba con términos en inglés o más específicos.
        </p>
      </div>
    )
  }

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-border/60 bg-background/40">
      {/* Header */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3"
        style={{ background: "linear-gradient(135deg, rgba(37,99,235,0.08), rgba(147,51,234,0.06))" }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <BookOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <span className="truncate">
              {total.toLocaleString()} artículos científicos
              {data?.query ? <span className="font-normal text-muted-foreground"> · “{data.query}”</span> : null}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <TrendingUp className="h-3 w-3" />
            Ordenados por número de citas · {providers.length || "varias"} fuentes
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          <Sparkles className="h-3 w-3" />
          Más citados primero
        </span>
      </div>

      {/* Papers */}
      <ul className="space-y-2 p-3">
        {visible.map((p, i) => (
          <PaperRow key={`${p.doi || p.title || i}-${i}`} paper={p} rank={i + 1} />
        ))}
      </ul>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
        {papers.length > 12 ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[12px] font-medium text-blue-600 transition-opacity hover:opacity-80 dark:text-blue-400"
          >
            {showAll ? "Ver menos" : `Ver los ${papers.length} resultados`}
          </button>
        ) : (
          <span />
        )}
        {providers.length ? (
          <span className="truncate text-[10px] text-muted-foreground">
            Fuentes: {providers.map((p) => SOURCE_LABEL[p] || p).join(" · ")}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default PapersResultCard
