# SiraGPT — Sandbox de Edición de Documentos
## Especificación de implementación y protocolo de verificación

**Versión:** 1.0 · **Fecha:** septiembre 2026 · **Propietario:** Sira
**Dirigido a:** el agente de desarrollo (Claude Code u otro agente de código). Léelo completo antes de escribir una sola línea.

---

## 0. Cómo debes trabajar

### 0.1 Antes de codificar
1. Lee este documento completo. Si algo contradice el estado real del repositorio, prevalece el repositorio y lo anotas en `docs/specs/doc-sandbox/decisiones.md`.
2. Explora el repositorio y escribe `docs/specs/doc-sandbox/00-contexto-repo.md` con: estructura real de Next.js y Express, cómo se autentica, cómo se suben archivos hoy, si ya existe BullMQ u otra cola, storage actual, convenciones de nombres y carpetas, cómo se corren tests y migraciones, variables de entorno existentes.
3. Verifica cada API externa contra su documentación oficial (§15) **antes** de usarla. Si una firma del SDK no coincide con lo que este documento sugiere, manda la documentación, no este documento, y déjalo escrito.
4. Presenta un plan por fase: archivos a crear/modificar, migraciones, dependencias nuevas, riesgos, estimación. **Espera aprobación explícita** antes de implementar.

### 0.2 Durante la implementación
- Fases en orden (§8). Una fase no empieza hasta que la anterior tenga tests en verde, reporte de cierre (§12) y aprobación.
- Una rama por fase (`feat/doc-sandbox-fase-1`). Commits pequeños y descriptivos.
- No toques código ajeno al módulo salvo que sea imprescindible; si lo haces, explícalo en el reporte.
- TypeScript estricto, sin `any` sin justificación escrita, errores tipados, logs estructurados con `job_id`, migraciones reversibles, `.env.example` actualizado.
- Cada decisión de diseño no cubierta aquí se documenta en `decisiones.md` (contexto, opciones, decisión, consecuencias).

### 0.3 Prohibiciones
- Simular, mockear, desactivar o "stubear" la validación (§5) en código de producción.
- Afirmar que algo funciona sin haberlo ejecutado. Toda afirmación en un reporte va acompañada del comando ejecutado y su salida real.
- Dejar TODOs en rutas críticas (validación, seguridad, rollback, borrado de datos).
- Secretos en código o commits. Solo variables de entorno.
- Inventar endpoints, parámetros o comportamientos de SDKs o librerías.
- Reducir alcance en silencio. Si algo no es viable, se reporta con motivo y alternativa.

---

## 1. Objetivo y principios no negociables

**Objetivo.** Un usuario sube un documento (Word, Excel, PowerPoint, PDF, texto), escribe qué quiere cambiar, y SiraGPT devuelve **el mismo archivo** con únicamente esos cambios aplicados, verificados, procesados en segundo plano y con un reporte de qué cambió.

**Principios.**
1. **Edición quirúrgica.** El documento nunca se regenera. Se abre el original, se modifican los nodos exactos (XML en Office, objetos en PDF, líneas en texto) y se reempaqueta.
2. **Nada se entrega sin validar.** Todo resultado pasa los 5 niveles de §5. Si uno falla, el usuario recibe un error explicado; nunca un archivo dudoso.
3. **El formato solo cambia si se pide.** Modo `preserve` por defecto. Cambios de formato únicamente en modo `reformat` explícito.
4. **Trazabilidad.** Cada job deja: plan de edición, scripts ejecutados (receta reproducible), reporte de validación, reporte de cambios y consumo/costo.
5. **Aislamiento.** El código que toca documentos corre en un sandbox sin red, efímero, con límites de recursos. La validación corre fuera del sandbox, en el worker.
6. **Motor intercambiable.** La orquestación no sabe qué sandbox hay detrás. Motor A (API de Anthropic) y Motor B (Docker propio) implementan la misma interfaz.

---

## 2. Alcance y modos

| Área | v1 (Fases 1–3) | v2 (Fases 4–5) |
|---|---|---|
| Formatos | docx, xlsx/xlsm, pptx, pdf (operaciones estructurales + micro-ediciones), md, txt, csv, json, html | odt/ods/odp, doc/xls/ppt (vía conversión), imágenes, PDF escaneado (OCR) |
| Modos | `preserve`, `tracked_changes` (docx), `approval` | `reformat`, `batch` |
| Motor | A (Anthropic) | B (Docker propio) con validación visual completa |

**Fuera de alcance permanente (siempre con aviso al usuario):** reescritura de párrafos en PDF sin fuente editable con fidelidad perfecta; Google Docs/Sheets nativos.

**Modos.**
- `preserve` (default): solo contenido; formato intacto.
- `tracked_changes`: igual que `preserve`, pero en docx los cambios quedan como control de cambios (`w:ins` / `w:del`, autor `SiraGPT`, fecha ISO, ids únicos).
- `approval`: el agente produce el plan de edición y se detiene; el usuario aprueba o edita el plan y recién entonces se ejecuta.
- `reformat`: el usuario pide explícitamente cambios de formato; se levantan las prohibiciones de §4 solo para lo pedido.
- `batch`: una instrucción sobre N archivos; un job padre y N jobs hijo.

