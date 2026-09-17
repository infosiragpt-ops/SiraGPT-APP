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


/** OLA200_WAVE_F FE-075 — lost-update guard: do not apply a diff if the etag moved. */
export function applyWorkspaceDiffIfEtagMatch<T>(
  currentEtag: string | null | undefined,
  expectedEtag: string | null | undefined,
  apply: () => T,
): { applied: boolean; reason?: string; value?: T } {
  const current = String(currentEtag || "")
  const expected = String(expectedEtag || "")
  if (expected && current && expected !== current) {
    return { applied: false, reason: "etag_mismatch" }
  }
  return { applied: true, value: apply() }
}
