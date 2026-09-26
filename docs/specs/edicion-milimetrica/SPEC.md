# SPEC — Edición milimétrica de Word, Excel y PowerPoint con verificación visual

> **Para:** el agente de código que trabaja en `infosiragpt-ops/SiraGPT-APP` (Claude Code / Codex).
> **Autor del encargo:** Sira · **Fecha:** 2026-09-26 · **Estado:** listo para implementar por fases.
> **Referencia probada:** `docs/specs/edicion-milimetrica/referencia/` (34 pruebas Python del motor y 8 pruebas Node
> contra el sandbox real del repo, driver local; todas verdes con LibreOffice 24.2 + poppler 24.02).
> **Demo visual del resultado:** `ui/timeline-demo.html` (ábrelo en el navegador).

---

## 0. Cómo usar este spec (léelo entero antes de tocar código)

1. Lee primero `CLAUDE.md`, `AGENTS.md`, `ROADMAP.md` y `STATE.md`. Sus reglas mandan sobre este documento:
   - **UI bloqueada** (regla 1 de CLAUDE.md, §1/§18 de AGENTS.md): la Fase E toca UI y **necesita aprobación
     explícita de Luis antes de empezar**. Sin esa aprobación, detente al terminar la Fase D.
   - **Nunca push a `main`.** Cada fase = una rama + un PR a `production-main`, CI verde («CI · required checks
     passed»), squash-merge.
   - **Solo modelos DeepSeek** (regla 8). La verificación con visión usa `deepseek-flash` (acepta imágenes).
   - **Una fase a la vez** (ROADMAP, regla dura 1). Esta pista extiende el contrato de F1 (`render_preview` y la
     regla de verificación). Pide a Luis que la registre en `STATE.md` antes de la Fase A.
2. Trabaja **fase por fase** (A → F). No adelantes trabajo de la fase siguiente.
3. Cada fase termina con su **gate**: los comandos de la sección «Gate» pasan en verde, más
   `git diff --check` y `bash scripts/verify-ui-lock.sh`.
4. El código de `referencia/` **ya funciona**: úsalo como base, no lo reescribas desde cero. Si cambias un
   algoritmo, las pruebas de referencia deben seguir pasando.
5. Honestidad: si un gate no pasa, la fase queda `IN_PROGRESS` en `STATE.md`. Nunca declares éxito sin verificar.

---

## 1. Qué debe lograr el usuario (resultado visible)

El usuario escribe, por ejemplo: «Cambia 2024 por 2025 en la portada y pon el título en negrita, sin tocar nada más».

1. El agente **inspecciona** el archivo y obtiene direcciones exactas (párrafo 8, run rojo «24», título en el párrafo 3).
2. Escribe su **checklist** (qué pidió el usuario + «no cambia nada más»).
3. **Edita quirúrgicamente**: solo cambian esos nodos XML; el resto del paquete queda igual.
4. **Verifica**: renderiza antes y después, compara píxeles, ubica las zonas cambiadas en mm, genera una imagen
   ANTES/DESPUÉS con recuadros y zoom, corre los checks y pide a un modelo de visión que revise la imagen
   contra la checklist.
5. Si algo falla, **corrige solo eso** y vuelve a verificar (máx. 3 intentos). Si no puede, lo dice.
6. En el chat, el usuario ve un **timeline** de íconos grises (documento, terminal, imagen, check) con la frase
   de cada paso, el detalle desplegable y la miniatura de la captura que miró el agente.

Ejemplo real producido por la referencia (`capturas/compare-docx-portada.png`): «Lima, 2024 → 2025» cambia
solo el dígito, dentro del run rojo; la zona detectada mide 2 × 3 mm (x 113–115 mm, y 148–151 mm).

---

## 2. Estado actual del repo (auditoría con rutas)

Todo en `backend/src/services/agent-runner/` salvo que se indique.

