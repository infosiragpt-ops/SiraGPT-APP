---
name: /code builder preview render gating
description: Why the deterministic /generate path must emit client-only files (no package.json) for complex apps to compile AND render.
---

# /code builder: making complex apps compile AND render

The `/code` deterministic app-builder (`/api/builder/generate`, LLM-free path) must emit a
**client-only** scaffold — a self-contained `index.html` plus `preview.html` + `README.md`,
**no `package.json`/Prisma/.env/codegen** — via `scaffoldFromBrief(brief, { mode: 'client' })`.
The default `scaffoldFromBrief()` (and the `/scaffold` route) stays fullstack; only `/generate`
opts into client mode.

**Why:**
1. The preview renderer gates on a node-bundler heuristic: it shows a "Pulsa ▶ Ejecutar"
   placeholder (instead of the app) whenever the project looks like a bundler project — i.e. a
   `package.json` declaring next/vite is present. No `package.json` ⇒ that heuristic is false ⇒
   the preview renders the active file directly, so the app shows up immediately.
2. A scaffolded Next.js + Prisma app 500s at runtime in the preview because there is no
   `DATABASE_URL`. A client-only app persists to `localStorage` instead, so it never depends on
   a DB to render.

**How to apply:**
- The preview's "active file" is the LAST one applied; the chat apply loop intentionally sorts
  `index.html` last so it stays active and the live app (not the README) renders. Preserve that
  ordering if you touch the apply loop.
- Entity extraction is fallback-layered and the order is load-bearing: explicit `"con X y Y"`
  extraction always wins; domain presets only fire when extraction is empty AND
  platform !== 'landing', before the generic "Registro" fallback. A bare "negocio" must still
  yield a single "Registro". Never let a preset hijack an explicit list or the bare fallback.
