import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { githubService } from "@/lib/github-service"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: vi.fn() }))
vi.mock("@/lib/api-base-url", () => ({ getSameOriginApiBaseUrl: () => "https://siragpt.com/api" }))

describe("GitHub connection requests keep the authenticated first-party origin", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(authenticatedFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response) })
  afterEach(() => { vi.restoreAllMocks() })
  it("keeps legacy connect calls and scopes chat authorization to its IDs", async () => {
    await githubService.connectUrl()
    expect(authenticatedFetch).toHaveBeenLastCalledWith("https://siragpt.com/api/github/connect", expect.objectContaining({ credentials: "include" }))
    await githubService.connectUrl({ chatId: "c", handoffId: "h", popup: true })
    expect(authenticatedFetch).toHaveBeenLastCalledWith("https://siragpt.com/api/github/connect?chatId=c&handoffId=h&popup=1", expect.objectContaining({ credentials: "include" }))
    await githubService.connectStatus({ chatId: "c", handoffId: "h" })
    expect(authenticatedFetch).toHaveBeenLastCalledWith("https://siragpt.com/api/github/connect/status?chatId=c&handoffId=h", expect.objectContaining({ credentials: "include" }))
    await githubService.status({ verify: true })
    expect(authenticatedFetch).toHaveBeenLastCalledWith("https://siragpt.com/api/github/status?verify=1", expect.objectContaining({ credentials: "include" }))
  })
  it("still downloads ZIP bytes from the correct API URL after resolving the origin per request", async () => {
    const blob = new Blob(["archive"], { type: "application/zip" })
    vi.mocked(authenticatedFetch).mockResolvedValue({ ok: true, blob: async () => blob } as Response)
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:download") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    await githubService.downloadZip("repo-owned")
    expect(authenticatedFetch).toHaveBeenCalledWith("https://siragpt.com/api/github/connected/repo-owned/download", expect.objectContaining({ credentials: "include" }))
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
  })
})
