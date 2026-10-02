'use strict';

/**
 * Generic AgentRunner tools. Small set, model-agnostic:
 *   execute_python, execute_bash, read_file, write_file, edit_file,
 *   list_files, glob, grep, render_preview,
 *   create_presentation / set_slide_background (optional high-level).
 *
 * Bound to ONE sandbox session. Errors return `ERROR: …` strings so the loop
 * never throws on a tool failure.
 *
 * F6 — web tools (web_search / web_fetch / browser_act) are appended when
 * the SIRAGPT_AGENT_WEB kill switch allows them (default ON, OFF under
 * NODE_ENV=test).
 *
 * Edición milimétrica (docs/specs/edicion-milimetrica/SPEC.md, Fase B): with
 * SIRAGPT_OFFICE_ENGINE !== '0' (default ON) the runner also gets
 * inspect_document / office_edit / verify_visual and render_preview v2
 * (./tools.office.js over sira_office.py). Every tool accepts an optional
 * `description` — a short Spanish phrase the user sees in the timeline. IMPORTANT split of worlds: the sandbox tools above run
 * inside the F5 gVisor sandbox with `--network none`; the web tools run in
 * the Node backend process (Playwright in its own child browser process)
 * behind their own SSRF guard — see ./browser/web-tools.js. Everything they
 * return is wrapped as UNTRUSTED DATA, never instructions.
 */

const { makeToolExecutors: makeDocExecutors } = require('../doc-agent/tools');
const { CHART_SCHEMA, normalizeNativeChart } = require('../document-pipeline/pptx-native-chart');
const {
  DESCRIPTION_PARAM,
  OFFICE_TOOL_DEFINITIONS,
  OUTPUTS_SNAPSHOT,
  makeOfficeToolExecutors,
  outputsSnapshot,
} = require('./tools.office');
const {
  webToolsEnabled,
  WEB_TOOL_DEFINITIONS,
  makeWebToolExecutors,
} = require('./browser');

const MAX_TOOL_RESULT_CHARS = 30_000;
const CMD_TIMEOUT_MS = 120_000;

// Clean light default for NEW decks when the user did not ask for a color.
// NEVER pink: FFC0CB is only used when the user actually asked for rosado.
const DEFAULT_DECK_COLOR = 'F8FAFC';

/**
 * Expand a Spanish/English color word into its gender/plural forms:
 * "morado" -> morado/morada/morados/moradas, "lila" -> lila/lilas,
 * "coral" -> coral/corales.
 */
function colorWordForms(word) {
  const w = String(word).toLowerCase();
  const forms = new Set([w]);
  if (w.endsWith('o')) {
    const stem = w.slice(0, -1);
    forms.add(`${stem}a`);
    forms.add(`${stem}os`);
    forms.add(`${stem}as`);
  } else if (/[aeiouáéíóú]$/.test(w)) {
    forms.add(`${w}s`);
  } else {
    forms.add(`${w}es`);
    forms.add(`${w}s`);
  }
  return [...forms];
}

// Compact spec -> expanded lookup. ANY of these names (or any #hex) is a valid
// user-chosen deck color; there is no privileged palette.
const COLOR_SPECS = [
  [['blanco', 'white'], 'FFFFFF'],
  [['rosado', 'rosa', 'pink'], 'FFC0CB'],
  [['negro', 'black'], '000000'],
  [['azul', 'blue'], '1E3A8A'],
  [['rojo', 'red'], 'DC2626'],
  [['verde', 'green'], '16A34A'],
  [['gris', 'gray', 'grey'], '6B7280'],
  [['naranja', 'anaranjado', 'orange'], 'F97316'],
  [['morado', 'purpura', 'púrpura', 'purple'], '7C3AED'],
  [['violeta', 'violet'], '8B5CF6'],
  [['lila', 'lilac'], 'C8A2C8'],
  [['fucsia', 'fuchsia'], 'D946EF'],
  [['celeste'], '87CEEB'],
  [['turquesa', 'turquoise'], '40E0D0'],
  [['beige'], 'F5F5DC'],
  [['dorado', 'gold'], 'FFD700'],
  [['plateado', 'plata', 'silver'], 'C0C0C0'],
  [['coral'], 'FF7F50'],
  [['vino', 'burdeos', 'burgundy', 'wine'], '722F37'],
  [['amarillo', 'yellow'], 'FACC15'],
  [['crema', 'cream'], 'FFFDD0'],
  [['marron', 'marrón', 'cafe', 'café', 'brown'], '8B4513'],
  [['cian', 'cyan', 'aqua'], '06B6D4'],
  [['salmon', 'salmón'], 'FA8072'],
  [['lavanda', 'lavender'], 'E6E6FA'],
  [['menta', 'mint'], '98FF98'],
];

