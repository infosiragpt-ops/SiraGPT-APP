type ProjectWorkspace = {
  id: string
  name: string
  description: string | null
  instructions: string | null
}

type DirectCodexWorkspace = {
  id: string
  name: string
}

export type CodeWorkspaceFolderResolution =
  | [directCodexProject: false, project: ProjectWorkspace]
  | [directCodexProject: true, project: DirectCodexWorkspace]

export async function resolveCodeWorkspaceFolder(
  folderId: string,
  getProject: (id: string) => Promise<ProjectWorkspace>,
  getCodexProject: (id: string) => Promise<DirectCodexWorkspace>,
): Promise<CodeWorkspaceFolderResolution> {
  const directCodexProjectId = folderId.startsWith("codex:")
  const projectId = folderId.replace(/^\w+:/, "")
  if (!directCodexProjectId) {
    try {
      return [false, await getProject(projectId)]
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status !== 404) throw error
    }
  }

  return [true, await getCodexProject(projectId)]
}
