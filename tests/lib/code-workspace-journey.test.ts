/**
 * Slice E — client-side journey for /code?folder=
 *
 * Auth return path → error classification → file-source contract → save mode
 * → code-workspace API client (hydrate/save). Pure + fetch-mocked; no runner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { authenticatedFetch, clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"
import { projectsService, ProjectServiceError } from "@/lib/projects-service"
import {
  buildCodeLoginNext,
  classifyFolderLoadError,
  encodeLoginNext,
  pickCodeWorkspaceHydration,
  resolveProjectFileSource,
  resolveWorkspaceSaveMode,
  workspaceSaveMessage,
  workspaceSourceLabel,
} from "@/lib/code-folder-utils"

const FOLDER = "cms2dv4ik0005qn019wtu19fl"

describe("Slice E journey: auth → folder → source → save → code-workspace API", () => {
  describe("1. Auth return preserves folder", () => {
    it("builds next=/code?folder=… and encodes for login", () => {
      const next = buildCodeLoginNext(`folder=${FOLDER}&tool=shell`)
      expect(next).toBe(`/code?folder=${FOLDER}&tool=shell`)
      const encoded = encodeLoginNext(next)
      expect(decodeURIComponent(encoded)).toBe(next)
      expect(encoded).not.toBe(encodeURIComponent("/code"))
    })
  })

  describe("2. Load failures stay differentiated (no synthetic workspace)", () => {
    it("maps 404 / 401 / network distinctly", () => {
      expect(classifyFolderLoadError(new ProjectServiceError("nf", { status: 404 })).kind).toBe(
        "not_found",
      )
      expect(classifyFolderLoadError(new ProjectServiceError("u", { status: 401 })).kind).toBe(
        "unauthorized",
      )
      expect(classifyFolderLoadError(new TypeError("fetch failed")).kind).toBe("network")
    })
  })

  describe("3. File source contract (knowledge files ≠ editor FS)", () => {
    it("server-available project is server persistence, not knowledge tree", () => {
      const source = resolveProjectFileSource({
        name: "Demo",
        knowledgeFileCount: 7,
        editorFileCount: 2,
        serverAvailable: true,
      })
      expect(source.kind).toBe("project")
      expect(source.persistence).toBe("server")
      expect(source.knowledgeFileCount).toBe(7)
      expect(source.fileCount).toBe(2)
      expect(workspaceSourceLabel(source)).toMatch(/servidor/i)
    })

    it("hydrates local-first when both caches have files", () => {
      expect(pickCodeWorkspaceHydration({ localFileCount: 3, serverFileCount: 10 })).toBe("local")
      expect(pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: 4 })).toBe("server")
      expect(pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: 0 })).toBe("empty")
    })
  })

  describe("4. Save contract", () => {
    it("Cmd+S on project+server writes remote; offline falls to browser copy", () => {
      const online = resolveProjectFileSource({ name: "P", serverAvailable: true })
      expect(resolveWorkspaceSaveMode(online, false)).toBe("server")
      expect(workspaceSaveMessage("server", { path: "a.ts" })).toMatch(/servidor/i)

      const offline = resolveProjectFileSource({ name: "P", serverAvailable: false })
      expect(resolveWorkspaceSaveMode(offline, false)).toBe("browser")
      expect(workspaceSaveMessage("browser")).toMatch(/sin persistencia en el servidor/i)
    })
  })

  describe("5. projectsService code-workspace transport", () => {
    const fetchMock = vi.fn<typeof fetch>()

    beforeEach(() => {
      localStorage.clear()
      clearAuthenticatedFetchCsrfCache()
      vi.clearAllMocks()
      vi.stubGlobal("fetch", fetchMock)
      // Cookie-session mutations request a CSRF token first; stub it.
      vi.spyOn(authenticatedFetch.csrfManager, "getToken").mockResolvedValue("test-csrf")
    })

    it("getCodeWorkspace returns snapshot for owner hydrate", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projectId: FOLDER,
            fileCount: 1,
            projectUpdatedAt: "2026-08-01T00:00:00.000Z",
            workspace: {
              v: 1,
              files: { "app.ts": { content: "export {}", language: "typescript" } },
              openTabs: ["app.ts"],
              activePath: "app.ts",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )

      const res = await projectsService.getCodeWorkspace(FOLDER)
      expect(res.projectId).toBe(FOLDER)
      expect(res.fileCount).toBe(1)
      expect(res.workspace.files["app.ts"].content).toBe("export {}")
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/projects/${FOLDER}/code-workspace`)
    })

    it("putCodeWorkspace sends PUT body and returns saved snapshot", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projectId: FOLDER,
            fileCount: 1,
            projectUpdatedAt: "2026-08-01T01:00:00.000Z",
            workspace: {
              v: 1,
              files: { "app.ts": { content: "export const x = 1" } },
              openTabs: ["app.ts"],
              activePath: "app.ts",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )

      const res = await projectsService.putCodeWorkspace(FOLDER, {
        v: 1,
        files: { "app.ts": { content: "export const x = 1" } },
        openTabs: ["app.ts"],
        activePath: "app.ts",
      })
      expect(res.fileCount).toBe(1)
      const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
      expect(putCall).toBeTruthy()
      const body = JSON.parse(String((putCall?.[1] as RequestInit)?.body || "{}"))
      expect(body.workspace.files["app.ts"].content).toBe("export const x = 1")
    })

    it("getCodeWorkspace maps 404 to typed ProjectServiceError", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Project not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      await expect(projectsService.getCodeWorkspace("missing")).rejects.toMatchObject({
        name: "ProjectServiceError",
        kind: "not_found",
        status: 404,
      })
    })
  })

  describe("6. Full chain (synthetic folder fixture)", () => {
    const fetchMock = vi.fn<typeof fetch>()

    beforeEach(() => {
      localStorage.clear()
      clearAuthenticatedFetchCsrfCache()
      vi.clearAllMocks()
      vi.stubGlobal("fetch", fetchMock)
      vi.spyOn(authenticatedFetch.csrfManager, "getToken").mockResolvedValue("test-csrf")
    })

    it("auth → project GET → code-workspace hydrate → save (PDF knowledge excluded)", async () => {
      const next = buildCodeLoginNext(new URLSearchParams({ folder: FOLDER, tool: "preview" }))
      expect(next).toBe(`/code?folder=${FOLDER}&tool=preview`)
      expect(decodeURIComponent(encodeLoginNext(next))).toBe(next)

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              project: {
                id: FOLDER,
                name: "Fixture App",
                description: null,
                instructions: null,
                isStarred: false,
                shareId: null,
                createdAt: "2026-07-31T00:00:00.000Z",
                updatedAt: "2026-07-31T00:00:00.000Z",
                files: [
                  {
                    id: "kf1",
                    filename: "brief.pdf",
                    originalName: "brief.pdf",
                    mimeType: "application/pdf",
                    size: 12,
                    createdAt: "2026-07-31T00:00:00.000Z",
                  },
                ],
                chats: [],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              projectId: FOLDER,
              fileCount: 1,
              projectUpdatedAt: "2026-07-31T00:00:00.000Z",
              workspace: {
                v: 1,
                files: {
                  "src/App.tsx": {
                    content: "export default function App(){return null}",
                    language: "typescript",
                  },
                },
                openTabs: ["src/App.tsx"],
                activePath: "src/App.tsx",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              projectId: FOLDER,
              fileCount: 1,
              projectUpdatedAt: "2026-08-01T00:00:00.000Z",
              workspace: {
                v: 1,
                files: {
                  "src/App.tsx": {
                    content: "export default function App(){return <main/>}",
                  },
                },
                openTabs: ["src/App.tsx"],
                activePath: "src/App.tsx",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )

      const project = await projectsService.get(FOLDER)
      expect(project.id).toBe(FOLDER)
      expect(project.files[0]?.originalName).toBe("brief.pdf")

      const remote = await projectsService.getCodeWorkspace(FOLDER)
      expect(Object.keys(remote.workspace.files)).toEqual(["src/App.tsx"])
      expect(Object.keys(remote.workspace.files).some((p) => p.endsWith(".pdf"))).toBe(false)
      expect(
        pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: remote.fileCount }),
      ).toBe("server")

      const source = resolveProjectFileSource({
        name: project.name,
        knowledgeFileCount: project.files.length,
        editorFileCount: remote.fileCount,
        serverAvailable: true,
      })
      expect(resolveWorkspaceSaveMode(source, false)).toBe("server")
      expect(workspaceSourceLabel(source)).toMatch(/servidor/i)

      await projectsService.putCodeWorkspace(FOLDER, {
        v: 1,
        files: {
          "src/App.tsx": { content: "export default function App(){return <main/>}" },
        },
        openTabs: ["src/App.tsx"],
        activePath: "src/App.tsx",
      })

      const putCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      )
      expect(String(putCall?.[0])).toContain(`/projects/${FOLDER}/code-workspace`)
      expect(String(putCall?.[0])).not.toMatch(/\/files\//)
    })
  })
})