---

## 3. Arquitectura objetivo

```
Next.js (UI) ──HTTP/SSE──▶ Express API ──▶ Postgres (jobs, eventos, artefactos)
                                   │
                                   ├──▶ Redis: BullMQ (cola doc-edit) + pub/sub (eventos)
                                   │
                                   └──▶ Storage S3-compatible (originales, salidas, reportes)
                                                      ▲
Worker (Node) ◀── consume cola ── ejecuta ──▶ SandboxEngine (A: Anthropic | B: Docker)
   └── Validación de 5 niveles (§5): siempre en el worker, nunca dentro del sandbox
```

### 3.1 Módulos (adaptar rutas a la estructura real; mantener la separación)
```
server/modules/doc-sandbox/
  api/          rutas Express + validación de entrada (zod)
  queue/        producer + worker BullMQ
  engine/       SandboxEngine (interfaz), anthropicEngine, dockerEngine
  agent/        prompts versionados, loader de skills, loop de herramientas (Motor B)
  validation/   structural.ts, openability.ts, visual.ts, textual.ts, orchestrator.ts (+ helpers Python)
  storage/      adapter S3, cifrado, retención
  events/       pub/sub → SSE
  skills/       SKILL.md propios + scripts
  types/        Job, EditPlan, AgentResult, ValidationReport, Artifact
app/(dashboard)/documentos/   páginas y componentes de UI
```

### 3.2 Interfaz del motor
```ts
export interface SandboxEngine {
  createSession(job: Job): Promise<SandboxSession>;
  uploadInputs(session: SandboxSession, files: InputFile[]): Promise<void>;
  run(session: SandboxSession, req: RunRequest, onEvent: (e: JobEvent) => void): Promise<RunResult>;
  downloadOutputs(session: SandboxSession): Promise<Artifact[]>;
  destroy(session: SandboxSession): Promise<void>;
}

export interface RunRequest {
  instructions: string;
  mode: 'preserve' | 'tracked_changes' | 'approval' | 'reformat';
  formats: string[];            // extensiones detectadas por sniffing, no por nombre
  skills: string[];             // lista estable, ordenada (§8.1.2)
  modelTier: 'mechanical' | 'academic';
  budget: { maxTurns: number; maxTokens: number; timeoutMs: number };
  approvedPlan?: EditPlan;      // solo en la segunda vuelta del modo approval
}

export interface RunResult {
  editPlan: EditPlan;           // parseado de edit_plan.json; obligatorio
  agentResult: AgentResult;     // parseado de result.json; obligatorio
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  transcript: JobEvent[];
}
```

### 3.3 Datos
- `doc_jobs`: `id, user_id, status, mode, engine, model_tier, instructions, input_keys[], output_keys[], edit_plan jsonb, validation_report_key, error jsonb, usage jsonb, cost_usd, attempts, session_ref, parent_job_id, prompt_version, created_at, started_at, finished_at, expires_at`.
- `doc_job_events`: `id, job_id, ts, type, payload jsonb`. Tipos: `status_changed`, `phase`, `agent_message`, `tool_call`, `validation_level`, `warning`, `error`.
- `doc_job_artifacts`: `id, job_id, kind, storage_key, mime, size, sha256, created_at`. Kinds: `input`, `output`, `edit_plan`, `recipe`, `agent_result`, `validation_report`, `thumbnail_before`, `thumbnail_after`, `text_diff`.

**Estados:** `queued → inspecting → planning → awaiting_approval → editing → validating → done | failed | cancelled`.
Las transiciones se implementan como máquina de estados explícita; una transición inválida lanza error; toda transición emite un evento.

### 3.4 Endpoints (todos autenticados; el usuario solo ve sus propios jobs)
| Método y ruta | Entrada | Salida |
|---|---|---|
| `POST /api/docs/jobs` | multipart: `files[]`, `instructions`, `mode`, `modelTier?` | `{ jobId }` |
| `GET /api/docs/jobs/:id` | — | estado, plan, artefactos, usage, error |
| `GET /api/docs/jobs/:id/events` | SSE; soporta `Last-Event-ID` para reconexión | stream de eventos |
| `POST /api/docs/jobs/:id/approve` | `{ editPlan }` (posiblemente editado por el usuario) | `{ ok }` |
| `POST /api/docs/jobs/:id/followup` | `{ instructions }` | `{ jobId }` hijo; reutiliza la sesión si sigue viva |
| `GET /api/docs/jobs/:id/artifacts/:artifactId` | — | URL firmada con TTL ≤ 10 min |
| `POST /api/docs/jobs/:id/cancel` | — | `{ ok }` |
| `DELETE /api/docs/jobs/:id` | — | borra fila y todos los artefactos del storage |

---

## 4. Prompt del sistema del agente editor (contrato)