const NAMED_COLORS = {};
for (const [names, hex] of COLOR_SPECS) {
  for (const name of names) {
    for (const form of colorWordForms(name)) NAMED_COLORS[form] = hex;
  }
}

function cap(s, maxChars = MAX_TOOL_RESULT_CHARS) {
  const str = String(s == null ? '' : s);
  return str.length > maxChars
    ? `${str.slice(0, maxChars)}\n…[result truncated]`
    : str;
}

// Advice is fixed harness text, never source code, file paths or exception
// values. The failed execution stays ERROR and still counts toward loop cuts.
function officeApiReadbackGuidance(code, stderr, enabled) {
  if (!enabled) return '';
  const error = String(stderr || '');
  const tail = error.slice(-8192).trim();
  if (!error.includes('Traceback (most recent call last):')
    || !/(?:^|\n)(?:AttributeError|TypeError):[^\n]*$/.test(tail)) return '';
  const usesOpenpyxl = /(?:^|\n)\s*(?:from\s+openpyxl(?:\.\w+)*\s+import\b|import\s+openpyxl\b)/.test(code)
    || /[\\/]openpyxl[\\/]/.test(tail);
  if (!usesOpenpyxl) return '';
  return '[Office readback guidance]\n'
    + 'No adivines otra propiedad de la biblioteca. Si el XLSX ya fue guardado, usa inspect_document sobre ese archivo para releer celdas y gráficas (type, title, series y referencias); no reconstruyas esos metadatos con atributos internos. '
    + 'Si falta una comprobación, consulta la firma o documentación de la API instalada antes de otro cambio. Corrige solo lo necesario y ejecuta verify_visual sobre el resultado final. Este error no valida el archivo ni permite entregarlo.';
}

function normalizeHex(raw) {
  const s = String(raw || '').trim();
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return named;
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : null;
}

