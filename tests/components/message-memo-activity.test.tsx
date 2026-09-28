import { describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))

import { areMessagePropsEqual } from "@/components/message-component"
import { appendActivity } from "@/lib/chat/activity-log"

describe("MessageComponent memo · live timeline", () => {
  it("re-renders on every stage while the content is still empty (3 stages → 3 renders)", () => {
    const base = { id: "m1", role: "ASSISTANT", content: "", files: null }
    let log = appendActivity([], { type: "stage", step: "tool_call", callId: "a", label: "Leyendo el documento" }, 1)
    let prev = { message: { ...base, activityLog: log }, isStreaming: true }
    const frames = [
      { type: "stage", step: "tool_result", callId: "a", ok: true, label: "Leyendo el documento" },
      { type: "stage", step: "tool_call", callId: "b", label: "Editando el documento" },
      { type: "stage", step: "tool_result", callId: "b", ok: true, label: "Editando el documento", thumbs: ["data:image/jpeg;base64,/9j/4AA="] },
    ]
    let renders = 0
    for (const frame of frames) {
      log = appendActivity(log, frame, 2)
      const next = { message: { ...base, activityLog: log }, isStreaming: true }
      if (!areMessagePropsEqual(prev, next)) renders += 1
      prev = next
    }
    expect(renders).toBe(3)
  })

  it("re-renders while reasoning streams, agent steps move and live stage notes change (content still empty)", () => {
    const base = { id: "m2", role: "ASSISTANT", content: "", files: null, activityLog: [] as unknown[] }
    const frame = (message: Record<string, unknown>) => ({ message: { ...base, ...message }, isStreaming: true })

    // Live reasoning grows while the content is still empty.
    expect(areMessagePropsEqual(frame({ reasoning: "Leo el contrato", reasoningStreaming: true }), frame({ reasoning: "Leo el contrato y comparo", reasoningStreaming: true }))).toBe(false)
    // reasoning_done flips the stream flag.
    expect(areMessagePropsEqual(frame({ reasoning: "x", reasoningStreaming: true }), frame({ reasoning: "x", reasoningStreaming: false }))).toBe(false)
    // A reasoning tool call appears.
    expect(areMessagePropsEqual(frame({ reasoningToolCalls: [] }), frame({ reasoningToolCalls: [{ index: 0, name: "web_search" }] }))).toBe(false)
    // An agent step changes status.
    const step = { id: "call_1", seq: 1, status: "executing", name: "web_search" }
    expect(areMessagePropsEqual(frame({ agentSteps: [step] }), frame({ agentSteps: [{ ...step, status: "completed", seq: 2 }] }))).toBe(false)
    expect(areMessagePropsEqual(frame({ agentRun: { status: "running" } }), frame({ agentRun: { status: "completed" } }))).toBe(false)
    expect(areMessagePropsEqual(frame({ agentPermission: null }), frame({ agentPermission: { permissionId: "p1" } }))).toBe(false)

    // A stage progress frame updates the row's note in place (same label).
    let log = appendActivity([], { type: "stage", step: "tool_call", stageId: "pipe:rag:1", phase: "rag", label: "Buscando los pasajes relevantes" }, 1)
    const before = frame({ activityLog: log })
    log = appendActivity(log, { type: "stage", step: "tool_progress", stageId: "pipe:rag:1", label: "Buscando los pasajes relevantes", detail: "142 fragmentos" }, 2)
    expect(areMessagePropsEqual(before, frame({ activityLog: log }))).toBe(false)

    // Same steps / same reasoning → still one render.
    expect(areMessagePropsEqual(frame({ reasoning: "x", agentSteps: [step] }), frame({ reasoning: "x", agentSteps: [{ ...step }] }))).toBe(true)
  })

  it("still skips parent re-renders that change nothing visible", () => {
    const message = { id: "m1", role: "ASSISTANT", content: "hola", files: null, activityLog: [] }
    expect(areMessagePropsEqual({ message, isStreaming: false }, { message: { ...message }, isStreaming: false })).toBe(true)
    expect(areMessagePropsEqual({ message, isStreaming: true }, { message, isStreaming: false })).toBe(false)
    expect(areMessagePropsEqual({ message: { ...message, progressStage: "a" } }, { message: { ...message, progressStage: "b" } })).toBe(false)
  })
})
