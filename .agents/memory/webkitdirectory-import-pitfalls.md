---
name: webkitdirectory folder-import pitfalls
description: Why focus-based cancel detection breaks <input webkitdirectory> uploads, and why the iframe local-folder import must never fall back to showDirectoryPicker.
---

# `<input webkitdirectory>` folder import pitfalls (Replit-preview iframe path)

Context: `showDirectoryPicker` (File System Access API) is blocked inside the
Replit preview's cross-origin iframe ("Cross origin sub frames aren't allowed to
show a file picker"). The fallback is a classic `<input webkitdirectory>` upload.

## Never use a window-`focus` timeout to detect "user cancelled the picker"

**Rule:** resolve the picker promise ONLY on the input's `change` (selection) and
`cancel` (dismiss) events. Do NOT add a `window.addEventListener("focus", …)` +
setTimeout heuristic to infer cancel.

**Why:** a directory upload triggers a SECOND browser confirmation
("Upload N files to this site?") that appears AFTER the OS dialog closes — and the
OS dialog closing already restores window focus. A focus-based timer therefore
fires while the user is still looking at that confirmation; at that moment
`input.files` is empty, so the heuristic calls `finish(null)` and DISCARDS a valid
folder selection. Symptom: user picks a folder, nothing happens (silent no-op),
they get confused and create a cloud project instead.

**How to apply:** modern Chrome/Edge/Firefox fire `cancel`; the only downside of
dropping the focus heuristic is a leaked hidden input + pending promise on truly
ancient browsers — acceptable vs. eating real selections.

## The iframe import must never fall back to the native picker or a cloud project

**Rule:** in the iframe / no-FS-Access branch, if `<input>` import throws, show a
`toast.error` — never re-trigger `showDirectoryPicker` and never silently create a
cloud project.

**Why:** the old "last resort" dispatched an event whose listener called
`openLocalDirectoryWorkspace()` → `showDirectoryPicker` → the same cross-origin
error again, OR routed into `handleOpenInCode({})` producing a stray
`POST /api/projects` + navigation to `/code?folder=<cloudId>` (cloud) instead of
`/code?local=<codexId>` (local). That is exactly the "no funciona bien" report.

**How to apply:** detect iframe with `window.self !== window.top` (wrapped in
try/catch → assume framed). All entry points that open a local folder (the sidebar
"Nueva empresa (carpeta local)" AND the 4 `/code` editor buttons that call
`openLocalFolderWorkspace`) must share one iframe-safe reader
(`readLocalFolderViaInput`, returns raw `LocalWorkspaceImport`, no persistence).
Input imports are read-only snapshots → set `linked=false` and clear linked
handles; native imports keep `linked=true` for write-back.

## Gesture preservation

`input.click()` must run synchronously inside the click handler — only synchronous
checks (iframe detection, `canOpenLocalDirectory()`) may precede the first `await`,
or the browser drops the user-activation and the picker won't open.