Se versiona en `agent/prompts/editor.system.md`; el job registra `prompt_version`. Puedes mejorarlo; no puedes debilitarlo. Las variables `{{mode}}`, `{{filename}}`, `{{workdir}}` se interpolan.

```
Eres el motor de edición de documentos de SiraGPT. Recibes el archivo {{filename}} y una
instrucción del usuario. Tu trabajo es devolver EL MISMO archivo con únicamente los cambios pedidos.
Modo activo: {{mode}}.

REGLAS ABSOLUTAS
1. Nunca regeneres el documento desde cero ni lo reconstruyas con una librería que reescribe el
   archivo completo (python-docx, openpyxl, python-pptx solo sirven para LEER).
2. Edita en el nivel más bajo posible: XML en OOXML/ODF, objetos en PDF, líneas en formatos planos.
3. Toca solo los nodos necesarios. Conserva estilos, fuentes, tamaños, colores, numeración, tablas,
   imágenes, encabezados, pies, notas, márgenes, secciones, metadatos y propiedades del documento.
4. Prohibido modificar styles.xml, numbering.xml, settings.xml, theme/, slideLayouts/, slideMasters/,
   [Content_Types].xml, archivos .rels, estilos de celda y formato condicional, salvo que el modo sea
   reformat y el usuario lo haya pedido explícitamente.
5. Si la instrucción es ambigua entre cambiar contenido y cambiar formato, asume contenido y deja la
   duda en result.json → warnings.
6. Si algo no se puede hacer conservando el formato, NO lo hagas a medias: regístralo en
   edit_plan.json → not_possible con el motivo y deja el archivo intacto en esa parte.
7. El archivo de salida se guarda en {{workdir}}/out/ con el MISMO nombre que el original.

FLUJO OBLIGATORIO
A. Inspección: desempaqueta (unzip) en {{workdir}}/unpacked/, inventaría las partes, extrae el texto
   de cada parte (cuerpo, encabezados, pies, notas, comentarios, cuadros de texto, notas del orador,
   hojas), y ubica exactamente dónde vive el contenido que hay que cambiar.
B. Plan: escribe {{workdir}}/edit_plan.json (esquema abajo). Si el modo es approval, DETENTE aquí.
C. Ejecución: aplica cada edición con un script guardado en {{workdir}}/recipe/NN_descripcion.py,
   uno por edición o grupo lógico. Jamás edites a mano el XML completo ni uses un editor interactivo.
D. Autoverificación: reempaqueta conservando el orden de partes y la compresión; comprueba que el
   archivo abre (por ejemplo, listado del zip + parseo XML de las partes tocadas); vuelve a extraer el
   texto y compáralo con el plan: cada edición aplicada, nada más cambiado.
E. Resultado: escribe {{workdir}}/result.json (esquema abajo).

REGLAS POR FORMATO (el skill del formato tiene el detalle; esto es lo mínimo)
DOCX  El texto está en w:t dentro de w:r. Word parte una misma frase en varios runs: une el texto
      de los runs del párrafo, localiza la cadena y reescribe conservando el w:rPr del primer run
      afectado; elimina los runs sobrantes solo si quedaron vacíos. Revisa header*.xml, footer*.xml,
      footnotes.xml, endnotes.xml, comments.xml y w:txbxContent. En modo tracked_changes: lo
      eliminado va en w:del > w:r > w:delText y lo nuevo en w:ins > w:r > w:t, con
      w:author="SiraGPT", w:date en ISO 8601 y w:id únicos en todo el documento.
XLSX  Los textos están en sharedStrings.xml (celdas con t="s") o inline (t="inlineStr"). Si un
      shared string lo usan varias celdas y solo debes cambiar una, crea un string nuevo y apunta
      esa celda al nuevo índice; nunca edites el compartido. Conserva el atributo s de cada celda.
      Si cambias entradas de fórmulas, borra los <v> cacheados de las celdas dependientes o activa
      fullCalcOnLoad="1" en workbook.xml/calcPr. Conserva intactos vbaProject.bin, charts/,
      drawings/, pivotCache/, tables/, comentarios y validaciones.
PPTX  El texto está en a:t dentro de a:r en slides/slideN.xml y notesSlides/notesSlideN.xml.
      Conserva a:rPr. No toques slideLayouts ni slideMasters. Para reordenar diapositivas edita
      p:sldIdLst y las relaciones; para eliminar una, quita también su rel y su entrada en
      [Content_Types].xml (única excepción permitida).
PDF   Operaciones estructurales (unir, dividir, rotar, marca de agua, numeración, formularios,
      anotaciones, metadatos, redacción) con pypdf/qpdf y guardado incremental. Micro-ediciones de
      texto con PyMuPDF: search_for → redacción del área → insert_text con la misma fuente (si está
      embebida y es extraíble) y el mismo tamaño, solo si el nuevo texto cabe en la misma línea.
      Cambios que requieran reflujo de párrafo: no los hagas; regístralos en not_possible con
      "requiere fuente editable (.docx de origen)".
PLANO Edita respetando codificación, finales de línea, indentación y estructura (csv: delimitador y
      comillas; json: indentación y orden de claves; md: sintaxis existente).

ESQUEMA edit_plan.json
{
  "file": "tesis.docx",
  "mode": "preserve",
  "edits": [
    { "id": 1, "part": "word/document.xml", "locator": "paragraph[42]",
      "before": "texto exacto anterior", "after": "texto exacto nuevo",
      "reason": "corrección pedida por el usuario", "page_hint": 7 }
  ],
  "not_possible": [ { "request": "…", "reason": "…" } ]
}

ESQUEMA result.json
{
  "output_file": "out/tesis.docx",
  "edits_applied": [1, 2], "edits_failed": [],
  "pages_affected": [7], "parts_modified": ["word/document.xml"],
  "warnings": [],
  "self_check": { "opened_ok": true, "text_diff_matches_plan": true }
}
Si edit_plan.json o result.json faltan o no cumplen el esquema, el job será rechazado.
```

