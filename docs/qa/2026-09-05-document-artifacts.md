# Document cards, preview controls and source-preserving edits

Base refreshed: `ff61eeb9d980775cb75900d5350278c58e098243` (`production-main`).
Branch: `fix/document-artifacts-editing-polish`.
This change is separate from the pending document-sandbox phase 1 work.

## Scope

- Generated and edited document cards share the same Office/PDF icon, compact
  preview/download buttons, accessible labels and loading/error behavior.
- PDF and server-converted Office previews use one real PDF.js page/zoom toolbar
  in the document header, on desktop and mobile. Direct PDFs no longer use a
  separate native iframe with an inaccurate outer page counter.
- PDF loading invalidates stale callbacks, installs observers after bytes arrive,
  keeps the selected page on zoom and permits horizontal scrolling without losing
  the left edge of enlarged pages. Success toasts no longer cover Close.
- The follow-up `en la primera Landin agrega en la Historia de los Dinosaurios de
  1998.` edits the existing first-slide title. It does not regenerate the deck or
  append an annex. Title edits use a shared source-grounded parser and PPTX adapter.
- Edited Office outputs cannot pass solely because their ZIP is readable. Checks
  reject unchanged files, metadata-only repacks, ambiguous original/output
  mappings, and failed persistence. The scoped PPTX title path additionally checks
  the exact requested title and byte-identical untouched OOXML parts.
- Follow-ups recover the latest compatible artifact, enforcing user/chat identity
  when recovering local storage metadata.
- The document browser spec is included in the mandatory `E2E · critical UI gate`,
  not just the informational smoke job. A successful informational job alone is
  not evidence that all of its tests passed.

## Reproduce local checks

Install the repository's existing root and backend dependencies normally in an
isolated checkout; no additional package or external model is needed.

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run
npm run type-check
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
node --require ./tests/register-ts-paths.cjs --test .test-dist/tests/document-preview-source.test.js .test-dist/tests/document-preview-regression.test.js .test-dist/tests/document-page-preview-source.test.js

task_artifacts_dir=$(mktemp -d)
NODE_ENV=test AGENT_ARTIFACT_DIR="$task_artifacts_dir" node --test \
  backend/tests/agent-runner-scenario-bank.test.js \
  backend/tests/generated-document-followup-edit.test.js \
  backend/tests/agent-runner.test.js \
  backend/tests/source-preserving-document-edit.test.js \
  backend/tests/doc-followup-recovery.test.js \
  backend/tests/pptx-surgical-edit.test.js \
  backend/tests/document-edit-output-proof-security.test.js