/** Accepts [{title,bullets}] or plain strings; drops empties, caps at 20. */
function normalizeOutline(raw) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 20 && raw.some((item) => item?.chart)) throw new Error('E_PARAMS: Más de 20 diapositivas con gráficas; usa execute_python sin recortar el contenido.');
  const out = [];
  for (const item of raw.slice(0, 20)) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push({ title: t.slice(0, 200), bullets: [] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const t = String(item.title || '').trim();
    if (!t && item.chart !== undefined) throw new Error('E_PARAMS: La diapositiva con gráfica necesita título; corrige outline o usa execute_python.');
    if (!t) continue;
    const bullets = (Array.isArray(item.bullets) ? item.bullets : [])
      .map((b) => String(b || '').trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((b) => b.slice(0, 300));
    out.push({ title: t.slice(0, 200), bullets, ...(item.chart !== undefined ? { chart: normalizeNativeChart(item.chart) } : {}) });
  }
  return out;
}

/** Minimal skeleton when no outline was provided — NO filler bullets. */
function buildSkeletonPlan({ title, topic, slides } = {}) {
  const n = Math.max(2, Math.min(20, Number(slides) || 4));
  const plan = [];
  for (let i = 1; i < n - 1; i += 1) {
    plan.push({ title: `${topic || title} — sección ${i}`, bullets: [] });
  }
  plan.push({ title: 'Gracias', bullets: [] });
  return plan;
}

const BASE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description:
        'Run Python 3 inside the isolated /workspace sandbox. Libraries: python-pptx, python-docx, openpyxl, lxml, pypdf, Pillow. Uploaded files are in /workspace/uploads; write deliverables to /workspace/outputs. 120s timeout, no network.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          code: { type: 'string', description: 'Python source to execute.' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_bash',
      description:
        'Run a bash command inside /workspace. zip/unzip, grep/sed/awk, libreoffice --headless. 120s timeout, no network. Prefer execute_python for document edits.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          command: { type: 'string', description: 'Bash command to run.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Paths relative to /workspace.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files recursively under a workspace directory with sizes.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_preview',
      description:
        'Convert a pptx or docx to PNG frames with LibreOffice headless and report per-slide brightness. REQUIRED after every edit before you claim success. Path relative to /workspace (e.g. outputs/deck.pptx).',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string', description: 'pptx/docx path relative to /workspace.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Surgical text edit: replace old_str with new_str in a workspace text file. old_str MUST occur exactly once (include surrounding context to make it unique). For OOXML parts, unzip first and edit the extracted XML.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string', description: 'File path relative to /workspace.' },
          old_str: { type: 'string', description: 'Exact existing text to replace (unique in the file).' },
          new_str: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_str', 'new_str'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find workspace files whose path matches a shell glob pattern (e.g. "*.pptx", "tmp/x/ppt/slides/*.xml"). Returns matching paths with sizes.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          pattern: { type: 'string', description: 'Glob pattern, relative to /workspace.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search text/regex inside workspace files (grep -rn). Use it to locate a hex, a phrase or an XML attribute before editing.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          pattern: { type: 'string', description: 'Text or extended regex to search for.' },
          path: { type: 'string', description: 'File or directory relative to /workspace (default ".").' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_presentation',
      description:
        'Create a NEW PowerPoint from scratch. Always adds one title slide before the outline. REQUIRED: pass `outline` with REAL content slides only, excluding the cover, with titles, bullets and optional native editable `chart`. For N total slides (N >= 2), provide N-1 outline entries. For a single slide or a coverless deck, use execute_python. Preserve requested chart type, all values, series, colors and layout. Use execute_python for unsupported designs; never replace a requested chart with bullets. `color` sets the overall slide background only when requested; series colors belong in chart.series[].color. Omit color for a clean light theme. Writes /workspace/outputs/<file>.pptx.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          topic: { type: 'string', description: 'Subject of the deck, e.g. embarazo.' },
          title: { type: 'string', description: 'Title slide text.' },
          color: { type: 'string', description: 'User-requested color: name or #hex. Omit if the user did not ask for one.' },
          theme: {
            type: 'string',
            enum: ['aurora', 'boardroom', 'minimal', 'editorial', 'consulting'],
            description: 'Optional professional theme when the user asked for a style but no color: aurora (moderno, default), boardroom (ejecutivo oscuro), minimal, editorial (cálido/educativo), consulting (corporativo). Ignored when `color` is set.',
          },
          outline: {
            type: 'array',
            description: 'Content slides with REAL content: [{title, bullets: ["…"]}, …]. Exclude the cover: the tool adds one title slide. For N total slides (N >= 2), use N-1 entries; for a single slide or coverless deck use execute_python.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                chart: CHART_SCHEMA,
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
          slides: { type: 'integer', description: 'Slide count when no outline is given (2-20).' },
          filename: { type: 'string', description: 'Output filename ending in .pptx' },
        },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_slide_background',
      description:
        'Optional high-level tool: paint every slide (or one slide) with a solid fill. Accepts a hex (#1E3A8A) or a named color (blanco, rosado, negro, azul). Prefer this for uniform background-color requests; use execute_python for anything else.',
      parameters: {
        type: 'object',
        properties: {
          description: DESCRIPTION_PARAM,
          path: { type: 'string', description: 'pptx path relative to /workspace.' },
          color: { type: 'string', description: 'Hex or named color (blanco, rosado, #1E3A8A).' },
          slide_number: { type: 'integer', description: '1-based slide; omit to paint all slides.' },
        },
        required: ['path', 'color'],
        additionalProperties: false,
      },
    },
  },
];

const PREVIEW_SCRIPT = `
import json, os, sys, glob
out_dir = sys.argv[1]
files = sorted(glob.glob(os.path.join(out_dir, "*.png")))
report = []
for p in files:
    info = {"path": p, "bytes": os.path.getsize(p)}
    try:
        from PIL import Image, ImageStat
        im = Image.open(p).convert("RGB")
        st = ImageStat.Stat(im)
        mean = sum(st.mean) / 3.0
        info["width"], info["height"] = im.size
        info["mean_brightness"] = round(mean, 2)
        info["looks_dark"] = mean < 40
        info["looks_light"] = mean > 200
    except Exception as e:
        info["note"] = str(e)
    report.append(info)
print(json.dumps({"ok": True, "frames": report, "count": len(report)}))
`.trim();

