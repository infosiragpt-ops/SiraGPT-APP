"use client"

// codex/codex-agent-panel — the Codex Agent V2 experience shell (feature 10),
// mounted in /code behind the health flag. Owns project selection + the active
// run, and renders the live timeline. Feature 11 adds the plan/checkpoint/
// summary/action-required cards, feature 12 the replica composer, feature 13
// the mobile tab bar. Minimal here so the timeline is exercisable end-to-end.

import React, { useEffect, useReducer, useState } from "react"
import clsx from "clsx"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Loader2, Plus, Eye, FileCode2, ListChecks, Plug, Play } from "lucide-react"
import { codexApi, type CodexProject } from "@/lib/codex/codex-api"
import { useCodexRun } from "@/lib/codex/use-codex-run"
import { CodexRunTimeline } from "./run-timeline"
import { PlanCard } from "./plan-card"
import { CheckpointCard } from "./checkpoint-card"
import { RunSummaryCard } from "./run-summary-card"
import { ActionRequiredCard } from "./action-required-card"
import { Composer, type ComposerSendPayload } from "./composer"
import { BottomTabBar } from "./bottom-tab-bar"
import { WebTab } from "./web-tab"
import { ChecklistTab } from "./checklist-tab"
import { FilesTab } from "./files-tab"
import { McpServersCard } from "@/components/settings/McpServersCard"
import { tabsReducer, initialTabsState, type CodexTabId } from "@/lib/codex/workspace-tabs"
import type { TimelineItem } from "@/lib/codex/timeline-reducer"

// Right-pane tabs on the desktop 3-pane layout (the left pane is always the
// Agent chat). Web is folded into Preview here; Agent never appears on the right.
const RIGHT_TABS: { id: CodexTabId; labelKey: string; icon: typeof Eye }[] = [
  { id: "preview", labelKey: "tabs.preview", icon: Eye },
  { id: "files", labelKey: "tabs.files", icon: FileCode2 },
  { id: "checklist", labelKey: "tabs.checklist", icon: ListChecks },
  { id: "connections", labelKey: "tabs.connections", icon: Plug },
]

