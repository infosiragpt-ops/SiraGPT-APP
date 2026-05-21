import type { MetadataRoute } from "next"

/**
 * Static sitemap for marketing surfaces. We list the same routes that
 * robots.ts explicitly allows — authenticated/transient routes are
 * intentionally excluded so we don't ship conflicting signals to Google.
 * Kept static (no DB query) so it stays fast and resilient at build time.
 */
const BASE_URL = "https://siragpt.com"

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const entries: Array<{ path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }> = [
    { path: "/", changeFrequency: "weekly", priority: 1.0 },
    { path: "/auth/login", changeFrequency: "monthly", priority: 0.6 },
    { path: "/auth/register", changeFrequency: "monthly", priority: 0.7 },
    { path: "/privacy-policy", changeFrequency: "yearly", priority: 0.3 },
    { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
    { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  ]
  return entries.map(({ path, changeFrequency, priority }) => ({
    url: `${BASE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }))
}
