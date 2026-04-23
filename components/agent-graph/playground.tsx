"use client"

/**
 * Playground — top-level layout that wires the prompt controls to
 * the stream service and drives three render surfaces (plan graph,
 * synthesis preview, event console) from one event stream.
 *
 * State machine:
 *   idle → planning → running → synthesizing → done
 *                                             → error
 *
 * Cancel: the Run button becomes a Stop button while the stream is
 * open. Stopping aborts the fetch, which the server propagates into
 * the orchestrator's AbortController — any in-flight LLM /
 * CrossRef / OpenAlex call is cancelled, not left to burn tokens.
 */

import * as React from "react"
import { Play, Square, Loader2, Network } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { PlanGraph, type GraphStep } from "./plan-graph"
import { StreamConsole, type ConsoleEntry } from "./stream-console"
import { SynthesisPreview } from "./synthesis-preview"
import {
  runAgent, type AgentEvent, type AgentThinking,
} from "@/lib/agent-stream-service"

type RunState = "idle" | "planning" | "running" | "synthesizing" | "done" | "error"

export function Playground() {
  const [prompt, setPrompt] = React.useState("")
  const [thinking, setThinking] = React.useState<AgentThinking>("medium")
  const [mode, setMode] = React.useState<"main" | "sandbox">("main")

  const [steps, setSteps] = React.useState<GraphStep[]>([])
  const [events, setEvents] = React.useState<ConsoleEntry[]>([])
  const [answer, setAnswer] = React.useState<string | null>(null)
  const [stoppedReason, setStoppedReason] = React.useState<string | undefined>()
  const [state, setState] = React.useState<RunState>("idle")
  const abortRef = React.useRef<AbortController | null>(null)

  const pushEvent = React.useCallback((type: string, label: string, detail?: string) => {
    setEvents(prev => [...prev, { at: Date.now(), type, label, detail }])
  }, [])

  const reset = React.useCallback(() => {
    setSteps([])
    setEvents([])
    setAnswer(null)
    setStoppedReason(undefined)
  }, [])

  const apply = React.useCallback((ev: AgentEvent) => {
    switch (ev.type) {
      case "policy":
        pushEvent("policy", `mode=${ev.mode}, hidden=${ev.hidden.length}`)
        break

      case "plan":
        pushEvent("plan", `${ev.plan.length} step(s)`, ev.rationale?.slice(0, 60))
        setSteps(ev.plan.map(p => ({
          step: p.step, goal: p.goal, tool_hint: p.tool_hint,
          status: "pending",
        })))
        setState("running")
        break

      case "replan":
        pushEvent("replan", `${ev.plan.length} new step(s)`, ev.rationale?.slice(0, 60))
        setSteps(prev => {
          // Keep already-done steps; append any new ones after them.
          const done = prev.filter(s => s.status === "done")
          const nextStart = done.length + 1
          const appended = ev.plan.map((p, i) => ({
            step: nextStart + i, goal: p.goal, tool_hint: p.tool_hint,
            status: "pending" as const,
          }))
          return [...done, ...appended]
        })
        break

      case "step":
        // Two shapes: planner-executor ({plan_step, trace}) or
        // low-thinking plain ReAct ({step}). Normalize both.
        if ("plan_step" in ev && ev.trace) {
          const idx = ev.plan_step - 1
          const trace = ev.trace
          pushEvent("step", `step ${ev.plan_step}`, trace.thought?.slice(0, 60))
          setSteps(prev => {
            const next = [...prev]
            if (next[idx]) {
              const hasFinal = trace.actions?.some((a: any) => a.tool === "finalize")
              next[idx] = {
                ...next[idx],
                status: hasFinal ? "done" : "running",
                trace: { thought: trace.thought, actions: trace.actions || [] },
              }
              // Mark previous running steps as done (sequential flow).
              for (let i = 0; i < idx; i++) {
                if (next[i].status === "running") next[i] = { ...next[i], status: "done" }
              }
            }
            return next
          })
        } else if ("step" in ev) {
          // Low-thinking mode: no plan, just raw react-agent steps.
          const t = (ev as any).step
          pushEvent("step", `react step ${t.step}`, t.thought?.slice(0, 60))
        }
        break

      case "synthesis":
        pushEvent("synthesis", "stitching final answer")
        setState("synthesizing")
        // Mark all remaining steps done — the executor only fires
        // synthesis after every step has produced an answer.
        setSteps(prev => prev.map(s =>
          s.status === "done" ? s : { ...s, status: "done" },
        ))
        break

      case "final":
        pushEvent("final", `${(ev.answer || "").length} chars`, ev.stoppedReason)
        setAnswer(ev.answer || "(no answer)")
        setStoppedReason(ev.stoppedReason)
        setState("done")
        break

      case "error":
        pushEvent("error", ev.error)
        setState("error")
        if (ev.error !== "aborted") toast.error(ev.error)
        break
    }
  }, [pushEvent])

  async function handleRun() {
    const q = prompt.trim()
    if (q.length < 3) { toast.error("Query too short"); return }

    reset()
    setState("planning")
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      for await (const ev of runAgent({
        query: q,
        thinking,
        useSkills: true,
        mode,
        signal: ctrl.signal,
      })) {
        apply(ev)
      }
      setState(prev => (prev === "done" || prev === "error") ? prev : "error")
    } catch (err: any) {
      if (err?.name === "AbortError") {
        pushEvent("error", "aborted by user")
        setState("idle")
      } else {
        toast.error(err?.message || "Run failed")
        setState("error")
      }
    } finally {
      abortRef.current = null
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  const running = state === "planning" || state === "running" || state === "synthesizing"

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 md:px-8 py-6 md:py-10">
        <header className="flex items-center gap-3 mb-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground/5">
            <Network className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-2xl font-serif tracking-tight">Agent playground</h1>
            <p className="text-sm text-muted-foreground">
              Live view of the planner → executor → synthesis loop. Useful for debugging tool selection, re-plans, and policy gating.
            </p>
          </div>
        </header>

        {/* Prompt + controls */}
        <div className="rounded-xl border border-border/60 bg-card p-4 mb-5">
          <Label htmlFor="ap-prompt" className="text-xs">Goal</Label>
          <Textarea
            id="ap-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleRun() }
            }}
            placeholder="e.g. Find 5 papers on Cronbach's alpha in Likert scales (2022-2024) and summarise the methodological consensus in APA 7."
            rows={3}
            disabled={running}
            className="mt-1 resize-none text-sm"
          />
          <div className="flex items-end justify-between gap-3 mt-3">
            <div className="flex gap-3">
              <div>
                <Label className="text-xs">Thinking</Label>
                <Select value={thinking} onValueChange={(v: any) => setThinking(v)} disabled={running}>
                  <SelectTrigger className="mt-1 h-8 w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low · plain ReAct</SelectItem>
                    <SelectItem value="medium">medium · plan once</SelectItem>
                    <SelectItem value="high">high · plan + re-plan</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Policy</Label>
                <Select value={mode} onValueChange={(v: any) => setMode(v)} disabled={running}>
                  <SelectTrigger className="mt-1 h-8 w-[110px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="main">main</SelectItem>
                    <SelectItem value="sandbox">sandbox</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {running ? (
              <Button onClick={handleStop} variant="outline" className="gap-2">
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button onClick={handleRun} disabled={prompt.trim().length < 3} className="gap-2">
                {state === "done" || state === "error" ? <Play className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                Run
                <span className="text-[10px] opacity-60 ml-1 hidden sm:inline">⌘↵</span>
              </Button>
            )}
          </div>
          {state !== "idle" && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {running && <Loader2 className="h-3 w-3 animate-spin" />}
              <span>state: {state}</span>
            </div>
          )}
        </div>

        {/* Three-column layout on desktop: graph | synthesis | console */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_360px] gap-5">
          <section>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-2">
              Plan graph
            </div>
            <PlanGraph steps={steps} />
          </section>

          <section className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-2">
              Synthesis
            </div>
            <SynthesisPreview
              markdown={answer}
              state={
                state === "idle" ? "idle" :
                state === "synthesizing" ? "synthesizing" :
                state === "done" ? "done" :
                state === "error" ? "error" : "waiting"
              }
              stoppedReason={stoppedReason}
            />
          </section>

          <section className="xl:block hidden">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-2">
              Events
            </div>
            <StreamConsole entries={events} className="h-[560px]" />
          </section>
        </div>

        {/* Mobile / tablet: show console below when not in xl layout */}
        <section className="xl:hidden mt-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-2">
            Events
          </div>
          <StreamConsole entries={events} className="h-[220px]" />
        </section>
      </div>
    </div>
  )
}
