# Contexto real del repositorio: sandbox documental

Fecha de inspección: 2026-09-04. Base examinada: `0f24e4d004f156eae838e21592539cca91f53cd3`.
Estado: diagnóstico y preparación del plan, no implementación ni certificación de producción.
Fuente de requisitos: [especificación v1.0](SPEC-sandbox-edicion-documentos.md). Se mantiene la aprobación previa de su §0.1.

## 1. Estructura y convenciones

- Frontend Next.js App Router en `app/`, componentes en `components/`, clientes/estado en `lib/` y alias `@/*`. Versiones declaradas: Next `15.5.21`, React `^18` (`package.json:241,251`).
- UI canónica `/agentes`; ya existen `app/documents/page.tsx`, `app/documents/editor/page.tsx` y el editor manual de `components/chat/DocumentEditorPanel.tsx`. No confundir este editor de texto extraído con edición binaria preservadora.
- Backend separado Express/CommonJS: `backend/index.js:542`, rutas en `backend/src/routes/`, servicios en `backend/src/services/`; Express `^4.18.2` (`backend/package.json:114`). La estructura objetivo `server/modules/` no es la dueña actual del flujo.
- TypeScript raíz es estricto pero excluye `backend` (`tsconfig.json:13,40–42`). Un módulo backend TS nuevo necesitará configuración, compilación, runtime y tests explícitos; añadir `.ts` no lo integra automáticamente en Express CommonJS.
- Se usan archivos kebab-case, `require/module.exports` en backend, tipos TS en frontend, esquemas zod y también `express-validator`. La nueva frontera puede adoptar zod sin convertir todo el backend.
- Política inspeccionada: `AGENTS.md` raíz; no se encontraron archivos scoped propios bajo los subárboles inspeccionados. No modificar upstream ni F7 como parte de este módulo.
- Docs adyacentes consultadas: `docs/DOCUMENT-EDITOR-MVP.md` y `docs/document-chat-integration-report.md`. Sus resultados históricos no sustituyen esta verificación.

## 2. Autenticación y subida actual

- `backend/src/middleware/auth.js:121–132` admite Bearer y cookie de sesión; `312–400` valida JWT/sesión activa y contempla API keys. Reutilizar esta frontera, no crear autenticación documental paralela.
- `backend/src/routes/files.js:981` monta subida múltiple con autenticación, scope `files:write`, multer y rate limit. Hay subida fragmentada adicional (`907–961`).
- Detección de contenido y política de tipo se aplican en `files.js:804–823`; la extracción/indexación tiene estados propios de archivo, no estados de edición.
- `backend/prisma/schema.prisma:1441–1462`: `File` conserva propietario, nombre original, MIME, bytes, referencia storage, texto extraído y etapa de procesamiento.
- La selección documental consulta por `userId`: `backend/src/services/agent-harness/tools/document-edit-tool.js:251`; `/api/doc` carga referencias propias en `backend/src/routes/doc.js:86–110`.
- No asumir que la protección de upload satisface sola el nuevo preflight: el worker también debe inspeccionar ZIP, XML, tamaños expandidos y tipo real antes de procesar.

## 3. Recorrido actual de una edición

```text
Chat + adjuntos → identificación de edición → /api/agent/task
                                           → cola o ejecución local
                                           → source-preserving / doc-agent
                                           → validación → artefacto → tarjeta/descarga
Otra entrada: /api/doc/generate → AgentRunner primero → editor preservador si no reclama
```

| Punto | Código observado |
|---|---|
| Detectar mutación documental | `lib/ai-service.ts:272–309,942–959` |
| Reenviar edición sin perder adjuntos | `lib/chat-context-integrated.tsx:3360–3451` |
| Runner primero en ruta doc | `backend/src/routes/doc.js:353–419` |
| Edición preservadora y rechazo de regeneración incorrecta | `backend/src/routes/doc.js:421–465` |
| Edición y publicación de eventos del task | `backend/src/services/agents/agent-task-runner.js:2480–2575` |
| Tool con schema, límite y ownership | `backend/src/services/agent-harness/tools/document-edit-tool.js:194–199,251` |
| Snapshot y eventos recuperables | `backend/src/routes/agent-task.js:722–754` |

No hay una sola ruta documental: la integración debe definir una entrada canónica para el nuevo contrato y evitar que otra ruta entregue candidatos sin pasar por su validador.

## 4. Colas y durabilidad