---

## 5. Validación de 5 niveles (obligatoria en todo job, en el worker)

Implementar en `validation/` como funciones puras que reciben rutas al original, al resultado y al `EditPlan`, y devuelven un `ValidationLevelResult { level, passed, details, durationMs }`. El `orchestrator` ejecuta los cinco en orden, corta al primer fallo y persiste `validation_report.json` como artefacto **siempre**, pase o falle. Sin flag, variable de entorno ni modo que permita saltarlos en producción.

**Nivel 1 — Estructural (OOXML/ODF).**
- El ZIP se lista sin error; ninguna entrada contiene `..` ni ruta absoluta (zip-slip); tamaño descomprimido ≤ 20× el comprimido y ≤ límite absoluto (zip bomb).
- Cada XML de las partes existentes parsea (helper Python con lxml).
- Conjunto de partes idéntico al original, salvo las declaradas en `parts_modified` o las esperadas por el modo (p. ej. eliminación de diapositiva).
- Hash SHA-256 por parte: todas las partes no declaradas en `parts_modified` deben ser **byte-idénticas** al original.
- `[Content_Types].xml` referencia todas las partes existentes y ninguna inexistente.
- xlsx: mismas partes `charts/`, `drawings/`, `pivotCache/`, `tables/`, `vbaProject.bin` (si existía) con hash idéntico.
- pdf: `qpdf --check` sin errores; número de páginas igual al original salvo operación estructural declarada.

**Nivel 2 — Apertura.** `soffice --headless --convert-to pdf --outdir <tmp> <resultado>` con timeout de 120 s: exit 0 y PDF generado. Registrar número de páginas (`pdfinfo`). Para xlsx, además: recalcular con LibreOffice y comprobar que ninguna celda con fórmula devuelve error nuevo (`#REF!`, `#NAME?`, `#VALUE!`) que no existiera en el original.

**Nivel 3 — Visual.** Renderizar original y resultado a PNG a 72 dpi (`pdftoppm`, a partir de los PDF del nivel 2). Comparar página a página con `pixelmatch` (o Pillow `ImageChops`). Regla: en páginas **no** listadas en `pages_affected`, el porcentaje de píxeles distintos debe ser ≤ `DOC_SANDBOX_VISUAL_TOLERANCE` (default 0,05 %, tolerancia de antialiasing); en páginas afectadas se registra el porcentaje pero no bloquea. Si el número de páginas cambió sin estar justificado por el plan → fallo. Guardar miniaturas antes/después de páginas afectadas como artefactos.

**Nivel 4 — Textual.** Extraer texto por parte antes y después (docx: todos los `w:t`/`w:delText` por parte; xlsx: valores por celda y hoja; pptx: `a:t` por diapositiva y nota; pdf: `pdftotext -layout`; planos: contenido). Diff línea a línea. **Cada hunk del diff debe corresponder a una edición del plan** (`before` ⊂ texto eliminado, `after` ⊂ texto insertado). Hunks sin edición asociada → fallo con el hunk en el reporte. Ediciones del plan marcadas como aplicadas pero sin hunk → fallo. Guardar el diff como artefacto.

**Nivel 5 — Rollback y reintento.** Si cualquier nivel falla: se descarta el resultado, se parte de la copia prístina del original, se vuelve a ejecutar el motor inyectando el reporte de fallo como contexto ("intento N fallado por: …") y `attempts++`. Máximo 3 intentos. Si el tercero falla → `failed` con el reporte completo y mensaje legible para el usuario. **Nunca** se entrega un archivo que no pasó los cuatro niveles anteriores.

**Test de fuego (obligatorio en CI):** instrucción "No cambies nada; solo confirma que puedes leer el documento" → el resultado debe ser idéntico al original por hash de cada parte (OOXML) o byte a byte (resto).

---