/**
 * Edición milimétrica kill switch: '0' restores the pre-Fase-B tool set
 * (render_preview v1 only, no office tools). Default ON.
 */
function officeEngineEnabled(env = process.env) {
  return String((env && env.SIRAGPT_OFFICE_ENGINE) ?? '').trim() !== '0';
}

function makeToolExecutors(sandbox, { setSlideBackgrounds, web, office } = {}) {
  const doc = makeDocExecutors(sandbox);
  const applyBg = setSlideBackgrounds
    || require('../document-editing/pptx-adapter').setSlideBackgrounds;

  const executors = {
    // Executors take an optional per-call context `{ signal }` (F3): the loop
    // forwards the turn's AbortSignal so a Stop mid-command kills the
    // in-flight sandbox process, not just the next iteration.
    async execute_python(args, ctx = {}) {
      const code = String(args?.code || '').trim();
      if (!code) return 'ERROR: empty code';
      // Helpers are staged in tmp/, while stdin scripts run from /workspace.
      // Compile the user's source separately so future imports and line
      // numbers retain normal stdin semantics instead of receiving a prefix.
      const bootstrap = "import sys; sys.path.insert(0, '/workspace/tmp'); sys.argv[0] = '-'; globals()['__file__'] = '<stdin>'; exec(compile(sys.stdin.read(), '<stdin>', 'exec'))";
      const wrapped = `python3 -c "${bootstrap}" <<'PY'\n${code}\nPY`;
      const r = await sandbox.exec(wrapped, { timeoutMs: CMD_TIMEOUT_MS, signal: ctx.signal });
      const parts = [];
      if (r.stdout) parts.push(r.stdout);
      if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
      parts.push(r.timedOut ? `[exit ${r.exitCode} — TIMED OUT]` : `[exit ${r.exitCode}]`);
      const output = cap(parts.join('\n'));
      if (r.aborted) return `ERROR: sandbox command aborted\n${output}`;
      if (r.timedOut) return `ERROR: sandbox command timed out after ${CMD_TIMEOUT_MS}ms\n${output}`;
      if (Number(r.exitCode) !== 0) {
        const guidance = officeApiReadbackGuidance(code, r.stderr, typeof executors.inspect_document === 'function');
        const detail = guidance ? cap(output, MAX_TOOL_RESULT_CHARS - guidance.length - 100) : output;
        return `ERROR: python failed\n${detail}${guidance ? `\n${guidance}` : ''}`;
      }
      return output;
    },

    async execute_bash(args, ctx = {}) {
      const command = String(args?.command || '').trim();
      if (!command) return 'ERROR: empty command';
      const r = await sandbox.exec(command, { timeoutMs: CMD_TIMEOUT_MS, signal: ctx.signal });
      const parts = [];
      if (r.stdout) parts.push(r.stdout);
      if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
      parts.push(r.timedOut ? `[exit ${r.exitCode} — TIMED OUT]` : `[exit ${r.exitCode}]`);
      const output = cap(parts.join('\n'));
      if (r.aborted) return `ERROR: sandbox command aborted\n${output}`;
      if (r.timedOut) return `ERROR: sandbox command timed out after ${CMD_TIMEOUT_MS}ms\n${output}`;
      if (Number(r.exitCode) !== 0) return `ERROR: sandbox command failed\n${output}`;
      return output;
    },
    bash: (args) => doc.bash(args),
    read_file: (args) => doc.read_file(args),
    write_file: (args) => doc.write_file(args),
    list_files: (args) => doc.list_files(args),
    str_replace: (args) => doc.str_replace(args),
    edit_file: (args) => doc.str_replace(args),

    async glob(args, ctx = {}) {
      const pattern = String(args?.pattern || '').trim();
      if (!pattern) return 'ERROR: pattern is required';
      if (/[;&|`$]/.test(pattern)) return 'ERROR: pattern must be a plain glob, not a shell expression';
      const r = await sandbox.exec(
        `cd /workspace && find . -type f -path ${JSON.stringify(`./${pattern.replace(/^\.\//, '')}`)} -exec ls -la {} + 2>/dev/null | head -200`,
        { timeoutMs: 30_000, signal: ctx.signal },
      );
      const out = String(r.stdout || '').trim();
      if (Number(r.exitCode) !== 0 && !out) return `ERROR: glob failed\n${r.stderr || ''}`;
      return cap(out || '(no matches)');
    },

    async grep(args, ctx = {}) {
      const pattern = String(args?.pattern || '');
      if (!pattern) return 'ERROR: pattern is required';
      const rel = String(args?.path || '.').replace(/^\/workspace\/?/, '') || '.';
      const r = await sandbox.exec(
        `cd /workspace && grep -rnE --binary-files=without-match -m 50 ${JSON.stringify(pattern)} ${JSON.stringify(rel)} 2>/dev/null | head -200`,
        { timeoutMs: 30_000, signal: ctx.signal },
      );
      const out = String(r.stdout || '').trim();
      if (out) return cap(out);
      if (Number(r.exitCode) === 1 || !r.stderr) return '(no matches)';
      return `ERROR: grep failed\n${r.stderr || ''}`;
    },

    async render_preview(args, ctx = {}) {
      const rel = String(args?.path || '').replace(/^\/workspace\/?/, '');
      if (!rel) return 'ERROR: path is required';
      const src = rel.startsWith('/') ? rel : `/workspace/${rel}`;
      try {
        await sandbox.exec('mkdir -p /workspace/previews', { timeoutMs: 10_000, signal: ctx.signal });
        const conv = await sandbox.exec(
          `soffice --headless --convert-to png --outdir /workspace/previews ${JSON.stringify(src)}`,
          { timeoutMs: CMD_TIMEOUT_MS, signal: ctx.signal },
        );
        if (Number(conv.exitCode) !== 0) {
          const blob = `${conv.stdout || ''}\n${conv.stderr || ''}`;
          if (/soffice|libreoffice|not found|No such file/i.test(blob)) {
            return cap(JSON.stringify({
              ok: true,
              skipped: true,
              reason: 'soffice_unavailable',
              note: 'Preview skipped; confirm the change with execute_python (xml_has_hex / list_slide_texts).',
            }));
          }
          return cap(`ERROR: LibreOffice failed\n${blob}`);
        }
        await sandbox.writeFile('tmp/preview_stat.py', PREVIEW_SCRIPT);
        const stat = await sandbox.exec(
          'python3 /workspace/tmp/preview_stat.py /workspace/previews',
          { timeoutMs: 30_000 },
        );
        if (Number(stat.exitCode) !== 0) {
          const listing = await sandbox.exec('ls -l /workspace/previews', { timeoutMs: 10_000 });
          return cap(`OK: converted, but brightness stats failed.\n${stat.stderr || ''}\n${listing.stdout || ''}`);
        }
        return cap(String(stat.stdout || '').trim() || 'OK: preview rendered');
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },

    async create_presentation(args) {
      const topic = String(args?.topic || args?.title || 'Presentación').trim();
      const title = String(args?.title || topic).trim();
      // The color is whatever the USER asked for (any name or #hex). When the
      // request has no color, fall back to a clean LIGHT theme — never pink.
      const requestedHex = normalizeHex(args?.color);
      let hex = requestedHex || DEFAULT_DECK_COLOR;
      let outline;
      try { outline = normalizeOutline(args?.outline); } catch (err) { return `ERROR: ${err.message}`; }
      const filename = String(args?.filename || `${topic.replace(/[^\w\-]+/g, '-').slice(0, 40) || 'presentacion'}.pptx`).replace(/\.pptx$/i, '') + '.pptx';
      const plan = outline.length
        ? outline
        : buildSkeletonPlan({ title, topic, slides: args?.slides });
      // Professional design system first (themes of pptx-design-system: cover,
      // title rule, cards, KPI tiles, footer). A requested color stays the
      // background of every slide. Any builder error falls back to the flat
      // deck below, so a design bug never costs the user the file.
      try {
        const PptxGenJS = require('pptxgenjs');
        const { resolveDesignTheme } = require('./design-theme');
        const { buildThemedDeck } = require('./deck-builder');
        const theme = resolveDesignTheme({ colorHex: requestedHex, themeId: requestedHex ? null : (args?.theme || 'aurora') });
        if (theme && theme.palette) {
          if (!requestedHex) hex = theme.palette.bg;
          const buffer = await buildThemedDeck({ PptxGenJS, title, topic, plan, theme, colorLocked: Boolean(requestedHex) });
          const outRel = `outputs/${filename}`;
          await sandbox.writeFile(outRel, buffer);
          return cap(JSON.stringify({
            ok: true,
            path: `/workspace/${outRel}`,
            color: `#${hex}`,
            defaultColor: !requestedHex,
            theme: theme.id,
            slides: plan.length + 1,
            outlineProvided: outline.length > 0,
            filename,
          }));
        }
      } catch (err) {
        if (plan.some((item) => item.chart)) return `ERROR: E_PARAMS: No se pudo crear la gráfica editable. Usa execute_python conservando el diseño y todos los datos. ${err.message}`;
        /* flat text deck below */
      }
      if (plan.some((item) => item.chart)) return 'ERROR: E_PARAMS: El diseño con gráfica requiere execute_python; no se creó una presentación incompleta.';
      hex = requestedHex || DEFAULT_DECK_COLOR;
      try {
        const PptxGenJS = require('pptxgenjs');
        const { INTERNAL } = require('../document-editing/pptx-adapter');
        const ink = (INTERNAL.contrastTextHex && INTERNAL.contrastTextHex(hex)) || '111111';
        const pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
        pptx.author = 'SiraGPT';
        pptx.title = title;
        const paint = (slide) => {
          slide.background = { color: hex };
          slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: 0, w: 13.333, h: 7.5,
            fill: { color: hex }, line: { color: hex },
          });
        };
        // Slide plan: the model's outline IS the content. Without an outline we
        // only emit a minimal title/closing skeleton — deliberately WITHOUT
        // filler bullets ("puntos clave sobre X") so a stub can never pass for
        // real content; the prompt instructs the model to always send outline.
        const titleSlide = pptx.addSlide();
        paint(titleSlide);
        titleSlide.addText(title, {
          x: 0.7, y: 2.6, w: 12, h: 1.3,
          fontSize: 40, bold: true, color: ink, align: 'left',
        });
        for (const item of plan) {
          const slide = pptx.addSlide();
          paint(slide);
          slide.addText(item.title, {
            x: 0.7, y: 0.55, w: 12, h: 1.1,
            fontSize: 26, bold: true, color: ink, align: 'left',
          });
          if (item.bullets.length) {
            slide.addText(
              item.bullets.map((text, idx) => ({
                text,
                options: { bullet: true, breakLine: idx < item.bullets.length - 1 },
              })),
              { x: 0.85, y: 1.9, w: 11.2, h: 4.6, fontSize: 18, color: ink },
            );
          }
        }
        const buffer = await pptx.write('nodebuffer');
        const outRel = `outputs/${filename}`;
        await sandbox.writeFile(outRel, buffer);
        return cap(JSON.stringify({
          ok: true,
          path: `/workspace/${outRel}`,
          color: `#${hex}`,
          defaultColor: !normalizeHex(args?.color),
          slides: plan.length + 1,
          outlineProvided: outline.length > 0,
          filename,
        }));
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },

    async set_slide_background(args) {

      const rel = String(args?.path || '').replace(/^\/workspace\/?/, '');
      const hex = normalizeHex(args?.color);
      if (!rel) return 'ERROR: path is required';
      if (!hex) return `ERROR: color not understood (${args?.color}). Use a hex like #1E3A8A or a name like blanco/rosado.`;
      try {
        const buf = await sandbox.readFile(rel);
        const slideNumber = args?.slide_number ? Number(args.slide_number) : null;
        const result = applyBg({
          buffer: buf,
          color: `#${hex}`,
          allSlides: !slideNumber,
          slideNumber,
          contrastText: true,
        });
        const base = rel.split('/').pop() || 'deck.pptx';
        const outName = base.replace(/(\.pptx)?$/i, '-editado.pptx');
        const outRel = `outputs/${outName}`;
        await sandbox.writeFile(outRel, result.buffer);
        return cap(JSON.stringify({
          ok: true,
          path: `/workspace/${outRel}`,
          color: `#${hex}`,
          slidesPainted: result.slidesPainted || result.changed || 'all',
        }));
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  };

  // Edición milimétrica (Fase B): the office executors are merged AFTER the
  // base set, so render_preview v2 replaces v1 — v1 stays as its fallback
  // for a sandbox without the engine. `office.enabled` lets tests force it.
  const officeOpts = office || {};
  const officeOn = officeOpts.enabled !== undefined
    ? Boolean(officeOpts.enabled)
    : officeEngineEnabled(officeOpts.env || process.env);
  if (officeOn) {
    Object.assign(executors, makeOfficeToolExecutors(sandbox, {
      visionVerifier: officeOpts.visionVerifier || null,
      attachImages: Boolean(officeOpts.attachImages),
      thumbs: Boolean(officeOpts.thumbs),
      onFailure: typeof officeOpts.onFailure === 'function' ? officeOpts.onFailure : null,
      fallbackRender: executors.render_preview,
      onVerify: typeof officeOpts.onVerify === 'function' ? officeOpts.onVerify : null,
    }));
    // Lets the loop tell a read-only execute_python from one that changed a
    // deliverable (gate v2). Symbol key: a model can never call it as a tool.
    executors[OUTPUTS_SNAPSHOT] = (opts) => outputsSnapshot(sandbox, opts);
  }

  // F6 — web tools run in the Node process, NOT inside the gVisor sandbox
  // (the sandbox keeps --network none). `web.enabled` lets tests force the
  // gate either way; `web` also carries the test injectables
  // ({ search, fetch, lookup, browserAct, env }).
  const webOpts = web || {};
  const webEnabled = webOpts.enabled !== undefined
    ? Boolean(webOpts.enabled)
    : webToolsEnabled(webOpts.env || process.env);
  if (webEnabled) Object.assign(executors, makeWebToolExecutors(webOpts));

  return executors;
}

