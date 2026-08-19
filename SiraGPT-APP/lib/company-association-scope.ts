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