## 6. Seguridad y privacidad
- Auth en todos los endpoints; comprobación de propiedad del job en cada acceso (403 si no es dueño); rate limit por usuario en `POST /jobs`.
- Tipo de archivo por sniffing de contenido (`file-type` o magic bytes), no por extensión. Extensión que no coincide con el contenido → rechazo con mensaje claro.
- Límites configurables: tamaño por archivo (default 50 MB), archivos por job (default 10), páginas (default 500).
- Protección zip-slip y zip bomb en el worker antes de cualquier procesamiento (§5 nivel 1 se ejecuta también sobre el **input**).
- Macros (`.docm`, `.xlsm`, `.pptm`): se conservan intactas, nunca se ejecutan; el usuario ve un aviso.
- Cifrado en reposo (SSE del bucket o cifrado a nivel de aplicación); URLs firmadas con TTL ≤ 10 min; nunca URLs públicas.
- Retención: `DOC_SANDBOX_RETENTION_DAYS` (default 30); job cron diario que borra artefactos y filas vencidas; `DELETE` inmediato a petición del usuario. Con Motor A, borrar los archivos subidos a la Files API al cerrar el job (best-effort, registrado en log).
- Logs sin contenido de documentos ni instrucciones completas (solo longitudes y hashes). Los transcripts del agente se guardan como artefacto cifrado, no en logs.
- Motor B: `--network none`, rootfs de solo lectura, tmpfs `/work`, usuario sin privilegios, `--cap-drop ALL`, `--security-opt no-new-privileges`, límites de memoria/CPU/pids, timeout duro con `kill`, contenedor destruido al terminar; runtime gVisor si se procesan jobs de usuarios no verificados.
- Secretos solo por entorno; `.env.example` documenta cada variable con su default.

## 7. Observabilidad y costos
- Logs estructurados (JSON) con `job_id`, `user_id`, `phase`, `engine`, `attempt`.
- Métricas por job: duración por fase, tokens (input/output/cache), costo USD, resultado por nivel de validación, número de intentos, tamaño del archivo.
- Métricas agregadas expuestas (Prometheus o tabla de métricas): tasa de éxito, p50/p95 de duración, costo medio, tasa de rollback, fallos por nivel.
- Alerta si la tasa de fallo en ventana de 1 h supera el 20 % o si un job supera `timeoutMs`.
- El costo por job se muestra al usuario en la UI si `DOC_SANDBOX_SHOW_COST=true`.

---

## 8. Plan por fases

### Fase 1 — Núcleo + Motor A (Anthropic)
**Entregable:** subir docx/xlsx/pptx/pdf, editar con Motor A en modo `preserve`, validar niveles 1, 4 y 5 (2 y 3 si LibreOffice ya está en la imagen del worker), descargar, ver lista de cambios. Sin modo `approval` todavía.

#### 8.1.1 Integración con la API de Anthropic
Verifica cada punto en la documentación (§15) antes de implementar; los nombres exactos de parámetros pueden haber cambiado y ese es tu problema, no un motivo para asumir.
1. Subir el archivo con la Files API (`client.beta.files.upload`, beta `files-api-2025-04-14`); guardar `file_id` en la sesión.
2. Llamar a `client.beta.messages.create` con:
   - `model` según `modelTier` (§8.1.3);
   - `betas: ['code-execution-2025-08-25', 'files-api-2025-04-14']`;
   - `container: { skills: [...] }` con la lista de §8.1.2, siempre en el mismo orden (caché de prompt);
   - `tools: [{ type: 'code_execution_20260521', name: 'code_execution' }]`;
   - `system`: prompt de §4 interpolado, con `cache_control` en el bloque de sistema;
   - `messages[0].content`: `[{ type: 'container_upload', file_id }, { type: 'text', text: instrucciones }]`.
3. Procesar la respuesta: recorrer los bloques; de los resultados de code execution extraer los `file_id` de los archivos creados (documento editado, `edit_plan.json`, `result.json`, scripts de `recipe/`); descargar con `client.beta.files.download`; guardar el `container.id` para follow-ups. Si el contenedor expiró, crear sesión nueva y volver a subir.
4. Mapear `usage` a costo con una tabla de precios en configuración; guardarlo en el job.
5. Al cerrar el job, borrar los archivos subidos con la Files API (best-effort).

#### 8.1.2 Mapa extensión → skills (lista estable, orden alfabético)
| Formato detectado | skills |
|---|---|
| docx | `['docx']` |
| xlsx / xlsm | `['xlsx']` |
| pptx | `['pptx']` |
| pdf | `['pdf']` |
| varios (batch) | unión ordenada alfabéticamente |
| md / txt / csv / json / html | `[]` (solo code execution) |

#### 8.1.3 Niveles de modelo
- `mechanical` (reemplazos, correcciones puntuales, operaciones PDF estructurales): modelo Sonnet vigente.
- `academic` (reescrituras, parafraseo, redacción de secciones): modelo Opus vigente.
- Clasificador de la instrucción con Haiku; ante duda, `academic`.
Los IDs de modelo y precios viven en configuración (`DOC_SANDBOX_MODEL_MECHANICAL`, `DOC_SANDBOX_MODEL_ACADEMIC`, `DOC_SANDBOX_MODEL_CLASSIFIER`), nunca hardcodeados.

