# Open Source Dependency Integration Plan

Fecha: 2026-05-01

## 1. Diagnostico del estado actual

SiraGPT ya tiene una base amplia para un ecosistema comercial de IA:

- **Frontend**: Next.js 14, React 18, Tailwind, Radix UI, `react-markdown`, KaTeX, visor unificado de documentos, chat avanzado, paneles de artefactos, voz, busqueda, proyectos, biblioteca, pagos y administracion.
- **Backend/API**: Express, Prisma, Postgres, Redis/BullMQ, rutas para chat, archivos, RAG, busqueda, agentes, documentos, Gmail/Google/Spotify, pagos, planes y super-admin.
- **Chat/streaming**: cliente con SSE/WebSocket, streaming de respuestas, estados agenticos, cola suave, retry, stop/abort, adjuntos y vista previa de documentos.
- **Documentos**: DOCX/XLSX/PPTX/PDF/HTML/Markdown/SVG, validadores OOXML/PDF, generacion avanzada y reparacion automatica.
- **RAG/agentes**: retrieval hibrido, BM25/MMR/reranking, memoria, task envelope, runtime, eventos, metricas, token ledger, token budget y execution trace.
- **Observabilidad/CI**: `/health`, `/metrics`, tests backend agenticos en CI, lint/tsc/build frontend, auditoria de licencias con bloqueo y Playwright smoke informativo.

Brechas contra un ecosistema ChatGPT + Gemini + Claude + Codex + Cursor:

| Area | Estado actual | Brecha comercial |
|---|---|---|
| Seguridad de render Markdown | `rehype-raw` renderizaba HTML crudo en chat | Necesita sanitizacion AST centralizada antes de React |
| Seguridad de supply chain | Gate de licencias, auditoria critica como hard gate y SBOM CycloneDX en CI | Quedan advisories high/moderate que requieren upgrades mayores controlados |
| Next.js runtime | `next@14.2.35` aplicado en esta fase | Quedan advisories `high` que requieren migracion mayor a Next 16 o mitigaciones operativas |
| Observabilidad | Metricas Prometheus propias, health checks y trazas OpenTelemetry backend activables por OTLP HTTP | Falta propagar spans manuales finos dentro de herramientas/RAG/agentes y agregar tracing frontend |
| Data fetching frontend | Contextos y llamadas manuales | Falta deduplicacion/caching estandar para historial, proyectos, conectores y settings |
| Cola/agentes | BullMQ/Redis y eventos durables | Falta dashboard operativo protegido para queues y workers |
| RAG/cache | Implementaciones propias | Falta cache LRU/TTL estandar para resultados, manifests y metadata con limites claros |
| Testing e2e | Playwright smoke informativo | Falta promocion gradual de e2e critico por flujos core: login, chat, upload, documento |
| Licencias | `THIRD_PARTY_LICENSES.md` automatizado y validacion local `npm run security:validate` | Falta formalizar aprobacion legal fuera del repositorio para excepciones futuras |
| Upload/documentos | Magic-byte check basico + OCR/RAG | Fase 2 agrega politica central de extension/MIME/tamano y sanitizacion de previews; queda reemplazar/aislar `xlsx` |

## 2. Matriz priorizada de dependencias recomendadas

Todas las versiones fueron consultadas en npm/GitHub el 2026-05-01. Antes de instalar cualquier paquete futuro se debe repetir la validacion de version, licencia, advisories, issues y compatibilidad.