- BullMQ e ioredis ya son dependencias (`backend/package.json:101,127`). `services/agents/agent-task-queue.js:107–125` crea la cola existente con retención acotada; `agent-task-worker.js:72–83` registra su consumidor.
- `routes/agent-task.js:1971–1974,2111–2115`: los adjuntos pueden ejecutarse localmente por defecto, salvo configuración/política. `2156–2178`: el fallo de enqueue también deriva a ejecución en proceso.
- Esa degradación existente no satisface por sí misma el worker aislado/durable de la especificación. No se certificó recuperación real después de matar procesos.
- `services/doc-engine/queue.js:147–164` ya contiene otro worker documental feature-gated. `doc-engine/flags.js:27–46` define cola, presupuesto, TTL y motor para ese subsistema.
- `AgentTask` y `AgentTaskEvent` ya están en Prisma (`schema.prisma:1297–1342`). El nuevo contrato de `doc_jobs/doc_job_events/doc_job_artifacts` no debe confundirse con esas tablas genéricas.
- El endpoint task `/events` actual responde JSON paginado por `after` (`routes/agent-task.js:732–754`); no acredita el SSE documental con `Last-Event-ID` requerido.

## 5. Storage, descargas y versiones

- `services/object-storage.js:11–20,78–104`: adapter local/R2 con refs `r2:`, escritura, lectura y helper de URL firmada. Se puede reutilizar sin introducir un segundo SDK S3.
- `backend/package.json:63–64` ya declara AWS S3 y presigner. La configuración existente de R2 admite TTL configurable (`src/orchestration/r2-storage.js:57`), cuyo default es 900 segundos: superior a los 600 requeridos para el módulo nuevo.
- La descarga de edición preservadora usa proxy autenticado: `routes/agent-task.js:543–615`, con metadata de dueño obligatoria y 403 usuario ajeno (`585–589`); sirve archivo local o stream R2. No es una descarga pública, pero tampoco es el contrato de URL firmada con TTL de la nueva API.
- `GeneratedArtifact` guarda metadata/validación (`schema.prisma:1399–1422`). El editor conserva el upload y crea artefactos nuevos.
- `FileVersion` (`schema.prisma:4107–4124`) y `services/document-editing/versioning.js:13–63,67–117` ofrecen historial y restauración append-only. La persistencia de versión es best-effort: errores devuelven null; no sirve sola como registro obligatorio del job.
- El editor manual persiste Markdown y exporta un documento nuevo; su límite está declarado en `docs/DOCUMENT-EDITOR-MVP.md`. No debe presentarse como preservación del Word original.
- Retención, cifrado de transcript, borrado integral por job y evidencia de SSE del bucket quedan por verificar/implementar; no se inspeccionaron secretos ni políticas reales de storage.

## 6. Componentes reutilizables y brechas bloqueantes

| Hallazgo | Evidencia y efecto frente a la especificación |
|---|---|
| Runs DOCX quirúrgicos existentes | `source-preserving-document-edit.js:2191–2275` une nodos de texto y modifica solo su contenido. Reutilizable con nuevos tests de partes y planes. |
| Reemplazo DOCX acotado al cuerpo | `source-preserving-document-edit.js:2334–2338,2376` trabaja en `word/document.xml`; no cumple por sí solo pie/notas/comentarios de G2. |
| Adapters OOXML existentes | `document-editing/xlsx-adapter.js:1–10` y `pptx-adapter.js:1–7` editan partes. El XLSX cae a primera hoja si no encuentra nombre (`84–90`): debe rechazarse para operaciones inequívocas. |
| Preservación general insuficiente | `source-preserving-document-edit.js:4827–4831` comprueba firma/no vacío en PDF/texto; `4851–4857` solo partes presentes en Office general. La comparación byte-idéntica está reservada al título DOCX (`4860–4886`). |
| MIME fail-open | `source-preserving-document-edit.js:4974–4984` marca el check verdadero si el validador lanza excepción. No trasladar este comportamiento. |
| No-op rechazado | `source-preserving-document-edit.js:4971–4973` exige bytes distintos; `doc-agent/index.js:238–245` rechaza copia idéntica. G11 exige lo contrario cuando el plan no modifica nada. |
| Gate útil antes de guardar | `source-preserving-document-edit.js:8228–8246` rechaza validación no aprobada antes de escribir artefacto. Conservar esta propiedad. |
| Motor A parcial ya presente | `doc-agent/anthropic-route.js:119–125` usa upload JSON; debe contrastarse con API oficial. `145–155` descarga con nombre file_id y no registra uso/container ni borra remotos. |
| Motor A evita validación local | `doc-agent/index.js:153–163` retorna antes del abort scope y revisión de outputs. No habilitarlo como F1 sin adaptar contrato y gate independiente. |
| Validación doc-agent advisory | `doc-agent/validate.js:106–140` permite forbidden-parts por default y baseline ausente. Batch usa baseline null (`doc-agent/index.js:235–236`). No es validación de cinco niveles. |
| Apertura/visual no obligatorios | `doc-agent/validate.js:144–155` expone builders de comandos, no una ejecución obligatoria externa al sandbox. |
| Retry no prueba restauración prístina | `doc-agent/index.js:266–301` reintenta en el mismo sandbox sin reconstruir explícitamente uploads/outputs. |
| Transformación de plantilla diferente | `doc-engine/chat-bridge.js:37–56` calcula checks de formato, pero `passed` solo depende de bloques/placeholders. No reutilizar como gate preserve. |
| PDF con límites honestos | `source-preserving-document-edit.js:3920–3932` falla cerrado en reemplazo de texto que no puede preservar. Adaptar a `not_possible` cuando corresponda. |
| Nombre/receta no uniformes | `source-preserving-document-edit.js:8216,8255–8267` añade sufijos; no produce el conjunto obligatorio plan/result/recipe/reporte por job. |

