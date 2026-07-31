/**
 * Canonical identity for the /code workspace.
 *
 * Cloud Project ids are Prisma CUIDs (and older data can contain UUIDs), while
 * the sidebar and chat-session store use `project:<id>`. Local folders keep
 * their `local:` namespace. Direct CodexProject workspaces use `codex:<id>` so
 * they cannot be mistaken for the separate Project model. Unknown legacy
 * workspace keys are preserved so a migration never strands existing browser
 * sessions.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CUID_RE = /^c[a-z0-9]{20,}$/i

export function isLocalCodexWorkspaceId(value: string | null | undefined): boolean {
  return String(value || "").trim().startsWith("local:")
}

export function codexProjectIdFromWorkspaceId(
  value: string | null | undefined,
  options?: { assumeProject?: boolean },
): string | null {
  const raw = String(value || "").trim()
  if (!raw || isLocalCodexWorkspaceId(raw) || raw.startsWith("codex:")) return null
  if (raw.startsWith("project:")) return raw.slice("project:".length).trim() || null
  if (options?.assumeProject || UUID_RE.test(raw) || CUID_RE.test(raw)) return raw
  return null
}

export function codexWorkspaceIdForProject(projectId: string | null | undefined): string | null {
  const id = codexProjectIdFromWorkspaceId(projectId, { assumeProject: true })
  return id ? `project:${id}` : null
}

export function canonicalCodexWorkspaceId(
  value: string | null | undefined,
  options?: { kind?: "local-folder" | "project" },
): string {
  const raw = String(value || "").trim()
  if (!raw) return "__default__"
  if (options?.kind === "local-folder" || isLocalCodexWorkspaceId(raw)) return raw
  if (raw.startsWith("codex:")) return raw
  if (options?.kind === "project") return codexWorkspaceIdForProject(raw) || "__default__"
  const projectId = codexProjectIdFromWorkspaceId(raw)
  return projectId ? `project:${projectId}` : raw
}
