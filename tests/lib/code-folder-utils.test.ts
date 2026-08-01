import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"
import { projectsService, ProjectServiceError } from "@/lib/projects-service"
import {
  buildCodeLoginNext,
  classifyFolderLoadError,
  encodeLoginNext,
  pickCodeWorkspaceHydration,
  resolveLocalFolderFileSource,
  resolveProjectFileSource,
  resolveWorkspaceSaveMode,
  workspacePersistenceStatus,
  workspaceSaveActionLabel,
  workspaceSaveCapability,
  workspaceSaveMessage,
  workspaceSourceLabel,
} from "@/lib/code-folder-utils"

describe("code folder login-next preservation", () => {
  it("keeps the folder query when building the return path", () => {
    expect(buildCodeLoginNext("folder=cms2dv4ik0005qn019wtu19fl")).toBe(
      "/code?folder=cms2dv4ik0005qn019wtu19fl",
    )
  })

  it("strips a leading ? from the raw location.search alignment", () => {
    expect(buildCodeLoginNext("?folder=abc&local=xyz")).toBe("/code?folder=abc&local=xyz")
  })

  it("accepts a URLSearchParams instance", () => {
    const params = new URLSearchParams({ folder: "abc" })
    expect(buildCodeLoginNext(params)).toBe("/code?folder=abc")
  })

  it("falls back to a bare /code when there is no query", () => {
    expect(buildCodeLoginNext(null)).toBe("/code")
    expect(buildCodeLoginNext(undefined)).toBe("/code")
    expect(buildCodeLoginNext("")).toBe("/code")
    expect(buildCodeLoginNext(new URLSearchParams())).toBe("/code")
  })

  it("encodes the next value so login reads the exact workspace back", () => {
    expect(encodeLoginNext("/code?folder=a b")).toBe(encodeURIComponent("/code?folder=a b"))
    expect(decodeURIComponent(encodeLoginNext("/code?folder=abc"))).toBe("/code?folder=abc")
  })

  it("refuses external or api escape paths", () => {
    expect(encodeLoginNext("https://evil.example")).toBe(encodeURIComponent("/code"))
    expect(encodeLoginNext("//evil.example")).toBe(encodeURIComponent("/code"))
    expect(encodeLoginNext("/api/projects")).toBe(encodeURIComponent("/code"))
  })
})

describe("classifyFolderLoadError", () => {
  it("maps HTTP 404 to not_found", () => {
    const err = classifyFolderLoadError(new ProjectServiceError("Project not found", { status: 404 }))
    expect(err.kind).toBe("not_found")
    expect(err.status).toBe(404)
  })

  it("maps HTTP 401 to unauthorized", () => {
    const err = classifyFolderLoadError(new ProjectServiceError("Unauthorized", { status: 401 }))
    expect(err.kind).toBe("unauthorized")
  })

  it("maps HTTP 403 to forbidden", () => {
    const err = classifyFolderLoadError(new ProjectServiceError("Forbidden", { status: 403 }))
    expect(err.kind).toBe("forbidden")
  })

  it("maps HTTP 5xx to server", () => {
    const err = classifyFolderLoadError(new ProjectServiceError("Internal", { status: 500 }))
    expect(err.kind).toBe("server")
  })

  it("maps a plain fetch rejection to network", () => {
    const err = classifyFolderLoadError(new TypeError("fetch failed"))
    expect(err.kind).toBe("network")
  })

  it("keeps the original message and an unknown kind for other errors", () => {
    const err = classifyFolderLoadError(new Error("boom"))
    expect(err.kind).toBe("network")
    expect(err.message).toBe("boom")
  })
})

describe("projectsService.get error transport", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    clearAuthenticatedFetchCsrfCache()
    vi.clearAllMocks()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("throws a typed not_found error on 404", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await expect(projectsService.get("missing-id")).rejects.toMatchObject({
      name: "ProjectServiceError",
      kind: "not_found",
      status: 404,
    })
  })

  it("throws a typed unauthorized error on 401", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await expect(projectsService.get("private-id")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    })
  })

  it("throws a typed network error when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))

    await expect(projectsService.get("network-id")).rejects.toMatchObject({
      kind: "network",
    })
  })

  it("resolves the project detail on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          project: {
            id: "p1",
            name: "Mi proyecto",
            description: null,
            instructions: null,
            isStarred: false,
            shareId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            files: [],
            chats: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    const project = await projectsService.get("p1")
    expect(project.id).toBe("p1")
    expect(project.name).toBe("Mi proyecto")
  })
})