Las rutas de servicios abreviadas en esta tabla son relativas a `backend/src/services/`. Severidad: las brechas de validación, aislamiento, baseline y cleanup son bloqueantes para declarar F1/F2 conformes, no prueba de un incidente real.

## 7. Migraciones, namespace y configuración

- PostgreSQL + Prisma: `backend/prisma/schema.prisma:4–10`; migraciones SQL en `backend/prisma/migrations/<timestamp>_<nombre>/migration.sql`.
- Desarrollo: `backend/package.json:18,23` declara `db:generate` y `db:migrate`. El wrapper `backend/scripts/start-with-migrations.js:1223–1224` ejecuta `prisma migrate deploy` para aplicación de migraciones. No se ejecutó ninguna migración durante el diagnóstico.
- Las nuevas tablas requieren migración aditiva y procedimiento reversible específico; Prisma no proporciona aquí una migración down automática del módulo. No usar reset ni borrar tablas de usuarios para rollback.
- `/api/docs` ya es alias Swagger en `backend/index.js:1196–1199`; revisar montaje/orden con los futuros `/api/docs/jobs`. `routes/api-docs.js:60–70,94–123` muestra rutas actuales. No reemplazar Swagger accidentalmente.
- Variables existentes relevantes, solo nombres leídos del código: `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, `AGENT_QUEUE_NAME`, `AGENT_TASK_QUEUE_ATTACHMENTS`, `AGENT_ARTIFACT_DIR`, `UPLOAD_DIR`, `FEATURE_DOC_ENGINE`, `DOC_ENGINE_QUEUE_NAME`, `DOC_ENGINE_ARTIFACT_TTL_SEC`, `DOC_ENGINE_SIGNING_SECRET`, `SIRAGPT_CHAT_TEMPLATE_TRANSFORM`, `SIRAGPT_DOC_AGENT_ROUTE`, `SIRAGPT_DOC_AGENT_MODEL`, `SIRAGPT_DOC_AGENT_MAX_RUNTIME_MS`, `ANTHROPIC_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_REGION`, `R2_PRESIGNED_URL_TTL_SECONDS`.
- Las variables `DOC_SANDBOX_*` son requisitos nuevos; no se presume que existan ni se configuran en esta etapa. Nunca volcar archivos de entorno.

## 8. Pruebas: baseline y alcance de la evidencia

En esta sesión el agente principal ejecutó una selección offline: **53 tests aprobados**. Comando, entorno y salida real se registran en [evidencia-diagnostico.md](evidencia-diagnostico.md). Este resultado no equivale a golden con Motor A real, CI completa, 80 % de cobertura ni despliegue.

- Tests focales existentes: `backend/tests/docx-list-preserving-edit.test.js`, `xlsx-surgical-edit.test.js`, `pptx-surgical-edit.test.js`, `pdf-surgical-edit.test.js`, `document-inplace-edit-acceptance.test.js`. Requieren dependencias backend (`pizzip`, `docx`, `exceljs`, `pptxgenjs`, `pdf-lib`; imágenes requieren `sharp`). Ejecutar en entorno de test aislado y sin credenciales reales.
- `document-background-edit-http-integration.test.js:238–270` usa rutas/editor reales, pero SDK, DB y persistencia in-memory; no prueba cola/DB reales. `document-background-edit-e2e.test.js:151` también usa Prisma falso.
- `e2e/document-background-edit.spec.ts:288–289,330–367` intercepta la API: prueba UI/reload/descarga, no un motor real. No etiquetarlo como evidencia de G1–G12.
- Raíz: `npm test` compila `tests/tsconfig.json` y ejecuta Node test; `npm run test:unit` usa Vitest; `npm run test:e2e` usa Playwright (`package.json:19–22`).
- `npm run lint` existe (`package.json:12`). No hay scripts `typecheck` ni `test:e2e:docs` declarados en los manifests inspeccionados: el plan debe añadirlos o documentar un comando equivalente, no afirmar que ya funcionan.
- Backend: `npm test` usa Node test y `posttest` agrega integraciones (`backend/package.json:40,42`). La cobertura global actual exige 60 % líneas/funciones, 50 % branches (`:16`), distinta al 80 % del módulo nuevo.

## 9. Límite del diagnóstico y siguiente paso

No se hicieron cambios funcionales, llamadas a proveedores, migraciones, operaciones de datos ni verificación live. Los hallazgos se basan en la revisión del código de la base indicada y en la selección offline enlazada.
El siguiente paso es aprobar el plan por fases y registrar decisiones antes de implementar. Cada fase debe conservar rollback propio, evidencia real y revisión independiente; un fallo de validación nunca debe publicar un candidato.
