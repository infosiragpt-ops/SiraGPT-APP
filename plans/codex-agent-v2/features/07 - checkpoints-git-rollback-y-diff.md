# Feature 07 — Checkpoints git, rollback y diff

**Fase:** F3 · **Depende de:** 02, 05, 06 · **Spec:** `docs/codex-agent-ux.md` §2.1, §6

## Descripción

Cada build que toca archivos termina en un **commit git real** en el workspace — el dato detrás de la tarjeta "Checkpoint made X ago" y sus tres acciones: *Rollback here* (hard reset confirmado), *Changes* (diff) y *View preview*. Reutiliza `gitCommitAll` de la feature 03 y el `exec` del runner (git ya está en la allowlist).

## Requisitos

1. **Creación de checkpoint** (`codex/checkpoint-service.js`): al cierre exitoso de un build con cambios (`git status --porcelain` no vacío), commit con **título descriptivo estilo commit generado por el agente** (pedido al LLM al final del loop; fallback determinista "feat(codex): cambios de la corrida <id-corto>" si el LLM no lo da). Persiste `CodexCheckpoint { runId, projectId, commitSha, title }` y emite `checkpoint_created`. Sin cambios → sin checkpoint (la tarjeta no aparece).
2. **Rollback:** `POST /api/codex/checkpoints/:id/rollback` (auth + ownership). Secuencia transaccional sobre el runner: stop dev server (si corre) → `git reset --hard <sha>` → si el lockfile cambió entre HEAD previo y el sha (`git diff --name-only`), reinstalar al próximo start (el `bun install` de `/run` lo cubre) → restart del dev server solo si estaba corriendo. La **confirmación es responsabilidad de la UI** (feature 11); el endpoint es idempotente (rollback al sha actual → no-op ok). Tras el rollback se registra un evento `run_status` informativo en la última corrida o un campo `rolledBackTo` en el proyecto — decidir en el plan TDD y documentar.
3. **Diff de un checkpoint:** `GET /api/codex/checkpoints/:id/diff` → `git diff <sha>^..<sha>` (cap 500KB con marcador de truncado) + `--shortstat` parseado `{ additions, deletions, filesChanged }`. Primer commit del repo (sin padre) → diff contra el árbol vacío (`git show`).
4. **Listado:** `GET /api/codex/projects/:id/checkpoints` orden createdAt desc, con título, sha corto, fecha y métricas del shortstat.
5. **Seguridad:** sha validado `/^[0-9a-f]{7,40}$/` antes de interpolarse en comandos; todos los git corren vía `exec` del runner con la identidad fija de la feature 03.

## Pasos técnicos

1. `checkpoint-service.js` TDD con runner falso: crear (con/sin cambios), título fallback, rollback (secuencia exacta de comandos verificada por el fake), diff (normal, primer commit, truncado).
2. Generación del título en el cierre del loop (feature 06): una llamada corta extra al LLM con el diffstat como contexto; test con LLM falso.
3. Rutas + contract tests (ownership, sha inválido 400, rollback de checkpoint ajeno 404).
4. Test de integración con **git real en repo temporal** (tmpdir + runner-client falso que ejecuta localmente `node:child_process`): commit → rollback → archivos restaurados byte a byte.
5. Gates + commits + push.

## Criterios de aceptación

- [ ] Build con cambios produce commit real + fila + evento; build sin cambios no produce checkpoint.
- [ ] Rollback restaura el workspace exactamente al estado del commit (verificado con git real en tmp) y reinicia el dev server solo si estaba corriendo.
- [ ] Diff devuelve unified diff + shortstat correcto; el primer checkpoint del repo no rompe.
- [ ] Sha malformado → 400 sin tocar el runner.
- [ ] Checkpoints de proyectos ajenos → 404.
- [ ] Suite completa + lint + CI verdes.
