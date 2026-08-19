---
name: /code auto-run on build completion
description: How the /code app builder auto-boots the dev server when the agent finishes, and the React timing trap behind it.
---

# /code auto-run timing

When the agent finishes building a project in the `/code` workspace, the preview
should auto-boot the real dev server (no manual ▶ Ejecutar) for projects the
sandboxed srcdoc iframe can't render, and stay on the instant srcdoc preview for
self-contained output.

## The race trap (non-obvious)
The chat panel dispatches the `siragpt:code-run-app` CustomEvent in the SAME tick
as the `applyBlock()` setState that writes the new files. `dispatchEvent` is
synchronous, so any listener that reads `files`/`activePath` from its closure (or
even from a ref) sees the PRE-build workspace — React hasn't committed yet. A
naive listener that called `runApp()` directly would boot the OLD code, or skip a
just-created project entirely.

**How to apply:** never have the listener read workspace state or start the run.
For an auto run the listener only bumps a signal counter (`setAutoRunSignal`). A
separate effect keyed on that signal runs AFTER commit and reads fresh state via
mirror refs (`filesRef`/`phaseRef`/`runAppRef` assigned every render). The signal
bump batches with the applyBlock setState (or, without batching, lands after it),
so by the time the effect runs the files are committed. The listener is registered
once (deps `[]`). `eslint-disable exhaustive-deps` on the signal effect is correct:
adding `files`/`runApp`/`phase` would re-fire auto-run on unrelated keystrokes.

## The gate must be activePath-independent
**Why:** `buildPreviewDocument(files, activePath)` returns `markdown/svg/html`
when the active tab is a README/SVG/self-contained doc, so gating on its
`kind==="unsupported"` gives a FALSE NEGATIVE inside a real Vite/Next project.
**How to apply:** gate auto-run on `projectNeedsDevServer(files)` =
`isNodeBundlerProject(files) && !(index.html exists && isSelfContainedHtml(it))`.
This distinguishes a real bundler app (index.html → `/src/main.tsx`, needs the dev
server) from the deterministic Builder's self-contained index.html (Vite/Next
package.json + CDN React inline runtime, renders via srcdoc, must NOT npm install),
and from Next without an index.html (needs the dev server).

## Other rules
- Auto run degrades SILENTLY: `started.disabled` or `started.error` (incl. the 403
  for non-allowlisted users) drops to phase `idle` instead of a red overlay — a
  manual ▶ Ejecutar still surfaces the reason. Dev-server errors AFTER boot still
  show via `pollUntilReady`.
- Don't interrupt an in-flight install: if a new build lands while phase is
  `starting`, queue it (`pendingAutoRunRef`) and drain it from an effect keyed on
  `liveRun.phase` once the boot settles, so the preview lands on the newest code.
