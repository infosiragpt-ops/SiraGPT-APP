import {
  codexProjectIdFromWorkspaceId,
  codexWorkspaceIdForProject,
  directCodexProjectIdFromWorkspaceId,
} from "./codex-workspace-identity"

type ProjectWorkspace = {
  id: string
  name: string
  description?: string | null
  instructions?: string | null
}

type DirectCodexWorkspace = {
  id: string
  name: string
}

export type CodeWorkspaceFolderResolution =
  | {
      kind: "project"
      workspaceId: string
      project: ProjectWorkspace
    }
  | {
      kind: "codex-project"
      workspaceId: string
      project: DirectCodexWorkspace
    }

type CodeWorkspaceFolderLoaders = {
  getProject: (id: string) => Promise<ProjectWorkspace>
  getCodexProject: (id: string) => Promise<DirectCodexWorkspace>
}

/**
 * Resolves the historically ambiguous `?folder=<cuid>` route. Project remains
 * the primary interpretation; a 404 falls back to CodexProject. Once resolved,
 * direct Codex workspaces receive their own namespace so company-association
 * checks cannot run against a CodexProject id.
 */
export async function resolveCodeWorkspaceFolder(
  folderId: string,
  loaders: CodeWorkspaceFolderLoaders,
): Promise<CodeWorkspaceFolderResolution> {
  const directCodexProjectId = directCodexProjectIdFromWorkspaceId(folderId)
  const projectId = codexProjectIdFromWorkspaceId(folderId, { assumeProject: true }) || folderId
  if (!directCodexProjectId) {
    try {
      const project = await loaders.getProject(projectId)
      return {
        kind: "project",
        workspaceId: codexWorkspaceIdForProject(project.id) || `project:${project.id}`,
        project,
      }
    } catch (error) {
      const candidate = error as {
        code?: unknown
        status?: unknown
        body?: { code?: unknown; error?: unknown }
      } | null
      if (
        candidate?.status !== 404
        && candidate?.code !== "project_not_found"
        && candidate?.body?.code !== "project_not_found"
        && candidate?.body?.error !== "project_not_found"
      ) throw error
    }
  }

  const project = await loaders.getCodexProject(directCodexProjectId || projectId)
  return {
    kind: "codex-project",
    workspaceId: `codex:${project.id}`,
    project,
  }
}
