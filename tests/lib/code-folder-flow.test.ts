/**
 * Slice E — synthetic flow contract for /code?folder=
 * Pure tests: auth return, error classification, hydrate pick, save mode.
 * No browser, no runner, no network.
 */
import { describe, expect, it } from "vitest"
import { ProjectServiceError } from "@/lib/projects-service"
import {
  buildCodeLoginNext,
  classifyFolderLoadError,
  encodeLoginNext,
  pickCodeWorkspaceHydration,
  resolveProjectFileSource,
  resolveWorkspaceSaveMode,
  workspacePersistenceStatus,
  workspaceSaveMessage,
} from "@/lib/code-folder-utils"

const FOLDER = "cms2dv4ik0005qn019wtu19fl"

describe("Slice E flow: auth → folder → tree → save", () => {
  it("preserves folder across login redirect next=", () => {
    const next = buildCodeLoginNext(`folder=${FOLDER}`)
    expect(next).toBe(`/code?folder=${FOLDER}`)
    const encoded = encodeLoginNext(next)
    expect(decodeURIComponent(encoded)).toBe(`/code?folder=${FOLDER}`)
  })

  it("preserves multi-param code URLs", () => {
    const params = new URLSearchParams({
      folder: FOLDER,
      tool: "preview",
      agent: "builder",
    })
    expect(buildCodeLoginNext(params)).toBe(
      `/code?folder=${FOLDER}&tool=preview&agent=builder`,
    )
  })

  it("classifies not-found vs unauthorized vs network for folder load", () => {
    expect(
      classifyFolderLoadError(new ProjectServiceError("Project not found", { status: 404 })).kind,
    ).toBe("not_found")
    expect(
      classifyFolderLoadError(new ProjectServiceError("Unauthorized", { status: 401 })).kind,
    ).toBe("unauthorized")
    expect(classifyFolderLoadError(new TypeError("fetch failed")).kind).toBe("network")
  })

  it("hydrates server code when local tree is empty", () => {
    expect(pickCodeWorkspaceHydration({ localFileCount: 0, serverFileCount: 3 })).toBe("server")
    expect(pickCodeWorkspaceHydration({ localFileCount: 2, serverFileCount: 5 })).toBe("local")
  })

  it("saves project workspaces to server mode by default", () => {
    const source = resolveProjectFileSource({ name: "Demo", knowledgeFileCount: 2 })
    expect(source.persistence).toBe("server")
    expect(resolveWorkspaceSaveMode(source, false)).toBe("server")
    expect(workspaceSaveMessage("server", { path: "src/a.ts" })).toMatch(/servidor/i)
  })

  it("does not claim cloud sync for browser-only fallback", () => {
    const status = workspacePersistenceStatus({
      kind: "project",
      browserOnly: true,
      persistence: "browser",
    })
    expect(status.label.toLowerCase()).not.toMatch(/nube|cloud/)
    expect(workspaceSaveMessage("browser").toLowerCase()).toMatch(/sin persistencia en el servidor/)
  })
})
