---
name: Reserved VM promote health gates on frontend port
description: How to triage a "Waiting for deployment to be ready" promote failure on the SiraGPT Reserved VM
---

The SiraGPT Reserved VM (gce) deploy promote health-check probes the **frontend** port (3000 → external 80), NOT the backend.

**Why:** `scripts/start-all.cjs` spawns Next.js (standalone) on the frontend port immediately and, under `REPLIT_DEPLOYMENT=1`, deliberately keeps the frontend online even if the backend (sidecar `start-with-migrations.js` → `index.js`) crashes or its readiness times out. So promote success depends only on the frontend opening port 3000 and answering 200.

**How to apply:** When a deploy build shows status `failed` but the build logs end with the image pushed + "Virtual machine created" + "Waiting for deployment to be ready" (i.e. build phase succeeded, promote phase failed):
1. Diff the last successful deploy commit vs the failed one. If the only deltas are backend/test/memory files (nothing under the Next.js app/frontend or `scripts/start-all.cjs`), the change set **cannot** cause a promote failure — backend-only changes never gate promote.
2. Confirm the app boots healthy locally: `curl localhost:80/` → 200 and `curl localhost:80/api/health` → healthy.
3. If both hold, the promote failure is a **transient infra/health-timeout** (more likely because the full build takes ~18 min). Just re-publish; do not chase a code fix.
4. Do NOT reproduce the exact prod boot locally by running `npm run build` + `postbuild:slim` — `scripts/postbuild-slim.js` deletes `node_modules`, `.next/server`, `.local`, `artifacts`, etc., which wipes the dev workspace.
