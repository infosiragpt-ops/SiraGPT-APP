import type { CodexCompanyAssociationState } from "./codex/codex-api"

export function companyAssociationMatches(
  state: CodexCompanyAssociationState | null | undefined,
  companyProjectId: string | null | undefined,
): boolean {
  const expectedId = String(companyProjectId || "").trim()
  return Boolean(expectedId && state?.company?.id === expectedId)
}

export function associatedCodexProjectIdForCompany(
  state: CodexCompanyAssociationState | null | undefined,
  companyProjectId: string | null | undefined,
): string | null {
  if (!companyAssociationMatches(state, companyProjectId)) return null
  return state?.association?.codexProject.id || null
}

export function shouldAcceptCompanyAssociationResponse(input: {
  requestedCompanyId: string
  currentCompanyId: string | null
  requestGeneration: number
  currentGeneration: number
  state: CodexCompanyAssociationState
}): boolean {
  return Boolean(
    input.requestedCompanyId
    && input.requestedCompanyId === input.currentCompanyId
    && input.requestGeneration === input.currentGeneration
    && companyAssociationMatches(input.state, input.requestedCompanyId),
  )
}

const ASSOCIATION_TTL_MS = 30_000
const associationCache = new Map<string, { at: number; value: unknown }>()

export function rememberCompanyAssociation(key: string, value: unknown): void {
  const k = String(key || "").trim()
  if (!k) return
  associationCache.set(k, { at: Date.now(), value })
}

export function readCompanyAssociation<T = unknown>(key: string): T | null {
  const k = String(key || "").trim()
  if (!k) return null
  const hit = associationCache.get(k)
  if (!hit) return null
  if (Date.now() - hit.at > ASSOCIATION_TTL_MS) {
    associationCache.delete(k)
    return null
  }
  return hit.value as T
}

export function invalidateCompanyAssociation(key?: string | null): void {
  if (!key) {
    associationCache.clear()
    return
  }
  associationCache.delete(String(key))
}