| Prioridad | Dependencia | URL | Version recomendada | Licencia | Proposito | Beneficio directo | Riesgo tecnico | Archivos que tocaria | Alternativas | Motivo de seleccion |
|---|---|---|---:|---|---|---|---|---|---|---|
| P0 integrada | `rehype-sanitize` | https://github.com/rehypejs/rehype-sanitize | `6.0.0` | MIT | Sanitizar HTML en AST Markdown | Bloquea scripts, handlers y URLs peligrosas sin perder KaTeX/codigo | ESM; requiere schema para HTML interno controlado | `lib/markdown-sanitize.ts`, `components/message-component.tsx`, CSS/tests/docs | `sanitize-html`, DOMPurify post-render | Encaja con `react-markdown`/`rehype-raw`; menor superficie y sin advisories conocidos |
| P0 integrada | `next` + `eslint-config-next` | https://github.com/vercel/next.js | `14.2.35` | MIT | Patch de runtime Next 14 | Elimina el advisory critico detectado por `npm audit --audit-level=critical` sin salto mayor | Build/regresion SSR; requiere smoke completo | `package.json`, `package-lock.json`, CI | Migrar a Next 15/16 | Patch semver-compatible frente a upgrade mayor |
| P0 integrada | `shiki` | https://github.com/shikijs/shiki | `1.29.2` | MIT | Highlighting TextMate para bloques de codigo | Hace consistente el commit actual que ya importa Shiki y evita `Module not found` en `npm ci` | Bundle pesado; debe cargarse lazy como ya hace `useShikiHighlight` | `package.json`, `package-lock.json`, `THIRD_PARTY_LICENSES.md` | `react-syntax-highlighter`, `lowlight` | MIT, activo y con carga dinamica existente |
| P0 integrada | `exceljs` | https://github.com/exceljs/exceljs | `4.4.0` | MIT | Lectura/generacion XLSX controlada | Sustituye `xlsx` npm, elimina advisories high sin fix y mantiene uso comercial compatible | Bundle cliente grande; se carga dinamicamente. No soporta `.xls` binario legacy | `package.json`, `backend/package.json`, viewers, previews, download routes, upload policy, tests/docs | `xlsx`, `@e965/xlsx`, `openpyxl`, `xlsxwriter` | MIT, mantenida, API Node/browser y menor riesgo legal/supply-chain para core comercial |
| P1 integrada | `@opentelemetry/api` + `@opentelemetry/sdk-node` + `@opentelemetry/resources` | https://github.com/open-telemetry/opentelemetry-js | `1.9.1` / `0.216.0` / `2.7.1` | Apache-2.0 | Trazas distribuidas | Correlacion request->LLM->tool->documento | Config/exporters; cardinalidad | `backend/index.js`, `backend/src/services/observability/*` | solo Pino/Prometheus | Estandar cloud, sin lock-in |
| P1 integrada | `@opentelemetry/auto-instrumentations-node` + `@opentelemetry/exporter-trace-otlp-http` | https://github.com/open-telemetry/opentelemetry-js-contrib | `0.74.0` / `0.216.0` | Apache-2.0 | Auto-instrumentar HTTP/Express/Redis/Postgres/OpenAI y exportar OTLP | Visibilidad rapida de latencia y errores | Ruido inicial; se ignoran `/health*`, `/metrics`, `fs`, `dns` | `backend/src/services/observability/*`, middleware, docs/tests | instrumentacion manual | Alto impacto con bajo codigo propio |
| P1 integrada | `octokit` | https://github.com/octokit/octokit.js | `5.0.5` | MIT | Conector GitHub tipo Codex/Cursor | Contexto profesional de repo, PRs, issues, README y Actions sin clonar codigo | ESM en backend CommonJS; requiere Node >=20 y token server-side para privados | `backend/src/services/github-codex-connector.js`, `backend/src/routes/github-codex.js`, `app/codex/page.tsx`, `lib/github-codex-service.ts` | `@octokit/rest`, REST manual con `fetch` | SDK oficial, MIT, mantenido y menor riesgo que clientes propios |
| P1 | `swr` | https://github.com/vercel/swr | `2.4.1` | MIT | Fetch cache/dedup en React | Mejora historial, settings y conectores | Migracion gradual por pantalla | `lib/*service.ts`, paginas cliente | React Query | Mas ligero y alineado con Next/Vercel |
| P1 | `@tanstack/react-query` | https://github.com/TanStack/query | `5.100.6` | MIT | Estado servidor complejo | Mejor para dashboards/admin con invalidaciones | Provider global; mayor cambio UX | `app/layout.tsx`, admin/proyectos | SWR | Elegir si se priorizan mutaciones complejas |
| P1 | `p-limit` | https://github.com/sindresorhus/p-limit | `7.3.0` | MIT | Concurrencia controlada | Evita bursts en RAG/OCR/providers | ESM; adaptar tests Node | RAG, OCR, file processing | Bottleneck existente | Minimalista para bucles internos |
| P1 | `quick-lru` | https://github.com/sindresorhus/quick-lru | `7.3.0` | MIT | Cache LRU en memoria | Limites claros para catlogos/modelos/search metadata | ESM; no sustituye Redis | RAG/search/model catalog | `lru-cache` | MIT; evita BlueOak en core |
| P2 | `@bull-board/express` | https://github.com/felixmosh/bull-board | `7.0.0` | MIT | UI operativa de BullMQ | Debug de tareas/colas agenticas | Debe ir detras de admin auth | `backend/src/routes/admin.js`, queue services | dashboards propios | Madura y especifica para BullMQ |
| P2 | `zod-to-json-schema` | https://github.com/StefanTerdell/zod-to-json-schema | `3.25.2` | ISC | Exportar contratos de tools/agentes | Documenta APIs internas para SDKs/conectores | Diferencias Zod v3/v4 | tool registry/docs | JSON schema manual | Reduce drift entre validacion y docs |
| P2 aplicada | `npm sbom` integrado | https://docs.npmjs.com/cli/commands/npm-sbom | npm CLI incluido | npm CLI | SBOM CycloneDX desde lockfiles | Evidencia enterprise/compliance sin dependencia nueva | Artefacto CI adicional | `.github/workflows/ci.yml`, `scripts/validate-supply-chain.js` | `@cyclonedx/cyclonedx-npm` | Menor superficie: usa herramienta oficial ya presente con Node/npm |

