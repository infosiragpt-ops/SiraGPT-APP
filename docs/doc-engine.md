# FEATURE_DOC_ENGINE — motor OOXML (SiraGPT / Luis Carrera)

Motor de transformación de documentos Office (DOCX/PPTX/XLSX → plantilla)
que **transplanta** el contenido fuente al body de la plantilla. Corrige el
bug de `/chat` «pasa este word al formato UPN»: el entregable ya no es la
plantilla vacía (`XXXXXXXX`).

**Default: apagado.** `FEATURE_DOC_ENGINE` solo se activa con `1` / `true` /
`yes` / `on`. Con el flag off, `/chat` y `/code` no cambian: el path de
edición por párrafos existente sigue igual.

OpenRouter está prohibido en este motor. El verify visual usa únicamente
DeepSeek V4 Flash / Pro (`DEEPSEEK_API_KEY`). No se inventan API keys: si
falta la key, el verify se omite.

## Pipeline

```
POST multipart source + template + instructions
  → jobId
  → unpack → map (w:styleId) → edit (transplant w:p / w:tbl)
  → validate (XML + r:id vs .rels) → render (soffice PDF + pdftoppm)
  → verify (DeepSeek vision, máx 3 iter, token budget cut)
  → done | error
```

Contrato `transformToTemplate`:

1. Copia la **plantilla** como base.
2. Mapea `w:styleId` source→template desde `styles.xml` (nombre, luego id).
3. Transplanta `w:p` y `w:tbl` del source. Los placeholders del body se van.
4. **Nunca** altera `w:sectPr`, headers, footers ni `numbering.xml`.

## APIs (solo estas; no se tocan `/chat` ni `/code`)

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| POST | `/api/documents/transform` | sí | multipart `source`, `template`, `instructions` → `{ jobId }` |
| GET | `/api/documents/:jobId/stream` | sí | SSE: `unpack\|map\|edit\|validate\|render\|verify\|done\|error` |
| GET | `/api/documents/:jobId/artifact` | sí / URL firmada | URL HMAC 15 min; `?sig=` descarga el DOCX |

Flag off ⇒ las tres responden **404**.

## Chat

Con `FEATURE_DOC_ENGINE=1`, un turno tipo «pasa este word al formato UPN»
(source + plantilla) entra a este job. Con el flag off, el editor por
párrafos existente no se toca.

## Sandbox

- Imagen: `siragpt-sandbox:doc-engine` (`services/doc-engine/Dockerfile`,
  `debian:bookworm-slim`, Python 3.11, LibreOffice writer/calc/impress,
  poppler, fonts-liberation, fonts-crosextra-carlito, zip/unzip, pandoc).
- Runner: `--network=none`, rootfs read-only, `--cap-drop=ALL`, seccomp
  por defecto, `--user 10001`, tmpfs `/workspace` 512MB.
- Workspace: `/workspace/{jobId}`, timeout 180s, cleanup en `finally`.
- Cola BullMQ `doc-jobs`, concurrency 2.

## Env (solo nombres; ver `.env.example`)

| Variable | Default | Qué hace |
|---|---|---|
| `FEATURE_DOC_ENGINE` | `0` | Activa el motor |
| `DOC_ENGINE_IMAGE` | `siragpt-sandbox:doc-engine` | Imagen del sandbox |
| `DOC_ENGINE_QUEUE_NAME` | `doc-jobs` | Cola BullMQ |
| `DOC_ENGINE_CONCURRENCY` | `2` | Workers |
| `DOC_ENGINE_TIMEOUT_MS` | `180000` | Timeout del job |
| `DOC_ENGINE_WORKSPACE_SIZE` | `512m` | tmpfs `/workspace` |
| `DOC_ENGINE_ARTIFACT_TTL_SEC` | `900` | URL firmada (15 min) |
| `DOC_ENGINE_VERIFY_MAX_ITERATIONS` | `3` | Iteraciones vision |
| `DOC_ENGINE_VERIFY_MAX_TOKENS` | `400` | Tope por llamada |
| `DOC_ENGINE_DEEPSEEK_FLASH_MODEL` | `deepseek-v4-flash` | Vision rápida |
| `DOC_ENGINE_DEEPSEEK_PRO_MODEL` | `deepseek-v4-pro` | Última iteración |
| `DOC_ENGINE_SIGNING_SECRET` | (vacío → `JWT_SECRET`) | HMAC de artefactos |
| `DEEPSEEK_API_KEY` | (vacío) | Cliente DeepSeek existente |
| `REDIS_URL` | — | Obligatoria para BullMQ; sin ella el job corre in-process |

## Compose (opcional, sin puerto público)

```bash
docker compose --profile doc-engine up
```

El servicio `doc-engine` no publica puertos. El healthcheck interno pega a
`http://127.0.0.1:8080/healthz` (200). El proxy existente del backend
(`:5000`) sirve las APIs.

## Skills

`packages/doc-skills/{docx,pptx,xlsx,pdf}/SKILL.md` +
`packages/doc-skills/scripts/{ooxml_unpack,ooxml_repack,ooxml_validate,render_preview,transform_to_template}.py`

## Tests

- Vitest: `tests/lib/doc-engine/*.test.ts` (path traversal, zip-bomb,
  `.rels`, style map, fixture UPN + golden `document.xml`).
- Backend: `backend/tests/doc-engine.test.js` (flag off, runner harden,
  verify DeepSeek-only, chat bridge).
