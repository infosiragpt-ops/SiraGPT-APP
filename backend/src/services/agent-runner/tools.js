'use strict';

/**
 * Generic AgentRunner tools. Small set, model-agnostic:
 *   execute_python, execute_bash, read_file, write_file, list_files,
 *   render_preview, set_slide_background (optional high-level).
 *
 * Bound to ONE sandbox session. Errors return `ERROR: …` strings so the loop
 * never throws on a tool failure.
 */

const { makeToolExecutors: makeDocExecutors } = require('../doc-agent/tools');

const MAX_TOOL_RESULT_CHARS = 30_000;
const CMD_TIMEOUT_MS = 120_000;

const NAMED_COLORS = {
  blanco: 'FFFFFF', white: 'FFFFFF', blanca: 'FFFFFF', blancos: 'FFFFFF', blancas: 'FFFFFF',
  rosado: 'FFC0CB', rosa: 'FFC0CB', pink: 'FFC0CB', rosada: 'FFC0CB',
  rosados: 'FFC0CB', rosadas: 'FFC0CB',
  negro: '000000', black: '000000', negra: '000000', negros: '000000', negras: '000000',
  azul: '1E3A8A', blue: '1E3A8A', azules: '1E3A8A',
  rojo: 'DC2626', red: 'DC2626', roja: 'DC2626', rojos: 'DC2626', rojas: 'DC2626',
  verde: '16A34A', green: '16A34A', verdes: '16A34A',
  gris: '6B7280', gray: '6B7280', grey: '6B7280', grises: '6B7280',
};

function cap(s) {
  const str = String(s == null ? '' : s);
  return str.length > MAX_TOOL_RESULT_CHARS
    ? `${str.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[result truncated]`
    : str;
}

function normalizeHex(raw) {
  const s = String(raw || '').trim();
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return named;
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : null;
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description:
        'Run Python 3 inside the isolated /workspace sandbox. Libraries: python-pptx, python-docx, openpyxl, lxml, pypdf, Pillow. Uploaded files are in /workspace/uploads; write deliverables to /workspace/outputs. 120s timeout, no network.',
      parameters: {
        type: 'object',
        properties: {
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
      name: 'create_presentation',
      description:
        'Create a NEW PowerPoint from scratch (topic + theme color). Use this when the user asks to CREATE a ppt, not to edit an uploaded file. Color: hex or named (rosado, blanco, azul). Writes /workspace/outputs/<file>.pptx.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Subject of the deck, e.g. embarazo.' },
          title: { type: 'string', description: 'Title slide text.' },
          color: { type: 'string', description: 'Theme color: rosado, blanco, #1E3A8A…' },
          slides: { type: 'integer', description: 'Number of slides (4-16, default 8).' },
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

function makeToolExecutors(sandbox, { setSlideBackgrounds } = {}) {
  const doc = makeDocExecutors(sandbox);
  const applyBg = setSlideBackgrounds
    || require('../document-editing/pptx-adapter').setSlideBackgrounds;

  return {
    async execute_python(args) {
      const code = String(args?.code || '').trim();
      if (!code) return 'ERROR: empty code';
      const wrapped = `python3 - <<'PY'\n${code}\nPY`;
      const r = await sandbox.exec(wrapped, { timeoutMs: CMD_TIMEOUT_MS });
      const parts = [];
      if (r.stdout) parts.push(r.stdout);
      if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
      parts.push(r.timedOut ? `[exit ${r.exitCode} — TIMED OUT]` : `[exit ${r.exitCode}]`);
      const output = cap(parts.join('\n'));
      if (r.aborted) return `ERROR: sandbox command aborted\n${output}`;
      if (r.timedOut) return `ERROR: sandbox command timed out after ${CMD_TIMEOUT_MS}ms\n${output}`;
      if (Number(r.exitCode) !== 0) return `ERROR: python failed\n${output}`;
      return output;
    },

    async execute_bash(args) {
      const command = String(args?.command || '').trim();
      if (!command) return 'ERROR: empty command';
      const r = await sandbox.exec(command, { timeoutMs: CMD_TIMEOUT_MS });
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

    async render_preview(args) {
      const rel = String(args?.path || '').replace(/^\/workspace\/?/, '');
      if (!rel) return 'ERROR: path is required';
      const src = rel.startsWith('/') ? rel : `/workspace/${rel}`;
      try {
        await sandbox.exec('mkdir -p /workspace/previews', { timeoutMs: 10_000 });
        const conv = await sandbox.exec(
          `soffice --headless --convert-to png --outdir /workspace/previews ${JSON.stringify(src)}`,
          { timeoutMs: CMD_TIMEOUT_MS },
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
      const hex = normalizeHex(args?.color) || 'FFC0CB';
      const n = Math.max(4, Math.min(16, Number(args?.slides) || 8));
      const filename = String(args?.filename || `${topic.replace(/[^\w\-]+/g, '-').slice(0, 40) || 'presentacion'}.pptx`).replace(/\.pptx$/i, '') + '.pptx';
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
        const titles = [title, `Qué es ${topic}`, 'Etapas', 'Cuidados y recomendaciones', 'Señales de alerta', 'Alimentación', 'Preguntas frecuentes', 'Gracias'];
        while (titles.length < n) titles.splice(titles.length - 1, 0, `${topic} (${titles.length})`);
        const used = titles.slice(0, n - 1).concat(['Gracias']);
        used.forEach((t, i) => {
          const slide = pptx.addSlide();
          paint(slide);
          slide.addText(t, {
            x: 0.7, y: i === 0 || t === 'Gracias' ? 2.6 : 0.55,
            w: 12, h: 1.1,
            fontSize: i === 0 || t === 'Gracias' ? 36 : 26,
            bold: true, color: ink, align: 'left',
          });
          if (t !== 'Gracias' && i !== 0) {
            slide.addText([
              { text: `Puntos clave sobre ${topic}`, options: { bullet: true, breakLine: true } },
              { text: 'Información clara, verificable y útil', options: { bullet: true, breakLine: true } },
              { text: 'Consulta siempre con un profesional de salud', options: { bullet: true } },
            ], { x: 0.85, y: 1.9, w: 11.2, h: 3.6, fontSize: 18, color: ink });
          }
        });
        const buffer = await pptx.write('nodebuffer');
        const outRel = `outputs/${filename}`;
        await sandbox.writeFile(outRel, buffer);
        return cap(JSON.stringify({
          ok: true,
          path: `/workspace/${outRel}`,
          color: `#${hex}`,
          slides: used.length,
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
}

module.exports = {
  TOOL_DEFINITIONS,
  makeToolExecutors,
  normalizeHex,
  NAMED_COLORS,
  CMD_TIMEOUT_MS,
};