Dependencias ya presentes reutilizadas en Fase 2:

| Dependencia | URL | Version instalada | Licencia | Uso | Decision |
|---|---|---:|---|---|---|
| `cheerio` | https://github.com/cheeriojs/cheerio | `1.x` | MIT | Sanitizacion server-side de HTML de preview | Reutilizada; evita introducir `sanitize-html` por historial de advisories |
| `dompurify` | https://github.com/cure53/DOMPurify | `3.x` | Apache-2.0 / MPL-2.0 | Sanitizacion client-side de previews | Reutilizada; no agrega lock-in ni dependencia nueva |
| `file-type` | https://github.com/sindresorhus/file-type | `22.x` backend | MIT | Deteccion por magic bytes | Reutilizada en upload policy |
| `multer` | https://github.com/expressjs/multer | `2.1.1` | MIT | Multipart upload | Actualizada para cerrar advisories DoS |
| `officeparser` | https://github.com/harshankur/officeParser | `6.1.1` | MIT | Extraccion de Office/PPTX | Actualizada; se adapto API nueva |
| `nodemailer` | https://github.com/nodemailer/nodemailer | `8.0.7` | MIT-0 | Email transaccional | Actualizada para cerrar advisories de inyeccion/DoS |

Dependencias descartadas en esta fase:

- `sanitize-html`: MIT y reciente, pero tiene historial de advisories; mejor para sanitizacion HTML server-side general, no para pipeline AST actual.
- `lru-cache`: madura, pero licencia BlueOak-1.0.0; se prefiere `quick-lru` MIT para core comercial salvo aprobacion legal.
- Paquetes GPL/AGPL/LGPL nuevos: no se integran en el core sin aprobacion explicita e aislamiento tecnico.

## 3. Integracion de bajo riesgo y alto impacto aplicada

Se integro `rehype-sanitize@6.0.0` en el render del chat:

- `lib/markdown-sanitize.ts`: schema centralizado basado en GitHub-style sanitize.
- `components/message-component.tsx`: `ReactMarkdown` usa `rehypeRaw -> rehypeSanitize -> rehypeKatex`.
- `components/chat-interface-enhanced.tsx`: el badge interno de busqueda agentica ya no usa `style` inline; usa `<progress>`.
- `app/globals.css`: estilos compatibles con `<progress>`.
- `tests/markdown-sanitize.test.ts`: cubre bloqueo de HTML ejecutable, preservacion del badge controlado, codigo y KaTeX.
- `next@14.2.35` y `eslint-config-next@14.2.35`: patch de seguridad dentro de la linea 14.2 para eliminar el fallo critico de auditoria sin adoptar una migracion mayor.
- `shiki@1.29.2`: se declara explicitamente porque el estado actual del codigo ya lo importa via `lib/use-shiki-highlight.ts`; validado como MIT, activo y sin advisories conocidos en GitHub Advisory DB.

Fase 2 aplicada:

