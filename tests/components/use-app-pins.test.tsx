import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth-context-integrated", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: "u1" } }),
}))

const fetchMock = vi.fn()

vi.mock("@/lib/authenticated-fetch", () => ({
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
}))

vi.mock("@/lib/api-base-url", () => ({
  getNormalizedApiBaseUrl: () => "http://test.local",
}))

import { useAppPins } from "@/lib/use-app-pins"

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {},
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  localStorage.clear()
})

describe("useAppPins", () => {
  it("honors a disabled feature flag that arrives after the first render", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { apps: [], pinsEnabled: false }))
    const { result } = renderHook(() => useAppPins("temp-chat-disabled"))
    await waitFor(() => expect(result.current.enabled).toBe(false))
    let added = true
    await act(async () => { added = await result.current.pinApp("github") })
    expect(added).toBe(false)
    expect(result.current.pinnedAppIds).toEqual([])
    expect(localStorage.getItem("apps.pins.draft.temp-chat-disabled")).toBeNull()
  })

  it.each(["temp-chat-1790885822370", "__new__"])("keeps optimistic draft %s pins local until the chat is persisted", async (draftId) => {
    fetchMock.mockResolvedValue(jsonResponse(200, { apps: [], pinsEnabled: true }))
    localStorage.setItem(`apps.pins.draft.${draftId}`, JSON.stringify(["github"]))

    const { result, rerender } = renderHook(({ id }) => useAppPins(id), {
      initialProps: { id: draftId },
    })
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["github"]))
    await act(async () => { await result.current.pinApp("x") })
    expect(result.current.pinnedAppIds).toEqual(["github", "x"])
    await act(async () => { await result.current.unpinApp("github") })
    expect(result.current.pinnedAppIds).toEqual(["x"])
    expect(localStorage.getItem(`apps.pins.draft.${draftId}`)).toBe(JSON.stringify(["x"]))
    expect(result.current.lastRejection).toBeNull()
    expect(result.current.syncing).toBe(false)
    expect(result.current.revision).toBe(0)
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/chats/"))).toBe(true)

    // The creation flow migrates draft pins on its first real turn. A real ID
    // must still hydrate that canonical result and use its revision on writes.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["x"], revision: 1 }))
    rerender({ id: "persisted-chat" })
    await waitFor(() => expect(result.current.revision).toBe(1))
    expect(result.current.pinnedAppIds).toEqual(["x"])
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["x", "github"], revision: 2 }))
    await act(async () => { await result.current.pinApp("github") })
    expect(result.current.pinnedAppIds).toEqual(["x", "github"])
    const put = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/chats/persisted-chat/pins") && init?.method === "PUT")
    expect(put?.[1]?.headers?.["If-Match"]).toBe('"pins-1"')
  })

  it("hydrates server pins with revision and pins optimistically", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apps: [], pinsEnabled: true })) // GET /apps (flag)
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["github"], revision: 3 })) // GET pins
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["github", "x"], revision: 4 })) // PUT pins

    const { result } = renderHook(() => useAppPins("chat_1"))
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["github"]))

    await result.current.pinApp("x")
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["github", "x"]))
    await waitFor(() => expect(result.current.revision).toBe(4))
    // PUT carried the If-Match revision.
    const putCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes("/pins") && String(url).includes("chat_1")
      && (init as RequestInit | undefined)?.method === "PUT",
    )
    const options = putCall?.[1] as RequestInit
    expect((options.headers as Record<string, string>)["If-Match"]).toBe('"pins-3"')
  })

  it("rebases once on 412 PIN_SET_STALE and reapplies the local intent", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apps: [], pinsEnabled: true })) // GET /apps (flag)
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: [], revision: 0 })) // GET pins (empty)
      .mockResolvedValueOnce(jsonResponse(412, {
        code: "PIN_SET_STALE",
        details: { effectivePinnedAppIds: ["linkedin"], effectiveRevision: 5 },
      })) // PUT -> stale (another tab pinned linkedin)
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["linkedin", "github"], revision: 6 })) // rebased PUT

    const { result } = renderHook(() => useAppPins("chat_2"))
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual([]))

    await result.current.pinApp("github")
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["linkedin", "github"]))
    expect(result.current.revision).toBe(6)
    expect(result.current.lastRejection).toBeNull()
  })

  it("unpins without touching the connection and clears the local draft", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apps: [], pinsEnabled: true })) // GET /apps (flag)
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["github", "x"], revision: 2 }))
      .mockResolvedValueOnce(jsonResponse(200, { pinnedAppIds: ["x"], revision: 3 }))

    const { result } = renderHook(() => useAppPins("chat_3"))
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["github", "x"]))
    await result.current.unpinApp("github")
    await waitFor(() => expect(result.current.pinnedAppIds).toEqual(["x"]))
    expect(localStorage.getItem("apps.pins.draft.chat_3")).toBe(JSON.stringify(["x"]))
  })
})
