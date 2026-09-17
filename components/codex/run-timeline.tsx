"use client"

// codex/run-timeline — renders a run's timeline in seq order (feature 10):
// narrative paragraphs, collapsible reasoning blocks, grouped action chips, and
// the floating "Scroll to latest" pill. Plan/checkpoint/summary/action-required
// items render via the cards from feature 11 (passed as `cardRenderer`); a
// minimal fallback keeps the timeline self-contained.

import React from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { ArrowDown, Loader2, Volume2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { codexApi } from "@/lib/codex/codex-api"
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-sanitize"
import { ActionChipsRow } from "./action-chips-row"
import { ReasoningBlock } from "./reasoning-block"
import { useStickToBottom } from "@/lib/codex/use-stick-to-bottom"
import type { TimelineItem, TimelineState } from "@/lib/codex/timeline-reducer"

export interface CodexRunTimelineProps {
  state: TimelineState
  /** Feature 11 plugs in the rich cards; returns null to use the fallback. */
  cardRenderer?: (item: TimelineItem) => React.ReactNode | null
  className?: string
  runId?: string | null
}

type Translate = ReturnType<typeof useTranslations>

function SummaryAudioButton({ runId }: { runId: string }) {
  const [busy, setBusy] = React.useState(false)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const generate = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await codexApi.generateRunSummaryAudio(runId)
      setAudioUrl(result.audio.audioUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el audio.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl} className="h-9 w-full" />
      ) : (
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-50"
          aria-label="Escuchar resumen ejecutivo"
          title="Escuchar resumen ejecutivo"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}
      {error ? <p className="mt-1 text-[11px] text-amber-300">{error}</p> : null}
    </div>
  )
}

function FallbackCard({ item, t, runId }: { item: TimelineItem; t: Translate; runId?: string | null }) {
  if (item.kind === "plan") {
    return (
      <div className="my-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-sm">
        <div className="font-semibold text-violet-200">{t("plan.title")}</div>
        <div className="mt-1 text-zinc-300">{item.architecture}</div>
        <div className="mt-1 text-xs text-zinc-400">{item.pages.length} {t("plan.pages")} · {item.components.length} {t("plan.components")} · {item.tasks.length} {t("plan.tasks")}</div>
      </div>
    )
  }
  if (item.kind === "checkpoint") {
    return <div className="my-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm"><code className="text-xs">{item.commitSha?.slice(0, 7)}</code> — {item.title}</div>
  }
  if (item.kind === "summary") {
    const m = item.metrics || {}
    return <div className="my-2 rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-zinc-300">{t("summary.workedFor", { duration: t("summary.actions", { count: m.actionsCount ?? 0 }) })} · +{m.additions ?? 0} −{m.deletions ?? 0}</div>
  }
  if (item.kind === "run_audio") {
    return (
      <div className="my-2 border-l-2 border-sky-500/40 pl-3">
        <audio controls preload="metadata" src={item.audioUrl} className="h-9 w-full" />
      </div>
    )
  }
  if (item.kind === "file_patch") {
    return (
      <details className="my-2 border-l-2 border-emerald-500/40 pl-3 text-xs">
        <summary className="cursor-pointer font-medium text-zinc-300">Cambio en {item.path}</summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] text-zinc-400">{item.patch}</pre>
      </details>
    )
  }
  if (item.kind === "executive_summary") {
    const summary = item.summary
    return (
      <div className="my-2 border-l-2 border-emerald-500/50 pl-3 text-sm">
        <div className="font-semibold text-zinc-100">Resumen ejecutivo</div>
        <div className="mt-1 text-zinc-300">{summary.result}</div>
        <div className="mt-1 text-xs text-zinc-400">{summary.impact}</div>
        {runId ? <SummaryAudioButton runId={runId} /> : null}
      </div>
    )
  }
  if (item.kind === "action_required") {
    return (
      <div className="my-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
        <div className="font-semibold text-red-300">🔴 {t("actionRequired.title")}</div>
        <div className="mt-1 text-zinc-300">{item.title}</div>
      </div>
    )
  }
  if (item.kind === "tool_permission") {
    return (
      <div className="my-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3 text-sm">
        <div className="font-semibold text-amber-200">Aprobación de herramienta</div>
        <div className="mt-1 text-zinc-300">{item.humanDescription || item.toolName}</div>
      </div>
    )
  }
  return null
}

function renderItem(
  item: TimelineItem,
  t: Translate,
  cardRenderer?: CodexRunTimelineProps["cardRenderer"],
  runId?: string | null,
): React.ReactNode {
  switch (item.kind) {
    case "narrative":
      return (
        <div key={item.id} className="prose prose-invert prose-sm my-1 max-w-none text-zinc-200">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>{item.text}</ReactMarkdown>
        </div>
      )
    case "reasoning":
      return <ReasoningBlock key={item.id} label={item.label} text={item.text} durationMs={item.durationMs} done={item.done} />
    case "action_group":
      return <ActionChipsRow key={item.id} actions={item.actions} />
    default: {
      const custom = cardRenderer?.(item)
      return <React.Fragment key={item.id}>{custom != null ? custom : <FallbackCard item={item} t={t} runId={runId} />}</React.Fragment>
    }
  }
}

export function CodexRunTimeline({ state, cardRenderer, className, runId }: CodexRunTimelineProps) {
  const t = useTranslations("codex")
  const stick = useStickToBottom(`${state.items.length}:${state.lastSeq}`)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={stick.ref}
        onScroll={stick.onScroll}
        className={clsx("flex-1 overflow-y-auto px-3 py-2", className)}
        data-testid="codex-run-timeline"
      >
        {state.items.map((item) => renderItem(item, t, cardRenderer, runId))}
      </div>

      {stick.showPill && (
        <button
          type="button"
          onClick={() => stick.scrollToBottom(true)}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-200 shadow-lg backdrop-blur hover:bg-zinc-800"
        >
          <ArrowDown className="h-3.5 w-3.5" /> {t("timeline.scrollToLatest")}
        </button>
      )}
    </div>
  )
}
