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

  it("still skips parent re-renders that change nothing visible", () => {
    const message = { id: "m1", role: "ASSISTANT", content: "hola", files: null, activityLog: [] }
    expect(areMessagePropsEqual({ message, isStreaming: false }, { message: { ...message }, isStreaming: false })).toBe(true)
    expect(areMessagePropsEqual({ message, isStreaming: true }, { message, isStreaming: false })).toBe(false)
    expect(areMessagePropsEqual({ message: { ...message, progressStage: "a" } }, { message: { ...message, progressStage: "b" } })).toBe(false)
  })
})
