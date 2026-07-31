import {
  codexProjectIdFromWorkspaceId,
  codexWorkspaceIdForCodexProject,
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
      projectId: string
      project: ProjectWorkspace
    }
  | {
      kind: "codex-project"
      workspaceId: string
      codexProjectId: string
      project: DirectCodexWorkspace
    }

type CodeWorkspaceFolderLoaders = {
  getProject: (id: string) => Promise<ProjectWorkspace>
  getCodexProject: (id: string) => Promise<DirectCodexWorkspace>
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    code?: unknown
    status?: unknown
    body?: { code?: unknown; error?: unknown }
  } | null
  return candidate?.status === 404
    || candidate?.code === "project_not_found"
    || candidate?.body?.code === "project_not_found"
    || candidate?.body?.error === "project_not_found"
}

async function loadDirectCodexProject(
  projectId: string,
  getCodexProject: CodeWorkspaceFolderLoaders["getCodexProject"],
): Promise<CodeWorkspaceFolderResolution> {
  const project = await getCodexProject(projectId)
  return {
    kind: "codex-project",
    workspaceId: codexWorkspaceIdForCodexProject(project.id) || `codex:${project.id}`,
    codexProjectId: project.id,
    project,
  }
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
  if (directCodexProjectId) {
    return loadDirectCodexProject(directCodexProjectId, loaders.getCodexProject)
  }

  const projectId = codexProjectIdFromWorkspaceId(folderId, { assumeProject: true }) || folderId
  try {
    const project = await loaders.getProject(projectId)
    return {
      kind: "project",
      workspaceId: codexWorkspaceIdForProject(project.id) || `project:${project.id}`,
      projectId: project.id,
      project,
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  return loadDirectCodexProject(projectId, loaders.getCodexProject)
}