| # | Hallazgo | Dónde | Efecto |
|---|---|---|---|
| 1 | `render_preview` usa `soffice --convert-to png`: **solo la 1.ª página/lámina**, sin DPI ni rango | `tools.js` executor `render_preview` | No se puede verificar la página 7 de una tesis |
| 2 | `render_preview` devuelve **solo brillo** (JSON), nunca la imagen | `tools.js` + `PREVIEW_SCRIPT` | El modelo nunca «mira» la captura |
| 3 | `/workspace/previews` **no se limpia** entre turnos; el script de brillo lee todos los `*.png` | `tools.js` | Reporta capturas viejas como si fueran nuevas |
| 4 | El gate acepta cualquier `render_preview` que no empiece con `ERROR:`, incluso `skipped` | `verify.js` `needsVerification` | «Verificado» sin haber renderizado |
| 5 | `execute_python` cuenta como edición aunque solo lea; el propio prompt pide reabrir con `execute_python` después de renderizar | `verify.js` `EDIT_TOOLS` + `prompt.js` regla 3b | El gate se re-arma y fuerza vueltas extra |
| 6 | **Presupuesto de compactación = max(1500, max_tokens) ≈ 2048 tokens.** Con resultados grandes recorta cuerpos a 80–400 caracteres y puede borrar el primer mensaje no-system (el pedido del usuario) | `loop.js` `compactMessagesInPlace` → `engine-adapter.js` `compactUntilTokenBudget` | El modelo pierde el mapa del documento y hasta el pedido literal |
| 7 | `max_tokens` de salida por defecto 2048 | `loop.js` `MAX_TOKENS_DEFAULT`, env `SIRAGPT_AGENT_RUNNER_MAX_TOKENS` | Un lote de parafraseo se corta a la mitad del JSON |
| 8 | Argumentos de tool topados en 32 KiB (se rechazan o se truncan) | `engine-adapter.js` `TOOL_ARG_MAX_BYTES`, `capToolArgBytes32KiB` | Lotes grandes de `office_edit` fallan |
| 9 | Etiquetas fijas: «Ejecutando código» / «Verificando resultado»; `toStageEvent` descarta `args` | `loop.js` evento `tool_call`, `trace.js` | El usuario no sabe qué lee ni qué hace |
| 10 | El reducer del cliente guarda solo `{label, tool}` y fusiona etiquetas iguales | `lib/chat/activity-log.ts` `appendActivity` | Se pierde detalle, estado de error y orden real |
| 11 | El comparador de `React.memo` solo mira `id`, `content` y `files` (probable: el timeline no repinta en vivo) | `components/message-component.tsx` `areMessagePropsEqual` | Pasos que aparecen de golpe al final |
| 12 | Imagen del sandbox de producción sin `poppler-utils` ni fuentes métricas (solo `fonts-dejavu-core`) | `services/sandbox/runner/Dockerfile` | Calibri/Times/Arial se renderizan con otras métricas; no hay `pdftoppm` |
| 13 | Dos Dockerfiles construyen la misma etiqueta `siragpt-doc-sandbox:latest` | `services/sandbox/runner/Dockerfile` y `infra/sandbox/Dockerfile` | Las fuentes en producción dependen de cuál se construyó último |
| 14 | LibreOffice no recalcula fórmulas de xlsx al abrir (modo por defecto «nunca») | perfil de LibreOffice | Verificar totales de Excel da valores viejos |
| 15 | Ya existen piezas buenas fuera del runner: `document-editing/docx-precision-edit.js` (`applyDocxPrecisionEdit`), `xlsx-adapter.js` (`setCellValue`), `pptx-adapter.js`, y el diff de píxeles de `modules/doc-sandbox/validation/validator.py` `visual()` | varios | Reutilizables como referencia; no están expuestos al runner |
| 16 | El hook de imágenes de tools existe y sirve: `result.__f7Image` → `buildImageDataMessage` (mensaje `user` con `image_url`) | `loop.js` hook F7, `multimodal/vision.js` | Base para adjuntar capturas |
| 17 | `TraceRail` / `TraceRailRow` ya dibujan el riel de íconos grises tipo Claude | `components/trace-rail.tsx` | La UI casi existe; faltan los datos |

Verificado en esta auditoría: `enforceAdditionalPropertiesFalse` solo produce una copia del esquema para validar
enums; **no elimina** campos extra de los argumentos. Por eso `office_edit.ops[]` puede declarar solo `op` (enum)
y aceptar los demás campos por operación.

---

## 3. Arquitectura objetivo

```
Usuario ──SSE──► agentic-chat-stream.js ──► AgentRunner (index.js → loop.js)
                         ▲                        │  tool_call(description) / tool_result(thumbs)
                         │ stage v2               ▼
                    trace.js ◄──────────── executors: tools.js + tools.office.js
                                                  │  args en archivo JSON (nunca en el shell)
                                                  ▼
                                   sandbox (gVisor, --network none)
                                   python3 /workspace/tmp/sira_office.py <cmd>
                                     inspect · edit · render · verify · recalc
                                     LibreOffice (perfil propio) · pdftoppm · pdftotext · Pillow
                                                  │ composites PNG + thumbs JPG
                                                  ▼
                         multimodal/visual-verifier.js ──► deepseek-flash (visión)
```

Piezas nuevas:

| Archivo | Rol |
|---|---|
| `agent-runner/sira_office.py` | Motor: inspección con direcciones, edición quirúrgica, render de todas las páginas, diff visual en mm, compuesto con zoom, recálculo de xlsx en copia |
| `agent-runner/tools.office.js` | Definiciones y executors: `inspect_document`, `office_edit`, `render_preview` v2, `verify_visual`; `installOfficeEngine`, `outputsFingerprint`, `KIND_BY_TOOL` |
| `agent-runner/multimodal/visual-verifier.js` | Revisión de la imagen contra la checklist con `deepseek-flash`; `ok:null` si no hay visión |
| `tests/agent-runner-office-tools.test.js` | Pruebas Node contra el sandbox real |
| `tests/python/test_sira_office.py` + `tests/fixtures/office/*` | Pruebas del motor |

---

## 4. Fase A — Motor de oficina en el sandbox

**Objetivo:** que cada sandbox tenga `sira_office.py` y las herramientas y fuentes para renderizar fiel.

### A.1 Archivos

1. **Agregar** `backend/src/services/agent-runner/sira_office.py` ← copia de `referencia/sira_office.py` (sin cambios).
2. **Agregar** `backend/tests/python/test_sira_office.py` ← `referencia/test_sira_office.py`, y
   `backend/tests/python/make_fixtures.py` ← `referencia/make_fixtures.py`.
3. **Agregar** fixtures binarios `backend/tests/fixtures/office/` ← `referencia/fixtures/*`
   (`tesis_demo.docx`, `presupuesto_demo.xlsx`, `defensa_demo.pptx`, `tesis_larga_demo.docx`). En CI se usan con
   `SIRA_FIXTURES_DIR` para no depender de openpyxl/python-pptx.
4. **Modificar** `backend/src/services/agent-runner/index.js`, justo después de escribir `tmp/office_helpers.py`:

