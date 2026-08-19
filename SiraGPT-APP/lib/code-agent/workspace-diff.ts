/**
 * Diff two workspace snapshots so a turn can validate only what it wrote.
 *
 * React state is stale inside an async work_task loop (applyBlock updates
 * land on the next render). Callers should prefer the files the executor
 * returns; this helper is the fallback when a path only mutates the store.
 */

export type WorkspaceFileSnapshot = {
  path?: string
  content?: string
}

export function changedWorkspaceFiles(
  before: Record<string, string>,
  after: Record<string, WorkspaceFileSnapshot>,
): Array<{ path: string; content: string }> {
  const changed: Array<{ path: string; content: string }> = []
  for (const [path, file] of Object.entries(after || {})) {
    const content = file?.content ?? ""
    const key = file?.path || path
    if (!key) continue
    if (before[key] === content) continue
    changed.push({ path: key, content })
  }
  return changed
}
