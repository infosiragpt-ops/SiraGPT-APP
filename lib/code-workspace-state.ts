import { languageForPath, type CodeFiles } from "./code-workspace-utils"

export type CodeWorkspaceState = {
  files: CodeFiles
  openTabs: string[]
  activePath: string | null
}

export type WorkspaceMirrorCommand =
  | { kind: "write"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string }

export type WorkspaceFileTransition = {
  state: CodeWorkspaceState
  mirror: WorkspaceMirrorCommand | null
}

function unchanged(state: CodeWorkspaceState): WorkspaceFileTransition {
  return { state, mirror: null }
}

/** Update an existing file and emit a mirror command only for a real change. */
export function updateWorkspaceFile(
  state: CodeWorkspaceState,
  path: string,
  content: string,
  updatedAt = Date.now(),
): WorkspaceFileTransition {
  const existing = state.files[path]
  if (!existing || existing.content === content) return unchanged(state)

  return {
    state: {
      ...state,
      files: {
        ...state.files,
        [path]: { ...existing, content, updatedAt },
      },
    },
    mirror: { kind: "write", path, content },
  }
}

/** Create a file, or focus the existing file without overwriting or mirroring it. */
export function createWorkspaceFile(
  state: CodeWorkspaceState,
  path: string,
  content: string,
  updatedAt = Date.now(),
): WorkspaceFileTransition {
  if (state.files[path]) {
    const openTabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
    if (openTabs === state.openTabs && state.activePath === path) return unchanged(state)
    return {
      state: { ...state, openTabs, activePath: path },
      mirror: null,
    }
  }

  return {
    state: {
      files: {
        ...state.files,
        [path]: {
          path,
          language: languageForPath(path),
          content,
          updatedAt,
        },
      },
      openTabs: [...state.openTabs, path],
      activePath: path,
    },
    mirror: { kind: "write", path, content },
  }
}

/** Rename without clobbering an existing destination. */
export function renameWorkspaceFile(
  state: CodeWorkspaceState,
  oldPath: string,
  newPath: string,
  updatedAt = Date.now(),
): WorkspaceFileTransition {
  const existing = state.files[oldPath]
  if (!existing || state.files[newPath]) return unchanged(state)

  const renamed = {
    ...existing,
    path: newPath,
    language: languageForPath(newPath),
    updatedAt,
  }
  const files = { ...state.files, [newPath]: renamed }
  delete files[oldPath]

  return {
    state: {
      files,
      openTabs: state.openTabs.map((path) => (path === oldPath ? newPath : path)),
      activePath: state.activePath === oldPath ? newPath : state.activePath,
    },
    mirror: { kind: "rename", from: oldPath, to: newPath },
  }
}

/** Delete an existing file and choose the same deterministic tab fallback as the UI. */
export function deleteWorkspaceFile(
  state: CodeWorkspaceState,
  path: string,
): WorkspaceFileTransition {
  if (!state.files[path]) return unchanged(state)

  const files = { ...state.files }
  delete files[path]
  const openTabs = state.openTabs.filter((openPath) => openPath !== path)

  return {
    state: {
      files,
      openTabs,
      activePath:
        state.activePath === path
          ? openTabs[openTabs.length - 1] ?? null
          : state.activePath,
    },
    mirror: { kind: "delete", path },
  }
}
