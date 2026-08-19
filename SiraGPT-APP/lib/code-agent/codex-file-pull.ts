/**
 * codex-file-pull — integrity-checked read-back of a Codex run's files.
 *
 * The panel used to pull the tree with a bare Promise.all whose per-file
 * catch → null silently dropped unreadable files: an iterate turn could
 * apply 78/80 files and leave the local workspace as a stale/remote MIX with
 * no signal whatsoever. This helper does a parallel first pass, ONE
 * sequential retry of the failures (transient blips), and reports exactly
 * which paths stayed unreadable so the caller can decide (warn / refuse to
 * apply a partial tree). Empty-content files are skipped (not failures) —
 * same semantics the old code had.
 */

export type PulledFile = { path: string; content: string }
export type PullResult = { files: PulledFile[]; failed: string[] }

export interface CodexFileReader {
  readFileContent(projectId: string, path: string): Promise<{ content?: string | null } | null | undefined>
}

type Attempt = { kind: "ok"; file: PulledFile } | { kind: "skip" } | { kind: "fail" }

async function tryRead(api: CodexFileReader, projectId: string, path: string): Promise<Attempt> {
  try {
    const file = await api.readFileContent(projectId, path)
    return file?.content ? { kind: "ok", file: { path, content: file.content } } : { kind: "skip" }
  } catch {
    return { kind: "fail" }
  }
}

export async function pullProjectFiles(
  api: CodexFileReader,
  projectId: string,
  paths: readonly string[],
): Promise<PullResult> {
  const files: PulledFile[] = []
  let failed: string[] = []

  const first = await Promise.all(paths.map((p) => tryRead(api, projectId, p)))
  first.forEach((res, i) => {
    if (res.kind === "ok") files.push(res.file)
    else if (res.kind === "fail") failed.push(paths[i])
  })

  if (failed.length > 0) {
    const still: string[] = []
    for (const p of failed) {
      const res = await tryRead(api, projectId, p)
      if (res.kind === "ok") files.push(res.file)
      else if (res.kind === "fail") still.push(p)
    }
    failed = still
  }

  return { files, failed }
}
