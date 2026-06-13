"use client"

// codex/run-timeline — renders a run's timeline in seq order (feature 10):
// narrative paragraphs, collapsible reasoning blocks, grouped action chips, and
// the floating "Scroll to latest" pill. Plan/checkpoint/summary/action-required
// items render via the cards from feature 11 (passed as `cardRenderer`); a
// minimal fallback keeps the timeline self-contained.

import React from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { ArrowDown } from "lucide-react"
import ReactMarkdown from "react-markdown"
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
}

type Translate = ReturnType<typeof useTranslations>

function FallbackCard({ item, t }: { item: TimelineItem; t: Translate }) {
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
  if (item.kind === "action_required") {
    return (
      <div className="my-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
        <div className="font-semibold text-red-300">🔴 {t("actionRequired.title")}</div>
        <div className="mt-1 text-zinc-300">{item.title}</div>
      </div>
    )
  }
  return null
}

function renderItem(item: TimelineItem, t: Translate, cardRenderer?: CodexRunTimelineProps["cardRenderer"]): React.ReactNode {
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
      return <React.Fragment key={item.id}>{custom != null ? custom : <FallbackCard item={item} t={t} />}</React.Fragment>
    }
  }
}

export function CodexRunTimeline({ state, cardRenderer, className }: CodexRunTimelineProps) {
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
        {state.items.map((item) => renderItem(item, t, cardRenderer))}
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
