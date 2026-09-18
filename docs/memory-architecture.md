# Memoria estilo Claude Code — arquitectura (2026-09-18)

```
Usuario → Agente ⇄ memoria: índice siempre cargado + temas a demanda
                 ⇄ búsqueda agéntica: grep, chats pasados (RAG vectorial solo si el corpus no cabe)
                 ⇄ subagentes en paralelo con memoria compartida
        → respuesta + escritura de memoria en la misma conversación
Entre sesiones:  consolidación («dreaming») → memoria reorganizada y revisable
Sesiones largas: compactación de contexto → lo importante pasa a memoria
```

## Piezas

| Pieza | Archivo | Qué hace |
|---|---|---|
| Vault (canónico) | `backend/src/services/memory/vault.js` | Una sola memoria por usuario sobre la tabla existente `user_memories` (sin migración). `category` = tema (`personal, preference, work, project, people, decision, tool, instruction, knowledge`). Escrituras guardadas (≤400 chars, sin secretos, ventana 60/10 min), dedupe por hash de contenido (repetir un hecho lo refuerza), fallo suave siempre. |
| Índice siempre cargado | `vault.buildIndexBlock(userId)` → `routes/ai.js` (bloque `memory`) | Temas con conteo + las 12 entradas más importantes (≤1800 chars) + cómo abrir más. Sustituye al documento en disco (`memory-document`), que se importa una vez al vault si este está vacío. |
| Temas a demanda | tool `memory_read_topic` | Abre un tema completo cuando el índice lo menciona. |
| Búsqueda agéntica | tools `memory_search`, `chat_history_search` | `memory_search`: grep léxico (acentos/mayúsculas plegados) sobre toda la memoria; el peldaño vectorial (`long-term-memory.recallFacts`) solo se suma cuando el corpus supera `SIRAGPT_MEMORY_GREP_MAX_CHARS` (24k). `chat_history_search`: FTS Postgres (`content_tsv`) sobre los chats anteriores del usuario (`memory/chat-history-search.js`), con fallback ILIKE. |
| Escritura en la misma conversación | tools `memory_write`, `memory_forget`; extractor `long-term-memory.extractFactsAsync` → `vault.recordFacts` | El modelo guarda hechos duraderos de forma deliberada; el extractor automático sigue funcionando y ahora aterriza en el vault (`source: auto`). |
| Subagentes con memoria compartida | `codex/agent-sdk/index.js` `sharedMemoryIndex` + `build-tools.js` (`userId` en deps) | Cada especialista recibe el mismo índice; como el vault es Postgres, lo que uno escribe lo ven los demás. |
| Compactación → memoria | `conversation-compactor.scheduleMemoryExtraction` | Al plegar turnos antiguos, los hechos duraderos del transcript plegado se extraen (LLM del ladder de memoria) y se guardan con `source: compaction:<chatId>`. `SIRAGPT_COMPACTION_MEMORY=0` lo apaga. |
| Consolidación («dreaming») | `memory/consolidation.js`, job `jobs/memory-consolidation.js`, cron `memory-consolidation` (`SIRAGPT_MEMORY_CONSOLIDATION_CRON`, 03:17 UTC) | Para cada usuario con cambios desde su último pase: el LLM propone fusiones/contradicciones (gana la más reciente)/re-clasificación/descartes; la propuesta se valida **fail-closed** (cada id exactamente una vez, sin crecer, sin texto fuera de rango, ≤40 % descartes) y se aplica en transacción. Informe revisable con snapshot (últimos 5 en `system_settings` `memory.consolidation.<userId>`), reversible. |
| Superficie de revisión | `GET/POST /api/memory/consolidation[/run|/:id/revert]`, `components/settings/MemorySettingsCard.tsx` | «Consolidar ahora», qué se fusionó/descartó/reordenó, «Deshacer». Nuevos temas visibles con etiqueta de origen (aprendido / guardado en chat / rescatado al compactar / consolidado). |

## Rutas
`GET /api/memory` (entradas + markdown + stats) · `GET /api/memory/index` (el bloque tal cual lo ve el modelo) · `GET /api/memory/topics/:topic` · `GET /api/memory/search?q=` · `POST/PATCH/DELETE /api/memory[/:id]` · `GET /api/memory/consolidation` · `POST /api/memory/consolidation/run` · `POST /api/memory/consolidation/:id/revert`.

## Variables
`SIRAGPT_MEMORY_GREP_MAX_CHARS` (24000) · `SIRAGPT_MEMORY_CONSOLIDATION` (`0` apaga) · `SIRAGPT_MEMORY_CONSOLIDATION_CRON` (`17 3 * * *`) · `SIRAGPT_MEMORY_CONSOLIDATION_BATCH` (50) · `SIRAGPT_COMPACTION_MEMORY` (`0` apaga) · `SIRAGPT_MEMORY_LLM_MODEL` (modelo del ladder de memoria).

## Tests
`backend/tests/memory-vault.test.js` · `memory-consolidation.test.js` · `memory-tools.test.js` · `chat-history-search.test.js` (Prisma falso en `tests/helpers/fake-memory-prisma.js`).

## Lo que NO cambia
`user_memories` y `system_settings` ya existen en producción (verificado), así que la publicación es automática. Los sinks anteriores (`memory-document` en disco, pgvector store, RAG de long-term-memory, Hermes) siguen escribiendo; el vault es la vista canónica que el modelo y el usuario ven.
