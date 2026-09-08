import type {
  CompanySocialPlatform,
  CompanySocialProvider,
} from "./company-social-api"

const SOCIAL_RESOURCE_V2_PREFIX = "social:v2:"
const SOCIAL_PLATFORMS: readonly CompanySocialPlatform[] = [
  "facebook",
  "linkedin",
  "x",
]

export function companySocialResourceKey(
  provider: Pick<CompanySocialProvider, "platform" | "connection">,
): string | null {
  return companySocialResourceKeyForConnection(
    provider.platform,
    provider.connection,
  )
}

export function companySocialResourceKeyForConnection(
  platform: CompanySocialPlatform,
  connection: Pick<
    NonNullable<CompanySocialProvider["connection"]>,
    "id" | "accountId" | "connected"
  > | null | undefined,
): string | null {
  if (!connection?.connected) return null
  return companySocialResourceIdentityKey(platform, connection)
}

export function companySocialResourceIdentityKey(
  platform: CompanySocialPlatform,
  connection: Pick<
    NonNullable<CompanySocialProvider["connection"]>,
    "id" | "accountId"
  > | null | undefined,
): string | null {
  const connectionId = String(connection?.id || "").trim()
  const accountId = String(connection?.accountId || "").trim()
  if (
    !SOCIAL_PLATFORMS.includes(platform)
    || !connectionId
    || !accountId
  ) return null
  try {
    return `${SOCIAL_RESOURCE_V2_PREFIX}${platform}:${encodeURIComponent(connectionId)}:${encodeURIComponent(accountId)}`
  } catch {
    return null
  }
}

export function companySocialPlatformFromResourceKey(
  resourceKey: string,
): CompanySocialPlatform | null {
  if (!resourceKey.startsWith(SOCIAL_RESOURCE_V2_PREFIX)) return null
  const [platform, connectionId, accountId, ...extra] = resourceKey
    .slice(SOCIAL_RESOURCE_V2_PREFIX.length)
    .split(":")
  if (
    extra.length > 0
    || !SOCIAL_PLATFORMS.includes(platform as CompanySocialPlatform)
    || !connectionId
    || !accountId
  ) return null
  return platform as CompanySocialPlatform
}

export function companySocialResourceAssignedToDepartment(
  assignments: Record<string, string>,
  provider: Pick<CompanySocialProvider, "platform" | "connection">,
  departmentId: string,
): boolean {
  const resourceKey = companySocialResourceKey(provider)
  return Boolean(resourceKey && assignments[resourceKey] === departmentId)
}

export function assignedCompanySocialPlatforms(
  assignments: Record<string, string>,
  providers: readonly Pick<CompanySocialProvider, "platform" | "connection">[],
  departmentId: string,
): CompanySocialPlatform[] {
  return providers
    .filter((provider) => (
      companySocialResourceAssignedToDepartment(assignments, provider, departmentId)
    ))
    .map((provider) => provider.platform)
}

export function isLegacyCompanySocialResourceKey(resourceKey: string): boolean {
  return /^social:(facebook|linkedin|x)$/.test(resourceKey)
}
