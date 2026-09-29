'use strict';

/**
 * Herramientas Office del AgentRunner sobre el motor `sira_office.py`, que corre
 * DENTRO del sandbox (misma frontera de aislamiento que execute_python).
 *
 * Spec: docs/specs/edicion-milimetrica/SPEC.md (Fase B). Base: la referencia
 * probada de docs/specs/edicion-milimetrica/referencia/node/tools.office.js.
 * Adaptaciones al repo (todas fail-open):
 *   - installOfficeEngine acepta `{ dir }` (pruebas del archivo ausente);
 *   - runEngine marca las fallas de infraestructura con `code` + `infra:true`
 *     (motor ausente, salida inválida, timeout, sandbox caído) y el executor
 *     las reporta vía `onFailure` → tracker de fallas del turno;
 *   - render_preview v2 cae al render v1 (`fallbackRender`) si el motor no está;
 *   - outputsFingerprint usa python3 (portátil: el sandbox y los devs macOS).
 *
 *   inspect_document  → estructura con direcciones exactas (párrafo i, celda Hoja!C5, lámina/forma, mm)
 *   office_edit       → operaciones quirúrgicas atómicas (solo cambia lo pedido)
 *   render_preview    → v2: TODAS las páginas (pdftoppm), dpi, rango, hoja de contacto
 *   verify_visual     → diff de partes + semántico + píxeles (zonas en mm) + compuesto
 *                        antes/después con zoom + checks + revisión con modelo de visión
 *
 * Contrato con loop.js
 *   - Un executor devuelve un string, o un objeto
 *       { text, __f7Image?: { base64, mediaType }, __thumbs?: [{ base64, mediaType }] }
 *     El hook de loop.js (Fase D) convierte cualquier objeto a su `text`; las
 *     miniaturas (opción `thumbs: true`, flag SIRAGPT_AGENT_THUMBS) viajan en el
 *     evento stage v2 del timeline, nunca al modelo.
 *   - Nunca lanza: los errores vuelven como 'ERROR: …' → el paso queda ok:false.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENGINE_REL = 'tmp/sira_office.py';
const ENGINE_LOCAL_PATH = path.join(__dirname, 'sira_office.py');
const MAX_RESULT_CHARS = 30_000;
// Formats sira_office.py renders (detect_format). Anything else (a .md or
// .html a sub-agent wrote) keeps the v1 renderer, exactly as before Fase B.
const ENGINE_RENDER_RE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx|pdf)$/i;
const DEFAULT_DPI = 110;

function engineTimeoutMs(env = process.env) {
  const n = Number(env.SIRAGPT_OFFICE_ENGINE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 10_000 ? Math.min(n, 600_000) : 170_000;
}

function cap(text, n = MAX_RESULT_CHARS) {
  const s = String(text == null ? '' : text);
  return s.length > n ? `${s.slice(0, n)}\n…[truncado: ${s.length - n} caracteres más]` : s;
}

/** Ruta relativa a /workspace; rechaza absolutas fuera del workspace y '..'. */
function toRel(p) {
  const raw = String(p || '').trim().replace(/^\/workspace\/?/, '');
  if (!raw || raw.startsWith('/') || raw.split(/[\\/]/).includes('..')) return null;
  return raw.replace(/\\/g, '/');
}

function slug(rel) {
  return String(rel).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
}

/** outputs/<base>-editado.<ext>; si ya es "-editado" → "-editado-v2", "-v3"… */
function defaultDst(srcRel) {
  const ext = path.extname(srcRel);
  let base = path.basename(srcRel, ext);
  const m = /^(.*)-editado(?:-v(\d+))?$/.exec(base);
  if (m) base = `${m[1]}-editado-v${m[2] ? Number(m[2]) + 1 : 2}`;
  else base = `${base}-editado`;
  return `outputs/${base}${ext}`;
}

