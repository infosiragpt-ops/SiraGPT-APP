# Document cards, preview controls and source-preserving edits

Base: `09fa991cf78a3f425499caefde3d2e68ae58b3b0` (`production-main`).
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

## Reproduce local checks

Install the repository's existing root and backend dependencies normally in an
isolated checkout; no additional package or external model is needed.

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run
npm run type-check
node --test tests/document-preview-source.test.ts tests/document-preview-regression.test.ts tests/document-page-preview-source.test.ts

task_artifacts_dir=$(mktemp -d)
NODE_ENV=test AGENT_ARTIFACT_DIR="$task_artifacts_dir" node --test \
  backend/tests/generated-document-followup-edit.test.js \
  backend/tests/agent-runner.test.js \
  backend/tests/source-preserving-document-edit.test.js \
  backend/tests/doc-followup-recovery.test.js \
  backend/tests/pptx-surgical-edit.test.js

npx playwright test e2e/document-artifact-consistency.spec.ts --project=chromium
npm run ui-lock:verify
```

The Node option avoids experimental Node 26 localStorage interfering with jsdom.
For an already running **local** Next instance, use `PLAYWRIGHT_BASE_URL` to avoid
starting a second server. The E2E fixture refuses non-loopback hosts.

## Evidence and limits

- Frontend component/library suite: 734 passing tests. Preview source regressions:
  10 passing tests. Backend focused/regression suite: 177 passing tests, none skipped.
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