/** Tracks the md breakpoint so the tab bar only exists on mobile. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)")
    const update = () => setMobile(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return mobile
}

export function CodexAgentPanel() {
  const t = useTranslations("codex")
  const [projects, setProjects] = useState<CodexProject[] | null>(null)
  const [project, setProject] = useState<CodexProject | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Latest composer Plan-toggle choice. When on, the run is planning-only: the
  // plan card hides "Aprobar y construir" and approvePlan is a guarded no-op, so
  // no build run can ever be created from a planning-only send (feature 12 acc.).
  const [planOnly, setPlanOnly] = useState(false)

  const { state, status, active, markApproved } = useCodexRun(activeRunId)

  const isMobile = useIsMobile()
  const [tabs, dispatchTabs] = useReducer(tabsReducer, undefined, () => initialTabsState())
  // Accrue the Agent-tab badge when timeline events arrive while elsewhere.
  useEffect(() => { if (state.lastSeq >= 0) dispatchTabs({ type: "agent_event" }) }, [state.lastSeq])
  // Surface a run/build failure as the Preview-tab error dot (req 5): the
  // dev-server-failed signal here is the run ending in error. Cleared on any
  // non-error status so a fresh run drops the stale dot.
  useEffect(() => { dispatchTabs({ type: "preview_error", value: status === "error" }) }, [status])
  const selectTab = (tab: CodexTabId) => dispatchTabs({ type: "select", tab })
  // Mobile: a single pane driven by the bottom tab bar. Desktop: a 3-pane split
  // (Agent left + a tabbed right pane), so the right pane has its own tab state.
  const activeTab: CodexTabId = isMobile ? tabs.active : "agent"
  const [rightTab, setRightTab] = useState<CodexTabId>("preview")

  // Preview pane: the runner dev server is single-tenant, so opening a preview
  // (re)starts THIS project's dev server, then the iframe is remounted to reload.
  const [previewStarting, setPreviewStarting] = useState(false)
  const [previewReloadKey, setPreviewReloadKey] = useState(0)
  async function startPreviewPane() {
    if (!project) return
    setPreviewStarting(true)
    try {
      await codexApi.startPreview(project.id)
      setPreviewReloadKey((k) => k + 1)
    } catch (e: any) {
      toast.error(e?.message || t("errors.openPreview"))
    } finally {
      setPreviewStarting(false)
    }
  }

  // Approve the plan → create the build run and switch the timeline to it.
  // The plan card is only marked approved AFTER the build run is created, so a
  // failed request never leaves the card collapsed-approved with no build run
  // (req 5: no inconsistent UI state on error). The PlanCard's own busy spinner
  // covers the in-flight state while we await.
  async function approvePlan() {
    if (!project || !activeRunId) return
    // Plan toggle on → planning-only: refuse to create the build run.
    if (planOnly) return
    try {
      const build = await codexApi.approvePlan(project.id, activeRunId)
      markApproved()
      setActiveRunId(build.id)
    } catch (e: any) {
      toast.error(e?.message || t("errors.approvePlan"))
    }
  }

  // Map plan/checkpoint/summary/action_required items to their rich cards.
  function renderCard(item: TimelineItem): React.ReactNode | null {
    switch (item.kind) {
      case "plan":
        return (
          <PlanCard
            architecture={item.architecture}
            pages={item.pages}
            components={item.components}
            tasks={item.tasks}
            approved={item.approved}
            waiting={status === "waiting_approval"}
            planOnly={planOnly}
            onApprove={approvePlan}
            onAdjust={() => document.querySelector<HTMLTextAreaElement>("[data-codex-composer]")?.focus()}
          />
        )
      case "checkpoint":
        return (
          <CheckpointCard
            checkpointId={item.checkpointId}
            commitSha={item.commitSha}
            title={item.title}
            createdAt={item.createdAt}
            projectId={project?.id}
            previewUrl={project?.previewUrl}
          />
        )
      case "summary":
        return <RunSummaryCard metrics={item.metrics} />
      case "action_required":
        return <ActionRequiredCard title={item.title} rawError={item.rawError} blockedCapabilities={item.blockedCapabilities} remediationUrl={item.remediationUrl} />
      default:
        return null
    }
  }

  useEffect(() => {
    codexApi.listProjects().then(setProjects).catch(() => setProjects([]))
  }, [])

  // Pick the most recent active/last run for the selected project.
  useEffect(() => {
    if (!project) return
    codexApi.listRuns(project.id).then((runs) => {
      if (runs.length) setActiveRunId(runs[0].id)
    }).catch(() => {})
  }, [project])

  async function createProject() {
    setBusy(true)
    try {
      const p = await codexApi.createProject(t("panel.defaultProjectName", { n: (projects?.length || 0) + 1 }))
      setProjects((cur) => [p, ...(cur || [])])
      setProject(p)
    } catch (e: any) {
      toast.error(e?.message || t("errors.createProject"))
    } finally {
      setBusy(false)
    }
  }

  // A composer send always starts a PLAN run (plan-first); the build run is
  // created later by the plan card's approval. Attachments are inlined into the
  // run prompt (feature 12 minimal scope). The chosen tier travels to the run.
  async function send(payload: ComposerSendPayload) {
    if (!project) return
    const attachText = payload.attachments.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n")
    const fullPrompt = [attachText, payload.prompt].filter(Boolean).join("\n\n").trim()
    if (!fullPrompt) return
    // Remember the Plan-toggle choice so the resulting plan card can suppress
    // the build path while the toggle is active (req 2: forces planning-only).
    setPlanOnly(payload.planOnly)
    setBusy(true)
    try {
      const run = await codexApi.createRun(project.id, { mode: "plan", prompt: fullPrompt, tier: payload.tier })
      setActiveRunId(run.id)
    } catch (e: any) {
      toast.error(e?.message || t("errors.startRun"))
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!activeRunId || !active) return
    try { await codexApi.cancelRun(activeRunId) } catch (e: any) { toast.error(e?.message || t("errors.stopRun")) }
  }

  if (projects === null) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("panel.loading")}</div>
  }

  const agentView = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        {activeRunId ? (
          <CodexRunTimeline state={state} cardRenderer={renderCard} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-500">
            {project ? t("panel.emptyDescribe") : t("panel.emptySelect")}
          </div>
        )}
      </div>
      <Composer disabled={!project} busy={busy} active={active} onSend={send} onStop={stop} />
    </div>
  )

  const previewPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <button type="button" onClick={startPreviewPane} disabled={previewStarting || !project} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50">
          {previewStarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {t("preview.start")}
        </button>
        <span className="truncate text-[11px] text-zinc-500">{t("preview.hint")}</span>
      </div>
      <div className="min-h-0 flex-1"><WebTab key={previewReloadKey} url={project?.previewUrl ?? null} /></div>
    </div>
  )

  const tabContent = (tab: CodexTabId): React.ReactNode => {
    switch (tab) {
      case "preview":
      case "web":
        return previewPane
      case "files":
        return <FilesTab projectId={project?.id ?? null} />
      case "connections":
        return <div className="h-full overflow-y-auto p-3"><McpServersCard /></div>
      case "checklist":
        return <ChecklistTab state={state} runStatus={status} />
      case "agent":
      default:
        return agentView
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <span className="text-sm font-semibold">⚡ Codex</span>
        <select
          className="ml-2 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs"
          value={project?.id || ""}
          onChange={(e) => setProject(projects.find((p) => p.id === e.target.value) || null)}
        >
          <option value="">{t("panel.selectProject")}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" onClick={createProject} disabled={busy} className="ml-auto flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs hover:bg-white/10">
          <Plus className="h-3.5 w-3.5" /> {t("panel.newProject")}
        </button>
        {status && <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{status}</span>}
      </header>

      {isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col">{tabContent(activeTab)}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left: the Agent chat is always visible. */}
          <div className="flex w-[42%] min-w-[400px] max-w-[680px] shrink-0 flex-col border-r border-white/10">
            {agentView}
          </div>
          {/* Right: tabbed Preview / Código / Checklist / Conexiones. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2">
              {RIGHT_TABS.map(({ id, labelKey, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setRightTab(id)}
                  aria-current={rightTab === id ? "page" : undefined}
                  className={clsx("flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs", rightTab === id ? "border-violet-400 text-violet-200" : "border-transparent text-zinc-400 hover:text-zinc-200")}
                >
                  <Icon className="h-3.5 w-3.5" /> {t(labelKey)}
                  {id === "preview" && tabs.previewError && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-red-500" />}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">{tabContent(rightTab)}</div>
          </div>
        </div>
      )}

      {isMobile && <BottomTabBar state={tabs} onSelect={selectTab} />}
    </div>
  )
}
