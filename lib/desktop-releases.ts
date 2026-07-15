export type DesktopReleaseChannel = "stable" | "beta"
export type DesktopReleasePlatform = "macos-arm64" | "macos-x64" | "windows-x64"

export type DesktopReleaseAsset = {
  platform: DesktopReleasePlatform
  version: string
  releaseTag: string
  fileName: string
  downloadUrl: string
  pageUrl: string
  checksumUrl: string | null
  sizeBytes: number
  publishedAt: string
  signed: boolean
  prerelease: boolean
}

type GitHubAsset = {
  name: string
  browser_download_url: string
  size: number
}

export type GitHubDesktopRelease = {
  tag_name: string
  html_url: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

const RELEASES_API = "https://api.github.com/repos/infosiragpt-ops/SiraGPT-APP/releases?per_page=30"
const DOWNLOADS_PAGE = "https://siragpt.com/descargas"

const FALLBACK_BETA_ASSETS: Partial<Record<DesktopReleasePlatform, DesktopReleaseAsset>> = {
  "macos-arm64": {
    platform: "macos-arm64",
    version: "0.4.3",
    releaseTag: "native-qa-v0.4.3-bffcbf7",
    fileName: "SiraGPT-0.4.3-arm64.dmg",
    downloadUrl: "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-qa-v0.4.3-bffcbf7/SiraGPT-0.4.3-arm64.dmg",
    pageUrl: `${DOWNLOADS_PAGE}#mac`,
    checksumUrl: "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-qa-v0.4.3-bffcbf7/macos-SHA256SUMS.txt",
    sizeBytes: 121964048,
    publishedAt: "2026-07-06T00:49:17Z",
    signed: false,
    prerelease: true,
  },
  "windows-x64": {
    platform: "windows-x64",
    version: "0.4.3",
    releaseTag: "native-qa-v0.4.3-bffcbf7",
    fileName: "SiraGPT-Setup-0.4.3.exe",
    downloadUrl: "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-qa-v0.4.3-bffcbf7/SiraGPT-Setup-0.4.3.exe",
    pageUrl: `${DOWNLOADS_PAGE}#windows`,
    checksumUrl: "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-qa-v0.4.3-bffcbf7/windows-SHA256SUMS.txt",
    sizeBytes: 104505976,
    publishedAt: "2026-07-06T00:49:17Z",
    signed: false,
    prerelease: true,
  },
}

function isDesktopPlatform(value: string | null): value is DesktopReleasePlatform {
  return value === "macos-arm64" || value === "macos-x64" || value === "windows-x64"
}

export function parseDesktopPlatform(value: string | null): DesktopReleasePlatform | null {
  if (isDesktopPlatform(value)) return value
  if (value === "mac" || value === "macos") return "macos-arm64"
  if (value === "windows" || value === "win32") return "windows-x64"
  return null
}

export function parseDesktopChannel(value: string | null): DesktopReleaseChannel {
  return value === "beta" ? "beta" : "stable"
}

function assetMatchesPlatform(name: string, platform: DesktopReleasePlatform): boolean {
  if (/\.blockmap$/i.test(name)) return false
  if (platform === "macos-arm64") return /SiraGPT-.*-arm64\.dmg$/i.test(name)
  if (platform === "macos-x64") return /SiraGPT-.*\.dmg$/i.test(name) && !/-arm64\.dmg$/i.test(name)
  return /^SiraGPT[ .-]Setup[ .-].+\.exe$/i.test(name)
}

function checksumForPlatform(release: GitHubDesktopRelease, platform: DesktopReleasePlatform): string | null {
  const prefix = platform.startsWith("macos") ? "macos-" : "windows-"
  const platformManifest = release.assets.find(
    (asset) => asset.name.toLowerCase().startsWith(prefix) && /sha256sums\.txt$/i.test(asset.name),
  )
  const sharedManifest = release.assets.find((asset) => /^sha256sums\.txt$/i.test(asset.name))
  return platformManifest?.browser_download_url || sharedManifest?.browser_download_url || null
}

function versionFromAsset(name: string, tag: string): string {
  return name.match(/(\d+\.\d+\.\d+)/)?.[1] || tag.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"
}

export function findDesktopRelease(
  releases: GitHubDesktopRelease[],
  platform: DesktopReleasePlatform,
  channel: DesktopReleaseChannel,
): DesktopReleaseAsset | null {
  for (const release of releases) {
    if (release.draft || (channel === "stable" && release.prerelease)) continue
    const asset = release.assets.find((candidate) => assetMatchesPlatform(candidate.name, platform))
    if (!asset) continue
    return {
      platform,
      version: versionFromAsset(asset.name, release.tag_name),
      releaseTag: release.tag_name,
      fileName: asset.name,
      downloadUrl: asset.browser_download_url,
      pageUrl: `${DOWNLOADS_PAGE}#${platform.startsWith("macos") ? "mac" : "windows"}`,
      checksumUrl: checksumForPlatform(release, platform),
      sizeBytes: asset.size,
      publishedAt: release.published_at || "",
      signed: !release.prerelease,
      prerelease: release.prerelease,
    }
  }
  return null
}

async function fetchDesktopReleases(): Promise<GitHubDesktopRelease[]> {
  const requestInit: RequestInit & { next: { revalidate: number } } = {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "SiraGPT-Desktop-Release-Resolver",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    next: { revalidate: 900 },
  }
  const response = await fetch(RELEASES_API, requestInit)
  if (!response.ok) throw new Error(`desktop_release_lookup_${response.status}`)
  const payload = await response.json()
  return Array.isArray(payload) ? payload : []
}

export async function resolveDesktopRelease(
  platform: DesktopReleasePlatform,
  channel: DesktopReleaseChannel,
): Promise<DesktopReleaseAsset | null> {
  try {
    const release = findDesktopRelease(await fetchDesktopReleases(), platform, channel)
    if (release) return release
  } catch {
    // The public beta fallback keeps downloads available during GitHub API outages.
  }
  return channel === "beta" ? FALLBACK_BETA_ASSETS[platform] || null : null
}

export async function resolveDesktopReleaseCatalog(channel: DesktopReleaseChannel) {
  const platforms: DesktopReleasePlatform[] = ["macos-arm64", "macos-x64", "windows-x64"]
  const releases = await Promise.all(platforms.map(async (platform) => [platform, await resolveDesktopRelease(platform, channel)] as const))
  return Object.fromEntries(releases) as Record<DesktopReleasePlatform, DesktopReleaseAsset | null>
}