- `.github/workflows/ci.yml`: CI ejecuta con Node.js 24.
- `backend/src/services/upload-security-policy.js`: politica central para allowlist, extension/MIME, limites y contenido activo.
- `backend/src/routes/files.js` y `backend/src/middleware/upload.js`: revalidacion post-write antes de extraccion, OCR, RAG y OpenAI Files.
- `backend/src/services/preview-html-sanitizer.js` y `backend/src/services/doc-preview.js`: sanitizacion server-side de previews DOCX/XLSX/CSV.
- `components/document-preview.tsx`: sanitizacion client-side antes de `srcDoc`/`dangerouslySetInnerHTML`.
- `backend/.env.example`: variables `MAX_FILE_SIZE`, `UPLOAD_MAX_FILE_MB`, `MAX_UPLOAD_FILES`, `ALLOW_UNBOUNDED_UPLOADS`.
- `backend/package.json` y lockfile: parches de seguridad backend (`axios`, `express`, `multer`, `prisma`, `nodemailer`, `officeparser`) y eliminacion de `html-docx-js` no usado.
- `docs/phase-2-security-documents.md`: runbook de la fase.
- `backend/tests/upload-security-policy.test.js` y `backend/tests/preview-html-sanitizer.test.js`: regresiones de seguridad.

Por que esta dependencia:

- Resuelve una superficie real: respuestas de IA y estados internos pueden contener HTML crudo.
- Mantiene compatibilidad con Markdown, tablas GFM, codigo, KaTeX y badges internos.
- Es pequena, MIT, del ecosistema unified que ya usa el proyecto y sin advisories conocidos en GitHub Advisory DB al momento de validar.

## 4. Pruebas

Local:

```bash
npm test -- --test-name-pattern="markdown sanitizer"
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
npm run licenses:check
npm run licenses:report
npm audit --omit=dev --audit-level=critical
```

