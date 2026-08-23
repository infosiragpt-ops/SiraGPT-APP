# FEATURE_DOC_ARTIFACT_EDITOR — editor Word tipo Artifacts

Microservicio **aparte de /chat** para editar un artefacto DOCX en un panel
lateral (abrir → editar → progreso SSE → descargar). No reutiliza el chrome
del chat ni OpenRouter.

Flag: `FEATURE_DOC_ARTIFACT_EDITOR` (default **false**). Con el flag off,
todas las rutas excepto `GET /health` responden 404.

## Por qué es un servicio aparte

`FEATURE_DOC_ENGINE` ya cubre **transplantar** un Word fuente al Formato UPN
(`transformToTemplate`: copia `w:p` / `w:tbl` del source, conserva `sectPr`
y headers/footers de la plantilla). Eso vive en el path de /chat.

El editor de artefactos es el siguiente paso, estilo Claude Artifacts:

1. El usuario abre un DOCX ya generado o adjunto.
2. Pide cambios en lenguaje natural (“corrige el título”, “quita el anexo 2”).
3. El servicio aplica la edición **sobre el mismo paquete OOXML**, emite
   progreso, y entrega un download. El chat no se redibuja.

Por eso el flag es otro: se puede encender el transplant UPN en producción
sin activar el editor, y al revés.

## Contrato HTTP

Montado en `/api/doc-artifact-editor` (Bearer, CSRF cookie-auth catch-all).

| Método | Ruta | Flag off | Descripción |
|--------|------|----------|-------------|
| GET | `/health` | 200 | `{ ok, enabled, provider: "deepseek", isolatedFromChatChrome: true }` |
| POST | `/sessions` | 404 | Abre un artefacto (`multipart` campo `artifact`) |
| GET | `/sessions/:id` | 404 | Estado + eventos |
| POST | `/sessions/:id/edits` | 404 | Aplica instrucción (DeepSeek plan; scaffold no inventa OOXML) |
| GET | `/sessions/:id/stream` | 404 | SSE `open\|plan\|edit\|validate\|render\|done\|error` |
| GET | `/sessions/:id/download` | 404 | Bytes actuales del DOCX |

No hay rutas de UI. El panel (fuera de este PR) consume solo esta API.

## Proveedor

- **Solo DeepSeek** (`DEEPSEEK_API_KEY`, modelos `deepseek-v4-flash` /
  `deepseek-v4-pro`, mismos defaults que `FEATURE_DOC_ENGINE`).
- OpenRouter está **prohibido** en este motor. `assertNoOpenRouter()` lo
  documenta: aunque existan `OPENROUTER_*` en el proceso para otras
  superficies, este servicio no las lee.
- Sin key: `applyEdit` no muta el buffer y marca `skipped` (no inventa keys).

## Relación con /chat y el preview

- **Transplant UPN** (“pasa este word al formato UPN”):
  `tryDocEngineAfterSelection` → `transformToTemplate`. In-process PizZip.
  No requiere `FEATURE_DOC_ENGINE` para el chat (ese flag sigue gateando
  BullMQ / sandbox / `/api/documents`).
- **Preview en /chat**: path primario LibreOffice → PDF
  (`/api/agent/artifact/:id/preview.pdf` o `/api/files/:id/render?target=pdf`).
  El dump HTML de Mammoth **no** es el preview de Word. El visor existente
  (`DocumentPreview` + `PdfRenderer`) ya tiene páginas, zoom y toolbar 1/N.
- **Este editor**: no pinta el preview. El cliente del panel puede reutilizar
  el mismo `previewPdfUrl` del artefacto abierto.

## Env

| Variable | Default | Rol |
|----------|---------|-----|
| `FEATURE_DOC_ARTIFACT_EDITOR` | off | Enciende el microservicio |
| `DOC_ARTIFACT_EDITOR_TIMEOUT_MS` | 120000 | Tope por edición |
| `DOC_ARTIFACT_EDITOR_TTL_SEC` | 900 | TTL de sesión / download |
| `DOC_ENGINE_DEEPSEEK_FLASH_MODEL` | `deepseek-v4-flash` | Plan |
| `DOC_ENGINE_DEEPSEEK_PRO_MODEL` | `deepseek-v4-pro` | Reintento |
| `DEEPSEEK_API_KEY` | — | Obligatoria para aplicar ediciones con LLM |

## Rollback

1. Quitar `FEATURE_DOC_ARTIFACT_EDITOR` (o dejarla unset). `/health` sigue
   en 200 con `enabled: false`; el resto 404.
2. /chat no cambia: el transplant y el preview paginado no dependen de este flag.

## Verificación

```bash
node --test backend/tests/doc-engine.test.js backend/tests/doc-artifact-editor.test.js
```
