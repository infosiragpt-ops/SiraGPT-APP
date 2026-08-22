# SIRA Document Intelligence Engine — SDIE v2

Phase 1 of the document-understanding path used by `/chat` and `/code`.

## Why

A user uploaded `Formato_para_el_articulo_de_revision_narrativa….docx` and asked «dame un resumen en un solo párrafo». The assistant returned the document title plus editorial fragments such as:

- «Incluir la imagen del reporte de similitud con el porcentaje…»
- «Matriz de sistematización de los treinta estudios incluidos.»

Root cause: **top-k RAG + free-form LLM**. Template instructions inside the file scored as “relevant chunks” and were echoed instead of a full-document synthesis.

## Flag

| Variable | Default | Effect |
|----------|---------|--------|
| `FEATURE_SDIE_V2` | on (`1`) | Document+summary turns on `/chat` and `/code` compile a `RequestSpec` and skip top-k RAG. Set `0`/`false`/`off` to restore the generic path. |
| `FEATURE_DOC_ENGINE` | on | Existing OOXML / `transformToTemplate` / source-preserving Word edit path. **SDIE never claims these turns.** |
| `SDIE_DEEPSEEK_MODEL` | `deepseek-v4-flash` | DeepSeek V4 Flash or Pro only. |
| `SDIE_LLM_TIMEOUT_MS` | `45000` | Per-call timeout for SDIE generation. |

Models: **DeepSeek V4 Flash / Pro only**. OpenRouter is rejected.

## Pipeline

1. **Intent compiler** (`backend/src/services/sdie/request-spec.js`)  
   User prompt → `RequestSpec`:
   - `intent` (`summarize` / `analyze` / `extract` / `edit` / `deliverable` / `other`)
   - `scope.coverage` (`full` for summaries)
   - `output.paragraphs` / `headings` / `bullets` / `language`
   - `grounding.untrustedDocument: true`  
   Detects «un solo párrafo», «resumen», «in one paragraph», «en N párrafos».  
   Document text is **untrusted** and is never compiled as instructions.

2. **Planner** (`planner.js`)  
   `summarize_full` ⇒ **no top-k**. Walk every heading/section, compress each to notes, then one hierarchical draft.

3. **Extractors**  
   Reuse `fileProcessor` DOCX/PDF extracts (mammoth HTML→markdown, PDF streaming). Prefer full text + headings. Editorial/template lines are tagged and excluded from summary evidence by default.

4. **Generate + validate**  
   DeepSeek V4 Flash/Pro under the `RequestSpec`. Deterministic validators:
   - exact paragraph count
   - no headings/bullets when forbidden
   - reject editorial contamination  
   Repair ≤ 3. Only an **approved plain answer** is streamed to the user. If generation fails, the generic path continues **without** top-k RAG for `summarize_full`.

5. **Wiring**  
   - `POST /api/ai/generate` (used by `/chat` and `/code`) short-circuits before operational RAG / agentic chat.  
   - `agentic-chat-stream` runs SDIE only after the source-preserving OOXML preloop has declined the turn.  
   Edit / “hazme un Word” / agent-runner create turns stay on `FEATURE_DOC_ENGINE`.

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

Success criterion: «dame un resumen en un solo párrafo» yields **one synthesizing paragraph**, not title/editorial fragments.
