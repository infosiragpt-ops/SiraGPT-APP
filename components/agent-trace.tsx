"use client"

/**
 * AgentTrace — evolution of ThinkingTrace for agent-harness turns.
 *
 * Keeps ThinkingTrace's visual language intact (shimmer header with the
 * DotmCircular15 glyph, markdown reasoning, token-class theming) and
 * interleaves the typed tool-call timeline:
 *
 *   - vertical gray connector rail on the left (border-l, like ThinkingTrace),
 *   - one row per tool call: lucide icon by tool family (Globe web, Code2
 *     execution, Plug MCP, FileText artifacts/docs), the humanDescription as
 *     the main text, the dot-matrix spinner while `executing` and a check /
 *     red error mark when settled,
 *   - a collapsible chip revealing arguments + result preview through the
 *     existing CustomCodeBlock renderer (red tint when is_error),
 *   - an inline permission card (Permitir / Permitir siempre en este chat /
 *     Denegar) with a subtle pulse while the loop is paused waiting,
 *   - auto-collapse on agent_done to one summary line — "Pensó 8 s · usó 3
 *     herramientas" — expandable with a click; historical messages render
 *     collapsed from the persisted agent_metadata.
 *
 * Strings come from the `agent` next-intl namespace (es/en seeds, propagated
 * to every locale; English deep-merge covers any gap).
 */