#### 8.1.4 Criterios de fase
Todo lo de §11 marcado "F1", más: 10 jobs concurrentes sin cruce de archivos (test), test de fuego en verde, costo registrado en cada job.

### Fase 2 — Validación completa y experiencia de resultado
- LibreOffice + poppler + qpdf en la imagen del worker; niveles 2 y 3 obligatorios para docx/xlsx/pptx/pdf.
- Miniaturas antes/después y diff textual como artefactos y en la UI.
- Modo `tracked_changes`: contar `w:ins`/`w:del` en el resultado; deben corresponder a las ediciones del plan.
- Nivel 5 probado con fallo inducido (fixture que dispara fallo del nivel 4 en el intento 1 y éxito en el 2).

### Fase 3 — Aprobación, follow-ups, batch, UI completa
- Modo `approval` con edición del plan en la UI (el usuario puede quitar o cambiar `after` de cada edición).
- Follow-up reutilizando la sesión; chat de seguimiento por job.
- Modo `batch` con job padre y progreso agregado.
- Skills propios de SiraGPT subidos como custom skills (procedimientos de parafraseo, matrices, formato de universidades) — cada uno con su propio golden test.

### Fase 4 — Motor B (sandbox propio en Docker)
**Imagen** `siragpt/doc-sandbox` (esbozo; ajustar versiones):
```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip nodejs npm unzip zip \
    libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
    poppler-utils qpdf tesseract-ocr tesseract-ocr-spa ocrmypdf \
    fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages lxml python-docx openpyxl python-pptx pypdf pymupdf pdfplumber pillow defusedxml
RUN useradd -m -u 1000 sandbox
COPY skills/ /opt/skills/
USER sandbox
WORKDIR /work
```
**Ejecución por job:**
```
docker run --rm --network none --read-only --tmpfs /work:rw,size=2g,uid=1000 \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 256 siragpt/doc-sandbox:<tag>
```
- `dockerEngine` con dockerode: copia el input a `/work/in/`, ejecuta cada herramienta del agente como `docker exec`, recoge `/work/out/`, `/work/edit_plan.json`, `/work/result.json`, `/work/recipe/`.
- Loop del agente con la Messages API y herramientas cliente `bash`, `view`, `create_file`, `str_replace` (salidas truncadas a 20 KB, `maxTurns` respetado, `cache_control` en el sistema). Skills: los de documentos del repositorio abierto `anthropics/skills` vendorizados en `skills/vendor/` respetando su licencia, más los propios en `skills/siragpt/`; se carga en el sistema solo el `SKILL.md` del formato detectado (revelación progresiva).
- Pool de 2–4 contenedores calientes; timeout duro por job; destrucción garantizada aunque el worker falle (reconciliador al arrancar).
- Los mismos golden tests de §10 deben pasar con `engine=docker`. La selección de motor es por configuración (`DOC_SANDBOX_ENGINE=anthropic|docker`) y por job.

### Fase 5 — Formatos v2
ODF (`content.xml`; `mimetype` primero y sin comprimir al reempaquetar), `.doc/.xls/.ppt` vía conversión de ida y vuelta con LibreOffice y aviso de posible pérdida, imágenes con Pillow, PDF escaneado con OCR previo (ocrmypdf) y ediciones como capa superpuesta.

---

## 9. Frontend (Next.js)
- Página `documentos`: subida múltiple (drag & drop), caja de instrucciones, selector de modo con tres interruptores visibles (conservar formato — fijo en on salvo `reformat`; control de cambios; aprobar antes de ejecutar), selector de nivel de modelo.
- Vista de job: línea de tiempo en vivo por SSE (fases y mensajes del agente en lenguaje claro, sin exponer comandos salvo en un panel "detalle técnico" plegado), estado de cada nivel de validación, lista de cambios (antes/después por edición), miniaturas antes/después, botón de descarga, costo, y chat de seguimiento.
- Modo `approval`: tabla editable del plan con aprobar/quitar por edición y botón "Ejecutar".
- Estados de error legibles: qué nivel falló y por qué, con opción "Reintentar con otra instrucción".
- Reconexión SSE automática; la vista se rehidrata desde `GET /jobs/:id` al recargar.

---

## 10. Pruebas obligatorias

### 10.1 Fixtures (`test/fixtures/docs/`)
Genéralas por script (`test/fixtures/build.ts` + helpers Python) para que sean reproducibles, y complétalas con 3–5 documentos reales anonimizados que Sira entregará (tesis .docx con formato de universidad, matriz .xlsx con fórmulas y gráfico, presentación de defensa .pptx). Mínimo:
- `tesis.docx`: encabezado, pie con numeración, notas al pie, lista numerada, tabla, imagen, cuadro de texto, y al menos una frase partida en 3 runs con formato distinto (negrita a mitad de frase).
- `presupuesto.xlsx`: dos hojas, fórmulas dependientes entre hojas, gráfico, formato condicional, celdas combinadas, un shared string usado por varias celdas.
- `macros.xlsm`: con `vbaProject.bin`.
- `defensa.pptx`: 8 diapositivas, notas del orador, imagen, layouts distintos.
- `informe.pdf`: texto con fuente embebida + formulario; `escaneado.pdf`: solo imagen.
- `corrupto.docx`, `zipbomb.docx`, `zipslip.docx`, `fake.docx` (PDF renombrado), `grande.docx` (> límite).

