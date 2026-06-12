# Feature 15 — Integración E2E y hardening

**Fase:** F6 · **Depende de:** todas (01–14) · **Spec:** `docs/codex-agent-ux.md` §11, §12 (F6), §13

## Descripción

El cierre de la iniciativa: el flujo completo del spec verificado por tests de integración deterministas, los riesgos de §13 endurecidos, y la documentación final. Después de esta feature, `CODEX_AGENT_V2=1` es una decisión de despliegue, no de desarrollo.

## Requisitos

1. **Test de integración del flujo completo** (`backend/tests/codex-e2e-flow.test.js`, offline y determinista):
   crear proyecto → describir contexto → corrida plan (`plan_proposed`, `waiting_approval`) → aprobar → corrida build con streaming (narrativa + acciones agrupadas + razonamiento) → `checkpoint_created` → `run_summary` con métricas exactas → rollback → preview/start.
   Dobles: LLM guionizado (fake), runner-client respaldado por **git real en tmpdir** (ejecuta los comandos localmente con `node:child_process` — valida que la secuencia git funciona de verdad), DB falsa o de test, Redis falso (pub/sub en memoria).
2. **Cobertura de render por tipo de evento:** suite vitest que pasa un replay completo grabado (fixture JSON con los 12 tipos) por el reducer + render de items y tarjetas — el "golden file" del protocolo. Cambiar un shape de evento rompe este test a propósito.
3. **Hardening de los riesgos del spec §13:**
   - Worker: límites verificados (concurrencia, timeout duro con job que cuelga → `error` limpio).
   - `codex_events`: verificación del índice en queries de replay (explain o test de volumen razonable, p. ej. 5k eventos < umbral).
   - Reconexión SSE agresiva (drop cada N eventos) sin pérdida ni duplicado — test automatizado.
   - Rollback bajo dev server corriendo — cubierto con git real en tmp.
   - Config: validación al boot de envs incoherentes con flag on (p. ej. `CODE_RUNNER_URL` ausente → warn claro), estilo `attribution-config-validator`.
4. **Smoke manual documentado:** guion paso a paso en `docs/codex-agent-ux.md` (sección nueva "Smoke de release") para validar en local con Docker: levantar perfil opencode, flag on, crear proyecto, plan, build con modelo real barato (FlashGPT), checkpoint, rollback, preview.
5. **Documentación final:** actualizar `docs/codex-agent-ux.md` con lo que difiera de lo implementado (decisiones tomadas en planes TDD de fase), y CLAUDE.md con la sección del subsistema (módulos, rutas, envs, tests) siguiendo el formato de las secciones existentes.
6. **Cero regresiones con flag off:** corrida explícita de la suite completa + arranque del backend con flag off verificando que no se registra worker ni rutas activas (smoke automatizado).

## Pasos técnicos

1. Fixture de replay golden (generada por una corrida guionizada, commiteada como JSON).
2. `codex-e2e-flow.test.js` con los dobles descritos; helpers compartidos en `backend/tests/codex-test-utils.js`.
3. Tests de hardening uno a uno (timeout, reconexión, volumen, config-validator).
4. Smoke manual ejecutado de verdad una vez (con Docker + FlashGPT) y transcrito al doc.
5. Actualización de docs + CLAUDE.md.
6. Gates finales: `npm test` + `npm run lint` + `npx tsc --noEmit --skipLibCheck` + build + CI verde. Push final.

## Criterios de aceptación

- [ ] El test E2E recorre el flujo completo del spec §11 y pasa offline en CI.
- [ ] El golden file de replay cubre los 12 tipos de evento y el render de las 4 tarjetas.
- [ ] Job colgado → `error` por timeout sin zombies; reconexión agresiva sin pérdida/duplicado; replay de 5k eventos dentro del umbral.
- [ ] Backend con flag off: sin worker, rutas 404, suite completa idéntica a main previo a la iniciativa.
- [ ] Smoke manual documentado y ejecutado una vez con modelo real.
- [ ] CLAUDE.md y el spec reflejan el sistema tal como quedó.
- [ ] CI en verde — cierre de la iniciativa.