let enginePyCache = null;
function loadEnginePy({ dir } = {}) {
  if (dir) {
    try { return fs.readFileSync(path.join(dir, 'sira_office.py'), 'utf8') || null; } catch (_) { return null; }
  }
  if (enginePyCache === null) {
    try { enginePyCache = fs.readFileSync(ENGINE_LOCAL_PATH, 'utf8'); } catch (_) { enginePyCache = ''; }
  }
  return enginePyCache || null;
}

/**
 * Copia el motor al sandbox (index.js lo llama junto a office_helpers.py).
 * Fail-open: sin el archivo devuelve false y el agente sigue con execute_python.
 */
async function installOfficeEngine(sandbox, { dir } = {}) {
  const py = loadEnginePy({ dir });
  if (!py || !sandbox || typeof sandbox.writeFile !== 'function') return false;
  await sandbox.writeFile(ENGINE_REL, py);
  return true;
}

/**
 * Ejecuta un comando del motor. Los argumentos viajan en un archivo JSON (nunca
 * interpolados en el shell): rutas, textos con comillas o saltos de línea son seguros.
 */
async function runEngine(sandbox, cmd, args, { signal, timeoutMs = engineTimeoutMs() } = {}) {
  const argsRel = `tmp/sira-args-${crypto.randomUUID()}.json`;
  try {
    await sandbox.writeFile(argsRel, JSON.stringify(args));
  } catch (err) {
    return { ok: false, infra: true, code: 'sandbox_error', error: `no pude escribir los argumentos en el sandbox: ${err.message}` };
  }
  let r;
  try {
    r = await sandbox.exec(`cd /workspace && python3 /workspace/${ENGINE_REL} ${cmd} --args-file /workspace/${argsRel}`,
      { timeoutMs, signal });
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, code: 'aborted', error: 'cancelado por el usuario' };
    return { ok: false, infra: true, code: 'sandbox_error', error: `el sandbox rechazó el comando: ${err.message}` };
  } finally {
    Promise.resolve(sandbox.exec(`rm -f /workspace/${argsRel}`, { timeoutMs: 10_000 })).catch(() => {});
  }
  if (r.aborted) return { ok: false, code: 'aborted', error: 'cancelado por el usuario' };
  if (r.timedOut) return { ok: false, infra: true, code: 'timeout', error: `el motor tardó más de ${Math.round(timeoutMs / 1000)} s` };
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  try {
    return JSON.parse(lines[lines.length - 1] || '');
  } catch (_) {
    const blob = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    if (/No such file|can't open file/.test(blob)) {
      return { ok: false, infra: true, code: 'engine_missing', error: 'el motor sira_office.py no está instalado en el sandbox (installOfficeEngine)' };
    }
    return { ok: false, infra: true, code: 'invalid_output', error: `salida inválida del motor (exit ${r.exitCode}): ${cap(blob, 800)}` };
  }
}

async function readImage(sandbox, rel) {
  const buf = await sandbox.readFile(toRel(rel) || rel);
  const mediaType = /\.jpe?g$/i.test(rel) ? 'image/jpeg' : 'image/png';
  return { base64: Buffer.from(buf).toString('base64'), mediaType, bytes: buf.length };
}

const DESCRIPTION_PARAM = {
  type: 'string',
  description: 'Frase corta en español (máx. 80 caracteres) de lo que haces; el usuario la ve en el timeline. Ej.: "Leyendo la portada de la tesis".',
};

const OFFICE_OPS = [
  // docx
  'replace_text', 'set_paragraph_text', 'insert_paragraph_after', 'delete_paragraph', 'set_format',
  'set_paragraph_format', 'set_cell_text',
  // xlsx
  'set_cell', 'set_cell_style',
  // pptx
  'set_shape_text', 'set_geometry', 'set_fill', 'set_text_format',
];

