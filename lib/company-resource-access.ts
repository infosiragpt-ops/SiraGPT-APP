export type CompanyResourceActivation = {
  assignedToDepartment: boolean
  connected: boolean
  connectorResource: boolean
  availableToCompany?: boolean
}

export function isCompanyResourceActive({
  assignedToDepartment,
  connected,
  connectorResource,
  availableToCompany,
}: CompanyResourceActivation): boolean {
  if (!assignedToDepartment || !connected) return false
  return !connectorResource || Boolean(availableToCompany)
}

export function assertCompanyOrgScope(orgId?: string | null): string {
  const id = String(orgId || "").trim()
  if (!id) {
    const err = new Error("org_scope_required")
    err.name = "OrgScopeError"
    throw err
  }
  return id
}

export function hasCompanyOrgScope(orgId?: string | null): boolean {
  return Boolean(String(orgId || "").trim())
}