```js
const { installOfficeEngine } = require('./tools.office');
// …
try { await installOfficeEngine(sandbox); } catch (_) { /* fail-open: el agente sigue con execute_python */ }
```

   (`tools.office.js` llega en la Fase B; en la Fase A puedes dejar un loader equivalente a `loadOfficeHelpersPy`.)

5. **Modificar** `services/sandbox/runner/Dockerfile` (imagen de producción según `services/sandbox/DEPLOY.md`):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk zip unzip \
      python3 python3-pip \
      libreoffice --no-install-recommends \
      poppler-utils \
      fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir python-docx openpyxl python-pptx pypdf mammoth lxml pandas numpy tabulate pillow
```

6. **Unificar la etiqueta** (hallazgo 13): o bien un solo Dockerfile construye `siragpt-doc-sandbox:latest`, o
   ambos instalan exactamente la misma lista de paquetes y fuentes. Documenta la decisión en `services/sandbox/DEPLOY.md`.

### A.2 Detalles del motor que NO debes romper

- **Perfil propio de LibreOffice** (`_lo_profile`): se crea con `OOXMLRecalcMode=0` y `ODFRecalcMode=0`
  («recalcular siempre al abrir»). Sin eso, verificar totales de Excel devuelve valores viejos (probado: con el
  perfil por defecto una celda `=A1+A2` con caché 999 sigue en 999; con el perfil, 30). Ruta configurable con
  `SIRA_LO_PROFILE`; por defecto en `tempfile.gettempdir()` (en el sandbox es `/tmp`, tmpfs escribible).
- **Atomicidad:** `edit()` no escribe nada si una operación falla.
- **Partes intactas:** solo se re-serializan las partes XML tocadas; el resto se copia con el mismo contenido y orden.
- **Campos protegidos:** texto dentro de campos complejos (citas de Mendeley/Zotero, índices) es `kind='fld'`;
  ninguna operación puede cambiarlo. `set_paragraph_text` aplica un diff palabra a palabra, así una cita que
  sigue igual en el texto nuevo queda intacta.
- **Orden de esquema:** `set_child_ordered` inserta `w:rPr`/`w:pPr`/`a:rPr`/`a:spPr` en el orden del esquema.
- **Diff por canal RGB** (no en gris): un azul→verde de igual luminosidad también se detecta.
- **Documentos largos:** si hay más de 12 páginas, `verify` hace un barrido a 36 ppp de todas + comparación de
  texto por página, y rasteriza a resolución completa solo las candidatas (máx. 8).
- **Micro-desplazamientos de kerning:** al partir un run (p. ej. colorear solo parte de un título), LibreOffice
  re-posiciona glifos vecinos por fracciones de píxel. `page_diff` separa esas zonas con un desenfoque gaussiano de
  1,5 px (medido: ≤16 de diferencia en kerning contra ≥75 en cambios reales) y las reporta como «micro-desplazamiento
  de kerning, sin cambio visible»: no cuentan como página cambiada y se dibujan en ámbar fino en el compuesto.

### A.3 Gate de la Fase A

```bash
cd backend
SIRA_FIXTURES_DIR=$PWD/tests/fixtures/office python3 -m unittest tests/python/test_sira_office.py -v   # 34 OK con soffice/poppler; sin ellos, se saltan solo las de render
docker build -t siragpt-doc-sandbox:test -f ../services/sandbox/runner/Dockerfile ../services/sandbox/runner
docker run --rm siragpt-doc-sandbox:test sh -c 'fc-match Calibri; fc-match "Times New Roman"; fc-match Arial; pdftoppm -v 2>&1 | head -1'
# Esperado: Carlito, Liberation Serif, Liberation Sans y la versión de pdftoppm
```

Registra la prueba Python en CI (shard 1 ya instala LibreOffice, poppler y fuentes; ver `.github/workflows/ci.yml`,
paso «Install real document validators»). Agrega `lxml pillow` al `pip install` de ese paso si no están.

---

## 5. Fase B — Tools del runner

**Objetivo:** que el modelo tenga `inspect_document`, `office_edit`, `render_preview` v2 y `verify_visual`, y que
cada llamada lleve una frase `description` para el usuario.

### B.1 Archivos

1. **Agregar** `backend/src/services/agent-runner/tools.office.js` ← `referencia/node/tools.office.js`.
2. **Agregar** `backend/tests/agent-runner-office-tools.test.js` ← `referencia/node/agent-runner-office-tools.test.js`
   y regístralo en el script `test` de `backend/package.json` (junto a `tests/agent-runner-*.test.js`).
3. **Modificar** `tools.js`:
   - Importa `OFFICE_TOOL_DEFINITIONS` y `makeOfficeToolExecutors`.
   - Nuevo flag `officeEngineEnabled(env)`: `env.SIRAGPT_OFFICE_ENGINE !== '0'` (por defecto encendido).
   - En `buildToolDefinitions`: si el flag está encendido, **reemplaza** la definición vieja de `render_preview` por
     la v2 y agrega las otras tres. Si está apagado, todo queda como hoy.
   - En `makeToolExecutors(sandbox, opts)`: si el flag está encendido, fusiona
     `makeOfficeToolExecutors(sandbox, { visionVerifier: opts.visionVerifier, attachImages: opts.attachImages, thumbs: opts.thumbs })`
     **después** de los executors base (así `render_preview` v2 reemplaza a la v1).
4. **Parámetro `description` en TODAS las tools base** (`execute_python`, `execute_bash`, `read_file`,
   `write_file`, `edit_file`, `list_files`, `glob`, `grep`, `create_presentation`, `set_slide_background`):
   agrega `description: DESCRIPTION_PARAM` (exportado desde `tools.office.js`) a `properties`. Es opcional:
   no lo pongas en `required`. Los executors lo ignoran.
5. **Modificar** `loop.js`, en el `onEvent({ type: 'tool_call', … })`: agrega
   `description: typeof args.description === 'string' ? args.description.slice(0, 120) : undefined` y
   `callId: call && call.id`. Usa la `description` como `label` cuando exista (si no, la etiqueta actual).
   Haz lo mismo con `callId` en el evento `tool_result`.

### B.2 Contratos de las tools (resumen; el esquema exacto está en `tools.office.js`)

| Tool | Argumentos clave | Devuelve al modelo |
|---|---|---|
| `inspect_document` | `path`, `query?`, `start?`, `limit?`, `detail?`, `sheet?`, `slide?`, `scope?` | JSON: docx → `page` (mm), `stats`, `paragraphs[{i, text, style?, table?, has_field?, runs?}]`, `tables`; xlsx → `sheets[{name, dimension, cells[{ref, value, formula?, style?}], merged}]`; pptx → `slide_size_mm`, `slides[{n, layout, shapes[{id, name, kind, placeholder?, x_mm, y_mm, w_mm, h_mm, inherited_position?, text?, font_pt?, fill?}]}]` |
| `office_edit` | `src`, `dst?` (por defecto `outputs/<nombre>-editado.<ext>`, luego `-editado-v2`…), `ops[]`, `track_changes?` | JSON `{ok, dst, applied[], changed_parts[]}` o `ERROR: …` con los errores por operación y «no se escribió nada» |
| `render_preview` | `path`, `pages?` («3», «2-5»), `dpi?` (50–300) | JSON con `page_count`, `frames[]` (campos v1: `mean_brightness`, `looks_dark`, `looks_light`) y `contact_sheet` |
| `verify_visual` | `before?`, `after`, `checklist[]` (obligatoria), `expect?` {`contains`, `not_contains`, `only_pages`, `same_page_count`, `cells`, `allowed_parts`}, `dpi?` | Resumen en español + `VEREDICTO: VERIFICADO`, o `ERROR: verificación fallida` con lo marcado ✗ |

Operaciones de `office_edit` (todas probadas en la referencia):

| Formato | Operación | Campos |
|---|---|---|
| docx | `replace_text` | `find`, `replace`, `paragraph?`, `occurrence?` (1 = primera), `all?`, `ignore_case?`, `scope?` (`body`/`all`), `part?` |
| docx | `set_paragraph_text` | `paragraph`, `text` (diff mínimo por palabras; conserva citas y formato de lo que no cambia) |
| docx | `insert_paragraph_after` | `paragraph`, `text`, `style?` (clona `w:pPr` y el formato del primer run del vecino) |
| docx | `delete_paragraph` | `paragraph` (rechaza el que lleva `w:sectPr` y el único de una celda) |
| docx | `set_format` | `paragraph`, `find?`, `occurrence?`, `all?`, `bold?`, `italic?`, `underline?`, `size_pt?`, `color?`, `font?`, `highlight?` |
| docx | `set_paragraph_format` | `paragraph`, `align?` (left/center/right/justify), `space_before_pt?`, `space_after_pt?`, `line_spacing?` (1.5 = 360), `indent_left_mm?`, `first_line_mm?`, `hanging_mm?` |
| docx | `set_cell_text` | `table`, `row`, `col`, `text` |
| xlsx | `set_cell` | `sheet`, `ref`, `value` (número, texto, booleano) o `formula` (con o sin `=`) |
| xlsx | `set_cell_style` | `sheet`, `ref` o `range`, `bold?`, `italic?`, `color?`, `fill?`, `number_format?`, `h_align?`, `font_size?` |
| pptx | `replace_text` | `find`, `replace`, `slide?`, `shape?` (nombre o id), `occurrence?`, `all?` |
| pptx | `set_shape_text` | `slide`, `shape`, `text` (líneas = párrafos) |
| pptx | `set_geometry` | `slide`, `shape`, `x_mm?`, `y_mm?`, `w_mm?`, `h_mm?`, `dx_mm?`, `dy_mm?` (absolutos en la lámina; traduce grupos; hace explícita la posición heredada de un placeholder) |
| pptx | `set_fill` | `slide`, `shape`, `color` (hex o `none`) |
| pptx | `set_text_format` | `slide`, `shape`, `find?`, `size_pt?`, `bold?`, `italic?`, `underline?`, `color?`, `font?` |

Detalles de Excel: el estilo `s` de la celda se conserva; los textos nuevos se agregan al final de
`sharedStrings.xml` (o como `inlineStr` si el libro no tiene esa parte); cualquier cambio marca
`<calcPr fullCalcOnLoad="1"/>`; si se tocaron fórmulas se elimina `xl/calcChain.xml` con su relación y su
`Override`; la celda maestra de una fórmula compartida y las fórmulas matriciales se rechazan con un mensaje claro.

### B.3 Seguridad (no negociable)

- Los argumentos viajan en `tmp/sira-args-<uuid>.json`; el comando de shell es fijo (`toRel` rechaza `..` y
  rutas absolutas fuera de `/workspace`). Hay prueba con `"`, `$()`, backticks y saltos de línea.
