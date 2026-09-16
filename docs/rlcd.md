# RLCD — Reinforcement Learning for Calibrated Decisions

Inspirado en el método RLCD de TypeSafe AI (modelo Jev): un sistema que no
solo decide sino que devuelve una **probabilidad calibrada** de que la
decisión sea correcta, y se entrena para que esa probabilidad coincida con
la frecuencia real de acierto. En SiraGPT lo aplicamos a las decisiones
tipadas que ya toma cada turno de `/api/ai/generate`:

| Decisión (`kind`) | Elección (`choice`) | Confianza declarada |
|-------------------|---------------------|---------------------|
| `intent_triage` | `execute` / `ask` | `1 − ambiguity_score` para execute, `ambiguity_score` para ask |
| `execution_lane` | `agentic` / `plain` | `detectCodeTaskIntent().confidence` (o su complemento) |
| `model_route` | modelo seleccionado | `routing.recommendedScore` |
| `compute_mode` | `direct` / `extended` / … | distancia de `difficulty.score` a los umbrales 0.35 / 0.65 |

Hasta ahora ninguna de esas confianzas se comprobaba contra el resultado del
turno. El módulo `backend/src/services/rlcd/`:

1. **Registra** cada decisión con su confianza (`decision-ledger.recordDecision`)
   en el punto donde nacen (`routes/ai.js`, tras las métricas cognitivas y en
   la decisión del carril agéntico). Los ids viajan en `req._rlcdDecisionIds`
   y se persisten en `messages.metadata.rlcd.decisions`; al persistir la
   respuesta se unen al `messageId` (`bindMessage`).
2. **Une resultados** (ground truth) a esas decisiones:
   - 👍 / 👎 (`POST /chats/messages/:id/feedback` → `recordThumb`) por messageId;
   - «Regenerar» → `regenerated` para el último turno del chat;
   - fallo de proveedor / corte TTFB (`onProviderFailure`) → `provider_failure` / `ttfb_abort`;
   - nota de fidelidad A/B → `high_faithfulness`, D/F → `low_faithfulness`;
   - restricción incumplida → `constraint_violation`.
   Una señal posterior sustituye a la anterior (un 👍 tras un fallo implícito
   no cuenta dos veces).
3. **Calibra**: 10 bins de confianza por `kind` con `n`, confianza media,
   aciertos y Brier acumulado → `ECE`, `Brier`, precisión observada por bin.
   `calibrated(kind, conf)` devuelve la probabilidad calibrada: encoge la
   tasa observada del bin hacia la confianza cruda con `PRIOR_WEIGHT` (5)
   pseudo-muestras, así sin datos devuelve la cruda y converge a la observada.
4. **Actúa**: la decisión del carril de ejecución. Si las heurísticas (regex
   `AGENTIC_PROMPT_HINT`, edición de documento…) dicen «chat plano» pero el
   turno es una tarea de código, el bucle agéntico se fuerza cuando
   `calibrated('execution_lane', codeConfidence) ≥ SIRAGPT_RLCD_LANE_THRESHOLD`
   (0.6). Si esos turnos forzados acaban en 👎 / fallos, la probabilidad
   calibrada baja y deja de forzar sola.

## Telemetría

- `GET /api/rlcd/stats` (autenticado): `enabled`, `laneSteering`,
  `laneThreshold`, `decisions`, `outcomes`, `reliability[{kind, samples, ece,
  brier, accuracy}]`. Admin además: `reliabilityBins` (por bin), `byKind`,
  `byOutcome`, `lane {consulted, forced}`, `outcomesUnmatched`.
- `/metrics`: `sira_rlcd_decisions_total`, `sira_rlcd_decisions_kind`,
  `sira_rlcd_outcomes_total`, `sira_rlcd_outcomes_unmatched_total`,
  `sira_rlcd_outcome_label`, `sira_rlcd_lane_consulted_total`,
  `sira_rlcd_lane_forced_total`, `sira_rlcd_ece`, `sira_rlcd_brier`,
  `sira_rlcd_accuracy` (gauges por `kind`).
- Logger privado de generate: `rlcd.decisions_recorded`, `rlcd.lane_decided`.

## Flags

| Env | Default | Efecto |
|-----|---------|--------|
| `SIRAGPT_RLCD_ENABLED` | on | Registro + unión de resultados. `0/false/off` apaga **el ledger** (no el slice documental) |
| `SIRAGPT_RLCD_LANE_STEERING` | on | Uso activo en el carril de ejecución |
| `SIRAGPT_RLCD_LANE_THRESHOLD` | 0.6 | Probabilidad calibrada mínima para forzar el bucle agéntico |
| `SIRAGPT_RLCD_MIN_BIN_SAMPLES` | 5 | Muestras para marcar un bin como fiable en el informe |
| `SIRAGPT_RLCD_PRIOR_WEIGHT` | 5 | Pseudo-muestras del encogimiento hacia la confianza cruda |
| `SIRAGPT_RLCD_MAX_DECISIONS` | 20000 | Tope de decisiones en memoria (FIFO) |

Otra superficie, **independiente**: análisis documental (`SIRAGPT_RLCD_DOCUMENTS`,
default off) — trailer de confianza, evidencia (extracto/RAG/citas), claims
supported/inferred, defer, Brier/ECE sobre 👍/👎 de documentos. Ver
`docs/rlhf-rlcd-documents.md`. `GET /api/rlcd/stats` incluye `documents`
con ese snapshot (phase 2: `byBin`, `overconfidenceRate`, `claimSupportRate`);
`GET /api/rlhf/stats` → `rlcd` es solo el slice documental. Export
contrastivo: `GET /api/rlhf/export?format=rlcd`.

Estado en memoria (como `routing-feedback`); `snapshot()/load()` permiten
persistirlo. Las decisiones también quedan en `messages.metadata.rlcd`, así
que un backfill futuro puede reconstruir los bins desde la base de datos.

Además este lote arregla un hueco del puente RLHF: `routing-bridge.extractModel`
leía `metadata.model`, que no existía (vivía en `generationUsage.model`), por
lo que ningún 👍/👎 llegaba a `routing-feedback`. Ahora `metadata.model` se
guarda en el nivel superior.

## Verificar

```bash
cd backend
node --test tests/rlcd-decision-ledger.test.js tests/metrics-route.test.js
```