import React, { useEffect, useMemo, useRef, useState } from "react"
import clsx from "clsx"
import {
  ChevronDown,
  ChevronRight,
  Bot,
  Globe,
  Code2,
  Plug,
  FileText,
  Image as ImageIcon,
  Wrench,
  Check,
  X,
  ShieldQuestion,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-sanitize"
import { DotmCircular15 } from "@/components/ui/dotm-circular-15"
import { CustomCodeBlock } from "@/components/ui/custom-code-block"
import { apiClient } from "@/lib/api"
import { formatThinkingDuration } from "@/components/thinking-trace"
import type { AgentStepClient, AgentRunClient, AgentPermissionClient } from "@/lib/chat-context-integrated"

export type AgentTraceProps = {
  /** Chain-of-thought text (markdown), partial while streaming. */
  reasoning?: string
  reasoningStreaming?: boolean
  reasoningDurationMs?: number | null
  /** Typed tool-call steps, ordered by (blockIndex, seq). */
  steps: AgentStepClient[]
  run?: AgentRunClient | null
  permission?: AgentPermissionClient | null
  /** Optimistically clear the permission card after answering. */
  onPermissionAnswered?: () => void
}

function toolIconFor(name?: string) {
  const n = String(name || "").toLowerCase()
  const cls = "h-3.5 w-3.5"
  if (n.startsWith("mcp__")) return <Plug className={cls} />
  if (/search|browse|web|url|fetch|read/.test(n)) return <Globe className={cls} />
  if (/javascript|exec|code|python|bash|run|sandbox/.test(n)) return <Code2 className={cls} />
  if (/artifact|doc|file|pdf|rag|create_document/.test(n)) return <FileText className={cls} />
  if (/image|chart|diagram|video|svg|media|music|speech/.test(n)) return <ImageIcon className={cls} />
  return <Wrench className={cls} />
}

function prettyJsonOrRaw(raw?: string): string {
  const value = (raw || "").trim()
  if (!value) return ""
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function StepRow({ step, isLast }: { step: AgentStepClient; isLast: boolean }) {
  const t = useTranslations("agent")
  const [open, setOpen] = useState(false)
  const prettyArgs = useMemo(() => prettyJsonOrRaw(step.args), [step.args])
  const prettyResult = useMemo(() => prettyJsonOrRaw(step.preview), [step.preview])
  const running = step.status === "planned" || step.status === "executing"
  const failed = step.status === "error" || step.status === "denied" || Boolean(step.isError)

  return (
    <div className="relative flex gap-2.5 pb-2.5 last:pb-0">
      {/* Vertical connector rail between step icons. */}
      {!isLast && <span aria-hidden className="absolute left-[9.5px] top-5 bottom-0 w-px bg-border/60" />}
      <div
        className={clsx(
          "z-[1] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-background",
          failed ? "border-red-500/40 text-red-500" : "border-border/60 text-muted-foreground",
        )}
      >
        {toolIconFor(step.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx("text-[12.5px] font-medium", failed ? "text-red-500/90" : "text-foreground/80")}>
            {step.humanDescription || t("usingTool", { name: step.name })}
          </span>
          {running ? (
            <DotmCircular15 size={13} className="shrink-0" ariaLabel={t("working")} />
          ) : failed ? (
            <X className="h-3.5 w-3.5 shrink-0 text-red-500" aria-label={t("error")} />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label="ok" />
          )}
          {step.status === "denied" && (
            <span className="rounded-full border border-red-500/30 bg-red-500/[0.07] px-1.5 py-px text-[10.5px] text-red-500/90">
              {t("permissionDeniedChip")}
            </span>
          )}
          {typeof step.durationMs === "number" && step.durationMs > 750 && !running && (
            <span className="text-[10.5px] text-muted-foreground/70">
              {formatThinkingDuration(step.durationMs)}
            </span>
          )}
          {(prettyArgs || prettyResult) && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-0.5 rounded-full border border-border/60 px-1.5 py-px text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t("details")}
            </button>
          )}
        </div>
        {open && (
          <div className={clsx("mt-1.5 space-y-1.5 overflow-hidden rounded-lg text-[12px]", failed && "ring-1 ring-red-500/25")}>
            {prettyArgs && (
              <div>
                <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">{t("arguments")}</div>
                <CustomCodeBlock className="language-json">{prettyArgs}</CustomCodeBlock>
              </div>
            )}
            {prettyResult && (
              <div>
                <div className={clsx("mb-0.5 text-[10.5px] uppercase tracking-wide", failed ? "text-red-500/80" : "text-muted-foreground/70")}>
                  {failed ? t("error") : t("result")}
                </div>
                <CustomCodeBlock className="language-json">{prettyResult}</CustomCodeBlock>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PermissionCard({
  permission,
  onAnswered,
}: {
  permission: AgentPermissionClient
  onAnswered?: () => void
}) {
  const t = useTranslations("agent")
  const [busy, setBusy] = useState<string | null>(null)
  // Optimistic hide after a successful answer — the stream's
  // permission_resolved frame clears the store state right behind it.
  const [answered, setAnswered] = useState(false)

  const answer = async (decision: "allow" | "always_allow_in_chat" | "deny") => {
    if (busy) return
    setBusy(decision)
    try {
      await apiClient.resolveAgentPermission(permission.permissionId, decision)
      setAnswered(true)
      onAnswered?.()
    } catch (err: any) {
      toast.error(t("permissionError"))
      console.warn("[agent-trace] permission answer failed:", err?.message)
      setBusy(null)
    }
  }

  if (answered) return null

  return (
    <div className="my-2 rounded-xl border border-border/70 bg-muted/30 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 animate-pulse items-center justify-center text-muted-foreground">
          <ShieldQuestion className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground/90">
            {t("permissionTitle", { name: permission.name })}
          </div>
          {permission.humanDescription && (
            <div className="mt-0.5 text-[12px] text-muted-foreground">{permission.humanDescription}</div>
          )}
          {permission.args && (
            <pre className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-2 font-mono text-[11px] text-muted-foreground">
              {prettyJsonOrRaw(permission.args)}
            </pre>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => answer("allow")}
              className="inline-flex h-7 items-center rounded-full bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "allow" ? <DotmCircular15 size={13} /> : t("allow")}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => answer("always_allow_in_chat")}
              className="inline-flex h-7 items-center rounded-full border border-border/70 px-3 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted/50 disabled:opacity-50"
            >
              {busy === "always_allow_in_chat" ? <DotmCircular15 size={13} /> : t("allowAlways")}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => answer("deny")}
              className="inline-flex h-7 items-center rounded-full border border-red-500/30 px-3 text-[12px] font-medium text-red-500/90 transition-colors hover:bg-red-500/[0.07] disabled:opacity-50"
            >
              {busy === "deny" ? <DotmCircular15 size={13} /> : t("deny")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AgentTrace({
  reasoning = "",
  reasoningStreaming = false,
  reasoningDurationMs,
  steps,
  run,
  permission,
  onPermissionAnswered,
}: AgentTraceProps) {
  const t = useTranslations("agent")
  const active = reasoningStreaming || run?.status === "running" || (!run && steps.some((s) => s.status === "planned" || s.status === "executing"))
  // Expanded while the run is live; auto-collapses on agent_done. The user's
  // explicit toggle always wins afterwards (same pattern as ThinkingTrace).
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const expanded = userToggled !== null ? userToggled : active
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active || !expanded) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reasoning, steps, active, expanded])

  const toolCount = run?.toolCalls ?? steps.length
  const durationMs = run?.durationMs ?? reasoningDurationMs ?? 0

  const prettyDuration = formatThinkingDuration(Math.max(durationMs, 1000))
  const headerLabel = active
    ? t("working")
    : run?.status === "interrupted"
      ? t("interrupted")
      : toolCount === 1
        ? t("summaryOne", { duration: prettyDuration })
        : toolCount > 1
          ? t("summary", { duration: prettyDuration, count: toolCount })
          : t("summaryNoTools", { duration: prettyDuration })

  if (!steps.length && !(reasoning || "").trim() && !active) return null

  return (
    <div className="mb-2.5 w-full max-w-2xl">
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
        aria-label={t("traceAria")}
        className="group flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left"
      >
        {active ? (
          <DotmCircular15 size={18} className="shrink-0" ariaLabel={t("working")} />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={clsx(
            "min-w-0 truncate text-[13px] font-medium tracking-tight",
            active ? "thinking-shimmer-text" : "text-muted-foreground group-hover:text-foreground/80",
          )}
        >
          {headerLabel}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        )}
      </button>

      {expanded && (
        <div className="mt-1 border-l border-border/50 pl-3">
          <div
            ref={scrollerRef}
            className={clsx(
              "overflow-y-auto pr-1 text-[13px] leading-relaxed text-muted-foreground",
              active ? "max-h-64" : "max-h-96",
            )}
          >
            {(reasoning || "").trim() && (
              <div className="prose prose-sm dark:prose-invert mb-2 max-w-none [&_p]:my-1.5 [&_pre]:my-2">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                  {reasoning}
                </ReactMarkdown>
              </div>
            )}
            {steps.map((step, i) => (
              <StepRow key={step.id} step={step} isLast={i === steps.length - 1} />
            ))}
          </div>
          {permission && (
            <PermissionCard key={permission.permissionId} permission={permission} onAnswered={onPermissionAnswered} />
          )}
        </div>
      )}
    </div>
  )
}
