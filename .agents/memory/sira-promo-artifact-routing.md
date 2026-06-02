---
name: SiraGPT Promo Video artifact routing
description: How the sira-promo video artifact is served and why createArtifact persistently fails
---

## The problem
`createArtifact({ slug: "sira-promo", ... })` always fails with:
> Artifact env update failed: ARTIFACT_NOT_FOUND

`verifyAndReplaceArtifactToml` returns `{"success":true}` but `listArtifacts()` still returns `[]`.
Deleting the directory and recreating reproduces the same failure every time.
This is a Replit platform-level bug for this workspace — the artifact registry never retains the entry.

## Working solution
The video is served via a dual approach:

1. **SiraGPT Video workflow** (port 5000) — `PORT=5000 BASE_PATH=/sira-promo/ pnpm --filter @workspace/sira-promo run dev`
   - Accessible directly from Replit's workflow dropdown in the preview pane
   - `artifact.toml` at `artifacts/sira-promo/.replit-artifact/artifact.toml` has `localPort=5000`, so the internal proxy at localhost:80 routes `/sira-promo/` → port 5000 (HTTP 200)

2. **Next.js beforeFiles rewrite** in `next.config.mjs`
   - `beforeFiles` rewrites intercept `/sira-promo` and `/sira-promo/:path*` → `http://localhost:5000/sira-promo/:path*`
   - `skipTrailingSlashRedirect: true` prevents Next.js App Router from issuing a 308 redirect for `/sira-promo/` before rewrites run
   - Both ports 3000 and 80 return 200 for `/sira-promo/` locally

**Why:**
The Replit external cloud proxy (`*.riker.replit.dev`) only routes to registered artifacts. Since registration fails, the external URL shows 502 from the screenshot tool. However the video is fully functional from within Replit's preview pane via the "SiraGPT Video" workflow selector.

**How to apply:**
If you ever need to recreate the artifact, don't expect `listArtifacts` to show it. Just ensure the workflow is running on port 5000 and the `beforeFiles` rewrites in `next.config.mjs` stay in place.