- `dst` siempre dentro de `outputs/`; nunca igual a `src`.
- El contenido del documento es **dato**: el verificador de visión usa `IMAGE_DATA_FRAMING`.

### B.4 Límites del loop que debes respetar

- **32 KiB de argumentos por llamada** (hallazgo 8): el prompt debe pedir lotes de `office_edit` de máx. ~25 KB.
  Para parafrasear un capítulo: 6–10 párrafos por llamada, encadenando `dst` de una como `src` de la siguiente.
- **Máx. 8 tool calls por mensaje** (`MAX_TOOL_CALLS_PER_MSG`).

### B.5 Gate de la Fase B

```bash
cd backend
node --test tests/agent-runner-office-tools.test.js          # 8/8 (las de render se saltan sin soffice)
node --test tests/agent-runner.test.js tests/agent-runner-e2e.test.js tests/agent-runner-f3-traces.test.js tests/agent-runner-f7-multimodal.test.js
SIRAGPT_OFFICE_ENGINE=0 node --test tests/agent-runner-e2e.test.js   # el modo viejo sigue intacto
```

Agrega una prueba de loop con cliente guionado (patrón `scriptedClient` de `tests/agent-runner.test.js`): el
modelo llama `inspect_document` → `office_edit` → `verify_visual` → respuesta final; comprueba que los eventos
`tool_call` traen `description` y `callId`, y que el turno termina con `stoppedReason: 'final'`.

