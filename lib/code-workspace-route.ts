import {
  codexProjectIdFromWorkspaceId,
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
  | readonly [false, ProjectWorkspace]
  | readonly [true, DirectCodexWorkspace]

/**
 * Resolves the historically ambiguous `?folder=<cuid>` route. Project remains
 * the primary interpretation; a 404 falls back to CodexProject. Once resolved,
 * direct Codex workspaces receive their own namespace so company-association
 * checks cannot run against a CodexProject id.
 */
export async function resolveCodeWorkspaceFolder(
  folderId: string,
  getProject: (id: string) => Promise<ProjectWorkspace>,
  getCodexProject: (id: string) => Promise<DirectCodexWorkspace>,
): Promise<CodeWorkspaceFolderResolution> {
  const directCodexProjectId = directCodexProjectIdFromWorkspaceId(folderId)
  const projectId = codexProjectIdFromWorkspaceId(folderId, { assumeProject: true }) || folderId
  if (!directCodexProjectId) {
    try {
      return [false, await getProject(projectId)]
    } catch (error) {
      const candidate = error as {
        code?: unknown
        status?: unknown
      } | null
      if (
        candidate?.status !== 404
        && candidate?.code !== "project_not_found"
      ) throw error
    }
  }

  return [true, await getCodexProject(directCodexProjectId || projectId)]
}
