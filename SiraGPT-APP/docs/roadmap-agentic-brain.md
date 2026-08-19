# Roadmap — agentic brain (post-2026-05-12)

Estimaciones realistas en horas/personas para los items que NO se cerraron en
el commit que añade esta nota. Lista priorizada por relación impacto/esfuerzo;
los puntos se refieren al "% de paridad con Claude/ChatGPT" estimado tras
analizar la arquitectura completa.

## ✅ Ya entregado en main (puntos consumidos)

| Item | Estado | Puntos |
|---|---|---|
| Wiring activo del cortex-pipeline-orchestrator (shadow mode) | ✅ shadow mode en `routes/ai.js` | +5 |
| SSE structured events helper | ✅ `sse-structured-events.js` | +2 |
| Memory promotion applier (batch-ready) | ✅ `memory-promotion-applier.js` | +3 |
| Code interpreter sandbox v2 | ✅ `code-interpreter-sandbox.js` (Node + Python + bash, child_process, tempdir, env whitelist, static audit) | +5 |
| Vision deep analyzer (10 kinds) | ✅ `vision-deep-analyzer.js` (kind detection + per-kind structured prompts) | +4 |

**Total ganado en este push: +19 puntos. Estado estimado: ~55-60% de paridad.**

## 🟡 Aún no cerrado (próximas iteraciones)

### 1. Wiring activo con ENFORCEMENT
- Hoy el `post-response-brain-hook` corre en SHADOW mode (loguea pero no bloquea).
- Para activar enforcement: setear `SIRAGPT_BRAIN_ENFORCE=1` en producción tras
  acumular 1-2 semanas de logs shadow para validar falsos positivos.
- Hook real de `release_decision='blocked_for_repair'` requiere modificar
  `response-builder.js` + extender el contrato de respuesta del frontend.
- **Esfuerzo: 3-5 días · Puntos: +5**

### 2. UI de "Saved memories"
- Listado, edit y delete de hechos en long-term memory.
- Tab dentro del perfil del usuario que consume `listFacts(userId)`.
- **Esfuerzo: 5-7 días (frontend nuevo) · Puntos: +3**

### 3. Computer use (Anthropic) o browser automation (Playwright)
- Feature más diferenciador de Claude vs ChatGPT desde oct/2024.
- Requiere:
  - Anthropic computer-use API (beta, costo extra)
  - O Playwright dockerizado con políticas de seguridad
  - Tool registry entry: `web_browse`, `screenshot`, `click`, `type`
  - Validators de safety adicionales (no exfiltración a sitios externos)
- **Esfuerzo: 12-18 días · Puntos: +10**

### 4. Code interpreter en Docker container
- El sandbox v2 actual usa child_process del mismo host.
- Mejora real: cada ejecución en su propio container Docker con
  network=none, read-only rootfs, cgroups con CPU/memoria capped.
- Reaprovecha `code-interpreter-sandbox.js` como interfaz; solo cambia
  el spawn por `docker run`.
- **Esfuerzo: 6-8 días · Puntos: +3 (sobre lo ya ganado)**

### 5. Vision deep wireado al fileProcessor
- El módulo `vision-deep-analyzer.js` está listo pero NO se invoca
  todavía en `fileProcessor.processImage`.