describe("workspace file-source contract (Slice B + C)", () => {
  it("declares project workspaces as server-backed editor FS (not Project.files tree)", () => {
    const source = resolveProjectFileSource({
      name: "Demo",
      knowledgeFileCount: 3,
      editorFileCount: 0,
    })
    expect(source).toMatchObject({
      kind: "project",
      persistence: "server",
      linked: false,
      browserOnly: false,
      knowledgeFileCount: 3,
      fileCount: 0,
      name: "Demo",
    })
  })

  it("does not treat knowledge attachments as editor files", () => {
    // Even with many server knowledge files, editor fileCount stays independent.
    const source = resolveProjectFileSource({
      name: "Docs project",
      knowledgeFileCount: 12,
      editorFileCount: 2,
    })
    expect(source.knowledgeFileCount).toBe(12)
    expect(source.fileCount).toBe(2)
    expect(source.linked).toBe(false)
    // Knowledge count must never flip linked/disk semantics.
    expect(source.kind).toBe("project")
  })

  it("marks linked local folders as local-disk persistence", () => {
    const source = resolveLocalFolderFileSource({
      name: "my-app",
      linked: true,
      fileCount: 5,
    })
    expect(source).toMatchObject({
      kind: "local-folder",
      persistence: "local-disk",
      linked: true,
      browserOnly: false,
      fileCount: 5,
    })
  })

  it("marks unlinked local folders as browser fallback", () => {
    const source = resolveLocalFolderFileSource({
      name: "my-app",
      linked: false,
      fileCount: 1,
    })
    expect(source.kind).toBe("browser")
    expect(source.persistence).toBe("browser")
    expect(source.browserOnly).toBe(true)
  })

  it("labels project sources distinctly in the tree footer", () => {
    expect(workspaceSourceLabel({ kind: "project", browserOnly: true })).toBe(
      "Proyecto · solo en este navegador",
    )
    expect(
      workspaceSourceLabel({ kind: "project", persistence: "server", browserOnly: false }),
    ).toBe("Proyecto · servidor + este navegador")
    expect(workspaceSourceLabel({ kind: "local-folder", linked: true })).toBe(
      "Sincronizado con carpeta local",
    )
    expect(workspaceSourceLabel({ kind: "browser" })).toBe("Solo en este navegador")
  })

  it("does not label bare browser sessions as Proyecto when browserOnly is true", () => {
    expect(workspaceSourceLabel({ kind: "browser", browserOnly: true })).toBe(
      "Solo en este navegador",
    )
    expect(
      workspaceSourceLabel({
        kind: "browser",
        browserOnly: true,
        persistence: "browser",
      }),
    ).toBe("Solo en este navegador")
  })
})

describe("workspace save contract (Slice C / F6)", () => {
  it("resolves project workspaces to server mode when available", () => {
    const source = resolveProjectFileSource({ name: "P", knowledgeFileCount: 1 })
    expect(source.persistence).toBe("server")
    expect(source.browserOnly).toBe(false)
    expect(resolveWorkspaceSaveMode(source, false)).toBe("server")
  })

  it("falls back to browser mode when server is unavailable", () => {
    const source = resolveProjectFileSource({ name: "P", serverAvailable: false })
    expect(source.persistence).toBe("browser")
    expect(source.browserOnly).toBe(true)
    expect(resolveWorkspaceSaveMode(source, false)).toBe("browser")
  })

  it("resolves linked local folders to local-disk", () => {
    const source = resolveLocalFolderFileSource({ name: "app", linked: true, fileCount: 3 })
    expect(resolveWorkspaceSaveMode(source, true)).toBe("local-disk")
    expect(resolveWorkspaceSaveMode(source, false)).toBe("browser")
  })

  it("save messages distinguish server vs browser", () => {
    expect(workspaceSaveMessage("server", { path: "a.ts" })).toMatch(/servidor/i)
    expect(workspaceSaveMessage("browser").toLowerCase()).toMatch(/sin persistencia en el servidor/)
    expect(workspaceSaveMessage("local-disk", { path: "src/a.ts", folderName: "my-app" })).toContain(
      "my-app",
    )
  })

  it("exposes remote:true for server project capability", () => {
    const projectCap = workspaceSaveCapability(
      resolveProjectFileSource({ name: "Demo" }),
      false,
    )
    expect(projectCap.remote).toBe(true)
    expect(projectCap.mode).toBe("server")
    expect(projectCap.label).toBe(workspaceSaveActionLabel("server"))
  })

  it("noop message when there is no active file", () => {
    expect(workspaceSaveMessage("noop")).toMatch(/no hay archivo/i)
  })
})

describe("workspace persistence honesty (Slice C)", () => {
  it("labels server-backed projects distinctly", () => {
    const status = workspacePersistenceStatus({
      kind: "project",
      browserOnly: false,
      persistence: "server",
    })
    expect(status.tone).toBe("server")
    expect(status.label.toLowerCase()).toMatch(/servidor/)
  })

  it("labels browser-only projects when server is down", () => {
    const status = workspacePersistenceStatus({ kind: "project", browserOnly: true })
    expect(status.label).toMatch(/navegador/i)
  })

  it("labels linked local folders as local-disk sync", () => {
    const status = workspacePersistenceStatus({ kind: "local-folder", linked: true })
    expect(status.tone).toBe("local")
    expect(status.label).toMatch(/carpeta local/i)
  })

  it("pickCodeWorkspaceHydration is local-first", () => {
    expect(pickCodeWorkspaceHydration({ localFileCount: 2, serverFileCount: 5 })).toBe("local")
    expect(pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: 3 })).toBe("server")
    expect(pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: 0 })).toBe("empty")
  })

  it("footer label for server project is not browser-only", () => {
    expect(
      workspaceSourceLabel({ kind: "project", persistence: "server", browserOnly: false }),
    ).toMatch(/servidor/)
  })
})