### 10.2 Unitarios (cobertura ≥ 80 % del módulo)
- Helpers OOXML: unión de runs, localización de texto, creación de shared string nuevo, inserción de `w:ins`/`w:del`, reempaquetado con orden y compresión.
- Cada nivel de validación con casos que pasan y que fallan; máquina de estados; parseo y validación de esquemas `edit_plan`/`result`; mapeo extensión→skills; cálculo de costo; sniffing de tipo.
- Adapters de motor con SDK mockeado (solo aquí se permite mockear, y solo el SDK, nunca la validación).

### 10.3 Integración / golden (motor real, ejecutados en CI con credenciales de test)
| # | Fixture | Instrucción | Aserciones |
|---|---|---|---|
| G1 | tesis.docx | reemplazar la frase partida en 3 runs | texto nuevo presente; `w:rPr` del primer run conservado; todas las demás partes con hash idéntico; nivel 3 ≤ tolerancia fuera de la página afectada |
| G2 | tesis.docx | corregir texto del pie y de la nota al pie 2 | cambios en `footer1.xml` y `footnotes.xml`; `document.xml` idéntico |
| G3 | tesis.docx, `tracked_changes` | reescribir dos párrafos | número de `w:ins`/`w:del` = ediciones del plan; LibreOffice abre; texto aceptado = `after` |
| G4 | presupuesto.xlsx | cambiar tres valores de entrada | dependientes recalculados o `fullCalcOnLoad`; `charts/chart1.xml` idéntico; sin errores nuevos |
| G5 | presupuesto.xlsx | renombrar el encabezado de una sola celda que comparte string | solo esa celda cambia; las otras que usaban el string, intactas |
| G6 | macros.xlsm | cambiar un valor | `vbaProject.bin` idéntico; aviso de macros en la UI |
| G7 | defensa.pptx | cambiar título de la diapositiva 3 y su nota | solo `slide3.xml` y `notesSlide3.xml` cambian; layouts idénticos |
| G8 | informe.pdf | unir con otro PDF, numerar páginas, marca de agua | `pdftotext` del contenido original idéntico; páginas = suma |
| G9 | informe.pdf | cambiar una fecha en una línea | solo esa línea cambia en `pdftotext`; nivel 3 ≤ tolerancia en otras páginas |
| G10 | escaneado.pdf | reescribir un párrafo | `not_possible` con motivo; archivo intacto; job `done` con warning, no `failed` |
| G11 | cualquiera | "No cambies nada" | test de fuego: hashes idénticos |
| G12 | tesis.docx | mismo cambio dos veces (follow-up) | segunda ejecución sin hunks: idempotencia |

### 10.4 Negativos y resiliencia
Corrupto, zip bomb, zip-slip, extensión falsa, tamaño excedido → rechazo con mensaje claro y sin procesamiento. Timeout del motor → `failed` limpio y sandbox destruido. Fallo inducido de validación → rollback, 2.º intento, éxito. Caída del worker a mitad de job → job vuelve a `queued` y el contenedor huérfano se limpia. Acceso a job ajeno → 403.

### 10.5 Carga
10 jobs concurrentes con fixtures distintas: ningún resultado contiene contenido de otro job; p95 dentro del objetivo definido en `decisiones.md`.

---

## 11. Definition of Done (por fase; marcar con evidencia)
- [ ] F1 Módulo con la estructura de §3.1 y la interfaz de §3.2; motor seleccionable por configuración.
- [ ] F1 Migraciones reversibles para las tres tablas; máquina de estados con tests.
- [ ] F1 Endpoints de §3.4 con auth, ownership, zod y rate limit.
- [ ] F1 Motor A integrado y verificado contra la documentación; costo y usage por job.
- [ ] F1 Niveles 1, 4 y 5 en producción, no desactivables; `validation_report.json` en cada job.
- [ ] F1 Test de fuego (G11) y G1, G4, G7, G8 en verde con motor real.
- [ ] F1 Negativos de §10.4 en verde; concurrencia de §10.5 en verde.
- [ ] F2 Niveles 2 y 3 en producción; miniaturas y diff como artefactos; G2, G3, G5, G6, G9, G10, G12 en verde.
- [ ] F2 Rollback probado con fallo inducido; `tracked_changes` verificado.
- [ ] F3 Modo `approval`, follow-up con reutilización de sesión, `batch`, UI completa de §9 con SSE reconectable.
- [ ] F3 Skills propios con golden test cada uno.
- [ ] F4 Motor B pasa todos los golden con `engine=docker`; flags de aislamiento verificados con test que intenta acceso a red y falla.
- [ ] Siempre: lint y typecheck limpios; cobertura ≥ 80 %; sin TODOs críticos; `.env.example` completo; README del módulo con runbook (cómo desplegar, cómo depurar un job, cómo rotar claves, cómo purgar datos).
- [ ] Siempre: reporte de cierre (§12) con evidencia real.