---

## 6. Fase C — Verificación con visión y gate fuerte

### C.1 Revisión visual con DeepSeek

1. **Agregar** `backend/src/services/agent-runner/multimodal/visual-verifier.js` ← `referencia/node/visual-verifier.js`.
2. En `index.js`, donde se crean los executors:

```js
const { createNativeDeepSeekClient } = require('./native-llm');
const { makeVisionVerifier } = require('./multimodal/visual-verifier');
const visionOn = process.env.SIRAGPT_VISUAL_VERIFY_VISION !== '0' && process.env.NODE_ENV !== 'test';
const visionVerifier = visionOn ? makeVisionVerifier({ client: createNativeDeepSeekClient() }) : null; // null sin DEEPSEEK_API_KEY
const executors = { ...makeToolExecutors(sandbox, { visionVerifier, attachImages: false, thumbs: thumbsEnabled }), ...f8.executors };
```

3. `attachImages` (adjuntar la imagen al propio loop) queda **apagado** mientras el modelo del loop sea
   `deepseek-v4-pro` (texto). Solo se enciende con `SIRAGPT_AGENT_VISION_IN_LOOP=1` **y** un modelo del loop con
   visión. Motivo: un `image_url` a un modelo sin visión devuelve 400 y `llm-runtime.js` no hace failover en 400.
4. Límite de imágenes: DeepSeek reescala cada imagen a un área de ~1300×1300 px y topa los tokens por imagen.
   Por eso el compuesto mide ~1450 px de ancho con zoom de las zonas; se envían **máx. 3** imágenes por revisión.
5. Semántica: `ok:true` (cumple todo), `ok:false` (el veredicto de visión veta), `ok:null` (sin visión: el turno
   sigue solo con checks automáticos y el mensaje final **debe decir** que no hubo revisión visual).

### C.2 Gate de verificación v2 (`verify.js`)

Reemplaza `needsVerification` por esta lógica (mantén la firma y los exports):

```js
const EDIT_TOOLS = new Set([...viejas, 'office_edit']);
const VISUAL_VERIFY = 'verify_visual';

function isRealEdit(step) {
  if (!EDIT_TOOLS.has(step.tool) || step.ok === false) return false;
  // execute_python/bash que no cambiaron outputs/ no cuentan como edición (hallazgo 5)
  if ((step.tool === 'execute_python' || step.tool === 'execute_bash' || step.tool === 'bash') && step.mutated === false) return false;
  return true;
}

function needsVerification(steps = [], { strict = officeEngineEnabled() } = {}) {
  const lastEdit = lastIndex(steps, isRealEdit);
  if (lastEdit === -1) return { needed: false, reason: null };
  if (!strict) { /* lógica actual con render_preview, sin cambios */ }
  const lastVerify = lastIndex(steps, (s) => s.tool === VISUAL_VERIFY);
  if (lastVerify < lastEdit) return { needed: true, reason: 'missing_visual_verify' };
  if (steps[lastVerify].ok === false) return { needed: true, reason: 'visual_checks_failed' };
  return { needed: false, reason: null };
}
```

- En `loop.js`, para `execute_python`/`execute_bash`/`bash`: calcula `outputsFingerprint(sandbox)` antes y después
  del executor y guarda `mutated: before !== after` en el `step` (si alguna huella es `null`, `mutated` queda
  `undefined` = se cuenta como edición, conservador).
- `verificationNudge(attempt, reason)`: agrega los textos de `missing_visual_verify` («Editaste pero no llamaste
  verify_visual…») y `visual_checks_failed` («verify_visual marcó ✗: corrige SOLO esos puntos con office_edit y
  vuelve a verificar»).
- Si `verify_visual` devuelve `ERROR` porque no hay renderizador (sandbox sin soffice), el turno termina con
  `verified:false` y `label:'Sin verificación visual'`; el resumen al usuario lo dice. Nunca un «listo» sin verificar.

### C.3 Contexto: que el pedido nunca se pierda (hallazgos 6 y 7)

1. **Separa el presupuesto de compactación del de salida.** En `compactMessagesInPlace` usa
   `SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS` (por defecto **60000**, acotado a [8000, 120000]) en lugar de
   `max(1500, max_tokens)`.
