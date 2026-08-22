# SIRA Document Intelligence Engine — SDIE v2

Phase 1 of the document-understanding path used by `/chat` and `/code`.

## Why

A user uploaded `Formato_para_el_articulo_de_revision_narrativa….docx` and asked «dame un resumen en un solo párrafo». The assistant returned the document title plus editorial fragments such as:

- «Incluir la imagen del reporte de similitud con el porcentaje…»
- «Matriz de sistematización de los treinta estudios incluidos.»

Root cause on the live VPS: **top-k `documentIntelligence.retrieveEvidence`**, not the OOXML edit slot.

Live path today:

1. Extract: `POST /api/files/upload` → `fileProcessor.processFile` / `processWord` (mammoth; Docling/MarkItDown when available).
2. `POST /api/ai/generate` (`/chat` and `/code`; `/code` sets `disableAgentic: true`).
3. File context: `chat-attachment-recovery.buildChatUploadedFileContext` → `message-attachments.buildUploadedFileContext`.
4. `isDeepDocumentQuestion` matches «resumen» → `retrieveRelevantEvidence` (`evidenceLimit` 16–18) → `retrieveEvidence` (`topK` 3–8).
5. Operational RAG (`DEFAULT_RETRIEVAL_K=8`) may also run.
6. Summaries use the **plain** stream (`shouldUseAgenticChat` skips them). `/code` never enters `agentic-chat-stream`.

Template instructions scored as “relevant chunks” and were echoed instead of a full-document synthesis.

## Flag

Mirror live `FEATURE_*` style (`FEATURE_DOC_ENGINE=1`, `deployments/flags.js`): `1` / `true` / `on`.

| Variable | Default | Effect |
|----------|---------|--------|
| `FEATURE_SDIE_V2` | on when unset (pin `1` in prod like `FEATURE_DOC_ENGINE`) | Document+summary turns compile a `RequestSpec` and bypass `retrieveEvidence`. Set `0`/`false`/`off` to restore the generic path. |
| `FEATURE_DOC_ENGINE` | on (`1` live) | Existing OOXML / `transformToTemplate` / source-preserving Word edit path. **SDIE never claims these turns.** |
| `SDIE_DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek V4 Flash or Pro only. |
| `SDIE_LLM_TIMEOUT_MS` | `45000` | Per-call timeout for SDIE generation. |

Models: **DeepSeek V4 Flash / Pro only**. OpenRouter is rejected.

Live inventory at Phase 1: `FEATURE_DOC_ENGINE=1`; no `FEATURE_SDIE*` yet. Unset `FEATURE_SDIE_V2` still enables the engine so the screenshot regression is fixed on deploy.

## Pipeline

1. **Intent compiler** (`backend/src/services/sdie/request-spec.js`)  
   User prompt → `RequestSpec`:
   - `intent` (`summarize` / `analyze` / `extract` / `edit` / `deliverable` / `other`)
   - `scope.coverage` (`full` for summaries)
   - `output.paragraphs` / `headings` / `bullets` / `language`
   - `grounding.untrustedDocument: true`  
   Detects «un solo párrafo», «resumen», «in one paragraph», «en N párrafos».  
   Document text is **untrusted** and is never compiled as instructions.

2. **`summarize_full` bypasses `retrieveEvidence`**  
   When `RequestSpec.strategy === 'summarize_full'` or `scope.coverage === 'full'`, `buildUploadedFileContext` does **not** call `retrieveRelevantEvidence` / `documentIntelligence.retrieveEvidence`. It uses the full extract (headings + body) and skips first-chunk analysis snippets. Operational RAG (`DEFAULT_RETRIEVAL_K=8`) is left running; SDIE does not steal that slot.

3. **Planner** (`planner.js`)  
   `summarize_full` ⇒ **no top-k**. Walk every heading/section, compress each to notes, then one hierarchical draft. Editorial/template lines are tagged and excluded.

4. **Extractors**  
   Reuse already-extracted `fileProcessor` text on the file row (mammoth / Docling / MarkItDown). Prefer full text + headings.

5. **Generate + validate**  
   DeepSeek V4 Flash/Pro under the `RequestSpec`. Deterministic validators:
   - exact paragraph count
   - no headings/bullets when forbidden
   - reject editorial contamination  
   Repair ≤ 3. Only an **approved plain answer** is streamed. If generation fails, the generic path continues with the full-document excerpt (still no `retrieveEvidence`).

6. **Wiring (only insert)**  
   `POST /api/ai/generate` — **after** file context + RAG + enrichment, **before** the agentic gate / `generateStream`.  
   This is the path both `/chat` and `/code` use.  
   **Do not** put SDIE only in the source-preserving / `FEATURE_DOC_ENGINE` edit slot (`agentic-chat-stream`): that chat-bridge is not wired for resumen, and `/code` sets `disableAgentic: true`.

## RequestSpec (Phase 1)

```json
{
  "version": 2,
  "intent": "summarize",
  "strategy": "summarize_full",
  "scope": { "coverage": "full", "excludeEditorial": true },
  "output": { "paragraphs": 1, "headings": false, "bullets": false, "language": "es" },
  "grounding": { "source": "document", "untrustedDocument": true, "allowInvention": false }
}
```

## Tests

- `backend/tests/sdie-v2-phase1.test.js` (node:test, CI backend shards)
- `tests/lib/sdie/sdie-v2-phase1.test.ts` (Vitest)
- Fixture: `backend/tests/fixtures/sdie-narrative-review-template.txt` mimics the screenshot document.

Success criterion: «dame un resumen en un solo párrafo» yields **one synthesizing paragraph**, not title/editorial fragments, on both `/chat` and `/code`.
