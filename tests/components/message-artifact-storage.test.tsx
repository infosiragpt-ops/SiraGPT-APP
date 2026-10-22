import * as React from "react"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))

import MessageComponent from "@/components/message-component"
const file = { id: "interactive-a", type: "artifact", runtime: "react", title: "Agenda", jsx: "const App = () => <div>Agenda</div>" }
const message = { id: "message-a", chatId: "chat-a", role: "ASSISTANT", content: "Agenda", files: JSON.stringify([file]) }
const onRegenerate = () => {}
const updateMessageInChat = () => {}
const bubble = (user: { id: string } | null, row = message) => <MessageComponent message={row} user={user} onRegenerate={onRegenerate} updateMessageInChat={updateMessageInChat} />
function request(frame: HTMLIFrameElement, action: string, value?: unknown) {
  const reply = vi.spyOn(frame.contentWindow!, "postMessage")
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow!, data: { type: "sgpt-artifact-storage", id: "request", action, key: "progress", value, fallback: null } }))
  expect(reply).toHaveBeenCalledOnce()
  const result = reply.mock.calls[0][0] as { value: unknown }
  reply.mockRestore()
  return result.value
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe("chat message artifact owner wiring", () => {
  it("updates the real bridge on account change even for the same memoized message object", () => {
    const view = render(bubble({ id: "owner-a" }))
    const frame = () => view.container.querySelector("iframe")!
    request(frame(), "set", 6)
    expect(localStorage.length).toBe(1)
    const first = frame()
    view.rerender(bubble({ id: "owner-b" }))
    expect(frame()).not.toBe(first)
    expect(request(frame(), "get")).toBeNull()
    view.rerender(bubble({ id: "owner-a" }))
    expect(request(frame(), "get")).toBe(6)
    view.rerender(bubble(null))
    expect(request(frame(), "get")).toBeNull()
  })
  it("uses the message chat and stable persisted identity after reloading a bubble", () => {
    const view = render(bubble({ id: "owner-a" }))
    request(view.container.querySelector("iframe")!, "set", 3)
    view.unmount()
    const reopened = render(bubble({ id: "owner-a" }, JSON.parse(JSON.stringify(message))))
    expect(request(reopened.container.querySelector("iframe")!, "get")).toBe(3)
    reopened.rerender(bubble({ id: "owner-a" }, { ...message, chatId: "copied-chat" }))
    expect(request(reopened.container.querySelector("iframe")!, "get")).toBeNull()
  })
})