2. **Fija (pin) el mensaje original del usuario** y la última checklist: marca el mensaje `user` inicial con
   `pin: true` al construir `messages` en `index.js`, y verifica que `tryRestorePins` lo conserve completo.
3. **No recortes el último resultado de `inspect_document`** (el mapa del documento) mientras haya ediciones pendientes.
4. Para turnos de documentos, `max_tokens` de salida **8192** (`SIRAGPT_AGENT_RUNNER_MAX_TOKENS=8192`).
5. Las imágenes adjuntas al loop (si `attachImages`) se podan tras 2 vueltas (patrón `compactScreenshotHistory` de `cu-loop.js`).

### C.4 Prompt (`prompt.js`)

Reemplaza la línea de `render_preview` en TOOLS y las reglas 2–3 de HARD RULES por este bloque (mantén el resto):

```text
OFFICE FILES (docx/xlsx/pptx) — MANDATORY WORKFLOW
1. Understand: turn the user's words into a CHECKLIST (one requirement per item, literal values, plus
   "nothing else changes"). Keep the user's exact words; never "improve" what was not asked.
2. Inspect: call inspect_document (use `query` to locate text). Work with the exact addresses it returns
   (paragraph i, Sheet!C5, slide/shape name, mm). Never guess indices.
3. Edit: call office_edit with the smallest ops that satisfy the checklist. Never rewrite whole files with
   python-docx/openpyxl/pandas. Keep each office_edit call under ~25 KB of arguments; chain dst → src.
   Use track_changes when the user wants the advisor to see corrections.
4. Verify: call verify_visual with before=<source>, after=<output>, checklist=<your checklist> and `expect`
   (contains/not_contains with page, only_pages, cells for Excel). It renders ALL pages, diffs pixels and
   shows the before/after image to a vision model.
5. If the verdict is not VERIFICADO, fix ONLY the failed items and verify again (max 3 attempts).
6. Always fill `description` in every tool call: a short Spanish phrase of what you are doing
   ("Leyendo la portada de la tesis", "Cambiando el año en el párrafo 8", "Comparando antes y después").
7. Final reply in Spanish: what changed (page/cell/slide), the output file name, and whether visual review ran.
   If it could not be verified, say so plainly.
```

### C.5 Gate de la Fase C

- Pruebas nuevas en `tests/agent-runner.test.js` (o un archivo `agent-runner-visual-gate.test.js`):
  1. edición sin `verify_visual` → nudge `missing_visual_verify`;
  2. `verify_visual` con `ERROR` → nudge `visual_checks_failed`;
  3. `execute_python` de solo lectura (huella igual) **no** re-arma el gate;
  4. con `SIRAGPT_OFFICE_ENGINE=0` el gate viejo sigue igual;
  5. el mensaje original del usuario sobrevive a 10 vueltas con resultados de 20 KB (compactación).
- `visual-verifier` con cliente falso: veredicto ok, veto, JSON con cercas, texto sin JSON, error 400 (ya en la referencia).

---

## 7. Fase D — Eventos SSE enriquecidos y miniaturas (solo backend)

### D.1 `loop.js` — hook de resultados con objeto

Generaliza el hook F7 para que **cualquier** objeto se convierta a texto (hoy solo los que traen `__f7Image`):

```js
let f7Image = null;
let thumbs = null;
if (result && typeof result === 'object') {
  f7Image = result.__f7Image || null;
  thumbs = Array.isArray(result.__thumbs) ? result.__thumbs : null;
  result = String(result.text != null ? result.text : '[resultado sin texto]');
}
```

y en `onEvent({ type: 'tool_result', … })` agrega:

```js
callId: call && call.id,
thumbs: thumbsEnabled && thumbs ? thumbs.slice(0, 2)
  .filter((t) => t.bytes <= 80 * 1024)
  .map((t) => `data:${t.mediaType};base64,${t.base64}`) : undefined,
```

### D.2 `trace.js` — stage v2 (solo campos nuevos; nada existente cambia)

```js
const { KIND_BY_TOOL } = require('./tools.office');
// dentro de toStageEvent, en base:
if (ev.callId) base.callId = String(ev.callId);
if (ev.description) base.description = String(ev.description).slice(0, 120);
if (Array.isArray(ev.thumbs) && ev.thumbs.length) base.thumbs = ev.thumbs.slice(0, 2);
base.kind = KIND_BY_TOOL[ev.tool] || (type === 'thought' || type === 'iteration_start' ? 'thinking' : undefined);
if (type === 'tool_call') base.status = 'running';
if (type === 'tool_result') base.status = ev.ok === false ? 'error' : 'done';
if (type === 'tool_call' && ev.args) base.detail = previewArgs(ev.tool, ev.args); // código/comando/ruta/ops, ≤ 600 caracteres, sin secretos
```

- `label` = `description` si existe; si no, la etiqueta actual.
- `detail` en `tool_result` = `preview` (ya existe, ≤ 400).
- Etiquetas por defecto nuevas en `STAGE_LABELS`: `inspect_document` → «Leyendo el documento»,
  `office_edit` → «Editando el documento», `render_preview` → «Renderizando páginas»,
  `verify_visual` → «Comparando antes y después».
- `VERIFY_TOOLS` incluye `verify_visual`.

Contrato SSE final (compatible con clientes viejos):

