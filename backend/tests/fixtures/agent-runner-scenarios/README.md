# AgentRunner scenario bank

Thousands of real user-style scenarios (Spanish + some English) as **data**,
consumed by `backend/tests/agent-runner-scenario-bank.test.js`.

## What lives here

- `index.js` — deterministic fixture generator. `buildScenarioBank()` returns
  **≥2000 unique fixtures** built from cartesian products (verbs × document
  nouns × topics × colors × contexts), NOT copy-pasted test functions.
  Same inputs always produce the same bank; every text is unique (deduped);
  the test prints honest per-family counts.

## Fixture shape

```js
{
  id: 'create-es-0001',
  family: 'create_es',
  text: 'crea una ppt de embarazo de color rosado',
  context: { fileIds: ['file-1'], hasPriorArtifacts: true }, // optional
  expect: {
    runner: true,        // shouldRunAgentRunner(text + context)
    runnerOnly: true,    // isRunnerOnlyDocumentTurn(text) — claimed failures
                         // must surface an honest error, NEVER the pipeline
    orchestrate: false,  // shouldOrchestrate(text)
    colorHex: 'FFC0CB',  // color the OOXML must carry (named color or #hex)
    topicIncludes: ['embarazo'], // strings the deliverable must contain
    format: 'pptx',      // pptx | docx | xlsx
    mustNotPipeline: true, // advanced-document-pipeline / create_document ban
    agenticChat: false,  // optional shouldUseAgenticChat pin
  },
}
```

## Families

| family | covers |
|---|---|
| `production` | exact phrases from production incidents (embarazo rosado, uniformisa blanco, hex, gracias, …) |
| `create_es` / `create_en` | create ppt/word/excel × 24 ES + 12 EN topics × colors (named + hex + none) |
| `style` | color/style follow-ups (ponlas/píntalas/cámbialas/fondo/uniformiza/colorea) × full palette + hex |
| `thanks` | add-a-closing-slide follow-ups |
| `edit` | edits on attached documents (claimed, NOT runner-only) |
| `orchestrate` | genuinely multi-step goals (research/analyze THEN write) |
| `injection` / `injection_doc` | prompt-injection attempts — content is DATA, never instructions |
| `cancel` | stop/cancel phrases — must NOT claim the runner |
| `smalltalk` / `garbage` | hola, gratitude, trivia, empty/garbage — must NOT claim the runner |

## How it runs

- **Default CI** (the file is discovered by `scripts/test-shard.sh` like every
  other test): full routing assertions over ALL fixtures + a scripted-LLM
  e2e slice of **≥40 scenarios** with the real local sandbox and OOXML
  inspection. No network, no OpenRouter, no Docker. Whole file ≈ 1.5 s.
- **`SIRAGPT_SCENARIO_SMOKE=1`**: ~200-fixture routing smoke + 8 e2e
  scenarios, for ultra-fast iteration.
- **`npm run test:agent-scenarios`** (from `backend/`): runs the full bank
  explicitly.
- **Live evals** (`e2e/agent-runner-scenarios.spec.ts`, repo root): opt-in
  Playwright run against a real deployment. Skipped unless
  `SIRAGPT_LIVE_EVALS=1` **and** `PLAYWRIGHT_BASE_URL` are set — default CI
  never burns credits.

## Invariants the bank pins

1. Every create-doc / style-color phrase claims the AgentRunner
   (`shouldRunAgentRunner` + `isRunnerOnlyDocumentTurn`).
2. `hola`, gratitude, trivia, garbage, cancel and pure injection prompts
   NEVER claim the runner; the doc route returns `null` for them.
3. Color words (rosado, blanco, naranja, morado, celeste, verde, … + any
   `#hex`) resolve to the exact palette hex, and the e2e slice proves the
   hex lands in EVERY slide's XML.
4. A claimed failure produces ZERO stub files and never loads
   `advanced-document-pipeline` nor calls `create_document`.
5. Uploaded/web-like content is DATA: injection payloads inside files never
   reach the deliverable, and the agent prompt pins the security rule.
6. Palette drift fails loudly: fixture hexes are cross-checked against the
   runtime `NAMED_COLORS` table on every run.
