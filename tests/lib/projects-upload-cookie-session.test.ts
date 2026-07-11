import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"
import { projectsService } from "@/lib/projects-service"

type UploadCapableProjectsService = typeof projectsService & {
  uploadFiles(files: File[]): Promise<Array<{ id: string }>>
}

describe("project upload cookie session transport", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    clearAuthenticatedFetchCsrfCache()
    vi.clearAllMocks()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-upload" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ id: "file-1" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)
  })

  it("uses cookie credentials and CSRF while preserving the FormData boundary", async () => {
    const upload = (projectsService as UploadCapableProjectsService).uploadFiles
    expect(upload).toBeTypeOf("function")

    const files = [new File(["project context"], "context.txt", { type: "text/plain" })]
    const result = await upload(files)

    expect(result).toEqual([{ id: "file-1" }])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1]
    expect(String(uploadUrl)).toMatch(/\/files\/upload$/)
    expect(uploadInit?.credentials).toBe("include")
    expect(uploadInit?.body).toBeInstanceOf(FormData)

    const headers = new Headers(uploadInit?.headers)
    expect(headers.get("X-CSRF-Token")).toBe("csrf-upload")
    expect(headers.has("Authorization")).toBe(false)
    expect(headers.has("Content-Type")).toBe(false)
  })
})