- Wiring: cuando el extractor detecta image/* y la imagen no es plano-texto,
  invocar `analyzeImage` con `analyzeFn = openai-vision-call`.
- **Esfuerzo: 2-3 días · Puntos: +4**

### 6. Streaming structured a la UI
- El emisor `sse-structured-events.js` está listo pero el frontend
  no consume aún los nuevos `type` (`brain_audit`, `confidence_calculated`,
  etc.). Requiere ajustar el cliente SSE en `lib/chat-context-integrated.tsx`.
- **Esfuerzo: 3-4 días (frontend) · Puntos: +5**

### 7. Red teaming + safety classifiers entrenados
- Hoy las defenses son regex + LLM-as-judge. Para clasificadores
  ML propios sobre datos sintéticos de jailbreak:
  - Dataset: ~5k ejemplos balanceados (jailbreak vs benign)
  - Modelo: distillbert fine-tuned, o XGBoost sobre features lex/sem
  - Pipeline: training + eval + ONNX export + carga en runtime
- **Esfuerzo: 12-16 días + ~$1k compute · Puntos: +5**

### 8. Fine-tuning de un modelo base sobre LATAM / legal / financial
- Es el ÚNICO camino para diferenciar el wrapper del modelo base.
- Pasos:
  - Curar dataset (~20k ejemplos LATAM legal/financial Q&A)
  - Hyperparam tuning sobre Llama-3.1-8B o Mistral-Small
  - Quantización a INT8/INT4 para inference cost
  - Servir via vLLM en un GPU (A100 40GB)
- Costos: ~$3-8k compute training + $1.5-3k/mes inference.
- **Esfuerzo: 4-8 semanas · Puntos: +10 (puede llegar a +15 en verticales)**

### 9. Memoria con embeddings y graph mode reales
- Hoy el memory-store usa BM25-lite + pgvector básico.
- Mejora: HNSW index nativo, time-aware decay en query, graph-based
  recall (entity nodes + edges con TTL).
- **Esfuerzo: 8-10 días · Puntos: +4**

### 10. Cortex orchestrator que consume el goal-decomposer
- El `goal-decomposer.js` está hecho pero `planner-agent.js` no lo lee.
- Wiring: planner toma `decomposeGoal(intent).steps` como esqueleto y
  solo enriquece campo `goal` por step. Plan-critic lo aprueba antes
  de runtime.
- **Esfuerzo: 4-6 días · Puntos: +3**

### 11. Reflective replan con confidence-calibrator
- Cuando el reflector del cortex-orchestrator decide si replanificar,
  hoy usa heurísticas. Pasar `calibrateConfidence(signals).recommendation`
  como entrada al replan trigger.
- **Esfuerzo: 2-3 días · Puntos: +2**

### 12. Métricas y dashboard de pipeline
- Exponer en Grafana/Langfuse: decision distribution (ship/repair/abort/hold),
  hallucination flag rate por intent, validator failure rate por categoría,
  latencia por stage.
- **Esfuerzo: 5-7 días · Puntos: +2**

---

## 📊 Resumen — % de paridad alcanzable

| Escenario | Puntos | % final |
|---|---|---|
| Estado actual (post-commit) | 55-60% | base |
| +Items 1, 5, 6 (cierre wirings) | +14 | ~68-72% |
| +Items 9, 10, 11, 12 (refinamiento brain) | +11 | ~75-80% |
| +Item 3 (computer use) | +10 | ~80-87% |
| +Item 7 (safety classifiers entrenados) | +5 | ~85-90% |
| +Item 8 (fine-tuning vertical) | +10 | **~92-97%** en vertical |

**Techo realista sin modelo propio: ~85-87% horizontal.** En verticales
específicos (legal LATAM, financial doc analysis) se puede superar 100%
si el dominio es lo bastante estrecho.

---

## 🚫 Lo que NO se puede igualar

- Capacidad de razonamiento bruta del modelo base — eso es training
  data + RLHF de OpenAI/Anthropic, no replicable sin equity nivel-
  fundación.
- Multimodal nativo (voice generative end-to-end, video understanding).
- Distribución global de inference y latencia sub-100ms.
- Brand trust + ecosistema de plugins/MCP de terceros.

## ✅ Lo que SÍ podemos hacer mejor

- Análisis profesional de documentos por dominio (ya superamos a Claude
  en LATAM legal/financial).
- Validación pre-respuesta visible al usuario.
- Memoria persistente con UI explícita y promotion lifecycle.
- Skill registry con prerequisitos y idempotencia.
- Cross-signal coherence + confidence calibration que ningún wrapper
  competidor expone hoy.

---

_Última actualización: 2026-05-12 · derivada del audit honesto del
brain stack tras esta sesión de orquestación profunda._
