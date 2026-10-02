import { describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/agentes", useSearchParams: () => new URLSearchParams() }))

import { areMessagePropsEqual } from "@/components/message-component"

/**
 * Long chats: every settled bubble went through the full comparator (activity
 * signature, agent-steps key, JSON.stringify(files)) on every stream flush,
 * and re-rendered after every turn because the post-turn merge recreates
 * `agentMetadata` with equal values.
 */
describe("MessageComponent memo · settled bubbles", () => {
  it("same row object + same live flag is equal without rebuilding signatures", () => {
    const files = [{ id: "f1", name: "a.png", file: new Proxy({}, { get() { throw new Error("files must not be serialised on the fast path") } }) }]
    const message = { id: "a1", role: "ASSISTANT", content: "hola", files, agentMetadata: { status: "done", steps: 3 } }
    expect(areMessagePropsEqual({ message, isStreaming: false }, { message, isStreaming: false })).toBe(true)
    expect(areMessagePropsEqual({ message, isStreaming: true }, { message, isStreaming: false })).toBe(false)
  })

  it("agentMetadata is compared by value (the merge spreads the row), still by reference when it changed", () => {
    const message = { id: "a1", role: "ASSISTANT", content: "hola", files: null, agentMetadata: { status: "done", steps: 3 } }
    const merged = { ...message, agentMetadata: { status: "done", steps: 3 } }
    expect(areMessagePropsEqual({ message }, { message: merged })).toBe(true)
    const changed = { ...message, agentMetadata: { status: "done", steps: 4 } }
    expect(areMessagePropsEqual({ message }, { message: changed })).toBe(false)
    const asString = { ...message, agentMetadata: JSON.stringify({ status: "done", steps: 3 }) }
    expect(areMessagePropsEqual({ message }, { message: asString })).toBe(true)
  })
})
