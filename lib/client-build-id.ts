/**
 * Client build identity used for /code version-skew recovery.
 *
 * Preference: NEXT_PUBLIC_BUILD_ID → GIT-injected public id → Next.js
 * `deploymentId` / `__NEXT_DATA__.buildId`. Empty/"unknown" is treated as
 * "do not enforce mismatch" by the ensure API.
 */

export function resolveClientBuildId(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
  nextData?: { buildId?: string; deploymentId?: string },
): string {
  const candidates = [
    env.NEXT_PUBLIC_BUILD_ID,
    env.NEXT_PUBLIC_SENTRY_RELEASE,
    nextData?.deploymentId,
    nextData?.buildId,
  ]
  for (const candidate of candidates) {
    const value = String(candidate || "").trim()
    if (value && value !== "unknown") return value
  }
  return "unknown"
}

export function readBrowserClientBuildId(): string {
  if (typeof window === "undefined") {
    return resolveClientBuildId()
  }
  const nextData = (window as unknown as {
    __NEXT_DATA__?: { buildId?: string }
    next?: { deploymentId?: string }
  }).__NEXT_DATA__
  const deploymentId = (window as unknown as { next?: { deploymentId?: string } }).next?.deploymentId
  return resolveClientBuildId(process.env as Record<string, string | undefined>, {
    buildId: nextData?.buildId,
    deploymentId,
  })
}

export const CLIENT_BUILD_HEADER = "X-Client-Build"