/**
 * F6 — tool definitions for a run: the sandbox base set plus the web tools
 * when the SIRAGPT_AGENT_WEB kill switch allows them.
 */
function buildToolDefinitions(env = process.env) {
  const base = officeEngineEnabled(env) ? withOfficeTools(BASE_TOOL_DEFINITIONS) : [...BASE_TOOL_DEFINITIONS];
  return webToolsEnabled(env) ? [...base, ...WEB_TOOL_DEFINITIONS] : base;
}

/**
 * render_preview v1 is replaced IN PLACE by v2 and the other office tools
 * follow it, so the office workflow reads as one group in the tool list.
 */
function withOfficeTools(definitions) {
  const v2 = OFFICE_TOOL_DEFINITIONS.find((d) => d.function.name === 'render_preview');
  const others = OFFICE_TOOL_DEFINITIONS.filter((d) => d.function.name !== 'render_preview');
  const out = [];
  for (const def of definitions) {
    if (def.function.name === 'render_preview') out.push(v2, ...others);
    else out.push(def);
  }
  return out;
}

module.exports = {
  makeToolExecutors,
  buildToolDefinitions,
  officeEngineEnabled,
  OFFICE_TOOL_DEFINITIONS,
  BASE_TOOL_DEFINITIONS,
  WEB_TOOL_DEFINITIONS,
  webToolsEnabled,
  normalizeHex,
  normalizeOutline,
  NAMED_COLORS,
  DEFAULT_DECK_COLOR,
  CMD_TIMEOUT_MS,
};

// Live view: `TOOL_DEFINITIONS` reflects the CURRENT env each time it is
// read, so `require('./tools').TOOL_DEFINITIONS` includes the web tools
// exactly when the kill switch is on. (Consumers that destructure at module
// load — e.g. agent-runner/index.js — capture the boot-time value, which is
// the intended behavior for a process-level kill switch.)
Object.defineProperty(module.exports, 'TOOL_DEFINITIONS', {
  enumerable: true,
  configurable: true,
  get: () => buildToolDefinitions(),
});
