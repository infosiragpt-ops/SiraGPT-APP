# Document Chat Integration Report

Generated: 2026-04-24

## Executive Summary

The document generation pipeline is now integrated into the chat logic without adding UI surface area. The chat sends the user's clean prompt to `/api/doc/generate`, while the backend applies the multi-agent document pipeline internally.

This fixes the previous class of bugs where internal execution contracts could appear in the chat or contaminate generated document titles/content.

## Implemented Flow

1. Chat receives the user's message.
2. Intent classifier routes simple downloadable document requests to `doc`.
3. `buildDocumentChatRequest` derives format, template and complexity from the clean user prompt.
4. Chat sends `prompt`, `displayPrompt`, `format`, `template`, `complexity` and optional attached `files` to `/api/doc/generate`.
5. Backend verifies attached file ownership, loads extracted text metadata, and passes references to the document pipeline.
6. Pipeline generates the real file, validates it, scores it, repairs if needed, writes telemetry, and streams the final artifact.
7. Frontend receives the same `doc` artifact contract with `dataUrl`, filename, mime, size and metrics for preview/download.

## Files Changed

| File | Purpose |
|---|---|
| `lib/document-chat-request.ts` | Pure chat request builder for clean prompt, format, template, complexity and file ids. |
| `lib/chat-context-integrated.tsx` | Uses the clean document request builder for doc intent instead of sending internal contracts. |
| `lib/api.ts` | Extends `generateDocStream` typing with document pipeline parameters. |
| `backend/src/routes/doc.js` | Accepts document params and attached file ids, verifies ownership, and passes reference metadata to the pipeline. |
| `backend/src/services/document-pipeline/advanced-document-pipeline.js` | Incorporates reference-file metadata/excerpts into generated documents while scrubbing telemetry excerpts. |
| `tests/document-chat-request.test.ts` | Verifies clean prompt behavior and format/template/complexity detection. |
| `backend/tests/document-pipeline-chat-contract.test.js` | Verifies no contract leakage in SSE output and safe reference telemetry behavior. |

## Verification Commands Executed

```bash
node -c backend/src/services/document-pipeline/advanced-document-pipeline.js
node -c backend/src/routes/doc.js
node --test backend/tests/document-pipeline-chat-contract.test.js
rm -rf .test-dist && node ./node_modules/typescript/bin/tsc -p tests/tsconfig.json && node --test .test-dist/tests/document-chat-request.test.js .test-dist/tests/ai-service-intent.test.js
node --test backend/tests/document-pipeline-100.test.js
npx tsc --noEmit --pretty false
rm -rf .next && npm run build
```

## Results

| Check | Result |
|---|---|
| Backend syntax check | PASS |
| Route syntax check | PASS |
| Contract leakage tests | 2/2 PASS |
| Chat request + intent tests | 25/25 PASS |
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

## Remaining Risk

This update validates chat-to-document generation and attached-file metadata handling. For academic tasks requiring real DOI/source verification, the upstream research/agent pipeline must still collect and verify evidence before requesting final document generation.
