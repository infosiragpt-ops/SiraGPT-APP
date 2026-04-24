# Document Chat Integration Report

Generated: 2026-04-24

## Executive Summary

The document generation pipeline is now integrated into the chat logic without adding UI surface area. The chat sends the user's clean prompt to `/api/doc/generate`, while the backend applies the multi-agent document pipeline internally.

This fixes the previous class of bugs where internal execution contracts could appear in the chat or contaminate generated document titles/content.

The compound `agent_task` path now also validates files generated through its `create_document` tool before registering artifacts. This covers prompts such as "investiga y entrégame un Excel/Word/PPT/PDF", which route through the autonomous agent instead of the lightweight document endpoint.

## Implemented Flow

1. Chat receives the user's message.
2. Intent classifier routes simple downloadable document requests to `doc`.
3. `buildDocumentChatRequest` derives format, template and complexity from the clean user prompt.
4. Chat sends `prompt`, `displayPrompt`, `format`, `template`, `complexity` and optional attached `files` to `/api/doc/generate`.
5. Backend verifies attached file ownership, loads extracted text metadata, and passes references to the document pipeline.
6. Pipeline generates the real file, validates it, scores it, repairs if needed, writes telemetry, and streams the final artifact.
7. Frontend receives the same `doc` artifact contract with `dataUrl`, filename, mime, size and metrics for preview/download.

## Compound Agent Task Flow

1. Chat routes research/data-processing plus downloadable-file requests to `agent_task`.
2. The task agent calls `create_document` after collecting or processing evidence.
3. `create_document` executes the generated Python script in the sandbox.
4. The resulting artifact is validated with the same document validation layer before artifact registration.
5. Invalid files are blocked and returned as tool failures, forcing the agent to regenerate.
6. Valid files store owner-scoped artifact metadata plus technical/quality scores.
7. `verify_artifact` now returns the stored validation summary so the agent can supervise row counts, sheets, slides, paragraphs and integrity with metrics.

## Files Changed

| File | Purpose |
|---|---|
| `lib/document-chat-request.ts` | Pure chat request builder for clean prompt, format, template, complexity and file ids. |
| `lib/chat-context-integrated.tsx` | Uses the clean document request builder for doc intent instead of sending internal contracts. |
| `lib/api.ts` | Extends `generateDocStream` typing with document pipeline parameters. |
| `backend/src/routes/doc.js` | Accepts document params and attached file ids, verifies ownership, and passes reference metadata to the pipeline. |
| `backend/src/services/document-pipeline/advanced-document-pipeline.js` | Incorporates reference-file metadata/excerpts into generated documents while scrubbing telemetry excerpts. |
| `backend/src/services/agents/task-tools.js` | Validates `agent_task` create_document artifacts before registration and exposes metrics to verify_artifact. |
| `tests/document-chat-request.test.ts` | Verifies clean prompt behavior and format/template/complexity detection. |
| `backend/tests/document-pipeline-chat-contract.test.js` | Verifies no contract leakage in SSE output and safe reference telemetry behavior. |
| `backend/tests/agent-task-artifacts.test.js` | Verifies agent artifact ownership, validation metrics, artifact ids and invalid-artifact blocking. |

## Verification Commands Executed

```bash
node -c backend/src/services/document-pipeline/advanced-document-pipeline.js
node -c backend/src/routes/doc.js
node -c backend/src/services/agents/task-tools.js
node --test backend/tests/agent-task-artifacts.test.js backend/tests/document-pipeline-chat-contract.test.js
rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test .test-dist/tests/document-chat-request.test.js .test-dist/tests/ai-service-intent.test.js .test-dist/tests/agent-task-service.test.js
node --test backend/tests/document-pipeline-100.test.js
npx tsc --noEmit --pretty false
rm -rf .next && npm run build
```

## Results

| Check | Result |
|---|---|
| Backend syntax check | PASS |
| Route syntax check | PASS |
| Agent task tool syntax check | PASS |
| Agent task artifact validation tests | 4/4 PASS |
| Contract leakage tests | 2/2 PASS |
| Chat request + intent + agent reducer tests | 27/27 PASS |
| Document generation matrix | 100/100 PASS |
| TypeScript | PASS |
| Next production build | PASS |
| `GET /health` | 200 |
| `GET /chat` | 200 |
| `GET /projects` | 200 |
| `POST /api/auth/login` with `admin@example.com/password` | 200 |
| `POST /api/doc/generate` with `Creame en un word un chiste` | 200, DOCX, technical 100, quality 100, NO_LEAK |
| Upload text reference + `POST /api/doc/generate` with `files` | Upload 200, doc 200, DOCX, technical 100, quality 100 |

## Security And Telemetry

- The backend resolves attached file ids only for the authenticated user.
- Unknown or unauthorized file ids are ignored instead of being loaded.
- Reference excerpts can influence the generated document, but telemetry stores only metadata and extracted character counts, not raw excerpts.
- The chat-visible response and generated filenames were verified not to contain `siraGPT professional execution contract` or `Generate a polished downloadable file`.
- Agent-task artifacts are scoped by owner/chat and `create_document` refuses to register invalid files.
- Artifact metadata stores validation summaries so downloads remain auditable without re-opening every file.

## Remaining Risk

This update validates chat-to-document generation and attached-file metadata handling. For academic tasks requiring real DOI/source verification, the upstream research/agent pipeline must still collect and verify evidence before requesting final document generation.
