# Coding IDE shell on `/agentes` (AGENTES_CODING_V2 Phase 3a)

Flag-gated editor chrome **inside** the canonical `/agentes` surface.
Default **OFF**. This is not a `/code` revival, not F7 / SiraComputer,
and not an xterm.js vendor yet.

Phase 2 session adapter:
[`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).
Architecture:
[`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §7.

## What this PR adds

| Piece | Path |
|---|---|
| Health hook | `lib/agentes-coding/health.ts` — starts `enabled:false` |
| API client | `lib/agentes-coding/api.ts` — `createSession` / `listFiles` / `readFile` / `writeFile` / `exec` / `repoMap` (Phase 3b) |
| Gate | `components/agentes/coding-ide-gate.tsx` — render `null` unless `health.enabled === true` |
| Shell | `components/agentes/coding-ide-shell.tsx` — file tree, Monaco, diff, terminal stub |

The client **only** reads `GET /api/agentes-coding/health`. It does not
read `AGENTES_CODING_V2` or any `NEXT_PUBLIC_*` flag. Failed probes stay
off. First paint of `/agentes` is unchanged while the flag is off.

## Panes

- **Archivos** — simple tree from `listFiles`. Optional **Mapa** calls
  `GET /sessions/:id/map` (Phase 3b) and lists ranked file hints.
- **Editor** — existing `@monaco-editor/react` wrapper (`monaco-code-area`)
- **Diferencias** — Monaco `DiffEditor` (lado a lado / unificado)
- **Terminal** — WebSocket-ready stub (`data-ws-ready`); `exec` via HTTP

Spanish labels. No vendor / `model_id` strings.

## Out of scope

OpenSandbox K8s pool, enabling the flag on Lenovo, Daytona, cloning
repos, F7 rewrite, adding `xterm` as a new npm dependency.

## Tests

```bash
node --test tests/agentes-coding-ide-source.test.ts
npx vitest run tests/lib/agentes-coding-api.test.ts tests/lib/agentes-coding-file-tree.test.ts tests/components/agentes-coding-ide-gate.test.tsx --pool=threads
cd backend && node --test tests/agentes-coding-flags.test.js tests/agentes-coding-sandbox.test.js tests/agentes-coding-repo-map.test.js
```
