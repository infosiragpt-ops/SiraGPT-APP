# FEATURE_DOC_ENGINE — isolated OOXML sandbox (SiraGPT / Luis Carrera)

Motor de transformación de documentos Office (DOCX/PPTX/XLSX → plantilla)
que **transplanta** el contenido fuente al body de la plantilla. Corrige el
bug de `/chat` «pasa este word al formato UPN»: el entregable ya no es la
plantilla vacía (`XXXXXXXX`).

**Default: apagado.** `FEATURE_DOC_ENGINE` solo se activa con `1` / `true` /
`yes` / `on`. Con el flag off: **no** se registra el router `/api/documents`,
**no** arranca el worker `doc-jobs`, y las rutas nuevas responden **404**.

OpenRouter está prohibido en este motor. El verify visual usa únicamente
DeepSeek V4 Flash / Pro (`DEEPSEEK_API_KEY`) en el **control worker** (tiene
red). No se inventan API keys: si falta la key, el verify se omite.

## Arquitectura aislada

```
POST /api/documents/transform
  → disco (artifact-store)  — nunca buffers en Redis
  → BullMQ doc-jobs (conc 2, 180s)
  → docker run --rm --network=none --read-only --cap-drop=ALL
       --security-opt=no-new-privileges --user=10001:10001
       --tmpfs /workspace:rw,nosuid,nodev,noexec,size=536870912
       --pids-limit=256 --memory=768m --cpus=1
       siragpt-sandbox:doc-engine
  → eventos unpack|map|edit|validate|render|verify|done|error
  → vision (DeepSeek, máx 3 iter, DSL cerrado) en el control worker
  → cleanup en finally
```

Sin Docker / imagen, el pipeline cae al transform in-process (CI / tests).
El hook de `/chat` (UPN transplant) **sigue in-process** y no depende de
este contenedor.

## Imagen

```bash
docker build -t siragpt-sandbox:doc-engine -t iliagpt-sandbox:doc-engine \
  -f services/doc-engine/Dockerfile .
```

- Base: `debian:bookworm-slim`
- `python3.11` venv en `/opt/venv`
- LibreOffice writer/calc/impress, poppler, fonts-liberation,
  fonts-crosextra-carlito, zip/unzip, pandoc
- uid **10001**
- `requirements.lock` con versiones **y hashes** (`pip install --require-hashes`)

## APIs (solo estas; no se tocan `/chat` ni `/code`)

Caddy (siragpt.com) ya proxea `/api/*` al backend. **No** hay puertos
nuevos ni hostname de túnel.

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| GET | `/api/documents/healthz` | no | 200 solo si el flag está on (router registrado) |
| POST | `/api/documents/transform` | sí | multipart `source`, `template`, `instructions` → `{ jobId }` |
| GET | `/api/documents/:jobId/stream` | sí | SSE + `Last-Event-ID` replay (stream-resume Redis) |
| GET | `/api/documents/:jobId/artifact` | sí / URL firmada | HMAC TTL 900s |

Flag off ⇒ Express 404 (router no montado).

## Chat (hook de producción)

El Word path en vivo es in-process PizZip en
`tryGenerateSourcePreservingDocumentEdit`. Si `FEATURE_DOC_ENGINE=1` y hay
≥2 DOCX: `classifyTemplateVsContent` → `transformToTemplate` in-process.
`extractSectPr` usa el **último** match. El hook **conserva** el transplant
si `blocks>0` aunque los strings de sectPr intermedios difieran.

## Skills

`packages/doc-skills/{docx,pptx,xlsx,pdf}/SKILL.md`

Scripts:

- `limits.py` `xml_io.py`
- `ooxml_unpack.py` — sin `extractall`; traversal / symlink / zip-bomb 5000/200MB; exige `[Content_Types].xml`
- `ooxml_repack.py` — Content_Types primero, `ZIP_DEFLATED`, timestamps 1980-01-01, sin `pretty_print`
- `ooxml_validate.py` — parser seguro; `r:id` / `r:embed` / `r:link` vs `.rels`
- `render_preview.py` — soffice 90s process-group kill; `pdftoppm -png -r 110`
- `transform_to_template.py` — plantilla como base; sectPr terminal SHA-256; no toca headers/footers/`numbering.xml`; style map; rechaza OLE/ActiveX/macros
- `apply_visual_patch.py` — DSL cerrado solamente

PDF **no** es OOXML unpack-edit-repack.

## Env

| Variable | Default | Qué hace |
|---|---|---|
| `FEATURE_DOC_ENGINE` | `0` | Activa router + worker |
| `DOC_ENGINE_IMAGE` | `siragpt-sandbox:doc-engine` | Imagen efímera |
| `DOC_ENGINE_QUEUE_NAME` | `doc-jobs` | Cola BullMQ (registry conc 2) |
| `DOC_ENGINE_CONCURRENCY` | `2` | Workers |
| `DOC_ENGINE_TIMEOUT_MS` | `180000` | Deadline del job |
| `DOC_ENGINE_ARTIFACT_TTL_SEC` | `900` | URL firmada |
| `DOC_ENGINE_VERIFY_MAX_ITERATIONS` | `3` | Iteraciones vision |
| `DOC_ENGINE_VERIFY_MAX_TOKENS` | `400` | Tope por llamada |
| `DOC_ENGINE_DEEPSEEK_FLASH_MODEL` | `deepseek-v4-flash` | Vision rápida |
| `DOC_ENGINE_DEEPSEEK_PRO_MODEL` | `deepseek-v4-pro` | Última iteración |
| `DEEPSEEK_API_KEY` | (vacío) | Cliente DeepSeek existente |
| `REDIS_URL` | `redis://redis:6379` | Obligatoria para BullMQ |

## Compose

```bash
docker compose --profile doc-engine build
```

El servicio `doc-engine` **solo EXPOSE 8080** (sin `ports:`). No publica
puertos en el host. Health de producto: `GET https://siragpt.com/api/documents/healthz`.

## Tests

```bash
npm --prefix backend run test:doc-engine
npm run test:unit -- tests/lib/doc-engine --pool=threads
```

Cobertura: path traversal, symlink, zip-bomb, rels, style map, feature flag,
UPN sectPr SHA + header/footer + numbering hash + PDF ≥1 + golden C14N
`document.xml`.