npx playwright test e2e/document-artifact-consistency.spec.ts --project=chromium
npm run ui-lock:verify
```

The Node option avoids experimental Node 26 localStorage interfering with jsdom.
For an already running **local** Next instance, use `PLAYWRIGHT_BASE_URL` to avoid
starting a second server. The E2E fixture refuses non-loopback hosts.

## Evidence and limits

- Compiled frontend Node suite: 12,321 passing tests, 532 suites, no skips.
  Frontend component/library suite: 734 passing tests. Preview source regressions:
  10 passing tests. Backend release/regression/security suite: 243 passing tests
  in one Node 24 run, none skipped and no forced process exit.
- The expanded mandatory browser gate (chat, upload smoke and document cards)
  passes 7/7 locally on Node 24.19.0 and Chromium, with zero retries. The two
  document tests use the explicit mocks described below; the other smoke tests
  do not replace an authenticated backend upload acceptance test.
- Local optimized Next.js production build and bundle-size budget pass, with
  the existing noVNC top-level-await warning. Post-build TypeScript also passes:
  four pre-existing `Promise | object` route-prop annotations in three redirect
  pages were narrowed to the Next.js Promise contract. Their transpiled
  JavaScript remains byte-identical; redirects and the visible UI are unchanged.
  The local frontend build reused dependencies without regenerating the shared
  Prisma client; CI still performs the isolated install/generation/build gates.
- Chromium E2E: 2 passing tests (desktop 1440×1000 and mobile 390×844), with
  16 cards, 12 viewer flows and 8 byte-identical downloads in the companion
  visual check. Advancing, zooming and returning to page 1 preserves both the
  rendered content and page counter. Final screenshots were visually inspected;
  earlier blank-canvas and stale-counter captures were rejected, not counted as
  successful evidence. No application console errors were reported.
- The new backend tests generate a real 11-slide PPTX, exercise both editing entry
  points, read the resulting artifact, and compare every ZIP member: only
  `ppt/slides/slide1.xml` changes. Original bytes, other slides and notes remain
  unchanged. DOCX/XLSX/PDF no-op rejection uses actual synthetic format binaries.
- Browser tests exercise `/agentes` with initial/edited DOCX, XLSX, PPTX and PDF
  cards, real three-page PDF.js rendering, header navigation, zoom, downloads and
  switching an open document. Raster-pixel checks prevent accepting blank canvases.
- Browser auth/API/model and Office-to-PDF conversion responses are intercepted.
  This is not proof of a live authenticated request, a provider call, LibreOffice
  conversion or a production deployment. PDF/Office fixture bytes are synthetic;
  browser download checks assert exact filenames and hashes, not Office fidelity.
- No claim of arbitrary semantic editing for every format: free-form PDF text
  replacement still fails closed where existing adapters cannot preserve layout.
- No secrets, database migrations, Docker changes, DNS changes, model calls or
  production restarts are part of this patch. Before publishing, validate the
  real account/chat flow and document conversion in the deployment environment.

## Initial pre-deployment review — 2026-09-05 (superseded below)

The first PR CI run caught an outdated source-test assertion after shared card
styles were extracted, plus AgentRunner dependency/cancellation regressions.
The source test now checks both the helper import/use and the original style
contract. AgentRunner keeps the document classifier out of its dependency graph
and runs the surgical path within the existing cancellation/cleanup lifecycle;
a pre-cancelled PPTX regression checks exactly one cancellation and no output.
Selection regressions also cover an explicitly named PPTX taking precedence over
the previous artifact, quoted filenames versus replacement titles, and plural or
missing targets failing closed instead of silently editing another document.
Office validation now bounds archive metadata before allocating the ZIP entry
list, and uses bounded decompression with CRC/exact-length checks before reading
OOXML parts. Thirteen small adversarial fixtures cover dishonest sizes, entry
counts and invalid packages. The synchronous path accepts ZIP32 STORE/DEFLATE,
at most 5,000 entries, 50 MiB per part and 200 MiB total; unsupported or oversized
packages fail closed. It is not an unlimited document-processing promise.

Production was not changed during this review. Public readiness returned HTTP
200 and the live commit was `b30b48bc9b7c2510e86ff85c293852967ba31dc9`.
The configured Lenovo SSH key was rejected (`Permission denied (publickey)`).
The active GitHub deploy workflow still uses the legacy `/opt/siragpt` path and
hard-reset operations; its earlier failed run could not preserve rollback images.
Do not merge expecting that workflow to publish to the Lenovo. Restore the
approved Lenovo access, review its actual `publish.sh` and backup/rollback path,
then verify the published commit and authenticated document flow after release.

A fresh read-only `npm audit --omit=dev --audit-level=high` additionally reports
three high-severity affected packages in the root and twelve in the backend
(zero critical in both). No package/lockfile changed in this PR, so these are
baseline dependency findings, not newly introduced dependencies. Examples include
Next/sharp in the root and document/browser tooling in the backend. Some suggested
remediations require major versions or are unavailable; do not run a forced
automatic dependency rewrite as part of this document UI patch. Resolve and
validate these release-security findings before publication; a green critical-only
CI audit is not a clean high-severity audit.

## Reviewed release preparation — 2026-09-05

- Mac-to-Lenovo SSH now authenticates as `deploy`. The current production-main
  effort-control changes from PR #564 were integrated without replacing their UI.
- Dependencies were installed in this worktree, not through the previous shared
  node_modules symlinks. Next 15.5.25 and Sharp 0.35.4 remove the root high findings.
  Root production audit has zero high/critical findings; the old Sharp exception
  has been removed. Four moderate advisories remain in the raw root report.
- Backend Puppeteer 25.10.0 is lazy-loaded as ESM in the two existing callers;
  Prisma remains 6.19.3. Scoped transitive updates remove remediable high findings.
  Real browser launch, screenshot, PDF creation and Office parsing passed.
- `image-size@1.2.1` has no published fix for the two remaining high advisories.
  A reproducible, hash-checked source patch fixes non-advancing ICNS/BMFF loops.
  Malformed-file watchdog tests reproduce the old issue and verify termination
  after patching; valid raster/ICNS/HEIF/JXL dimensions remain unchanged.
  Every installed copy is verified after installation and inside the runtime
  Docker image. npm still reports two high affected packages through the
  PptxGenJS dependency chain, four moderate and one low. The backend gate retains
  that full report and only accepts the two exact advisories when every installed
  copy matches the fixed hashes. New findings or failed evidence block release.
- The optimized Next build, post-build TypeScript, bundle budgets and UI lock
  pass. The pre-existing noVNC top-level-await build warning remains.
- Final local verification: 12,388 compiled Node tests (533 suites), 734
  component/library tests, 325 backend regressions, 14 malformed/valid image
  security tests and one real-browser integration check all pass. The 15-test
  Chromium gate passes against the optimized build with zero retries, including
  original/edited Office/PDF downloads, actual PDF pixels, page/zoom controls
  and the preserved effort/permissions composer. An initial run exposed fixture
  assumptions: English browser locale and a blocked build-time public API URL.
  The fixtures now select Spanish where required and intercept the baked API
  origin without network access; no assertions were removed or UI changed.
- The reviewed publisher has 32 passing simulated tests for backups, bad or
  concurrent state, candidate attestation and recovery. These simulations are
  not a claim that a live rollback/restore drill occurred.
- The legacy automatic VPS deployment workflow was disabled before merging.
  Its replacement only verifies an already-published Lenovo SHA and readiness;
  it cannot deploy, access SSH secrets or run database migrations.
- The reviewed publisher backs up configuration/database, preserves prior image
  IDs, checks concurrent changes, verifies the candidate patch, activates only
  app services, and restores the previous release if readiness fails. PostgreSQL
  and Redis are neither republished nor restarted. See the Lenovo release runbook.

These preparation results do not assert that the new release is already public.
Actual merge SHA, publication and final HTTP/document acceptance are recorded
after deployment. The source-preserving editing scope and mocked-browser limits
  above still apply; this is not the separate sandbox phase 1 rollout.

The first expanded release CI run also caught a stale generated license
inventory and backend source-contract tests still pointing at the retired VPS
workflow. Those contracts now protect the actual read-only verification and
Lenovo publisher, including runner/frontend health before replacing the backend
and the same ordering during recovery. Reusable canary/migration implementations
were not removed or their tests quarantined. Lenovo does not currently run the
retired VPS Prometheus or /code canary: readiness alone is not claimed as either.
CI additionally exposed a real missing direct `js-yaml` dependency, previously
hidden by Puppeteer's incidental hoisting. `js-yaml@4.3.1` is now declared and
verified with a clean backend-only install, without rewriting the serializers.
The regenerated license inventory has 1,521 entries and passes the existing
permissive-license gate; no new license exception was added.