```json
{ "type": "stage", "step": "tool_result", "tool": "verify_visual", "label": "Comparando antes y después",
  "iteration": 4, "ok": true, "preview": "Verificación: tesis-editado.docx vs tesis.docx …",
  "callId": "call_4_verify", "kind": "check", "status": "done",
  "description": "Comparando antes y después", "thumbs": ["data:image/jpeg;base64,…"] }
```

### D.3 Persistencia del trace

Hoy el turno del runner guarda `steps: []` y el cliente pierde el timeline al refrescar (~2 s después del cierre).
Localiza el guardado del turno (`finishSourcePreservingPreloop('agent_runner', …)` en `agentic-chat-stream.js` y
el guardado del mensaje) y persiste `activityTrace`: máx. 60 eventos stage v2, **sin** `thumbs` en base64
(guarda las miniaturas como archivos del artefacto y referencia su URL autenticada, o descártalas).

Flag: `SIRAGPT_AGENT_THUMBS` (por defecto `1` en producción, `0` en `NODE_ENV=test`).

### D.4 Gate de la Fase D

- `tests/agent-runner-f3-traces.test.js` sigue verde sin cambios de expectativas previas.
- Pruebas nuevas: `toStageEvent` emite `kind`, `status`, `callId`, `description`, `thumbs`; un objeto sin
  `__f7Image` ya no produce `[object Object]`; miniaturas > 80 KB se descartan.

---

## 8. Fase E — Timeline en la interfaz (REQUIERE APROBACIÓN DE LUIS)

**No empieces sin la aprobación escrita de Luis** (UI lock). Al terminar: `npm run ui-lock:update`,
`npm run ui-lock:verify` y commit de `docs/UI_LOCK_HASHES.txt` en el mismo PR.

Referencia visual: `ui/timeline-demo.html` (ábrelo en el navegador).

### E.1 Datos

1. `lib/chat/activity-log.ts`
   - `ActivityStep` agrega: `kind?`, `description?`, `detail?`, `thumbs?: string[]`, `callId?`, `ok?`.
   - `appendActivity`: si llega `tool_result` con `callId` igual a un paso existente, **actualiza ese paso**
     (status `done`/`error`, agrega `detail` de salida y `thumbs`) en lugar de crear una fila nueva.
   - Solo fusiona filas con la misma etiqueta si **no** traen `callId` (heartbeats).
   - `status: "error"` cuando `ok === false`.
2. `lib/chat-context-integrated.tsx` `createActivityHandlers`: pasa el evento completo a `appendActivity`
   (hoy pasa solo `{label, tool, type}`).

### E.2 Presentación

- Reutiliza `TraceRail` / `TraceRailRow` (`components/trace-rail.tsx`) o `ClaudeThinkingTimeline`; **sin íconos
  nuevos** (AGENTS.md §18). Mapeo `kind` → ícono ya importado: `terminal`→`SquareTerminal`, `document`→`FileText`,
  `image`→`ImageIcon`, `search`→`Search`, `web`→`Globe`, `edit`→`PenLine`, `check`→`ListTree`.
- «Gris opaco bajito» = tokens existentes: `text-muted-foreground`, `border-border/70`, `bg-background`;
  en curso → el asterisco animado existente; error → `--step-failed`. Nada de colores nuevos.
- Cada fila: frase (`description`/`label`). En pasos `image` y `check` la miniatura se ve **siempre** bajo la frase
  (página suelta: 124 px de alto; compuesto ANTES/DESPUÉS: hasta 400 px de ancho), con `rounded-md border`, `alt` con
  la frase del paso, y se abre en grande al hacer clic. Al desplegar (`<details>` + `think-chevron`, patrón existente)
  se ve `detail` en bloque monoespaciado con ajuste de línea (máx. ~16 líneas visibles, con scroll).
- `components/message-component.tsx` `areMessagePropsEqual`: agrega comparación de
  `activityLog?.length`, el `status` del último paso, `progressStage` e `isStreaming`. Confírmalo con una prueba
  que emite 3 stages sin `content` y espera 3 filas renderizadas.

### E.3 Gate de la Fase E

- `npx vitest run tests/components/<nuevo>.test.tsx --pool=threads` (fila con detalle y miniatura; emparejamiento por `callId`).
- `node --test` de `tests/chat-activity-log.test.ts` (compilado) con casos nuevos de reducer.
- Ajusta las pruebas de fuente que fijan cadenas (`tests/claude-trace-rail-source.test.ts`,
  `tests/chat-activity-log.test.ts`) solo en lo que cambió a propósito.
- Comparación visual lado a lado (antes/después) con Playwright en claro y oscuro, como en `design-qa.md`.

---

## 9. Fase F — Evals, métricas y despliegue

### F.1 Escenarios de eval (en el harness F9 `src/services/agent-runner/evals/`)

| # | Archivo | Pedido | Debe cumplir |
|---|---|---|---|
| 1 | tesis_demo.docx | «Cambia 2024 por 2025 en la portada» | solo pág. 1 cambia; el run rojo sigue rojo |
| 2 | tesis_demo.docx | «Parafrasea el párrafo de García sin tocar la cita» | campo de cita intacto; texto distinto |
| 3 | tesis_demo.docx | «Pon en negrita "baja capacidad portante"» | solo ese fragmento en negrita |
| 4 | tesis_demo.docx | «Sangría de 1,25 cm y justificado en la introducción» | `w:ind firstLine=709`, `jc=both` |
| 5 | tesis_demo.docx | «Corrige 14,6 por 15,1 en la tabla con control de cambios» | `w:del`/`w:ins` autor SiraGPT |
| 6 | presupuesto_demo.xlsx | «Sube a 15 los ensayos de compresión y resalta la celda» | total recalculado 2231; relleno FFF2CC |
| 7 | presupuesto_demo.xlsx | «Agrega fila Imprevistos 5 % del total» | fórmula nueva; `calcChain` eliminado |
| 8 | defensa_demo.pptx | «Cambia el año de la portada» | solo lámina 1 |
| 9 | defensa_demo.pptx | «Mueve la nota 2 mm a la derecha y ponla verde» | x +72 000 EMU; relleno 2E7D32 |
| 10 | tesis_larga_demo.docx | «Cambia el subtítulo del capítulo 5» | barrido rápido; 1 página cambia |

