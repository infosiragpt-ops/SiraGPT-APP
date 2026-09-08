export type MobileReleasePlatform = "android-apk" | "android-aab"

export type MobileReleaseAsset = {
  platform: MobileReleasePlatform
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

export type GitHubMobileRelease = {
  tag_name: string
  html_url: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

const RELEASES_API = "https://api.github.com/repos/infosiragpt-ops/SiraGPT-APP/releases?per_page=100"
const DOWNLOADS_PAGE = "https://siragpt.com/descargas"

// Mobile packages are published under these tag families. Anything else
// (desktop-beta-*, native-qa-*) may also carry mobile assets historically,
// so unknown tags are still considered — the known families just win ties.
const PREFERRED_TAG_PREFIXES = ["native-mobile-qa-", "native-android-signed-"]

// Known-good public asset so the Android download keeps working during
// GitHub API outages or rate limiting (same pattern as desktop-releases).
const FALLBACK_ASSETS: Record<MobileReleasePlatform, MobileReleaseAsset> = {
  "android-apk": {
    platform: "android-apk",
    version: "0.4.4",
    releaseTag: "native-mobile-qa-v0.4.4-92849df",
    fileName: "SiraGPT-92849df-debug.apk",
    downloadUrl:
      "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-mobile-qa-v0.4.4-92849df/SiraGPT-92849df-debug.apk",
    pageUrl: `${DOWNLOADS_PAGE}#android`,
    checksumUrl:
      "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-mobile-qa-v0.4.4-92849df/SHA256SUMS.txt",
    sizeBytes: 4117570,
    publishedAt: "2026-07-23T03:01:40Z",
    signed: false,
    prerelease: true,
  },
  "android-aab": {
    platform: "android-aab",
    version: "0.4.4",
    releaseTag: "native-mobile-qa-v0.4.4-92849df",
    fileName: "SiraGPT-92849df-signed-release.aab",
    downloadUrl:
      "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-mobile-qa-v0.4.4-92849df/SiraGPT-92849df-signed-release.aab",
    pageUrl: `${DOWNLOADS_PAGE}#android`,
    checksumUrl:
      "https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-mobile-qa-v0.4.4-92849df/SHA256SUMS.txt",
    sizeBytes: 3024915,
    publishedAt: "2026-07-23T03:01:40Z",
    signed: true,
    prerelease: true,
  },
}

function isMobilePlatform(value: string | null): value is MobileReleasePlatform {
  return value === "android-apk" || value === "android-aab"
}

export function parseMobilePlatform(value: string | null): MobileReleasePlatform | null {
  if (isMobilePlatform(value)) return value
  // "android" means "the package a phone can install today": the APK.
  // The AAB is a Play Console artifact and must be requested explicitly.
  if (value === "android" || value === "apk") return "android-apk"
  if (value === "aab") return "android-aab"
  return null
}

function assetMatchesPlatform(name: string, platform: MobileReleasePlatform): boolean {
  if (platform === "android-apk") return /^SiraGPT-.*\.apk$/i.test(name)
  return /^SiraGPT-.*\.aab$/i.test(name)
}

function checksumForRelease(release: GitHubMobileRelease): string | null {
  const manifest = release.assets.find((asset) => /sha256sums\.txt$/i.test(asset.name))
  return manifest?.browser_download_url || null
}

function versionFromAsset(name: string, tag: string): string {
  return name.match(/(\d+\.\d+\.\d+)/)?.[1] || tag.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"
}

function tagPreference(tag: string): number {
  const index = PREFERRED_TAG_PREFIXES.findIndex((prefix) => tag.startsWith(prefix))
  return index === -1 ? PREFERRED_TAG_PREFIXES.length : index
}

export function findMobileRelease(
  releases: GitHubMobileRelease[],
  platform: MobileReleasePlatform,
): MobileReleaseAsset | null {
  const ranked = [...releases].sort((left, right) => {
    const leftPublishedAt = Date.parse(left.published_at || "")
    const rightPublishedAt = Date.parse(right.published_at || "")
    const leftTimestamp = Number.isFinite(leftPublishedAt) ? leftPublishedAt : 0
    const rightTimestamp = Number.isFinite(rightPublishedAt) ? rightPublishedAt : 0
    if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp
    return tagPreference(left.tag_name) - tagPreference(right.tag_name)
  })

  for (const release of ranked) {
    if (release.draft) continue
    const asset = release.assets.find((candidate) => assetMatchesPlatform(candidate.name, platform))
    if (!asset) continue
    return {
      platform,
      version: versionFromAsset(asset.name, release.tag_name),
      releaseTag: release.tag_name,
      fileName: asset.name,
      downloadUrl: asset.browser_download_url,
      pageUrl: `${DOWNLOADS_PAGE}#android`,
      checksumUrl: checksumForRelease(release),
      sizeBytes: asset.size,
      publishedAt: release.published_at || "",
      signed: platform === "android-aab" && /signed/i.test(asset.name),
      prerelease: release.prerelease,
    }
  }
  return null
}

async function fetchMobileReleases(): Promise<GitHubMobileRelease[]> {
  const requestInit: RequestInit & { next: { revalidate: number } } = {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "SiraGPT-Mobile-Release-Resolver",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    next: { revalidate: 900 },
  }
  const response = await fetch(RELEASES_API, requestInit)
  if (!response.ok) throw new Error(`mobile_release_lookup_${response.status}`)
  const payload = await response.json()
  return Array.isArray(payload) ? payload : []
}

export async function resolveMobileRelease(platform: MobileReleasePlatform): Promise<MobileReleaseAsset | null> {
  try {
    const release = findMobileRelease(await fetchMobileReleases(), platform)
    if (release) return release
  } catch {
    // The known public QA asset keeps the download available during GitHub API outages.
  }
  return FALLBACK_ASSETS[platform] || null
}

export async function resolveMobileReleaseCatalog() {
  const platforms: MobileReleasePlatform[] = ["android-apk", "android-aab"]
  const releases = await Promise.all(platforms.map(async (platform) => [platform, await resolveMobileRelease(platform)] as const))
  return Object.fromEntries(releases) as Record<MobileReleasePlatform, MobileReleaseAsset | null>
}
