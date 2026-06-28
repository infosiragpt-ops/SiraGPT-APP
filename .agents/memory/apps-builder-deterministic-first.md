---
name: APPS builder must be deterministic-first
description: Why the /code "APPS" conversational builder uses the LLM-free deterministic scaffold (not single-SSE LLM generation) for first builds, and how the live preview decides to render an index.html.
---

# APPS builder: deterministic-first first build

On the Reserved VM (GCLB ~30s hard response cut), the APP-mode "generate" path must
use the **deterministic builder** (LLM-free `buildApp` → `/api/builder/generate` →
`scaffoldFromBrief`), NOT a chat-model branch that streams the whole project in one
SSE.

**Why:** the single-SSE "generate the entire project from the chat model" branch
routinely exceeded the ~30s GCLB cut, so the owner saw the builder "se queda
cargando" / errors. The deterministic scaffold returns in a few seconds and emits a
**self-contained `index.html`** (React via unpkg CDN + inline runtime, `id="root"`,
no `/src/main.tsx`), so first build is fast and reliable. The OpenCode engine path
(only truly available in Docker, behind `engineAvailable`) is still preferred when
present; LLM enhancement is a possible *later* "Mejorar con IA" step, never the
first build.

**How to apply:**
- In the builder's `dispatch` "generate" case: `engineAvailable` → engine; else →
  deterministic `buildApp`. Do not reintroduce an `activeModelName` sendPrompt
  generation branch for first builds.
- Live preview (`buildPreviewDocument`): inside a Node-bundler project
  (`package.json` has next/vite) an **active** `index.html` should render in srcdoc
  ONLY if it is self-contained — i.e. it does not load a LOCAL module entry
  (`<script src>` ending in ts/tsx/jsx or anything under a `src/` folder, with or
  without a leading slash) and has no inline `<script type="module">` importing a
  local path. A real Vite/Next `index.html` (module → `/src/main.tsx`) must stay
  gated behind ▶ Ejecutar (it needs the dev server; srcdoc would be a blank page).
- CDN scripts (`https://` or protocol-relative `//…`) and inline non-module
  scripts are fine — that is exactly the deterministic builder's shape.
