/**
 * code-agent · observability JSONL store (server-only).
 *
 * Append-only daily JSONL persistence for /code observability runs. This file
 * is imported ONLY by the Next.js API route (`app/api/code-agent/
 * observability/route.ts`) — never by client bundles — so its `node:fs` usage
 * stays out of the webpack client graph (the CI "Unhandled scheme" failure was
 * caused by `node:fs` inside the shared module that the panel imports).
 *
 * Path: `.data/code-agent/observability/YYYY-MM-DD.jsonl`, outside the git
 * tree. Accepts arbitrary JSON lines (runs); returns the stored line count so
 * callers can confirm persistence without re-reading.
 */
import { mkdirSync, appendFileSync, readdirSync, readFileSync } from "node:fs"
import { resolve, join } from "node:path"

export const OBSERVABILITY_LOG_DIR = ".data/code-agent/observability"

function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Append one JSON line for a run. Returns true on success. */
export function appendObservabilityLine(run: unknown, dir: string = OBSERVABILITY_LOG_DIR): boolean {
  try {
    const root = resolve(process.cwd(), dir)
    mkdirSync(root, { recursive: true })
    const file = join(root, `${dateKey(new Date())}.jsonl`)
    appendFileSync(file, JSON.stringify(run) + "\n", "utf8")
    return true
  } catch {
    return false
  }
}

/** Read back all stored JSONL lines (newest file last). */
export function readObservabilityLines(dir: string = OBSERVABILITY_LOG_DIR): string[] {
  try {
    const root = resolve(process.cwd(), dir)
    const files = readdirSync(root)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
    return files.flatMap((f) =>
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0),
    )
  } catch {
    return []
  }
}