const OFFICE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'inspect_document',
      description:
        'Lee la ESTRUCTURA de un docx/xlsx/pptx con direcciones exactas: párrafos numerados (i) con estilo y formato de sus runs; '
        + 'celdas con valor, fórmula y formato; láminas con formas, placeholder, posición y tamaño en mm. Úsalo SIEMPRE antes de editar. '
        + 'Con `query` devuelve solo lo que contiene ese texto (así ubicas "2024" o "Tabla 3").',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a /workspace, p. ej. uploads/tesis.docx' },
          query: { type: 'string', description: 'Texto a ubicar (sin distinguir mayúsculas).' },
          start: { type: 'integer', description: 'docx: primer párrafo a listar (paginación).' },
          limit: { type: 'integer', description: 'Máximo de elementos (por defecto 200).' },
          detail: { type: 'boolean', description: 'docx: incluir el formato de cada run.' },
          sheet: { type: 'string', description: 'xlsx: nombre de la hoja.' },
          slide: { type: 'integer', description: 'pptx: número de lámina (1 = la primera).' },
          scope: { type: 'string', enum: ['body', 'all'], description: 'docx: "all" incluye encabezados, pies y notas.' },
          description: DESCRIPTION_PARAM,
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'office_edit',
      description:
        'Edita un docx/xlsx/pptx de forma QUIRÚRGICA: cambia solo lo pedido y copia todo lo demás igual (formato, estilos, citas, numeración). '
        + 'Es atómico: si una operación falla, no se escribe nada. Nunca sobrescribe el original: escribe en outputs/. '
        + 'DOCX: replace_text{find,replace,paragraph?,occurrence?,all?,scope?} · set_paragraph_text{paragraph,text} (parafraseo mínimo, conserva citas) · '
        + 'insert_paragraph_after{paragraph,text,style?} · delete_paragraph{paragraph} · set_format{paragraph,find?,occurrence?,bold?,italic?,underline?,size_pt?,color?,font?,highlight?} · '
        + 'set_paragraph_format{paragraph,align?,space_before_pt?,space_after_pt?,line_spacing?,indent_left_mm?,first_line_mm?,hanging_mm?} · set_cell_text{table,row,col,text}. '
        + 'XLSX: set_cell{sheet,ref,value|formula} · set_cell_style{sheet,ref|range,bold?,italic?,color?,fill?,number_format?,h_align?,font_size?}. '
        + 'PPTX: replace_text{find,replace,slide?,shape?,occurrence?,all?} · set_shape_text{slide,shape,text} · '
        + 'set_geometry{slide,shape,x_mm?,y_mm?,w_mm?,h_mm?,dx_mm?,dy_mm?} · set_fill{slide,shape,color} · set_text_format{slide,shape,find?,size_pt?,bold?,italic?,underline?,color?,font?}. '
        + 'Colores en hex RRGGBB. Índices y nombres salen de inspect_document. '
        + 'Máx. ~25 KB de argumentos por llamada: para lotes grandes (p. ej. parafrasear un capítulo) haz varias llamadas '
        + 'de 6–10 párrafos, usando el dst de una como src de la siguiente.',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Archivo de origen relativo a /workspace (uploads/… o la última versión en outputs/…).' },
          dst: { type: 'string', description: 'Opcional. Destino dentro de outputs/. Por defecto outputs/<nombre>-editado.<ext>.' },
          ops: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: { op: { type: 'string', enum: OFFICE_OPS } },
              required: ['op'],
              additionalProperties: true,
            },
          },
          track_changes: { type: 'boolean', description: 'docx: escribir los cambios como control de cambios (autor SiraGPT).' },
          description: DESCRIPTION_PARAM,
        },
        required: ['src', 'ops'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_preview',
      description:
        'Renderiza un docx/xlsx/pptx/pdf a PNG con LibreOffice: TODAS las páginas (o un rango), a la resolución pedida, más una hoja de contacto. '
        + 'Úsalo para MIRAR el documento. Para comprobar una edición usa verify_visual.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a /workspace.' },
          pages: { type: 'string', description: 'Opcional: "3" o "2-5". Por defecto todas.' },
          dpi: { type: 'integer', description: 'Resolución (50–300). Por defecto 110.' },
          description: DESCRIPTION_PARAM,
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_visual',
      description:
        'OBLIGATORIO después de editar. Compara ANTES vs DESPUÉS: partes XML cambiadas, cambios por párrafo/celda/forma, render de páginas, '
        + 'zonas cambiadas en mm, imagen antes/después con recuadros y zoom, checks de texto/celdas y revisión con modelo de visión contra tu checklist. '
        + 'Sin `before` revisa un documento NUEVO. Devuelve "VEREDICTO: VERIFICADO" o un ERROR con lo que falló.',
      parameters: {
        type: 'object',
        properties: {
          before: { type: 'string', description: 'Original relativo a /workspace (omítelo si el documento es nuevo).' },
          after: { type: 'string', description: 'Archivo editado relativo a /workspace (outputs/…).' },
          checklist: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: 'Lo que pidió el usuario, un requisito por ítem, incluido "no cambia nada más".',
          },
          expect: {
            type: 'object',
            description: 'Pruebas automáticas sobre el render.',
            properties: {
              contains: { type: 'array', items: {} , description: 'Textos que deben aparecer: "texto" o {text, page}.' },
              not_contains: { type: 'array', items: {}, description: 'Textos que ya no deben aparecer.' },
              only_pages: { type: 'array', items: { type: 'integer' }, description: 'Únicas páginas que pueden cambiar.' },
              same_page_count: { type: 'boolean' },
              cells: { type: 'object', description: 'xlsx: {"Hoja!C5": 155} verificado recalculando una copia.' },
              allowed_parts: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
          dpi: { type: 'integer' },
          description: DESCRIPTION_PARAM,
        },
        required: ['after', 'checklist'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * @param {object} sandbox  sesión de doc-agent/sandbox.js
 * @param {object} [opts]
 * @param {Function|null} [opts.visionVerifier]  de multimodal/visual-verifier.js (null = sin visión)
 * @param {boolean} [opts.attachImages]  adjuntar la imagen al loop (solo si el modelo del loop tiene visión)
 * @param {boolean} [opts.thumbs]        devolver miniaturas para el timeline (stage v2)
 * @param {Function|null} [opts.onFailure]  ({ tool, code, error }) para fallas de INFRAESTRUCTURA
 *   (motor ausente, salida inválida, timeout, sandbox caído) — las que afectan la respuesta al
 *   usuario. Nunca para errores de la operación que el modelo puede corregir. Fail-open.
 * @param {Function|null} [opts.fallbackRender]  render_preview v1: se usa si el motor no está
 * @param {Function|null} [opts.onVerify]  ({ after, passed, visionOk, checksOk, paginationChanged }) tras
 *   cada verify_visual: el turno sabe si un modelo de visión revisó el resultado (visionOk null = no
 *   hubo revisión) y las métricas F.2 ven desacuerdos visión/checks y cambios de paginación.
 */
/**
 * Every part of the written package equals the source (ZIP timestamps aside):
 * the edit changed nothing. Fail-open (false) when the files cannot be read.
 */
async function samePackageParts(sandbox, src, dst) {
  try {
    const PizZip = require('pizzip');
    const [a, b] = [new PizZip(await sandbox.readFile(src)), new PizZip(await sandbox.readFile(dst))];
    const names = Object.keys(a.files).filter((n) => !a.files[n].dir);
    const other = Object.keys(b.files).filter((n) => !b.files[n].dir);
    if (names.length !== other.length) return false;
    return names.every((n) => b.files[n] && Buffer.from(a.files[n].asUint8Array()).equals(Buffer.from(b.files[n].asUint8Array())));
  } catch (_) {
    return false;
  }
}

function makeOfficeToolExecutors(sandbox, {
  visionVerifier = null, attachImages = false, thumbs = false, onFailure = null, fallbackRender = null,
  onVerify = null,
} = {}) {
  function reportInfra(tool, res) {
    if (res && !res.infra && /no está instalado/.test(String(res.error || ''))) {
      // soffice / poppler missing in the sandbox image: the user gets no render.
      res = { ...res, infra: true, code: 'renderer_unavailable' };
    }
    if (!res || !res.infra || typeof onFailure !== 'function') return;
    try {
      Promise.resolve(onFailure({ tool, code: res.code || 'engine_error', error: String(res.error || '').slice(0, 500) }))
        .catch(() => {});
    } catch (_) { /* reporting never breaks a tool call */ }
  }

  async function withImages(text, imageRel, thumbRel) {
    const out = { text };
    try {
      if (attachImages && imageRel) out.__f7Image = await readImage(sandbox, imageRel);
      if (thumbs && thumbRel) out.__thumbs = [await readImage(sandbox, thumbRel)];
    } catch (_) { /* la imagen es un extra: el texto ya informa el resultado */ }
    return (out.__f7Image || out.__thumbs) ? out : text;
  }

  return {
    async inspect_document(args = {}, ctx = {}) {
      const rel = toRel(args.path);
      if (!rel) return 'ERROR: `path` inválido: usa una ruta relativa a /workspace, p. ej. uploads/tesis.docx';
      const payload = { path: rel };
      for (const k of ['query', 'start', 'limit', 'detail', 'sheet', 'slide', 'scope']) {
        if (args[k] !== undefined && args[k] !== null) payload[k] = args[k];
      }
      const res = await runEngine(sandbox, 'inspect', payload, ctx);
      if (!res || res.ok === false) {
        reportInfra('inspect_document', res);
        return `ERROR: ${res?.error || 'inspect falló'}`;
      }
      return cap(JSON.stringify(res));
    },

    async office_edit(args = {}, ctx = {}) {
      const src = toRel(args.src || args.path);
      if (!src) return 'ERROR: `src` inválido: ruta relativa a /workspace (uploads/… u outputs/…)';
      // «outputs/» (a folder) means «the default name in outputs/»; a path
      // outside the workspace is still refused.
      const dstArg = args.dst ? toRel(args.dst) : null;
      if (args.dst && !dstArg) return 'ERROR: `dst` debe estar dentro de outputs/';
      const dst = !dstArg || dstArg.endsWith('/') ? defaultDst(src) : dstArg;
      if (!dst || !dst.startsWith('outputs/')) return 'ERROR: `dst` debe estar dentro de outputs/';
      if (dst === src) return 'ERROR: `dst` debe ser un archivo nuevo; nunca se sobrescribe el origen';
      if (!Array.isArray(args.ops) || !args.ops.length) return 'ERROR: `ops` debe ser una lista con al menos una operación';
      const res = await runEngine(sandbox, 'edit', { src, dst, ops: args.ops, track_changes: Boolean(args.track_changes) }, ctx);
      if (!res || res.ok === false) {
        reportInfra('office_edit', res);
        const detail = res?.errors ? `\n${cap(JSON.stringify(res.errors), 4000)}` : '';
        const note = res?.note ? `\n${res.note}` : '';
        return `ERROR: ${res?.error || 'la edición no se aplicó'}${detail}${note}`;
      }
      if (await samePackageParts(sandbox, src, res.dst || dst)) {
        // Everything asked was already there («ya tiene sangría de 1,25 cm y
        // está justificado»): say so instead of retrying edits that cannot
        // change anything (eval docx-sangria-justificado spent 184 s on it).
        return cap(JSON.stringify({
          unchanged: true,
          note: 'SIN CAMBIOS: el archivo resultante es idéntico al original, así que lo pedido ya estaba aplicado. No reintentes ni entregues una copia: responde al usuario que el documento ya cumple lo que pidió, con el dato concreto (p. ej. «la introducción ya tiene sangría de primera línea de 1,25 cm y está justificada»).',
          ...res,
        }));
      }
      return cap(JSON.stringify(res));
    },

    async render_preview(args = {}, ctx = {}) {
      const rel = toRel(args.path);
      if (!rel) return 'ERROR: `path` inválido';
      if (!ENGINE_RENDER_RE.test(rel) && typeof fallbackRender === 'function') {
        return fallbackRender(args, ctx);
      }
      const outdir = `previews/${slug(rel)}`;
      const res = await runEngine(sandbox, 'render', {
        path: rel, outdir, dpi: Number(args.dpi) || DEFAULT_DPI, pages: args.pages, contact_sheet: true,
      }, ctx);
      if (res && (res.code === 'engine_missing' || res.code === 'invalid_output')
        && typeof fallbackRender === 'function') {
        // El sandbox no tiene el motor (imagen vieja / instalación fallida): el
        // render v1 sigue funcionando igual que antes de la Fase B.
        reportInfra('render_preview', res);
        return fallbackRender(args, ctx);
      }
      if (!res || res.ok === false) {
        reportInfra('render_preview', res);
        if (/no está instalado/.test(String(res?.error))) {
          // honestidad (contrato F1): se informa que NO hubo render, nunca un falso OK
          return cap(JSON.stringify({ ok: true, skipped: true, reason: 'renderer_unavailable', note: res.error }));
        }
        return `ERROR: ${res?.error || 'render falló'}`;
      }
      // Campos de compatibilidad con render_preview v1 (frames + brillo) para no romper tests/gate.
      const frames = (res.pages || []).map((p) => ({
        page: p.page, path: p.png, width: p.width_px, height: p.height_px,
        mean_brightness: p.mean_brightness, looks_dark: p.mean_brightness < 40, looks_light: p.mean_brightness > 200,
        blank: p.blank,
      }));
      const text = cap(JSON.stringify({
        ok: true, page_count: res.page_count, rendered: frames.length, dpi: res.dpi, engine: res.engine,
        frames, count: frames.length, contact_sheet: res.contact_sheet,
      }));
      return withImages(text, res.contact_sheet, res.thumb);
    },

    async verify_visual(args = {}, ctx = {}) {
      const after = toRel(args.after);
      if (!after) return 'ERROR: `after` inválido';
      const before = args.before ? toRel(args.before) : null;
      if (args.before && !before) return 'ERROR: `before` inválido';
      const checklist = Array.isArray(args.checklist) ? args.checklist.map(String).filter(Boolean).slice(0, 20) : [];
      if (!checklist.length) return 'ERROR: `checklist` es obligatorio: un requisito del usuario por ítem';
      const outdir = `previews/verify-${slug(after)}`;
      const res = await runEngine(sandbox, 'verify', {
        before, after, outdir, dpi: Number(args.dpi) || DEFAULT_DPI, expect: args.expect || {},
      }, ctx);
      if (!res || (res.ok === false && !res.summary)) {
        reportInfra('verify_visual', res);
        return `ERROR: ${res?.error || 'verify falló'}`;
      }
      let text = res.summary;
      let visionOk = null;
      let visionVeto = '';
      if (typeof visionVerifier === 'function' && Array.isArray(res.composites) && res.composites.length) {
        try {
          const images = [];
          for (const p of res.composites.slice(0, 3)) images.push(await readImage(sandbox, p));
          const v = await visionVerifier({ images, checklist, summary: res.summary, signal: ctx.signal });
          visionOk = v ? v.ok : null;
          if (visionOk === false) visionVeto = String(v?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
          text += `\n• Revisión visual (modelo de visión): ${v ? v.text : 'sin respuesta'}`;
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          text += `\n• Revisión visual: no disponible (${err.message}); solo verificación automática.`;
        }
      } else {
        text += '\n• Revisión visual: no configurada; solo verificación automática.';
      }
      text += `\n• Checklist del usuario: ${checklist.map((c, i) => `${i + 1}) ${c}`).join(' ')}`;
      const passed = res.ok === true && visionOk !== false;
      if (typeof onVerify === 'function') {
        try {
          onVerify({
            after,
            passed,
            visionOk,
            checksOk: res.ok === true,
            paginationChanged: Boolean(res.visual && res.visual.pagination_changed),
          });
        } catch (_) { /* observer only */ }
      }
      text += `\nVEREDICTO: ${passed ? 'VERIFICADO' : 'NO VERIFICADO — corrige lo marcado con ✗ y vuelve a verificar'}`;
      const failureReasons = [
        ...(res.ok !== true ? ['controles automáticos fallidos'] : []),
        ...(visionOk === false ? [`revisión visual: ${visionVeto || 'rechazada sin detalle'}`] : []),
      ];
      const body = passed ? text : `ERROR: verificación fallida\n• Motivo: ${failureReasons.join('; ') || 'verificación no concluyente'}\n${text}`;
      return withImages(cap(body), res.composites && res.composites[0], res.thumbs && res.thumbs[0]);
    },
  };
}

/**
 * Huella de /workspace/outputs: permite que el gate de verify.js distinga un
 * execute_python que SOLO leyó (no exige verificar) de uno que escribió.
 */
// python3 (no GNU find -printf / sha1sum): the sandbox image and macOS dev
// hosts both have it; the digest covers path + size + mtime of every file.
const FINGERPRINT_PY = 'import hashlib,os;h=hashlib.sha1();'
  + "fs=sorted(os.path.join(r,f) for r,_,n in os.walk('outputs') for f in n);"
  + "[h.update(('%s %d %d\\n'%(p,os.stat(p).st_size,os.stat(p).st_mtime_ns)).encode()) for p in fs];"
  + 'print(h.hexdigest())';

async function outputsFingerprint(sandbox, { signal } = {}) {
  try {
    const r = await sandbox.exec(`cd /workspace && python3 -c "${FINGERPRINT_PY}"`, { timeoutMs: 15_000, signal });
    if (Number(r.exitCode) !== 0) return null;
    return String(r.stdout || '').trim().split(/\s+/)[0] || null;
  } catch (_) {
    return null;
  }
}

// Per-file snapshot of /workspace/outputs ({ path: "size mtime_ns" }). The
// loop diffs two of them around execute_python/bash so the verification gate
// knows WHICH deliverables changed (a docx → visual verification required).
const SNAPSHOT_PY = 'import json,os;o={};'
  + "[o.__setitem__(os.path.join(r,f),'%d %d'%(os.stat(os.path.join(r,f)).st_size,os.stat(os.path.join(r,f)).st_mtime_ns)) for r,_,n in os.walk('outputs') for f in n];"
  + 'print(json.dumps(o))';

/** Symbol key: executors[OUTPUTS_SNAPSHOT]() — never reachable as a tool name. */
const OUTPUTS_SNAPSHOT = Symbol.for('siragpt.agentRunner.outputsSnapshot');

async function outputsSnapshot(sandbox, { signal } = {}) {
  try {
    const r = await sandbox.exec(`cd /workspace && python3 -c "${SNAPSHOT_PY}"`, { timeoutMs: 15_000, signal });
    if (Number(r.exitCode) !== 0) return null;
    const parsed = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Paths added, removed or rewritten between two snapshots (null when unknown). */
function changedOutputs(before, after) {
  if (!before || !after) return null;
  const changed = [];
  for (const [p, sig] of Object.entries(after)) if (before[p] !== sig) changed.push(p);
  for (const p of Object.keys(before)) if (!(p in after)) changed.push(p);
  return changed.sort();
}

/** Categoría de ícono para el timeline (la usa trace.js en la Fase D). */
const KIND_BY_TOOL = Object.freeze({
  execute_python: 'terminal',
  execute_bash: 'terminal',
  bash: 'terminal',
  read_file: 'document',
  list_files: 'document',
  glob: 'search',
  grep: 'search',
  write_file: 'edit',
  edit_file: 'edit',
  str_replace: 'edit',
  inspect_document: 'document',
  office_edit: 'edit',
  render_preview: 'image',
  verify_visual: 'check',
  describe_image: 'image',
  web_search: 'search',
  web_fetch: 'web',
  browser_act: 'web',
  create_presentation: 'edit',
  set_slide_background: 'edit',
});

module.exports = {
  ENGINE_REL,
  DESCRIPTION_PARAM,
  OFFICE_TOOL_DEFINITIONS,
  OFFICE_OPS,
  KIND_BY_TOOL,
  makeOfficeToolExecutors,
  installOfficeEngine,
  outputsFingerprint,
  outputsSnapshot,
  changedOutputs,
  OUTPUTS_SNAPSHOT,
  defaultDst,
  toRel,
  runEngine,
};
