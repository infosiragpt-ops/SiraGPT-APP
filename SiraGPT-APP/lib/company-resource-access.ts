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