Smoke manual:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
open http://127.0.0.1:3000/chat
```

Produccion:

- Revisar CI `frontend`, `backend`, `licenses` y `CI · required checks passed`.
- Confirmar que `/chat` renderiza codigo, matematicas KaTeX, tablas y el estado de busqueda agentica.
- Confirmar que respuestas con `<script>`, `onclick`, `onerror` o `javascript:` no llegan al DOM.
- Confirmar que `npm audit --omit=dev --audit-level=critical` termina con codigo 0. Los advisories `high` restantes de Next requieren migracion mayor o mitigacion separada; `xlsx` no tiene fix npm disponible.

### Fase 4 aplicada: hardening de pruebas unitarias y e2e

Se agrego cobertura enfocada en los riesgos introducidos/cerrados por Fase 3:

- `tests/attachment-ingest.test.ts`: paridad de politica cliente para permitir `.xlsx` y rechazar `.xls` legacy.
- `tests/download-excel.test.ts`: el fallback frontend de descarga Excel genera un workbook real con `exceljs`.
- `backend/tests/xlsx-safe-workbook.test.js`: el helper backend escribe/lee XLSX real y aplica limites de filas/columnas en previews.
- `e2e/chat-upload.spec.ts`: Playwright valida que el picker no reintroduce `.xls` cuando el compositor esta montado y que el primer render no lanza `pageerror`.
- `e2e/chat.spec.ts`: el smoke de `/chat` acepta login/bootstrap sin usuario sembrado, manteniendo la senal en no-5xx, titulo y shell estable.
- `.github/workflows/ci.yml`: el test backend de `xlsx-safe-workbook` queda dentro del job de backend.

El job e2e sigue como informativo a nivel branch protection, pero el paso `Run Playwright smoke` falla dentro del job para producir senal visible.

### Fase 5 aplicada: validacion de seguridad y licencias

Se convirtio la validacion de supply chain en un flujo reproducible:

- `scripts/validate-supply-chain.js`: comando local para auditoria critica, licencias, drift de `THIRD_PARTY_LICENSES.md` y SBOM CycloneDX.
- `package.json`: agrega `npm run security:validate` y `npm run sbom:generate`.
- `.github/workflows/ci.yml`: `Security · npm audit + SBOM` deja de ser informativo y pasa a ser hard gate para vulnerabilidades criticas de produccion.
- `.github/workflows/ci.yml`: publica `supply-chain-sbom` con `frontend.cdx.json` y `backend.cdx.json`.
- `docs/phase-5-security-license-validation.md`: runbook de validacion, politica aplicada y riesgos residuales.

No se agrego `@cyclonedx/cyclonedx-npm`: npm CLI ya incluye `npm sbom` y genera CycloneDX 1.5 desde lockfiles, reduciendo superficie de dependencias.

### Fase 6A aplicada: OpenTelemetry backend

Se integro trazado distribuido activable por entorno:

- `backend/src/services/observability/otel.js`: bootstrap oficial del SDK Node con OTLP HTTP.
- `backend/src/middleware/otel-request-context.js`: correlacion de `X-Request-Id` con `X-Trace-Id` sin adjuntar payloads ni PII.
- `backend/index.js`: OpenTelemetry arranca antes de Express/HTTP y se apaga limpiamente en shutdown.
- `backend/src/services/observability/health-check.js`: `/health` incluye check informativo `opentelemetry`.
- `backend/.env.example`: variables `OTEL_*`.
- `backend/tests/otel-observability.test.js`: pruebas de configuracion y correlacion.
- `docs/phase-6a-opentelemetry.md`: runbook de despliegue y validacion.

La integracion es opt-in: no intenta contactar un collector si no se configura `OTEL_ENABLED=true` o un endpoint OTLP.

### Fase 6B aplicada: conector GitHub tipo Codex/Cursor

Se integro un conector GitHub de bajo riesgo y alto impacto con `octokit@5.0.5`:

- `backend/src/services/github-codex-connector.js`: cliente Octokit server-side, parsing seguro de `owner/repo`, contexto de repo/PR/issues/Actions/README, errores normalizados y modo public read-only cuando no hay token.
- `backend/src/routes/github-codex.js`: endpoints autenticados `/api/codex/github/status` y `/api/codex/github/repo`.
- `app/codex/page.tsx` y `lib/github-codex-service.ts`: superficie operativa para inspeccionar repositorios y preparar contexto estilo Codex/Cursor.
- `components/app-sidebar.tsx`: `Codex` queda debajo de `Diseño`.
- `backend/.env.example`: `GITHUB_CODEX_TOKEN` documentado como token server-side opcional para repos publicos y requerido para privados.
- `backend/tests/github-codex-connector.test.js`: parsing, redaccion de token, agregacion de contexto y degradacion parcial.
- `docs/phase-6b-github-codex-connector.md`: runbook de seguridad, pruebas y despliegue.

No se clona codigo, no se ejecutan comandos del repositorio remoto y no se aceptan tokens GitHub desde el navegador.

### Fase 3 aplicada: hardening de dependencias de documentos/codigo

Se cerro deuda de bajo riesgo y alto impacto sin refactor masivo:

- `react-syntax-highlighter` y sus tipos fueron eliminados del core. Los visores de artefactos, paneles y documentos usan `components/ui/shiki-code-view.tsx`, montado sobre el hook Shiki existente.
- `xlsx` fue eliminado de raiz y backend. Lectura/generacion XLSX confiable migro a `exceljs@4.4.0` con helpers compartidos en `lib/xlsx-client.ts` y `backend/src/services/xlsx-safe-workbook.js`.
- `.xls` binario legacy queda rechazado en upload policy y en el selector de archivos. Es una reduccion deliberada de superficie: ExcelJS cubre OOXML `.xlsx`, no el formato binario antiguo.
- `THIRD_PARTY_LICENSES.md` se regenera despues de la sustitucion para reflejar `exceljs` MIT y retirar dependencias removidas.

Riesgos residuales:

- El sandbox de artefactos interactivos aun carga SheetJS por CDN dentro de un iframe `sandbox="allow-scripts"` sin `allow-same-origin`. No es dependencia npm del core ni toca cookies/localStorage del host, pero debe pasar a un bundle controlado o retirarse en una fase separada.
- `next@14.2.35` mantiene advisories `high` no criticos en `npm audit`; el salto a Next 15/16 queda como fase mayor por impacto de runtime.
- `uuid` aparece como `moderate` por transitivos de ExcelJS/LangGraph/node-cron; no se fuerza override porque los cambios sugeridos implican saltos mayores o downgrades.

## 5. Seguridad y licencias

- Re-ejecutar `npm audit --omit=dev --audit-level=critical` antes de cada merge.
- Re-ejecutar `npm run licenses:check` y `npm run licenses:report` despues de cada cambio de dependencias.
- Mantener GPL/AGPL fuera del core. LGPL solo con aprobacion legal e interfaz reemplazable.
- Agregar excepciones solo en `scripts/generate-third-party-licenses.js` con razon documentada.

## 6. Despliegue controlado

1. Commit pequeno por dependencia o grupo inseparable.
2. Push a rama corta.
3. PR hacia `main` o merge controlado segun politica del repo.
4. Vigilar GitHub Actions hasta verde.
5. Si falla frontend/build/licencias, revertir el commit aislado.
6. Si falla e2e informativo por flake, documentar; si falla por regresion real, bloquear merge.
