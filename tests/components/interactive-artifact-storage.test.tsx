import * as React from "react"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InteractiveArtifactDisplay } from "@/components/artifact/interactive-artifact-display"

const identity = { ownerId: "owner-a", chatId: "chat-a", messageId: "message-a" }
const artifact = { id: "artifact-a", type: "artifact", runtime: "react", title: "Agenda", jsx: "const App = () => <div>Agenda</div>" }

function request(frame: HTMLIFrameElement, action: string, key?: string, value?: unknown) {
  const target = frame.contentWindow!
  const reply = vi.spyOn(target, "postMessage")
  fireEvent(window, new MessageEvent("message", {
    source: target, data: { type: "sgpt-artifact-storage", id: "request-1", action, key, value, fallback: null },
  }))
  expect(reply).toHaveBeenCalledOnce()
  const result = reply.mock.calls[0][0] as { ok: boolean; value: unknown; error?: string }
  reply.mockRestore()
  return result
}
function mount(scope = identity, files: any[] = [artifact]) {
  const view = render(<InteractiveArtifactDisplay {...scope} files={files} />)
  return { ...view, frame: () => view.container.querySelector("iframe")! }
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

describe("interactive artifact storage bridge", () => {
  it("keeps saved state when the same artifact changes JSX/title, moves slots, and reloads", () => {
    const view = mount()
    expect(request(view.frame(), "set", "progress", { done: 4 }).ok).toBe(true)
    const revised = { ...artifact, title: "Agenda mejorada", jsx: "const App = () => <main>Agenda mejorada</main>" }
    view.rerender(<InteractiveArtifactDisplay {...identity} files={[{ ...artifact, id: "other" }, revised]} />)
    const frames = view.container.querySelectorAll("iframe")
    expect(request(frames[1], "get", "progress").value).toEqual({ done: 4 })
    view.unmount()
    const reopened = mount(identity, [revised])
    expect(request(reopened.frame(), "get", "progress").value).toEqual({ done: 4 })
  })

  it.each([
    { label: "another owner", scope: { ...identity, ownerId: "owner-b" }, files: [artifact] },
    { label: "another chat", scope: { ...identity, chatId: "chat-b" }, files: [artifact] },
    { label: "a copy", scope: identity, files: [{ ...artifact, id: "artifact-copy" }] },
  ])("isolates identical content in $label", ({ scope, files }) => {
    const view = mount()
    request(view.frame(), "set", "progress", 7)
    const previousFrame = view.frame()
    view.rerender(<InteractiveArtifactDisplay {...scope} files={files} />)
    expect(view.frame()).not.toBe(previousFrame)
    expect(request(view.frame(), "get", "progress").value).toBeNull()
    expect(request(view.frame(), "list").value).toEqual([])
    request(view.frame(), "set", "progress", 2)
    view.rerender(<InteractiveArtifactDisplay {...identity} files={[artifact]} />)
    expect(request(view.frame(), "get", "progress").value).toBe(7)
  })

  it("does not let a sibling or unrelated window operate another artifact's storage", () => {
    const view = mount(identity, [artifact, { ...artifact, id: "artifact-b" }])
    const [first, second] = view.container.querySelectorAll("iframe")
    request(first, "set", "result", 20)
    expect(request(second, "get", "result").value).toBeNull()
    const firstReply = vi.spyOn(first.contentWindow!, "postMessage")
    const secondReply = vi.spyOn(second.contentWindow!, "postMessage")
    fireEvent(window, new MessageEvent("message", { source: window, data: { type: "sgpt-artifact-storage", id: "forged", action: "delete", key: "result" } }))
    expect(firstReply).not.toHaveBeenCalled()
    expect(secondReply).not.toHaveBeenCalled()
    firstReply.mockRestore(); secondReply.mockRestore()
    expect(request(first, "get", "result").value).toBe(20)
    request(first, "delete", "result")
    expect(request(first, "get", "result").value).toBeNull()
  })

  it("ignores delayed requests from the previous frame after an account switch", () => {
    const view = mount()
    const oldWindow = view.frame().contentWindow!
    view.rerender(<InteractiveArtifactDisplay {...identity} ownerId="owner-b" files={[artifact]} />)
    const reply = vi.spyOn(view.frame().contentWindow!, "postMessage")
    fireEvent(window, new MessageEvent("message", { source: oldWindow, data: { type: "sgpt-artifact-storage", id: "late", action: "set", key: "progress", value: "old-owner" } }))
    expect(reply).not.toHaveBeenCalled()
    reply.mockRestore()
    expect(request(view.frame(), "get", "progress").value).toBeNull()
  })

  it("keeps identity delimiters and untrusted key names separate", () => {
    const view = mount({ ...identity, ownerId: "user:a", chatId: "b/c" })
    request(view.frame(), "set", "__proto__", { safe: true })
    request(view.frame(), "set", "constructor", 2)
    expect(request(view.frame(), "list").value).toEqual(["__proto__", "constructor"])
    view.rerender(<InteractiveArtifactDisplay {...identity} ownerId="user" chatId="a:b/c" files={[artifact]} />)
    expect(request(view.frame(), "get", "__proto__").value).toBeNull()
    expect(request(view.frame(), "list").value).toEqual([])
  })

  it("reports a failed persistent write instead of claiming success", () => {
    const view = mount()
    const original = localStorage
    vi.stubGlobal("localStorage", {
      setItem() { throw new Error("storage quota exceeded") },
      getItem: original.getItem.bind(original),
    })
    const result = request(view.frame(), "set", "progress", 10)
    expect(result).toMatchObject({ ok: false, error: "storage quota exceeded" })
    vi.unstubAllGlobals()
    expect(request(view.frame(), "get", "progress").value).toBeNull()
  })

  it("uses message identity for legacy artifacts without adopting unowned code-hash data", () => {
    const legacy = { ...artifact, id: undefined }
    // The former hash of this title + JSX was fggot7. Its owner is unknowable.
    localStorage.setItem("siraGPT:artifact:fggot7:progress", JSON.stringify("unknown-owner"))
    const view = mount(identity, [legacy])
    expect(request(view.frame(), "get", "progress").value).toBeNull()
    request(view.frame(), "set", "progress", 8)
    view.rerender(<InteractiveArtifactDisplay {...identity} files={[{ ...legacy, title: "Nuevo título", jsx: "const App = () => <div>Revisión</div>" }]} />)
    expect(request(view.frame(), "get", "progress").value).toBe(8)
    view.rerender(<InteractiveArtifactDisplay {...identity} messageId="message-copy" files={[legacy]} />)
    expect(request(view.frame(), "get", "progress").value).toBeNull()
    expect(localStorage.getItem("siraGPT:artifact:fggot7:progress")).toBe(JSON.stringify("unknown-owner"))
  })

  it.each([
    { ...identity, ownerId: "" },
    { ...identity, chatId: "" },
    { ...identity, messageId: "" },
  ])("never writes persistent data when an owner/chat/legacy identity is missing: %j", (scope) => {
    const legacy = { ...artifact, id: undefined }
    const view = mount(scope, [legacy])
    request(view.frame(), "set", "progress", 9)
    expect(request(view.frame(), "get", "progress").value).toBe(9)
    expect(localStorage.length).toBe(0)
    view.unmount()
    const reopened = mount(scope, [legacy])
    expect(request(reopened.frame(), "get", "progress").value).toBeNull()
  })
})