### F.2 Métricas (telemetría existente `[doc-routing]` + nuevas)

`office_verify_pass_rate`, `office_verify_attempts_per_turn`, `office_pagination_changed_total`,
`office_vision_disagreement_total` (visión veta y los checks pasaron, o al revés), latencia p50/p95 por tool.

### F.3 Flags y despliegue

| Flag | Por defecto | Efecto |
|---|---|---|
| `SIRAGPT_OFFICE_ENGINE` | `1` | Tools nuevas y gate v2; `0` = comportamiento actual |
| `SIRAGPT_VISUAL_VERIFY_VISION` | `1` (off en test) | Revisión con modelo de visión |
| `SIRAGPT_VISION_VERIFY_MODEL` | `deepseek-flash` | Modelo de visión |
| `SIRAGPT_AGENT_VISION_IN_LOOP` | `0` | Adjuntar imágenes al loop (solo con modelo del loop con visión) |
| `SIRAGPT_AGENT_THUMBS` | `1` (off en test) | Miniaturas en el SSE |
| `SIRAGPT_OFFICE_ENGINE_TIMEOUT_MS` | `170000` | Tope por llamada al motor |
| `SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS` | `60000` | Presupuesto de compactación |
| `SIRAGPT_AGENT_RUNNER_MAX_TOKENS` | `8192` en turnos de documentos | Salida por llamada |

Orden de encendido: chats internos → 10 % → 100 %, mirando las métricas de F.2 una semana.

---

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| El render de LibreOffice no es idéntico a Word | Fuentes métricas (Carlito/Caladea/Liberation); la verificación compara render contra render (mismo motor), no contra Word |
| Aptos (temas de `pptx-design-system.js`) no tiene sustituto métrico libre | Cambiar la fuente de los temas generados, o aceptar diferencias y no usar `only_pages` estricto en esos decks |
| Parafrasear cambia la paginación: todas las páginas siguientes «cambian» | El resumen informa «Paginación: N → M»; en parafraseo usa checks de texto y no `only_pages` |
| Documentos de 100+ páginas | Barrido a 36 ppp + detalle solo de candidatas (máx. 8); caché del render «antes» por hash (mejora opcional) |
| La visión se equivoca | Nunca decide sola: los checks deterministas siguen mandando; un veto de visión solo pide una revisión más |
| Costo de visión | ≤ 3 imágenes por verificación, ≤ 3 verificaciones por turno, `deepseek-flash` |
| Inyección de instrucciones dentro del documento o la imagen | Todo el contenido es dato (`IMAGE_DATA_FRAMING`, envoltorios existentes); el verificador solo responde JSON |
| Límite de 32 KiB de argumentos | Lotes ≤ 25 KB y encadenado (prompt, regla 3) |

---

## 11. Apéndice — algoritmos clave (implementados en la referencia)

**Reemplazo entre runs** (`replace_range_inplace`): concatena el texto de los segmentos (`w:t`, separadores
`w:tab`/`w:br` como `\t`/`\n`, campos como `fld` protegidos), recorta prefijo y sufijo comunes entre lo viejo y lo
nuevo, borra solo el tramo que difiere en cada segmento, e inserta el texto nuevo en el segmento donde empieza el
cambio (o, si solo se inserta, en el del carácter anterior). Los `w:t` que quedan vacíos se eliminan, y el run
también si queda sin contenido. `xml:space="preserve"` cuando hay espacios en los bordes.

**Parafraseo mínimo** (`apply_text_diff`): tokeniza en palabras y espacios, calcula opcodes con `difflib`, y los
aplica de derecha a izquierda con el reemplazo entre runs. Lo que no cambió (incluida una cita) no se toca.

**Diff visual** (`page_diff`): diferencia por canal RGB > 32 → máscara; rejilla de celdas de ~1,5 mm; dilatación
3×3 celdas (~3 mm) para unir letras de una misma palabra; componentes conexos; caja exacta con el `getbbox()` de la
máscara dentro de cada componente; conversión px → mm con el DPI.

**Compuesto** (`make_composite`): ANTES | DESPUÉS a 700 px de ancho por panel con recuadros rojos numerados; debajo,
por cada zona (máx. 3), un zoom de al menos 70 × 14 mm de contexto, ampliado hasta 4×.

**Unidades:** 1 mm = 36 000 EMU; 1 pt = 12 700 EMU; 1 mm ≈ 56,69 twips; `w:sz` en medios puntos; `a:rPr@sz` en
centésimos de punto; alto de fila de Excel en puntos.

**Tiempos medidos** (este entorno, LibreOffice 24.2): `edit` 0,01 s; `verify` de una tesis de 13 páginas 3,8 s;
render completo de 13 páginas a 110 ppp 3,7 s; batería Python completa (34 pruebas) 22 s.
