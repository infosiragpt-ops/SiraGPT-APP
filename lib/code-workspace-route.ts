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

type WorkspaceResolution = {
  kind: "project" | "codex"
  workspaceId: string
  project: {
    id: string
    name: string
    description?: string | null
    instructions?: string | null
  }
}

export type CodeWorkspaceFolderResolution =
  | [directCodexProject: false, project: ProjectWorkspace]
  | [directCodexProject: true, project: DirectCodexWorkspace]

export async function resolveCodeWorkspaceFolder(
  folderId: string,
  resolveWorkspace: (id: string) => Promise<WorkspaceResolution>,
): Promise<CodeWorkspaceFolderResolution> {
  const resolution = await resolveWorkspace(folderId)
  const directCodexProject = resolution.kind === "codex"
  const expectedWorkspaceId = `${directCodexProject ? "codex" : "project"}:${resolution.project.id}`
  if (resolution.workspaceId !== expectedWorkspaceId) {
    throw Object.assign(new Error("Workspace resolution returned an inconsistent identity."), {
      status: 502,
      code: "workspace_identity_mismatch",
    })
  }
  return directCodexProject
    ? [true, { id: resolution.project.id, name: resolution.project.name }]
    : [false, {
        id: resolution.project.id,
        name: resolution.project.name,
        description: resolution.project.description || null,
        instructions: resolution.project.instructions || null,
      }]
}
