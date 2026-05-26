---
name: repo-folder-integration
description: Compare OpenClaw top-level folders with SiraGPT folders and choose safe backend, agents, docs, CI, or infrastructure integration points.
version: 0.1.0
metadata:
  source_inspiration: openclaw/openclaw folder architecture
---

# Repo Folder Integration

Use this when the task asks to review "each folder", compare another product repo, or decide where an external capability belongs in SiraGPT.

## Contract

- Start from folder ownership, not from file names alone.
- Prefer SiraGPT-native surfaces: `.agents`, `backend/src`, `backend/skills`, `scripts`, `docs`, `.github/workflows`, and `infra`.
- Keep UI folders (`app`, `components`, `hooks`, `lib` UI surfaces) unchanged unless the user opens UI scope.
- Add backend or agent contracts before adding visual features.
- Each integration must name the validation command that proves it.

## Folder Map

| OpenClaw Area | SiraGPT Area | Integration Strategy |
|---|---|---|
| `.agents` | `.agents` | Copy upstream snapshots separately, rewrite active SiraGPT skills. |
| `.github` | `.github/workflows` | Reuse CI ideas only after matching current required checks. |
| `.vscode` | `.vscode` | Add developer ergonomics only if non-invasive. |
| `apps` | `app`, `android`, `ios`, `extension` | Treat as product surface; avoid unless UI/product scope is explicit. |
| `docs` | `docs`, `.agents/skills/technical-docs` | Convert into SiraGPT runbooks and operating contracts. |
| `extensions` | `backend/src/services`, `infra`, `extension` | Adapt provider/channel patterns behind backend contracts. |
| `packages` | `backend/src`, `lib`, `scripts` | Pull reusable internal utilities only with tests. |
| `qa`, `test` | `backend/tests`, `e2e`, `scripts` | Convert proof lanes into focused SiraGPT test commands. |
| `scripts` | `scripts`, `backend/scripts` | Port small deterministic tools with idempotent CLIs. |
| `security` | `docs/legal`, `scripts`, `.github/workflows` | Preserve threat model and secret handling guardrails. |
| `src` | `backend/src` | Integrate runtime ideas through SiraGPT services and tests. |
| `ui` | `app`, `components` | Protected by UI lock by default. |

## Validation

```bash
npm run agent:openclaw:map -- --json
npm run skill:validate:agents
git diff --check
bash scripts/verify-ui-lock.sh
```
