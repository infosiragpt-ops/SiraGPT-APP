import type { MetadataRoute } from "next"

/**
 * Dynamic robots.txt. We allow indexing of marketing pages
 * (landing, pricing, privacy) and disallow the authenticated /
 * billing / admin / share / API surface. Sitemaps would normally
 * be added once a public domain is wired; for now there's no
 * sitemap published.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/auth/login", "/auth/register", "/privacy-policy", "/privacy", "/terms"],
        disallow: [
          "/admin",
          "/super-admin",
          "/billing",
          "/api",
          "/share",
          "/chat",
          "/projects",
          "/settings",
          "/library",
          "/voice",
          "/codex",
          "/gpts/create",
          // Auth callback URLs carry one-time codes / state params — never
          // a candidate for indexing. Mirrors NON_CANONICAL_PREFIXES in
          // app/layout.tsx so robots + canonical signals stay aligned.
          "/auth/callback",
        ],
      },
    ],
    sitemap: "https://siragpt.com/sitemap.xml",
    host: "https://siragpt.com",
  }
}
