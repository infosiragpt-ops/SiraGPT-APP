# Software vs document routing

Production bug on `/agentes`: Muse Spark treated “créame una web de ventas” as a Document Sandbox Word job (`Web_de_ventas.docx`, 15/15 checks) instead of real code.

## Root cause

The backend already classified website builds as `CodePipeline` / `webdev` and set `required_extension: .html`. The chat client then remapped any `.html` / `html_file` contract to intent `doc`. `detectDocumentChatFormat` defaults missing “html” wording to `docx`, so the F1 document pipeline ran.

Bare `ventas` in the sheet lexicon could also promote a sales phrase to Excel on the agent-task path.

`AGENTES_CODING_V2` stays off. This fix uses the existing `webdev` → default agentic `/generate` path plus `create_artifact` (HTML/code). No new Lenovo env flag.

## Rules

| Ask | Plane |
|---|---|
| créame una web / sitio / landing / app / software / página web / ecommerce | **code** (`webdev`, HTML/JS/CSS artifact) |
| rédactame un informe de ventas en Word | **Word** |
| hazme un PDF de propuesta | **PDF** |
| datos de ventas / copy de ventas para el brochure | **not** forced to coding |

Classifier: `backend/src/services/agents/software-build-intent.js` (frontend mirror: `lib/software-build-intent.ts`).

Office `create_document` on a software ask fails with `E_SOFTWARE_CODE`.