---

## 12. Reporte de cierre de fase (formato obligatorio)
Archivo `docs/specs/doc-sandbox/reporte-fase-N.md` con exactamente estas secciones:
1. **Qué se implementó** — lista de archivos creados/modificados con una línea de propósito cada uno.
2. **Cómo se probó** — cada comando ejecutado y su salida real pegada (tests, lint, typecheck, e2e). Salidas truncadas indican dónde y por qué.
3. **Evidencia de validación** — rutas a `validation_report.json` de al menos 5 jobs reales, miniaturas antes/después, diffs.
4. **Decisiones tomadas** — referencia a entradas en `decisiones.md`.
5. **Desviaciones respecto a la especificación** — qué, por qué, impacto, propuesta.
6. **Limitaciones conocidas y riesgos** — con severidad.
7. **Checklist de §11** — cada ítem con ✅/❌ y enlace a su evidencia.
8. **Pendientes para la siguiente fase.**
Prohibido reportar como hecho algo que no se ejecutó. Un ítem sin evidencia cuenta como no hecho.

---

## 13. Protocolo de corroboración (para Sira, en cada fase)
1. **Lectura del reporte.** Cada afirmación tiene comando y salida. Si falta, la fase se devuelve sin revisar más.
2. **Reproducción.** `git checkout <rama>`, instalar dependencias, migraciones en base limpia, `npm run lint && npm run typecheck && npm test && npm run test:e2e:docs`. Todo en verde en tu máquina, no en la del agente.
3. **Prueba manual con 5 documentos reales** (una tesis docx, una matriz xlsx, una defensa pptx, dos PDF): abrirlos después en Word, Excel y PowerPoint en el Mac; no debe aparecer "reparar"; control de cambios visible en docx; fórmulas y gráficos intactos en xlsx; notas del orador en pptx; comparación visual página a página de al menos una página no afectada.
4. **Test de fuego a mano.** "No cambies nada" con tu tesis más compleja → descargar y comparar hashes por parte (`unzip -l` + `sha256sum` de cada parte).
5. **Fallo controlado.** Pedir algo imposible (reescribir un párrafo de un PDF escaneado) → debe llegar `done` con `not_possible` claro, no un archivo alterado.
6. **Seguridad a mano.** Intentar `GET /api/docs/jobs/<id ajeno>` (403); subir un PDF renombrado a `.docx` (rechazo); subir `zipslip.docx` (rechazo); comprobar que las URLs de descarga expiran.
7. **Costos y logs.** Ver que cada job tiene costo y usage; que ningún log contiene texto de documentos.
8. **Revisión independiente.** Abrir una sesión nueva del agente (sin el contexto del implementador) con el prompt de §14; corregir hallazgos bloqueantes y mayores; repetir hasta cero bloqueantes.
9. Solo entonces: aprobar la fase, mergear y autorizar la siguiente.

---

## 14. Prompt para el agente revisor (sesión independiente)
```
Actúa como revisor senior independiente de la rama <rama>. No confíes en el reporte del implementador.
1. Lee docs/specs/doc-sandbox/SPEC-sandbox-edicion-documentos.md completo.
2. Lee el diff completo de la rama contra main.
3. Ejecuta tú mismo lint, typecheck, tests unitarios y e2e, y pega las salidas.
4. Busca específicamente y reporta con archivo:línea y cómo reproducir:
   - validación mockeada, desactivable o saltable en producción;
   - rutas sin auth o sin comprobación de propiedad; URLs de descarga no firmadas o sin TTL;
   - manejo de errores que traga excepciones; promesas sin await; timeouts ausentes; contenedores o
     archivos temporales que no se destruyen en caso de error;
   - zip-slip / zip bomb sin protección; sniffing de tipo por extensión;
   - secretos en código; `any` sin justificación; TODOs en rutas críticas;
   - desviaciones respecto a la especificación no declaradas en el reporte;
   - afirmaciones del reporte sin evidencia ejecutada;
   - tests que no prueban lo que dicen probar (aserciones débiles, fixtures triviales).
5. Entrega una lista de hallazgos con severidad (bloqueante / mayor / menor). No propongas cambios de
   estilo. No arregles nada: solo reporta.
```

---

## 15. Referencias que el agente debe consultar antes de implementar
- Agent Skills (API): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Inicio rápido de Skills en la API: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/quickstart
- Guía de Skills (caché, versiones, custom skills): https://platform.claude.com/docs/en/build-with-claude/skills-guide
- Code execution tool (contenedores, límites, archivos): https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
- Files API: https://platform.claude.com/docs/en/build-with-claude/files
- Skills de documentos de código abierto (docx, pdf, pptx, xlsx): https://github.com/anthropics/skills
- Mapa de la documentación de la API: https://docs.claude.com/en/docs_site_map.md
