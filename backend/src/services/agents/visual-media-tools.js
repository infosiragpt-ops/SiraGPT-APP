/**
 * visual-media-tools — agentic tools for image, video, chart, diagram,
 * infographic, and dashboard generation.
 *
 * Each tool follows the react-agent shape used by task-tools.js:
 *   { name, description, parameters, execute(args, ctx) → result }
 *
 * All generated files go through the shared artifact system so they
 * appear as downloadable assets in the chat and are persisted for
 * the agent's Verify step.
 *
 * Design principles:
 * • Reuse existing siraGPT services (ai-service for images, viz-generator
 *   for charts, code-sandbox for SVG/Html rendering) — no duplicate logic.
 * • Every tool emits ctx.onEvent events so the SSE stream updates the
 *   UI in real time (tool_call → tool_output with progress).
 * • Artifacts are saved with the same saveArtifact() helper the rest
 *   of the agent toolbelt uses for consistency.
 * • All external API calls are guarded with ctx.signal for cancellation
 *   and a reasonable timeout (default 60 s, extended for video).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sandbox = require('./code-sandbox');
const { saveArtifact, EXTENSION_TO_MIME, INTERNAL } = require('./task-tools');

const { previewText, validateAgentArtifactBuffer } = INTERNAL;

// ── Lazy imports (avoid circular deps / unnecessary loads) ─────────────

let aiServiceMod;
function getAiService() {
  if (!aiServiceMod) aiServiceMod = require('../../services/ai-service');
  return aiServiceMod;
}

let vizGeneratorMod;
function getVizGenerator() {
  if (!vizGeneratorMod) vizGeneratorMod = require('../../services/viz-generator');
  return vizGeneratorMod;
}

let imageEngineMod;
function getImageEngine() {
  if (!imageEngineMod) imageEngineMod = require('../media/image-engine');
  return imageEngineMod;
}

// ── Shared helpers ──────────────────────────────────────────────────────

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function tempPath(filename) {
  const dir = process.env.AGENT_ARTIFACT_DIR
    || path.join(process.cwd(), 'uploads', 'agent-artifacts');
  ensureDir(dir);
  return path.join(dir, `vis-${Date.now()}-${String(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}

function emitEvent(ctx, type, data) {
  if (ctx && typeof ctx.onEvent === 'function') {
    try { ctx.onEvent({ type, ...data }); } catch { /* best-effort */ }
  }
}

function finalizeArtifact({ filename, buffer, mime, ctx }) {
  const b64 = buffer.toString('base64');
  return saveArtifact({
    filename,
    base64: b64,
    mime,
    ownerUserId: ctx?.userId,
    chatId: ctx?.chatId,
  });
}

/**
 * Make a safe SVG string that validates as well-formed XML.
 */
function svgDocument({ width = 800, height = 600, body, title, description } = {}) {
  const safeTitle = xmlEscape(String(title || ''));
  const safeDesc = xmlEscape(String(description || ''));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="0 0 ${width} ${height}"`,
    `     role="img" aria-labelledby="vis-title vis-desc">`,
    `  <title id="vis-title">${safeTitle}</title>`,
    `  <desc id="vis-desc">${safeDesc}</desc>`,
    `  <defs>`,
    `    <filter id="vis-shadow"><feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000" flood-opacity=".12"/></filter>`,
    `  </defs>`,
    body || '',
    `</svg>`,
  ].join('\n');
}

function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Validate a user/model-supplied color before interpolating it into an SVG
// attribute, an HTML style attribute, or a JS string literal. Only accepts a
// 3- or 6-digit hex (with #) or a conservative rgb/rgba()/hsl() form; anything
// else (e.g. `"><script>` or a quote that would break out of the context)
// falls back to the theme color. Mirrors the inline /^#[0-9A-Fa-f]{6}$/ checks
// the newer diagram tools already use, hoisted into one reusable helper.
function safeColor(c, fallback) {
  if (typeof c !== 'string') return fallback;
  const v = c.trim();
  if (/^#[0-9A-Fa-f]{3}$/.test(v) || /^#[0-9A-Fa-f]{6}$/.test(v)) return v;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(v)) return v;
  if (/^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\)$/.test(v)) return v;
  return fallback;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Generate a structured scene breakdown from a video prompt and duration.
 * Splits the prompt into logical scenes with descriptions, actions, visual
 * style notes, and audio cues — used as storyboard fallback when no real
 * video generation API is configured.
 */
function generateScenesFromPrompt(prompt, totalDuration) {
  const safePrompt = String(prompt || '');
  const words = safePrompt.split(/\s+/).filter(Boolean);
  const sceneCount = Math.min(Math.max(Math.ceil(words.length / 20), 3), 8);
  const durationPerScene = Math.max(2, Math.floor(totalDuration / sceneCount));
  const remainingDuration = totalDuration - (durationPerScene * (sceneCount - 1));

  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];
  const visualStyles = [
    'Cámara lenta, plano general, iluminación natural',
    'Primer plano, profundidad de campo reducida, colores cálidos',
    'Travelling lateral, enfoque suave, paleta de colores fríos',
    'Plano cenital, simetría, contraste alto',
    'Cámara en mano, estilo documental, grano de película',
    'Plano secuencia, movimiento fluido, iluminación de estudio',
    'Contrapicado, dramático, sombras marcadas',
    'Plano detalle, macro, texturas visibles',
  ];
  const audioCues = [
    'Música ambiental suave',
    'Silencio, solo sonidos ambiente',
    'Música épica cresciendo',
    'Efectos de sonido sincronizados',
    'Narración en off',
    'Transición musical',
    'Silencio dramático',
    'Crescendo musical',
  ];

  // Split words into scenes
  const wordSets = [];
  for (let i = 0; i < sceneCount; i++) {
    const start = Math.floor((i / sceneCount) * words.length);
    const end = Math.floor(((i + 1) / sceneCount) * words.length);
    wordSets.push(words.slice(start, end));
  }

  return wordSets.map((wset, i) => {
    const sceneWords = wset.join(' ');
    const duration = i === sceneCount - 1 ? remainingDuration : durationPerScene;
    const timeStart = i * durationPerScene;
    const timeEnd = timeStart + duration;

    // Build a natural description from the words for this scene
    let description = sceneWords || `Continuación de la escena anterior.`;
    if (description.length < 15) {
      description = `Escena ${i + 1}: ${safePrompt.slice(0, 40)} — secuencia ${i + 1} de ${sceneCount}.`;
    }

    // Infer action from scene position
    const actions = [
      'Apertura: establecer el contexto visual y la atmósfera.',
      'Desarrollo: presentar los elementos clave de la narrativa.',
      'Transición: cambio de perspectiva o ubicación.',
      'Clímax visual: el momento más impactante de la secuencia.',
      'Resolución: cerrar la secuencia visual.',
    ];

    return {
      scene: i + 1,
      description: description.slice(0, 250),
      action: (actions[i] || actions[actions.length - 1]).slice(0, 150),
      visualStyle: (visualStyles[i % visualStyles.length]).slice(0, 150),
      audio: (audioCues[i % audioCues.length]).slice(0, 100),
      duration,
      timeRange: `${timeStart}s - ${timeEnd}s`,
      color: colors[i % colors.length],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Tool 1: generate_image
// ─────────────────────────────────────────────────────────────────────────

const generateImage = {
  name: 'generate_image',
  description: 'Generate an image from a text description using ANY configured AI image model — OpenAI (gpt-image), Google (Imagen/Gemini), fal.ai (FLUX, etc.), OpenRouter or xAI. The model is routed to its provider automatically and, if that provider fails or has no API key, the engine fails over to the next configured one. The resulting image is saved as a downloadable artifact. Use for photos, illustrations, concept art, product mockups, or any visual content.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate. More detail = better results.' },
      style: { type: 'string', description: 'Optional style hint: "realistic", "vivid", "natural", "photographic", "digital-art", "anime", "oil-painting", "line-art". Default: "vivid".' },
      aspectRatio: { type: 'string', enum: ['square', 'wide', 'portrait'], description: 'Aspect ratio hint. Default: "square". wide → landscape, portrait → vertical.' },
      quality: { type: 'string', enum: ['standard', 'hd'], description: 'Quality level. Default: "standard".' },
      model: { type: 'string', description: 'Optional image model id, e.g. "gpt-image-2", "imagen-4.0-generate-001", "fal-ai/flux/schnell", "google/gemini-2.5-flash-image", "grok-2-image". Only pass it when the user asked for a specific model; omit to use the best configured provider.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute({ prompt, style = 'vivid', aspectRatio = 'square', quality = 'standard', model }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'generate_image', preview: prompt });

    try {
      // Enhance prompt with style hint
      const styleHints = {
        realistic: 'Photorealistic, highly detailed.',
        vivid: 'Vivid colors, striking composition.',
        natural: 'Natural lighting, candid style.',
        photographic: 'Photographic quality, shallow depth of field.',
        'digital-art': 'Digital art, rendered, clean lines.',
        anime: 'Anime style, cel-shaded.',
        'oil-painting': 'Oil on canvas, textured brushstrokes.',
        'line-art': 'Clean line art, no fill, minimalist.',
      };
      const styleDesc = styleHints[style] || 'Vivid colors, striking composition.';
      const enhancedPrompt = `${styleDesc} ${prompt}`;

      emitEvent(ctx, 'tool_output', { tool: 'generate_image', preview: 'Generando imagen…', partial: true });

      const engine = getImageEngine();
      const result = await engine.generateImage({
        prompt: enhancedPrompt,
        model: model || ctx.imageModel || undefined,
        aspectRatio,
        quality,
        n: 1,
        signal: ctx.signal,
      });

      if (!result.ok || !result.images?.length) {
        const msg = result.error || 'El servicio de imágenes no devolvió resultado. Reintenta con un prompt más simple.';
        emitEvent(ctx, 'tool_output', { tool: 'generate_image', ok: false, preview: msg });
        return { ok: false, error: msg, attempts: result.attempts };
      }

      const buffer = Buffer.from(result.images[0].b64, 'base64');
      const filename = `image_${crypto.randomBytes(4).toString('hex')}.png`;

      const artifact = finalizeArtifact({ filename, buffer, mime: 'image/png', ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'png',
          mime: 'image/png',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'generate_image',
        ok: true,
        preview: `Imagen lista: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB, ${result.model} vía ${result.provider})`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        mime: 'image/png',
        prompt: enhancedPrompt,
        provider: result.provider,
        model: result.model,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'generate_image', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 1b: edit_image (img2img — transform an existing image)
// ─────────────────────────────────────────────────────────────────────────

/** Resolve the source image for edit_image into a Buffer. */
async function resolveEditSourceImage({ imageUrl, fileId }, ctx = {}) {
  const prisma = ctx.prisma || (() => { try { return require('../../config/database'); } catch { return null; } })();

  async function bufferFromFileRecord(record) {
    if (!record || !record.path) return null;
    try {
      const buf = await fs.promises.readFile(record.path);
      return buf && buf.length
        ? { buffer: buf, mimeType: record.mimeType || 'image/png', source: record.originalName || record.filename }
        : null;
    } catch {
      return null;
    }
  }

  // 1. Explicit URL (http(s), data: or a local /uploads path).
  const url = String(imageUrl || '').trim();
  if (url) {
    const dataMatch = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (dataMatch) {
      return { buffer: Buffer.from(dataMatch[2], 'base64'), mimeType: dataMatch[1], source: 'data-url' };
    }
    if (/^https?:\/\//i.test(url)) {
      try {
        // SSRF guard: the URL is an LLM-produced tool argument — block
        // private / loopback / cloud-metadata targets with the same vetting
        // the harness web_fetch tool uses, and refuse redirects (an
        // approved host could otherwise bounce us to an internal one).
        // eslint-disable-next-line global-require
        const { assertSafeUrl } = require('../agent-harness/tools/web-fetch-tool');
        assertSafeUrl(url);
        const resp = await fetch(url, { redirect: 'error', ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (resp && resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length) {
            return { buffer: buf, mimeType: resp.headers?.get?.('content-type') || 'image/png', source: url };
          }
        }
      } catch { /* unsafe or unreachable URL → fall through to other sources */ }
    }
    const uploadsMatch = url.match(/\/uploads\/(.+)$/);
    if (uploadsMatch) {
      try {
        // Containment check: the captured segment is attacker-influenced —
        // resolve it and require it to stay inside the uploads root so
        // "/uploads/../../etc/passwd" cannot escape.
        const uploadsRoot = path.resolve(__dirname, '../../../uploads');
        const local = path.resolve(uploadsRoot, uploadsMatch[1]);
        if (local === uploadsRoot || !local.startsWith(uploadsRoot + path.sep)) return null;
        const buf = await fs.promises.readFile(local);
        if (buf.length) return { buffer: buf, mimeType: 'image/png', source: url };
      } catch { /* fall through */ }
    }
  }

  // 2. Explicit fileId (ownership-checked).
  if (fileId && prisma && ctx.userId) {
    try {
      const record = await prisma.file.findFirst({ where: { id: String(fileId), userId: ctx.userId } });
      const resolved = await bufferFromFileRecord(record);
      if (resolved) return resolved;
    } catch { /* fall through */ }
  }

  // 3. Image attached to THIS message (toolContext.fileIds).
  if (prisma && ctx.userId && Array.isArray(ctx.fileIds) && ctx.fileIds.length) {
    try {
      const records = await prisma.file.findMany({
        where: { id: { in: ctx.fileIds.map(String) }, userId: ctx.userId },
      });
      const image = records.find((r) => String(r.mimeType || '').startsWith('image/'));
      const resolved = await bufferFromFileRecord(image);
      if (resolved) return resolved;
    } catch { /* fall through */ }
  }

  // 4. Most recent image in the chat (uploaded or generated via the
  //    dedicated image route, which persists files on the message). The
  //    fileId embedded in message.files is NOT trusted: the file record
  //    must belong to the requesting user (same ownership filter as the
  //    fileId branches above).
  if (prisma && ctx.chatId && ctx.userId) {
    try {
      const messages = await prisma.message.findMany({
        where: { chatId: ctx.chatId, files: { not: null } },
        orderBy: { timestamp: 'desc' },
        take: 10,
      });
      for (const message of messages) {
        let files;
        try {
          files = typeof message.files === 'string' ? JSON.parse(message.files) : message.files;
        } catch { continue; }
        if (!Array.isArray(files)) continue;
        const image = files.find((f) => f && (f.type === 'image' || String(f.type || '').startsWith('image/')) && (f.fileId || f.id));
        if (!image) continue;
        const record = await prisma.file.findFirst({
          where: { id: String(image.fileId || image.id), userId: ctx.userId },
        });
        const resolved = await bufferFromFileRecord(record);
        if (resolved) return resolved;
      }
    } catch { /* fall through */ }
  }

  return null;
}

const editImage = {
  name: 'edit_image',
  description: 'Edit / transform an EXISTING image with a natural-language instruction (img2img): remove or change the background, add/remove objects, change colors or style, retouch, restore, etc. The source image is resolved automatically from the file the user attached, an explicit imageUrl/fileId, or the most recent image in this chat. Use when the user says "edita/modifica/retoca esta foto", "quítale el fondo", "cámbiale el color", "remove the background". Do NOT use to create brand-new images — that is generate_image.',
  parameters: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: 'The transformation to apply, in natural language (e.g. "quita el fondo y déjalo transparente", "make the sky sunset orange").' },
      imageUrl: { type: 'string', description: 'Optional URL of the source image (http(s), data: or an /uploads path from this chat).' },
      fileId: { type: 'string', description: 'Optional id of an uploaded file to edit. Defaults to the image attached to the message or the last image in the chat.' },
      model: { type: 'string', description: 'Optional edit model override (e.g. "gemini-2.5-flash-image", "gpt-image-1"). Omit to use the best configured provider.' },
    },
    required: ['instruction'],
    additionalProperties: false,
  },
  async execute({ instruction, imageUrl, fileId, model } = {}, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'edit_image', preview: instruction });

    try {
      const cleanInstruction = String(instruction || '').trim();
      if (!cleanInstruction) return { ok: false, error: 'La instrucción de edición está vacía.' };

      emitEvent(ctx, 'tool_output', { tool: 'edit_image', preview: 'Buscando la imagen a editar…', partial: true });
      const source = await resolveEditSourceImage({ imageUrl, fileId }, ctx);
      if (!source) {
        const msg = 'No encontré ninguna imagen para editar. Pide al usuario que adjunte la imagen o genera una primero con generate_image.';
        emitEvent(ctx, 'tool_output', { tool: 'edit_image', ok: false, preview: msg });
        return { ok: false, error: msg };
      }

      emitEvent(ctx, 'tool_output', { tool: 'edit_image', preview: 'Aplicando la edición a la imagen…', partial: true });
      const engine = getImageEngine();
      const result = await engine.editImage({
        prompt: cleanInstruction,
        imageBuffer: source.buffer,
        mimeType: source.mimeType,
        model,
        signal: ctx.signal,
      });

      if (!result.ok || !result.images?.length) {
        const msg = result.error || 'El servicio de edición de imágenes no devolvió resultado.';
        emitEvent(ctx, 'tool_output', { tool: 'edit_image', ok: false, preview: msg });
        return { ok: false, error: msg, attempts: result.attempts };
      }

      const buffer = Buffer.from(result.images[0].b64, 'base64');
      const filename = `imagen_editada_${crypto.randomBytes(4).toString('hex')}.png`;
      const artifact = finalizeArtifact({ filename, buffer, mime: 'image/png', ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'png',
          mime: 'image/png',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'edit_image',
        ok: true,
        preview: `Imagen editada: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB, ${result.model} vía ${result.provider})`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        mime: 'image/png',
        instruction: cleanInstruction,
        sourceImage: source.source,
        provider: result.provider,
        model: result.model,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'edit_image', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 2: create_chart
// ─────────────────────────────────────────────────────────────────────────

const createChart = {
  name: 'create_chart',
  description: 'Generate a data chart or graph (bar, line, pie, scatter, histogram, area, radar, donut, bubble, horizontal_bar, funnel, gauge, waterfall, heatmap, treemap) from structured data. The chart is rendered as an SVG file and saved as a downloadable artifact. For complex multi-series or interactive charts, describe the data in detail.',
  parameters: {
    type: 'object',
    properties: {
      chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'histogram', 'area', 'radar', 'donut', 'bubble', 'horizontal_bar', 'funnel', 'gauge', 'waterfall', 'heatmap', 'treemap'], description: 'Type of chart to generate.' },
      title: { type: 'string', description: 'Chart title.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Category labels (x-axis for bar/line, segments for pie/donut).' },
      datasets: { type: 'array', items: { type: 'object', properties: {
        label: { type: 'string', description: 'Series label for legend.' },
        data: { type: 'array', items: { type: 'number' }, description: 'Numeric values for this series.' },
        color: { type: 'string', description: 'Optional hex color like #FF6B35.' },
      } }, description: 'One or more data series.' },
      xLabel: { type: 'string', description: 'X-axis label.' },
      yLabel: { type: 'string', description: 'Y-axis label.' },
      stacked: { type: 'boolean', description: 'Stack bar/area series. Default false.' },
      theme: { type: 'string', enum: ['professional', 'vibrant', 'pastel', 'dark', 'minimal'], description: 'Color theme. Default: "professional".' },
    },
    required: ['chartType', 'title', 'labels', 'datasets'],
    additionalProperties: false,
  },
  async execute({ chartType, title, labels, datasets, xLabel, yLabel, stacked, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_chart', preview: `${chartType}: ${title}` });

    try {
      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeLabels = labels.map(l => xmlEscape(String(l)));

      // Color palettes
      const palettes = {
        professional: ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'],
        vibrant:      ['#FF6B35', '#004E89', '#1A936F', '#FFC857', '#E71D36', '#7B2D8E', '#00B4D8', '#FF8C42'],
        pastel:       ['#A7C7E7', '#B5EAD7', '#FFDAC1', '#FFC8DD', '#C7CEEA', '#F0E6EF', '#D4F0F0', '#FDE2E4'],
        dark:         ['#00D4AA', '#FF6B6B', '#54A0FF', '#FFD93D', '#6C5CE7', '#FD79A8', '#00CEC9', '#E17055'],
        minimal:      ['#1a1a2e', '#16213e', '#0f3460', '#e94560', '#533483', '#3b82f6', '#10b981', '#f59e0b'],
      };
      const palette = palettes[theme] || palettes.professional;

      // Compute layout
      const W = chartType === 'horizontal_bar' ? 1000 : (chartType === 'gauge' ? 600 : 800);
      const H = chartType === 'horizontal_bar'
        ? Math.max(400, labels.length * 50 + 120)
        : chartType === 'funnel'
          ? Math.max(400, labels.length * 70 + 140)
          : chartType === 'gauge'
            ? 400
            : 500;
      const M = { top: 60, right: 40, bottom: 80, left: 80 };
      const innerW = W - M.left - M.right;
      const innerH = H - M.top - M.bottom;

      // Sanitize numeric inputs — coerce non-finite values to 0 so a single
      // bad cell (NaN/null/string) doesn't poison the entire chart.
      datasets = datasets.map(d => ({
        ...d,
        data: (d.data || []).map(v => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        }),
      }));

      // Find global max
      const allValues = datasets.flatMap(d => d.data);
      const maxVal = Math.max(...allValues, 1) * 1.15;
      const minVal = Math.min(...allValues, 0);
      const range = maxVal - minVal || maxVal || 1;

      // Y-axis ticks
      const ticks = 5;
      const tickStep = range / ticks;
      const tickFormat = (v) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(range < 10 ? 1 : 0);

      // Colors per dataset
      const colors = datasets.map((d, i) => safeColor(d.color, palette[i % palette.length]));

      function buildChartBody() {
        if (chartType === 'pie' || chartType === 'donut') {
          return buildPieBody();
        }
        if (chartType === 'horizontal_bar') {
          return buildHBarBody();
        }
        if (chartType === 'funnel') {
          return buildFunnelBody();
        }
        if (chartType === 'gauge') {
          return buildGaugeBody();
        }
        if (chartType === 'waterfall') {
          return buildWaterfallBody();
        }
        if (chartType === 'heatmap') {
          return buildHeatmapBody();
        }
        if (chartType === 'treemap') {
          return buildTreemapBody();
        }
        return buildCartesianBody();
      }

      function buildHeatmapBody() {
        // Heatmap: rows = datasets (each dataset.label is a row label),
        // columns = labels. Values are mapped to color intensity.
        if (!datasets.length) return '';
        const rows = datasets.length;
        const cols = labels.length || 1;
        const cellW = innerW / cols;
        const cellH = Math.min(50, innerH / rows);
        const allVals = datasets.flatMap(d => d.data);
        const vMin = Math.min(...allVals, 0);
        const vMax = Math.max(...allVals, 1);
        const vRange = vMax - vMin || 1;

        function lerpColor(t) {
          // Cool→warm: light blue → dark blue → red
          t = Math.max(0, Math.min(1, t));
          const stops = [
            [241, 245, 249], // slate-100
            [147, 197, 253], // blue-300
            [59, 130, 246],  // blue-500
            [220, 38, 38],   // red-600
          ];
          const idx = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
          const local = (t * (stops.length - 1)) - idx;
          const a = stops[idx], b = stops[idx + 1];
          const r = Math.round(a[0] + (b[0] - a[0]) * local);
          const g = Math.round(a[1] + (b[1] - a[1]) * local);
          const bl = Math.round(a[2] + (b[2] - a[2]) * local);
          return `rgb(${r},${g},${bl})`;
        }

        let body = '';
        // Column labels
        safeLabels.forEach((lbl, ci) => {
          const cx = M.left + (ci + 0.5) * cellW;
          body += `<text x="${cx}" y="${M.top - 12}" text-anchor="middle" font-family="Arial" font-size="11" fill="#555">${lbl}</text>`;
        });
        // Row labels + cells
        datasets.forEach((ds, ri) => {
          const ry = M.top + ri * cellH;
          const safeRow = xmlEscape(String(ds.label || `Fila ${ri + 1}`).slice(0, 30));
          body += `<text x="${M.left - 8}" y="${ry + cellH / 2 + 4}" text-anchor="end" font-family="Arial" font-size="11" fill="#555">${safeRow}</text>`;
          for (let ci = 0; ci < cols; ci++) {
            const v = ds.data[ci];
            if (v === undefined || v === null) continue;
            const t = (v - vMin) / vRange;
            const fill = lerpColor(t);
            const x = M.left + ci * cellW;
            body += `<rect x="${x + 1}" y="${ry + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="${fill}" rx="2"/>`;
            body += `<text x="${x + cellW / 2}" y="${ry + cellH / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="10" fill="${t > 0.55 ? '#fff' : '#1E293B'}" font-weight="bold">${tickFormat(v)}</text>`;
          }
        });
        // Legend (gradient bar)
        const legX = M.left + innerW - 220;
        const legY = M.top + datasets.length * cellH + 24;
        body += `<text x="${legX}" y="${legY - 6}" font-family="Arial" font-size="10" fill="#666">${tickFormat(vMin)}</text>`;
        body += `<text x="${legX + 200}" y="${legY - 6}" text-anchor="end" font-family="Arial" font-size="10" fill="#666">${tickFormat(vMax)}</text>`;
        for (let i = 0; i < 40; i++) {
          body += `<rect x="${legX + i * 5}" y="${legY}" width="5" height="10" fill="${lerpColor(i / 40)}"/>`;
        }
        return body;
      }

      function buildTreemapBody() {
        // Treemap: squarified-ish layout for datasets[0].data values, labelled by safeLabels
        const ds = datasets[0];
        if (!ds || !ds.data.length) return '';
        const items = ds.data.map((v, i) => ({ v: Math.max(0, v), label: safeLabels[i] || `Item ${i + 1}` }))
          .filter(it => it.v > 0);
        if (!items.length) return '';
        items.sort((a, b) => b.v - a.v);
        const total = items.reduce((s, it) => s + it.v, 0);

        // Simple slice-and-dice: alternate horizontal/vertical splits
        function layout(items, x, y, w, h, horizontal = true) {
          if (!items.length) return [];
          if (items.length === 1) return [{ ...items[0], x, y, w, h }];
          const tot = items.reduce((s, it) => s + it.v, 0);
          // Find split that's ~half
          let acc = 0, splitIdx = 0;
          for (let i = 0; i < items.length; i++) {
            acc += items[i].v;
            if (acc >= tot / 2) { splitIdx = Math.max(1, i); break; }
          }
          const left = items.slice(0, splitIdx);
          const right = items.slice(splitIdx);
          const leftSum = left.reduce((s, it) => s + it.v, 0);
          const ratio = leftSum / tot;
          if (horizontal) {
            const wL = w * ratio;
            return [
              ...layout(left, x, y, wL, h, !horizontal),
              ...layout(right, x + wL, y, w - wL, h, !horizontal),
            ];
          } else {
            const hL = h * ratio;
            return [
              ...layout(left, x, y, w, hL, !horizontal),
              ...layout(right, x, y + hL, w, h - hL, !horizontal),
            ];
          }
        }

        const cells = layout(items, M.left, M.top, innerW, innerH, innerW > innerH);
        let body = '';
        cells.forEach((c, i) => {
          const color = palette[i % palette.length];
          body += `<rect x="${c.x + 1}" y="${c.y + 1}" width="${Math.max(c.w - 2, 0)}" height="${Math.max(c.h - 2, 0)}" fill="${color}" stroke="#fff" stroke-width="2" opacity="0.92" rx="2"/>`;
          if (c.w > 50 && c.h > 30) {
            body += `<text x="${c.x + 8}" y="${c.y + 18}" font-family="Arial" font-size="12" font-weight="bold" fill="#fff">${c.label}</text>`;
            body += `<text x="${c.x + 8}" y="${c.y + 34}" font-family="Arial" font-size="11" fill="#fff" opacity="0.85">${tickFormat(c.v)} (${((c.v / total) * 100).toFixed(1)}%)</text>`;
          } else if (c.w > 30 && c.h > 16) {
            body += `<text x="${c.x + 4}" y="${c.y + 14}" font-family="Arial" font-size="10" fill="#fff">${c.label.slice(0, 8)}</text>`;
          }
        });
        return body;
      }

      function buildFunnelBody() {
        const ds = datasets[0];
        if (!ds || !ds.data.length) return '';
        const values = ds.data;
        const maxV = Math.max(...values, 1);
        const stageH = Math.min(60, (innerH - 20) / values.length - 8);
        const cx = W / 2;
        const maxStageW = innerW * 0.8;
        let body = '';
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          const wTop = (v / maxV) * maxStageW;
          const nextV = i < values.length - 1 ? values[i + 1] : v * 0.6;
          const wBot = (nextV / maxV) * maxStageW;
          const y = M.top + i * (stageH + 8);
          const color = colors[0] || palette[i % palette.length];
          const xTopL = cx - wTop / 2, xTopR = cx + wTop / 2;
          const xBotL = cx - wBot / 2, xBotR = cx + wBot / 2;
          body += `<path d="M ${xTopL} ${y} L ${xTopR} ${y} L ${xBotR} ${y + stageH} L ${xBotL} ${y + stageH} Z" fill="${palette[i % palette.length]}" opacity="0.88" stroke="#fff" stroke-width="2"/>`;
          body += `<text x="${cx}" y="${y + stageH / 2 - 4}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="#fff">${safeLabels[i] || `Etapa ${i + 1}`}</text>`;
          body += `<text x="${cx}" y="${y + stageH / 2 + 12}" text-anchor="middle" font-family="Arial" font-size="11" fill="#fff" opacity="0.9">${tickFormat(v)}</text>`;
          if (i > 0) {
            const prev = values[i - 1] || 1;
            const pct = ((v / prev) * 100).toFixed(1);
            body += `<text x="${xTopR + 12}" y="${y + 4}" font-family="Arial" font-size="10" fill="#666">${pct}%</text>`;
          }
        }
        return body;
      }

      function buildGaugeBody() {
        const ds = datasets[0];
        if (!ds || !ds.data.length) return '';
        const value = ds.data[0] || 0;
        const max = ds.data[1] || Math.max(value * 1.25, 100);
        const cx = W / 2, cy = H * 0.65;
        const r = Math.min(W * 0.32, H * 0.42);
        const startA = Math.PI;
        const endA = 2 * Math.PI;
        const ratio = Math.max(0, Math.min(1, value / (max || 1)));
        const valueA = startA + ratio * (endA - startA);

        const arcPath = (a0, a1, rad) => {
          const x0 = cx + rad * Math.cos(a0), y0 = cy + rad * Math.sin(a0);
          const x1 = cx + rad * Math.cos(a1), y1 = cy + rad * Math.sin(a1);
          const large = (a1 - a0) > Math.PI ? 1 : 0;
          return `M ${x0} ${y0} A ${rad} ${rad} 0 ${large} 1 ${x1} ${y1}`;
        };

        let body = '';
        // Background arc
        body += `<path d="${arcPath(startA, endA, r)}" fill="none" stroke="#E5E7EB" stroke-width="28" stroke-linecap="round"/>`;
        // Value arc — color zones
        const segments = 3;
        const colors3 = ['#10B981', '#F59E0B', '#EF4444'];
        for (let i = 0; i < segments; i++) {
          const a0 = startA + (i / segments) * (endA - startA);
          const a1 = startA + ((i + 1) / segments) * (endA - startA);
          if (a0 < valueA) {
            body += `<path d="${arcPath(a0, Math.min(a1, valueA), r)}" fill="none" stroke="${colors[0] || colors3[i]}" stroke-width="28" stroke-linecap="round" opacity="0.9"/>`;
          }
        }
        // Needle
        const nx = cx + (r - 18) * Math.cos(valueA);
        const ny = cy + (r - 18) * Math.sin(valueA);
        body += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#1E293B" stroke-width="4" stroke-linecap="round"/>`;
        body += `<circle cx="${cx}" cy="${cy}" r="10" fill="#1E293B"/>`;
        body += `<circle cx="${cx}" cy="${cy}" r="4" fill="#fff"/>`;
        // Value text
        body += `<text x="${cx}" y="${cy + 50}" text-anchor="middle" font-family="Arial" font-size="32" font-weight="bold" fill="#1E293B">${tickFormat(value)}</text>`;
        body += `<text x="${cx}" y="${cy + 72}" text-anchor="middle" font-family="Arial" font-size="12" fill="#64748B">${safeLabels[0] || 'Valor'} / ${tickFormat(max)}</text>`;
        // Min / Max ticks
        body += `<text x="${cx - r}" y="${cy + 22}" text-anchor="middle" font-family="Arial" font-size="11" fill="#64748B">0</text>`;
        body += `<text x="${cx + r}" y="${cy + 22}" text-anchor="middle" font-family="Arial" font-size="11" fill="#64748B">${tickFormat(max)}</text>`;
        return body;
      }

      function buildWaterfallBody() {
        const ds = datasets[0];
        if (!ds || !ds.data.length) return '';
        const values = ds.data;
        // Compute running total at each step
        const ends = [];
        let cum = 0;
        for (let i = 0; i < values.length; i++) {
          ends.push({ start: cum, end: cum + values[i], val: values[i] });
          cum += values[i];
        }
        const allCums = ends.flatMap(e => [e.start, e.end]).concat([0]);
        const wMax = Math.max(...allCums);
        const wMin = Math.min(...allCums, 0);
        const wRange = (wMax - wMin) || 1;

        const seriesWidth = innerW / values.length;
        const barW = Math.max(20, seriesWidth * 0.6);
        let body = '';

        // Grid + zero line
        for (let t = 0; t <= ticks; t++) {
          const y = M.top + innerH - (t / ticks) * innerH;
          const val = wMin + (t / ticks) * wRange;
          body += `<line x1="${M.left}" y1="${y}" x2="${M.left + innerW}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          body += `<text x="${M.left - 8}" y="${y + 4}" text-anchor="end" font-family="Arial" font-size="11" fill="#888">${tickFormat(val)}</text>`;
        }

        ends.forEach((e, i) => {
          const cxBar = M.left + (i + 0.5) * seriesWidth;
          const isTotal = i === 0 || i === ends.length - 1;
          const yTop = M.top + innerH - ((Math.max(e.start, e.end) - wMin) / wRange) * innerH;
          const yBot = M.top + innerH - ((Math.min(e.start, e.end) - wMin) / wRange) * innerH;
          const fill = isTotal ? (palette[2] || '#64748B') : (e.val >= 0 ? '#10B981' : '#EF4444');
          body += `<rect x="${cxBar - barW / 2}" y="${yTop}" width="${barW}" height="${Math.max(yBot - yTop, 1)}" fill="${fill}" rx="3" opacity="0.9"/>`;
          body += `<text x="${cxBar}" y="${yTop - 6}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#1E293B">${e.val >= 0 && !isTotal ? '+' : ''}${tickFormat(e.val)}</text>`;
          body += `<text x="${cxBar}" y="${H - M.bottom + 18}" text-anchor="middle" font-family="Arial" font-size="11" fill="#555">${safeLabels[i] || `Paso ${i + 1}`}</text>`;
          // Connector line to next
          if (i < ends.length - 1) {
            const yEnd = M.top + innerH - ((e.end - wMin) / wRange) * innerH;
            body += `<line x1="${cxBar + barW / 2}" y1="${yEnd}" x2="${cxBar + seriesWidth - barW / 2}" y2="${yEnd}" stroke="#94A3B8" stroke-width="1" stroke-dasharray="3 3"/>`;
          }
        });
        return body;
      }

      function buildPieBody() {
        const cx = W / 2, cy = H / 2;
        const r = Math.min(W, H) / 2 - 60;
        const total = datasets[0]?.data.reduce((a, b) => a + b, 0) || 1;
        const isDonut = chartType === 'donut';
        let cumulative = -Math.PI / 2;
        let slices = '';
        let legends = '';

        datasets[0]?.data.forEach((val, i) => {
          if (!(val > 0)) {
            legends += `<rect x="${W - 180}" y="${60 + i * 22}" width="12" height="12" fill="${palette[i % palette.length]}" rx="2"/><text x="${W - 162}" y="${71 + i * 22}" font-family="Arial" font-size="12" fill="#333">${safeLabels[i] || ''}</text>`;
            return;
          }
          const angle = (val / total) * 2 * Math.PI;
          const startAngle = cumulative;
          const endAngle = cumulative + angle;
          const color = colors[0] || palette[i % palette.length];
          const midAngle = startAngle + angle / 2;
          const labelR = r + 24;
          const lx = cx + labelR * Math.cos(midAngle);
          const ly = cy + labelR * Math.sin(midAngle);

          // A single slice covering the full circle would have start==end,
          // which leaves the SVG arc undefined; emit a circle in that case.
          if (angle >= 2 * Math.PI - 1e-6) {
            slices += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2"/>`;
          } else {
            const startX = cx + r * Math.cos(startAngle);
            const startY = cy + r * Math.sin(startAngle);
            const endX = cx + r * Math.cos(endAngle);
            const endY = cy + r * Math.sin(endAngle);
            const largeArc = angle > Math.PI ? 1 : 0;
            slices += `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z" fill="${color}" stroke="#fff" stroke-width="2"/>`;
          }
          if (angle > 0.15) {
            const pct = ((val / total) * 100).toFixed(1);
            slices += `<text x="${lx}" y="${ly}" text-anchor="${lx > cx ? 'start' : 'end'}" dominant-baseline="middle" font-family="Arial" font-size="12" fill="#fff" font-weight="bold">${pct}%</text>`;
          }
          legends += `<rect x="${W - 180}" y="${60 + i * 22}" width="12" height="12" fill="${color}" rx="2"/><text x="${W - 162}" y="${71 + i * 22}" font-family="Arial" font-size="12" fill="#333">${safeLabels[i] || ''}</text>`;
          cumulative = endAngle;
        });

        if (isDonut) {
          slices += `<circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="#fff"/>`;
        }

        return slices + legends;
      }

      function buildHBarBody() {
        const barH = Math.min(28, (innerH - 20) / safeLabels.length - 4);
        let bars = '';
        const ds = datasets[0];
        if (!ds) return '';

        ds.data.forEach((val, i) => {
          const barW = (val / maxVal) * innerW;
          const y = M.top + i * (barH + 6) + 4;
          const color = colors[0] || palette[i % palette.length];
          bars += `<rect x="${M.left}" y="${y}" width="${Math.max(barW, 1)}" height="${barH}" fill="${color}" rx="4" opacity="0.9"/>`;
          bars += `<text x="${M.left - 8}" y="${y + barH / 2}" text-anchor="end" dominant-baseline="middle" font-family="Arial" font-size="12" fill="#555">${safeLabels[i]}</text>`;
          bars += `<text x="${M.left + barW + 6}" y="${y + barH / 2}" dominant-baseline="middle" font-family="Arial" font-size="11" fill="#333">${tickFormat(val)}</text>`;
        });

        return bars;
      }

      function buildCartesianBody() {
        const seriesWidth = innerW / safeLabels.length;
        const barCount = datasets.length;
        const barGap = 4;
        const barGroupW = barCount > 1 ? seriesWidth * 0.6 : seriesWidth * 0.7;
        const barW = Math.max(8, (barGroupW - barGap * (barCount - 1)) / barCount);

        let elements = '';
        let legends = '';

        // Grid lines
        for (let t = 0; t <= ticks; t++) {
          const y = M.top + innerH - (t / ticks) * innerH;
          const val = minVal + (t / ticks) * range;
          elements += `<line x1="${M.left}" y1="${y}" x2="${M.left + innerW}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          elements += `<text x="${M.left - 8}" y="${y + 4}" text-anchor="end" font-family="Arial" font-size="11" fill="#888">${tickFormat(val)}</text>`;
        }

        // X-axis labels
        safeLabels.forEach((label, i) => {
          const cx = M.left + (i + 0.5) * seriesWidth;
          elements += `<text x="${cx}" y="${H - M.bottom + 18}" text-anchor="end" transform="rotate(-35, ${cx}, ${H - M.bottom + 18})" font-family="Arial" font-size="11" fill="#555">${label}</text>`;

          if (chartType === 'bar' || chartType === 'horizontal_bar') {
            datasets.forEach((ds, di) => {
              const val = ds.data[i] || 0;
              const barX = cx - barGroupW / 2 + di * (barW + barGap);
              const barH = (val / maxVal) * innerH;
              const barY = M.top + innerH - barH;
              const color = colors[di] || palette[di % palette.length];
              const opacity = stacked ? '0.85' : '0.9';
              elements += `<rect x="${barX}" y="${barY}" width="${barW}" height="${Math.max(barH, 1)}" fill="${color}" rx="3" opacity="${opacity}"/>`;
              if (barH > 20) {
                elements += `<text x="${barX + barW / 2}" y="${barY + 14}" text-anchor="middle" font-family="Arial" font-size="10" fill="#fff" font-weight="bold">${tickFormat(val)}</text>`;
              }
            });
          } else {
            // Line / area / scatter
            if (chartType !== 'scatter') {
              datasets.forEach((ds, di) => {
                const val = ds.data[i] || 0;
                const x = chartType === 'scatter' ? M.left + (i + 0.25 + Math.random() * 0.5) * seriesWidth : cx;
                const y = M.top + innerH - (val / maxVal) * innerH;
                const color = colors[di] || palette[di % palette.length];
                const r = chartType === 'scatter' ? 6 : (i === datasets.length - 1 ? 5 : 4);
                elements += `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2" opacity="0.85"/>`;
              });
            }

            // Line / area paths
            datasets.forEach((ds, di) => {
              if (chartType === 'scatter') return;
              const color = colors[di] || palette[di % palette.length];
              const pts = ds.data.map((val, idx) => {
                const x = M.left + (idx + 0.5) * seriesWidth;
                const y = M.top + innerH - (val / maxVal) * innerH;
                return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
              }).join(' ');
              elements += `<path d="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;

              if (chartType === 'area') {
                const firstX = M.left + 0.5 * seriesWidth;
                const lastX = M.left + (ds.data.length - 0.5) * seriesWidth;
                const areaPath = `${pts} L ${lastX} ${M.top + innerH} L ${firstX} ${M.top + innerH} Z`;
                elements += `<path d="${areaPath}" fill="${color}" opacity="0.15"/>`;
              }
            });
          }
        });

        // Legend
        datasets.forEach((ds, di) => {
          const color = colors[di] || palette[di % palette.length];
          const lx = W / 2 - (datasets.length * 100) / 2 + di * 100;
          legends += `<rect x="${lx}" y="18" width="10" height="10" fill="${color}" rx="2"/><text x="${lx + 16}" y="27" font-family="Arial" font-size="11" fill="#555">${xmlEscape(ds.label || `Serie ${di + 1}`)}</text>`;
        });

        return elements + legends;
      }

      const chartBody = buildChartBody();

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `${chartType} chart: ${safeTitle}`,
        body: `
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#FAFAFA" rx="12"/>
  <!-- Title -->
  <text x="${W / 2}" y="14" text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#1a1a2e">${safeTitle}</text>
  <!-- Axes labels -->
  ${xLabel ? `<text x="${M.left + innerW / 2}" y="${H - 12}" text-anchor="middle" font-family="Arial" font-size="12" fill="#666">${xmlEscape(xLabel)}</text>` : ''}
  ${yLabel ? `<text x="20" y="${M.top + innerH / 2}" text-anchor="middle" transform="rotate(-90, 20, ${M.top + innerH / 2})" font-family="Arial" font-size="12" fill="#666">${xmlEscape(yLabel)}</text>` : ''}
  <!-- Chart content -->
  <g>${chartBody}</g>
        `,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `chart_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_chart',
        ok: true,
        preview: `Gráfico ${chartType} listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB) — ${labels.length} categorías, ${datasets.length} serie(s)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        chartType,
        title,
        categories: labels.length,
        series: datasets.length,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_chart', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 3: create_organigram
// ─────────────────────────────────────────────────────────────────────────

const createOrganigram = {
  name: 'create_organigram',
  description: 'Generate a professional organizational chart / organigram as an SVG file. Provide a hierarchical structure of positions/people, and this tool renders a clean tree diagram with leveled positions. Use for company org charts, team structures, project hierarchies, or any tree-based reporting structure.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Chart title (e.g. "Engineering Department — 2026").' },
      root: { type: 'object', properties: {
        name: { type: 'string', description: 'Person name or position title.' },
        role: { type: 'string', description: 'Role or department.' },
        children: { type: 'array', items: {
          type: 'object', properties: {
            name: { type: 'string', description: 'Person name or position title.' },
            role: { type: 'string', description: 'Role or department.' },
            children: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Nested subordinates.' },
          }, required: ['name'],
        }, description: 'Direct reports.' },
      }, required: ['name'], description: 'Root node of the hierarchy.' },
      colorScheme: { type: 'string', enum: ['corporate', 'modern', 'warm', 'cool'], description: 'Visual color scheme. Default: "corporate".' },
    },
    required: ['title', 'root'],
    additionalProperties: false,
  },
  async execute({ title, root, structure, colorScheme = 'corporate' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_organigram', preview: title });

    try {
      // Support both root and structure param names
      root = root || structure;
      if (!root || typeof root !== 'object') {
        return { ok: false, error: 'Se requiere root/structure con la jerarquía organizacional.' };
      }

      // Color schemes
      const schemes = {
        corporate: { root: '#1e3a5f', level1: '#2563EB', level2: '#3B82F6', level3: '#60A5FA', text: '#ffffff', accent: '#F59E0B' },
        modern:    { root: '#1a1a2e', level1: '#16213e', level2: '#0f3460', level3: '#533483', text: '#ffffff', accent: '#e94560' },
        warm:      { root: '#8B4513', level1: '#A0522D', level2: '#CD853F', level3: '#DEB887', text: '#ffffff', accent: '#FF8C00' },
        cool:      { root: '#004E89', level1: '#1A936F', level2: '#0D7C66', level3: '#41B3A0', text: '#ffffff', accent: '#FFC857' },
      };
      const scheme = schemes[colorScheme] || schemes.corporate;

      // Layout variables
      const BOX_W = 180, BOX_H = 56;
      const LEVEL_GAP = 100, SIBLING_GAP = 12;

      // Build tree with positions
      function layoutTree(node, depth = 0, offset = 0) {
        const children = node.children || [];
        const childLayouts = children.map((c, i) => layoutTree(c, depth + 1, i));

        const totalChildWidth = childLayouts.length > 0
          ? childLayouts.reduce((sum, cl) => sum + cl.totalWidth, 0) + (childLayouts.length - 1) * SIBLING_GAP
          : 0;

        const nodeW = Math.max(BOX_W, totalChildWidth);
        const myX = offset;
        const myY = depth * (BOX_H + LEVEL_GAP);

        // Center children under this node
        let childOffset = myX + (nodeW - totalChildWidth) / 2;
        for (const cl of childLayouts) {
          cl.offsetX = childOffset - (myX); // relative to myX
          cl.absX = childOffset;
          childOffset += cl.totalWidth + SIBLING_GAP;
        }

        return {
          node, depth, myX, myY, nodeW, children: childLayouts,
          totalWidth: nodeW,
          offsetX: 0, absX: myX,
        };
      }

      const tree = layoutTree(root, 0, 0);
      const canvasW = Math.max(600, tree.totalWidth + 80);
      const canvasH = (maxDepth(tree) + 1) * (BOX_H + LEVEL_GAP) + 60;

      function maxDepth(n) {
        return Math.max(0, ...(n.children || []).map(maxDepth)) + 1;
      }

      // Compute absolute coordinates
      function absLayout(n, parentX = 0, parentY = 0) {
        n.absX = parentX + n.myX;
        n.absY = 50 + n.myY;
        n.cx = n.absX + n.nodeW / 2;
        n.cy = n.absY + BOX_H / 2;
        if (n.children) {
          for (const c of n.children) {
            absLayout(c, n.absX, n.absY);
          }
        }
      }
      absLayout(tree);

      const rootCx = tree.absX + tree.nodeW / 2;
      const rootCy = 50 + BOX_H / 2;

      function colorForDepth(d) {
        if (d === 0) return scheme.root;
        if (d === 1) return scheme.level1;
        if (d === 2) return scheme.level2;
        return scheme.level3;
      }

      function renderNode(n) {
        const x = n.absX, y = n.absY;
        const w = n.nodeW, h = BOX_H;
        const fill = colorForDepth(n.depth);
        let html = '';

        // Box
        html += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" filter="url(#vis-shadow)"/>`;

        // Optional accent bar for root
        if (n.depth === 0) {
          html += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${scheme.accent}"/>`;
        }

        // Name
        const safeName = xmlEscape(String(n.node.name || '').slice(0, 40));
        html += `<text x="${x + w / 2 + (n.depth === 0 ? 3 : 0)}" y="${y + 22}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${scheme.text}">${safeName}</text>`;

        // Role
        if (n.node.role) {
          const safeRole = xmlEscape(String(n.node.role).slice(0, 50));
          html += `<text x="${x + w / 2 + (n.depth === 0 ? 3 : 0)}" y="${y + 40}" text-anchor="middle" font-family="Arial" font-size="11" fill="${scheme.text}" opacity="0.85">${safeRole}</text>`;
        }

        // Connection to parent (skip for root)
        if (n.depth > 0) {
          const px = n.absX + n.nodeW / 2;
          html += `<line x1="${px}" y1="${y}" x2="${px}" y2="${y - LEVEL_GAP}" stroke="${scheme.level1}" stroke-width="2" opacity="0.4"/>`;
        }

        // Connections to children
        if (n.children.length > 0) {
          const midY = y + h;
          const firstChildCx = n.children[0].absX + n.children[0].nodeW / 2;
          const lastChildCx = n.children[n.children.length - 1].absX + n.children[n.children.length - 1].nodeW / 2;
          html += `<line x1="${n.cx}" y1="${midY}" x2="${n.cx}" y2="${midY + LEVEL_GAP * 0.3}" stroke="${scheme.level2}" stroke-width="2" opacity="0.3"/>`;
          html += `<line x1="${firstChildCx}" y1="${midY + LEVEL_GAP * 0.3}" x2="${lastChildCx}" y2="${midY + LEVEL_GAP * 0.3}" stroke="${scheme.level2}" stroke-width="2" opacity="0.3"/>`;
          for (const c of n.children) {
            const ccx = c.absX + c.nodeW / 2;
            html += `<line x1="${ccx}" y1="${midY + LEVEL_GAP * 0.3}" x2="${ccx}" y2="${c.absY}" stroke="${scheme.level2}" stroke-width="2" opacity="0.3"/>`;
          }
        }

        for (const c of n.children) html += renderNode(c);
        return html;
      }

      const body = renderNode(tree);

      const svg = svgDocument({
        width: canvasW,
        height: canvasH,
        title: xmlEscape(String(title).slice(0, 120)),
        description: `Organizational chart: ${title}`,
        body: `
  <rect width="${canvasW}" height="${canvasH}" fill="#F8FAFC" rx="12"/>
  <text x="${canvasW / 2}" y="32" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="${scheme.root}">${xmlEscape(String(title).slice(0, 120))}</text>
  ${body}
        `,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `organigram_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const nodeCount = countNodes(tree);
      emitEvent(ctx, 'tool_output', {
        tool: 'create_organigram',
        ok: true,
        preview: `Organigrama listo: ${artifact.filename} (${nodeCount} posiciones, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        nodeCount,
        structure: {
          root: root.name,
          levels: treeDepth(tree),
        },
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_organigram', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

function countNodes(n) {
  return 1 + (n.children || []).reduce((sum, c) => sum + countNodes(c), 0);
}
function treeDepth(n) {
  return 1 + Math.max(0, ...(n.children || []).map(treeDepth));
}

// ─────────────────────────────────────────────────────────────────────────
// Tool 4: create_mermaid_diagram
// ─────────────────────────────────────────────────────────────────────────

const createMermaidDiagram = {
  name: 'create_mermaid_diagram',
  description: 'Generate a diagram using Mermaid syntax (flowchart, sequence, class, state, ER, Gantt, pie, timeline, gitgraph, or requirement diagram). The diagram is rendered as an SVG file and saved as a downloadable artifact. Use for flowcharts, sequence diagrams, architecture diagrams, project timelines, or any structured visual.',
  parameters: {
    type: 'object',
    properties: {
      diagramType: { type: 'string', enum: ['flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'timeline', 'gitgraph', 'requirementDiagram'], description: 'Mermaid diagram type.' },
      title: { type: 'string', description: 'Diagram title.' },
      definition: { type: 'string', description: 'Full Mermaid diagram definition (without the type header). E.g. for flowchart: "A[Start] --> B[End]". For sequence: "Alice->>John: Hello". The type header will be prepended automatically.' },
      direction: { type: 'string', enum: ['TB', 'BT', 'LR', 'RL'], description: 'Flowchart direction (TB=top-bottom, LR=left-right). Default "TB". Ignored for non-flowchart types.' },
    },
    required: ['diagramType', 'definition'],
    additionalProperties: false,
  },
  async execute({ diagramType, title, definition, direction = 'TB' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_mermaid_diagram', preview: `${diagramType}: ${title}` });

    try {
      // Build full Mermaid source
      const safeTitle = String(title || '').slice(0, 100);
      let mermaidSource;
      if (diagramType === 'flowchart') {
        mermaidSource = `---\ntitle: ${safeTitle}\n---\nflowchart ${direction}\n${definition}`;
      } else if (diagramType === 'gitgraph') {
        mermaidSource = `---\ntitle: ${safeTitle}\n---\ngitGraph\n${definition}`;
      } else {
        mermaidSource = `${diagramType}\n${definition}`;
      }

      // Use the sandbox to render via the mermaid CLI (if available) or generate
      // an SVG that embeds the mermaid source for client-side rendering.
      // The sandbox approach calls npx @mermaid-js/mermaid-cli which may not
      // be installed; fall back to an SVG container with the source embedded.
      let svg;
      try {
        emitEvent(ctx, 'tool_output', { tool: 'create_mermaid_diagram', preview: 'Renderizando diagrama Mermaid…', partial: true });

        const script = [
          `import { execSync } from 'child_process';`,
          `import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';`,
          `import { join } from 'path';`,
          `const tmpDir = join(process.cwd(), '.mermaid-tmp');`,
          `if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });`,
          `const mmdFile = join(tmpDir, 'diagram.mmd');`,
          `const svgFile = join(tmpDir, 'diagram.svg');`,
          `writeFileSync(mmdFile, ${JSON.stringify(mermaidSource)});`,
          `try {`,
          `  execSync(\`npx -y @mermaid-js/mermaid-cli mmdc -i \${mmdFile} -o \${svgFile} -b transparent -s 2\`, { timeout: 30000, stdio: 'pipe' });`,
          `  const data = readFileSync(svgFile, 'utf-8');`,
          `  console.log(JSON.stringify({ ok: true, svg: data }));`,
          `} catch (e) {`,
          `  console.log(JSON.stringify({ ok: false, error: String(e.message || e).split('\\n')[0] }));`,
          `}`,
        ].join('\n');

        const r = await sandbox.run({
          language: 'javascript',
          source: script,
          timeoutMs: 40000,
          signal: ctx.signal,
        });

        if (r.ok && r.stdout) {
          try {
            const parsed = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
            if (parsed.ok && parsed.svg) {
              svg = parsed.svg;
            }
          } catch { /* fall through */ }
        }
      } catch { /* fall through */ }

      if (!svg) {
        // Fallback: generate a self-contained HTML file with client-side
        // Mermaid rendering via CDN. Much more useful than raw source SVG.
        const safeMermaidSource = String(mermaidSource)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

        const mermaidHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${xmlEscape(safeTitle || 'Mermaid Diagram')}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f8fafc;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 20px;
  }
  .header {
    text-align: center;
    margin-bottom: 32px;
    max-width: 800px;
    width: 100%;
  }
  .header h1 { font-size: 20px; color: #1e293b; margin-bottom: 8px; }
  .header p { font-size: 13px; color: #64748b; }
  .diagram-container {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    padding: 40px;
    max-width: 1000px;
    width: 100%;
    overflow-x: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  }
  .diagram-container pre {
    display: none;
  }
  .footer {
    margin-top: 24px;
    font-size: 11px;
    color: #94a3b8;
    text-align: center;
  }
  .loading {
    text-align: center;
    padding: 60px 20px;
    color: #64748b;
    font-size: 14px;
  }
  .loading::after {
    content: '';
    display: inline-block;
    width: 20px;
    height: 20px;
    margin-left: 8px;
    border: 2px solid #e2e8f0;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error {
    color: #ef4444;
    text-align: center;
    padding: 20px;
  }
</style>
</head>
<body>
<div class="header">
  <h1>${xmlEscape(safeTitle || 'Mermaid Diagram')}</h1>
  <p>Type: ${xmlEscape(diagramType)} · Rendered client-side via Mermaid.js CDN</p>
</div>
<div class="diagram-container">
  <pre class="mermaid">
${safeMermaidSource}
  </pre>
  <div class="loading">Renderizando diagrama…</div>
</div>
<div class="footer">
  Generado por SiraGPT · Abre este archivo en un navegador para ver el diagrama interactivo
</div>
<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: 'default',
    themeVariables: {
      primaryColor: '#3b82f6',
      primaryTextColor: '#fff',
      primaryBorderColor: '#2563eb',
      lineColor: '#64748b',
      secondaryColor: '#f1f5f9',
      tertiaryColor: '#f8fafc',
    },
    securityLevel: 'loose',
  });
  document.querySelector('.loading').style.display = 'none';
</script>
</body>
</html>`;

        const htmlBuf = Buffer.from(mermaidHtml, 'utf8');
        const htmlArtifact = finalizeArtifact({
          filename: `diagram_${crypto.randomBytes(4).toString('hex')}.html`,
          buffer: htmlBuf,
          mime: 'text/html',
          ctx,
        });

        // Also save the SVG placeholder for preview
        const lines = mermaidSource.split('\n');
        const svgH = Math.max(400, lines.length * 18 + 100);
        const svgW = Math.max(500, Math.max(...lines.map(l => l.length)) * 9 + 40);
        svg = svgDocument({
          width: svgW,
          height: svgH,
          title: xmlEscape(safeTitle),
          description: `Mermaid ${diagramType} diagram`,
          body: `
  <rect width="${svgW}" height="${svgH}" fill="#FAFBFC" rx="12"/>
  <rect x="10" y="10" width="${svgW - 20}" height="36" rx="6" fill="#E8F0FE"/>
  <text x="${svgW / 2}" y="34" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#1a1a2e">Mermaid ${diagramType}: ${xmlEscape(safeTitle)}</text>
  <text x="${svgW / 2}" y="${svgH - 16}" text-anchor="middle" font-family="Arial" font-size="11" fill="#10B981">✅ Abre el archivo .html adjunto para ver el diagrama interactivo</text>
  `,
        });

        // Emit both artifacts
        emitEvent(ctx, 'file_artifact', {
          artifact: {
            id: htmlArtifact.id,
            filename: htmlArtifact.filename,
            format: 'html',
            mime: 'text/html',
            sizeBytes: htmlArtifact.sizeBytes,
            downloadUrl: htmlArtifact.downloadUrl,
          },
        });
      }

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `diagram_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_mermaid_diagram',
        ok: true,
        preview: `Diagrama ${diagramType} listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        diagramType,
        title: safeTitle,
        mermaidSource,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_mermaid_diagram', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 5: create_infographic_svg
// ─────────────────────────────────────────────────────────────────────────

const createInfographicSvg = {
  name: 'create_infographic_svg',
  description: 'Generate a professional infographic as an SVG file. Create visual content with metrics, comparison tables, data summaries, process flows, or key takeaways. Ideal for executive summaries, data storytelling, report highlights, and visual briefs.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Infographic title.' },
      sections: { type: 'array', items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'stat', 'list', 'quote', 'progress'], description: 'Section render style. Default: "text". stat = big number, list = bullet items, quote = pulled quote, progress = progress bars.' },
          heading: { type: 'string', description: 'Section heading.' },
          content: { description: 'Section body. For text/quote/stat: a string. For list: array of strings. For progress: array of {label, percent}.' },
          subtext: { type: 'string', description: 'Optional supporting text shown below stat value.' },
          icon: { type: 'string', enum: ['chart', 'bulb', 'star', 'target', 'gear', 'shield', 'globe', 'people', 'clock', 'rocket', 'check', 'lock', 'mail', 'money', 'growth', 'warning'], description: 'Optional icon type.' },
          metrics: { type: 'array', items: { type: 'object', properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            unit: { type: 'string' },
          } }, description: 'Optional numeric metrics to display.' },
          color: { type: 'string', description: 'Optional accent hex color.' },
        },
        required: ['heading'],
      }, description: '2-6 content sections to display.' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'bold'], description: 'Visual theme. Default: "professional".' },
      backgroundColor: { type: 'string', description: 'Background hex color. Default depends on theme.' },
    },
    required: ['title', 'sections'],
    additionalProperties: false,
  },
  async execute({ title, sections = [], theme = 'professional', backgroundColor }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_infographic_svg', preview: title });

    try {
      const themes = {
        professional: { bg: '#FAFBFC', card: '#FFFFFF', accent: '#2563EB', text: '#1E293B', muted: '#64748B', border: '#E2E8F0' },
        modern:       { bg: '#0B1121', card: '#1E293B', accent: '#818CF8', text: '#F1F5F9', muted: '#94A3B8', border: '#334155' },
        minimal:      { bg: '#F8FAFC', card: '#FFFFFF', accent: '#0EA5E9', text: '#0F172A', muted: '#64748B', border: '#E2E8F0' },
        bold:         { bg: '#1E0A3C', card: '#2D1B69', accent: '#F59E0B', text: '#FEF9C3', muted: '#A78BFA', border: '#4C1D95' },
      };
      const t = themes[theme] || themes.professional;
      const bg = backgroundColor || t.bg;

      const maxSections = Math.min(sections.length, 6);
      const safeTitle = xmlEscape(String(title).slice(0, 100));
      const W = 800;
      const SECTION_H = 210;
      const HEADER_H = 100;
      const PAD = 20;
      const H = HEADER_H + maxSections * SECTION_H + PAD * 2 + 40;

      const iconSvg = {
        chart: '<circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 34 L22 26 L28 30 L36 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
        bulb: '<path d="M18 14 C18 8 22 4 28 4 C34 4 38 8 38 14 C38 20 34 24 32 28 L24 28 C22 24 18 20 18 14Z" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="24" y1="32" x2="32" y2="32" stroke="currentColor" stroke-width="2.5"/><line x1="26" y1="36" x2="30" y2="36" stroke="currentColor" stroke-width="2.5"/><line x1="27" y1="40" x2="29" y2="40" stroke="currentColor" stroke-width="2"/>',
        star: '<polygon points="28,4 34,20 50,20 38,30 42,46 28,36 14,46 18,30 6,20 22,20" fill="none" stroke="currentColor" stroke-width="2.5"/>',
        target: '<circle cx="28" cy="28" r="20" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="28" cy="28" r="12" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="28" cy="28" r="4" fill="currentColor"/>',
        gear: '<circle cx="28" cy="28" r="10" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M28 8 L28 14 M28 42 L28 48 M8 28 L14 28 M42 28 L48 28 M13 13 L17 17 M39 39 L43 43 M13 43 L17 39 M39 17 L43 13" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
        shield: '<path d="M28 6 L48 14 V26 C48 38 38 48 28 52 C18 48 8 38 8 26 V14 Z" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M18 26 L24 32 L36 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
        globe: '<circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" stroke-width="2.5"/><ellipse cx="28" cy="28" rx="12" ry="22" fill="none" stroke="currentColor" stroke-width="2"/><line x1="8" y1="28" x2="48" y2="28" stroke="currentColor" stroke-width="2.5"/><path d="M16 8 C10 16 10 40 16 48 M40 8 C46 16 46 40 40 48" fill="none" stroke="currentColor" stroke-width="2"/>',
        people: '<circle cx="18" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="38" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M8 40 C8 28 24 28 28 28 C32 28 48 28 48 40" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="28" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M18 40 C18 30 38 30 38 40" fill="none" stroke="currentColor" stroke-width="2"/>',
        clock: '<circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="28" y1="28" x2="28" y2="14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="28" y1="28" x2="38" y2="32" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
        rocket: '<path d="M28 4 L40 16 C44 24 44 34 40 42 L28 48 L16 42 C12 34 12 24 16 16 Z" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M18 22 L28 28 L38 22" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M22 36 L28 32 L34 36" fill="none" stroke="currentColor" stroke-width="2"/>',
        check: '<circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M18 28 L24 34 L38 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
        lock: '<rect x="14" y="26" width="28" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M20 26 V18 C20 12 24 8 28 8 C32 8 36 12 36 18 V26" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="28" cy="36" r="3" fill="currentColor"/>',
        mail: '<rect x="8" y="14" width="40" height="28" rx="3" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M8 18 L28 32 L48 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>',
        money: '<circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M28 14 V42 M22 20 C22 16 32 16 32 20 C32 24 22 24 22 28 C22 32 32 32 32 36" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
        growth: '<path d="M8 44 L20 30 L28 36 L40 18 L48 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 12 L48 18 L42 26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
        warning: '<path d="M28 6 L50 46 L6 46 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><line x1="28" y1="22" x2="28" y2="34" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="28" cy="40" r="2" fill="currentColor"/>',
      };

      function inferSectionType(section) {
        if (section.type) return section.type;
        if (Array.isArray(section.content)) {
          if (section.content[0] && typeof section.content[0] === 'object' && 'percent' in section.content[0]) return 'progress';
          return 'list';
        }
        return 'text';
      }

      function renderSectionContent(section, sy, contentX) {
        const accent = safeColor(section.color, t.accent);
        const stype = inferSectionType(section);
        const safeContent = section.content;

        if (stype === 'stat') {
          const val = xmlEscape(String(safeContent || '').slice(0, 24));
          const sub = section.subtext ? xmlEscape(String(section.subtext).slice(0, 80)) : '';
          let html = `<text x="${contentX}" y="${sy + 88}" font-family="Arial" font-size="40" font-weight="bold" fill="${accent}">${val}</text>`;
          if (sub) html += `<text x="${contentX}" y="${sy + 116}" font-family="Arial" font-size="12" fill="${t.muted}">${sub}</text>`;
          return html;
        }
        if (stype === 'list') {
          const items = Array.isArray(safeContent) ? safeContent : String(safeContent || '').split('\n').filter(Boolean);
          return items.slice(0, 5).map((item, idx) => {
            const safeItem = xmlEscape(String(item).slice(0, 90));
            const ly = sy + 60 + idx * 22;
            return `<circle cx="${contentX + 6}" cy="${ly - 4}" r="3" fill="${accent}"/><text x="${contentX + 18}" y="${ly}" font-family="Arial" font-size="12" fill="${t.text}">${safeItem}</text>`;
          }).join('\n');
        }
        if (stype === 'quote') {
          const q = xmlEscape(String(safeContent || '').slice(0, 220));
          return [
            `<text x="${contentX}" y="${sy + 70}" font-family="Georgia, serif" font-size="42" fill="${accent}" opacity="0.55">"</text>`,
            `<text x="${contentX + 30}" y="${sy + 80}" font-family="Georgia, serif" font-size="14" font-style="italic" fill="${t.text}">${q}</text>`,
          ].join('\n');
        }
        if (stype === 'progress') {
          const items = Array.isArray(safeContent) ? safeContent : [];
          const barW = W - 2 * PAD - contentX - 16;
          return items.slice(0, 4).map((it, idx) => {
            const pct = Math.max(0, Math.min(100, Number(it.percent) || 0));
            const safeLbl = xmlEscape(String(it.label || `Item ${idx + 1}`).slice(0, 30));
            const py = sy + 60 + idx * 30;
            return [
              `<text x="${contentX}" y="${py - 4}" font-family="Arial" font-size="11" fill="${t.text}">${safeLbl}</text>`,
              `<text x="${contentX + barW}" y="${py - 4}" text-anchor="end" font-family="Arial" font-size="11" font-weight="bold" fill="${accent}">${pct}%</text>`,
              `<rect x="${contentX}" y="${py + 2}" width="${barW}" height="8" rx="4" fill="${t.border}"/>`,
              `<rect x="${contentX}" y="${py + 2}" width="${(barW * pct) / 100}" height="8" rx="4" fill="${accent}"/>`,
            ].join('');
          }).join('\n');
        }
        // text (default)
        const txt = xmlEscape(String(safeContent || '').slice(0, 300));
        // Simple word-wrap to ~3 lines
        const charsPerLine = Math.floor((W - contentX - PAD - 16) / 7);
        const lines = [];
        let remaining = txt;
        while (remaining.length > 0 && lines.length < 4) {
          if (remaining.length <= charsPerLine) { lines.push(remaining); break; }
          let cut = remaining.lastIndexOf(' ', charsPerLine);
          if (cut <= 0) cut = charsPerLine;
          lines.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut + 1);
        }
        return lines.map((line, idx) => `<text x="${contentX}" y="${sy + 60 + idx * 18}" font-family="Arial" font-size="12" fill="${t.muted}">${line}</text>`).join('\n');
      }

      let sectionsSvg = '';
      sections.slice(0, maxSections).forEach((section, i) => {
        const sy = HEADER_H + PAD + i * SECTION_H;
        const accent = safeColor(section.color, t.accent);
        const safeHeading = xmlEscape(String(section.heading).slice(0, 80));
        const hasMetrics = Array.isArray(section.metrics) && section.metrics.length > 0;
        const iconHtml = iconSvg[section.icon] ? `<g transform="translate(${PAD + 8}, ${sy + 14})" color="${accent}" stroke-width="auto">${iconSvg[section.icon]}</g>` : '';
        const contentX = iconHtml ? 80 : PAD + 16;

        sectionsSvg += `
  <!-- Section ${i + 1} (${inferSectionType(section)}) -->
  <rect x="${PAD}" y="${sy}" width="${W - 2 * PAD}" height="${SECTION_H - 8}" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
  <rect x="${PAD}" y="${sy}" width="4" height="${SECTION_H - 8}" rx="2" fill="${accent}"/>
  ${iconHtml}
  <text x="${contentX}" y="${sy + 28}" font-family="Arial" font-size="15" font-weight="bold" fill="${t.text}">${safeHeading}</text>
  ${renderSectionContent(section, sy, contentX)}
  ${hasMetrics ? section.metrics.map((m, mi) => {
    const mx = PAD + 16 + mi * 150;
    const my = sy + SECTION_H - 40;
    const safeVal = xmlEscape(String(m.value || '').slice(0, 12));
    const safeUnit = m.unit ? xmlEscape(m.unit) : '';
    const safeLabel = xmlEscape(String(m.label || '').slice(0, 20));
    return `<text x="${mx}" y="${my}" font-family="Arial" font-size="20" font-weight="bold" fill="${accent}">${safeVal}${safeUnit ? `<tspan font-size="12" fill="${t.muted}"> ${safeUnit}</tspan>` : ''}</text><text x="${mx}" y="${my + 16}" font-family="Arial" font-size="11" fill="${t.muted}">${safeLabel}</text>`;
  }).join('\n') : ''}
        `;
      });

      // Header bar
      const headerSvg = `
  <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${t.accent}" rx="0"/>
  <text x="${W / 2}" y="44" text-anchor="middle" font-family="Georgia, serif" font-size="26" font-weight="bold" fill="#ffffff">${safeTitle}</text>
  <text x="${W / 2}" y="68" text-anchor="middle" font-family="Arial" font-size="12" fill="#ffffff" opacity="0.8">Infografía generada por agente — ${new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}</text>
      `;

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Infographic: ${safeTitle}`,
        body: `${headerSvg}${sectionsSvg}`,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `infographic_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_infographic_svg',
        ok: true,
        preview: `Infografía lista: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB, ${maxSections} secciones)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        sections: maxSections,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_infographic_svg', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 6: create_dashboard_html
// ─────────────────────────────────────────────────────────────────────────

const createDashboardHtml = {
  name: 'create_dashboard_html',
  description: 'Generate an interactive HTML data dashboard with charts, metrics, and visualizations. The dashboard is a self-contained HTML file with Chart.js (CDN) for responsive, interactive charts. Use for performance dashboards, KPI overviews, analytics reporting, or data monitoring views.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Dashboard title.' },
      metrics: { type: 'array', items: { type: 'object', properties: {
        label: { type: 'string', description: 'Metric name.' },
        value: { type: 'string', description: 'Metric value (can include formatting like "$1.2M").' },
        change: { type: 'string', description: 'Optional change indicator like "+12%".' },
        color: { type: 'string', description: 'Optional accent hex color.' },
      } }, description: '2-6 KPI metric cards at the top.' },
      charts: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string', description: 'Chart title.' },
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'bubble', 'scatter'], description: 'Chart.js chart type.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Category labels.' },
        datasets: { type: 'array', items: { type: 'object', properties: {
          label: { type: 'string' },
          data: { type: 'array', items: { type: 'number' } },
          color: { type: 'string' },
        } }, description: 'Data series.' },
        xLabel: { type: 'string', description: 'X-axis label.' },
        yLabel: { type: 'string', description: 'Y-axis label.' },
        stacked: { type: 'boolean' },
      }, required: ['title', 'type', 'labels', 'datasets'] }, description: '1-6 chart widgets.' },
      theme: { type: 'string', enum: ['light', 'dark', 'corporate', 'vibrant'], description: 'Dashboard theme. Default: "light".' },
      columns: { type: 'integer', minimum: 1, maximum: 3, description: 'Number of chart columns. Default: 2.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({ title, metrics = [], charts = [], theme = 'light', columns = 2 }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_dashboard_html', preview: title });

    try {
      const themes = {
        light:     { bg: '#F8FAFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#3B82F6' },
        dark:      { bg: '#0F172A', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8' },
        corporate: { bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#475569', border: '#CBD5E1', accent: '#2563EB' },
        vibrant:   { bg: '#0B1121', card: '#1E293B', text: '#F8FAFC', muted: '#A78BFA', border: '#4C1D95', accent: '#F59E0B' },
      };
      const t = themes[theme] || themes.light;

      const safeTitle = xmlEscape(String(title).slice(0, 200));
      const maxMetrics = metrics.slice(0, 6);
      const maxCharts = charts.slice(0, 6);
      const colClass = columns === 1 ? 'full' : columns === 3 ? 'third' : 'half';
      const chartWidth = columns === 1 ? '100%' : columns === 3 ? '33.33%' : '50%';

      // Build metric cards HTML
      const metricCards = maxMetrics.map(m => {
        const val = xmlEscape(String(m.value || '').slice(0, 20));
        const label = xmlEscape(String(m.label || '').slice(0, 30));
        const change = m.change ? xmlEscape(m.change) : null;
        const color = safeColor(m.color, t.accent);
        return `
    <div class="metric-card" style="border-top: 3px solid ${color};">
      <div class="metric-value" style="color: ${color};">${val}</div>
      <div class="metric-label">${label}</div>
      ${change ? `<div class="metric-change">${change}</div>` : ''}
    </div>`;
      }).join('\n');

      // Build chart HTML
      const chartHtml = maxCharts.map((chart, i) => {
        const safeChartTitle = xmlEscape(String(chart.title || '').slice(0, 100));
        const chartId = `chart-${i}`;
        return `
  <div class="chart-wrapper" style="${maxCharts.length === 1 ? 'flex: 0 0 100%;' : `flex: 0 0 calc(${chartWidth} - 12px);`}">
    <h3 class="chart-title">${safeChartTitle}</h3>
    ${chart.xLabel || chart.yLabel ? `<div class="chart-labels">${chart.xLabel ? `<span>X: ${xmlEscape(chart.xLabel)}</span>` : ''}${chart.yLabel ? `<span>Y: ${xmlEscape(chart.yLabel)}</span>` : ''}</div>` : ''}
    <canvas id="${chartId}"></canvas>
  </div>`;
      }).join('\n');

      // Build chart initialization JavaScript
      const chartPalette = {
        light:     ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'],
        dark:      ['#818CF8', '#34D399', '#FBBF24', '#F87171', '#A78BFA', '#F472B6', '#2DD4BF', '#FB923C'],
        corporate: ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#DB2777', '#0D9488', '#EA580C'],
        vibrant:   ['#F59E0B', '#818CF8', '#34D399', '#F87171', '#A78BFA', '#F472B6', '#2DD4BF', '#FB923C'],
      };
      const colors = chartPalette[theme] || chartPalette.light;

      const chartScripts = maxCharts.map((chart, i) => {
        const dsList = chart.datasets.map((ds, di) => {
          const color = safeColor(ds.color, colors[di % colors.length]);
          return `{
          label: ${JSON.stringify(ds.label || `Serie ${di + 1}`)},
          data: ${JSON.stringify(ds.data)},
          borderColor: '${color}',
          backgroundColor: ${chart.type === 'pie' || chart.type === 'doughnut' ? JSON.stringify(ds.data.map((_, idx) => colors[idx % colors.length])) : `'${color}'`},
          ${chart.type === 'line' ? 'fill: false, tension: 0.3,' : ''}
          ${chart.stacked ? '' : ''}
        }`;
        }).join(',\n');

        return `
    new Chart(document.getElementById('chart-${i}'), {
      type: '${chart.type}',
      data: {
        labels: ${JSON.stringify(chart.labels)},
        datasets: [${dsList}]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: ${chart.datasets.length > 1}, position: 'bottom', labels: { color: '${t.muted}', font: { size: 11 } } }
        },
        scales: ${chart.type !== 'pie' && chart.type !== 'doughnut' && chart.type !== 'polarArea' ? `{
          x: { title: { display: ${!!chart.xLabel}, text: ${JSON.stringify(chart.xLabel || '')}, color: '${t.muted}' }, ticks: { color: '${t.muted}' }, grid: { color: '${t.border}' } },
          y: { title: { display: ${!!chart.yLabel}, text: ${JSON.stringify(chart.yLabel || '')}, color: '${t.muted}' }, ticks: { color: '${t.muted}' }, grid: { color: '${t.border}' }, beginAtZero: true }
        }` : '{}'}
      }
    });`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: ${t.bg}; color: ${t.text}; padding: 24px; }
  .dashboard-header { margin-bottom: 24px; }
  .dashboard-header h1 { font-size: 24px; font-weight: 700; color: ${t.accent}; letter-spacing: -0.5px; }
  .dashboard-header .subtitle { font-size: 13px; color: ${t.muted}; margin-top: 4px; }
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .metric-card { background: ${t.card}; border: 1px solid ${t.border}; border-radius: 10px; padding: 16px; }
  .metric-value { font-size: 26px; font-weight: 700; line-height: 1.2; }
  .metric-label { font-size: 12px; color: ${t.muted}; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .metric-change { font-size: 13px; color: #10B981; margin-top: 2px; }
  .charts-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .chart-wrapper { background: ${t.card}; border: 1px solid ${t.border}; border-radius: 10px; padding: 16px; }
  .chart-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: ${t.text}; }
  .chart-labels { font-size: 11px; color: ${t.muted}; margin-bottom: 8px; }
  .chart-labels span { margin-right: 12px; }
  .footer { margin-top: 20px; font-size: 11px; color: ${t.muted}; text-align: center; border-top: 1px solid ${t.border}; padding-top: 12px; }
  @media (max-width: 600px) {
    .chart-wrapper { flex: 0 0 100% !important; }
    .metrics-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="dashboard-header">
  <h1>${safeTitle}</h1>
  <div class="subtitle">Dashboard generado por agente · ${new Date().toISOString().split('T')[0]}</div>
</div>
${metricCards ? `<div class="metrics-grid">${metricCards}</div>` : ''}
${chartHtml ? `<div class="charts-grid">${chartHtml}</div>` : ''}
<div class="footer">Dashboard generado automáticamente · ${chartHtml.match(/chart-/g)?.length || 0} gráficos · ${metricCards.match(/metric-card/g)?.length || 0} indicadores</div>
<script>
  ${chartScripts}
</script>
</body>
</html>`;

      const buffer = Buffer.from(html, 'utf8');
      const filename = `dashboard_${crypto.randomBytes(4).toString('hex')}.html`;
      const artifact = finalizeArtifact({ filename, buffer, mime: 'text/html', ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'html',
          mime: 'text/html',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_dashboard_html',
        ok: true,
        preview: `Dashboard listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB, ${maxCharts.length} gráficos, ${maxMetrics.length} indicadores)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        charts: maxCharts.length,
        metrics: maxMetrics.length,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_dashboard_html', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 7: generate_video
// ─────────────────────────────────────────────────────────────────────────

const generateVideo = {
  name: 'generate_video',
  description: 'Generate a video from a text prompt using an AI video model (Veo, Runway, Pika, or similar). The video generation is launched asynchronously; the agent checks back for the result. Use for promotional videos, explainer animations, social media clips, or any short-form video content.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the video content. Describe the scene, motion, style, and mood.' },
      duration: { type: 'integer', minimum: 3, maximum: 30, description: 'Target duration in seconds. Default 8.' },
      aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3'], description: 'Aspect ratio. Default "16:9".' },
      style: { type: 'string', description: 'Style hint: "cinematic", "realistic", "animated", "claymation", "retro", "3d-render".' },
      model: { type: 'string', description: 'Optional fal.ai video model (e.g. "fal-ai/veo3/fast", "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", "fal-ai/sora-2/text-to-video"). Only pass it when the user asked for a specific model; omit for the default (Veo 3 fast).' },
      imageUrl: { type: 'string', description: 'Optional source image URL to animate (image-to-video). Use the URL of an image the user attached or one generated earlier in this chat.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute({ prompt, title, duration = 8, aspectRatio = '16:9', style, model, imageUrl }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'generate_video', preview: prompt });

    try {
      // Build enhanced prompt
      let enhancedPrompt = prompt;
      if (style) {
        const styleMap = {
          cinematic: 'Cinematic quality. Dramatic lighting, shallow depth of field.',
          realistic: 'Photorealistic. Natural motion, realistic textures.',
          animated: 'Animated style. Smooth motion, vibrant colors.',
          claymation: 'Claymation / stop-motion style. Slightly imperfect, tactile feel.',
          retro: 'Retro / vintage aesthetic. Warm tones, film grain.',
          '3d-render': '3D rendered. Clean lighting, smooth textures.',
        };
        const styleDesc = styleMap[style] || '';
        if (styleDesc) enhancedPrompt = `${styleDesc} ${prompt}`;
      }

      emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: 'Iniciando generación de video…', partial: true });

      // Resolve the video API URL and key
      const videoApiUrl = process.env.VIDEO_API_URL || process.env.NEXT_PUBLIC_VIDEO_API_URL;
      const videoApiKey = process.env.VIDEO_API_KEY || process.env.NEXT_PUBLIC_VIDEO_API_KEY;

      if (videoApiUrl && videoApiKey) {
        // External video generation API
        const { default: fetch } = await import('node-fetch');

        const body = {
          prompt: enhancedPrompt,
          duration,
          aspect_ratio: aspectRatio,
          filename: `video_${crypto.randomBytes(4).toString('hex')}.mp4`,
          user_id: ctx.userId || 'agent',
        };

        emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: 'Enviando solicitud al servicio de video…', partial: true });

        const resp = await fetch(videoApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${videoApiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctx.signal,
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          emitEvent(ctx, 'tool_output', { tool: 'generate_video', ok: false, preview: `Servicio de video respondió ${resp.status}: ${errText}` });
          return { ok: false, error: `Video API error: ${resp.status} ${errText}` };
        }

        const result = await resp.json();

        // If there's a download URL in the response, save it as an artifact
        if (result.videoUrl || result.downloadUrl) {
          const videoUrl = result.videoUrl || result.downloadUrl;
          emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: 'Descargando video generado…', partial: true });

          const videoResp = await fetch(videoUrl, { signal: ctx.signal });
          if (videoResp.ok) {
            const videoBuf = Buffer.from(await videoResp.arrayBuffer());
            const filename = `video_${crypto.randomBytes(4).toString('hex')}.mp4`;
            const artifact = finalizeArtifact({ filename, buffer: videoBuf, mime: 'video/mp4', ctx });

            emitEvent(ctx, 'file_artifact', {
              artifact: {
                id: artifact.id,
                filename: artifact.filename,
                format: 'mp4',
                mime: 'video/mp4',
                sizeBytes: artifact.sizeBytes,
                downloadUrl: artifact.downloadUrl,
              },
            });

            emitEvent(ctx, 'tool_output', {
              tool: 'generate_video',
              ok: true,
              preview: `Video listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024 / 1024)} MB)`,
            });

            return {
              ok: true,
              id: artifact.id,
              filename: artifact.filename,
              sizeBytes: artifact.sizeBytes,
              downloadUrl: artifact.downloadUrl,
              mime: 'video/mp4',
              prompt: enhancedPrompt,
              duration,
              aspectRatio,
            };
          }
        }

        // If generation was queued (async)
        if (result.operationId || result.jobId) {
          const operationId = result.operationId || result.jobId;
          emitEvent(ctx, 'tool_output', {
            tool: 'generate_video',
            ok: true,
            preview: `Video en proceso (ID: ${operationId}). El sistema lo entregará cuando esté listo.`,
          });
          return {
            ok: true,
            operationId,
            status: 'queued',
            prompt: enhancedPrompt,
            duration,
            aspectRatio,
            message: 'La generación de video está en proceso. El resultado aparecerá automáticamente cuando esté listo.',
          };
        }

        emitEvent(ctx, 'tool_output', {
          tool: 'generate_video',
          ok: true,
          preview: 'Solicitud de video enviada exitosamente.',
        });

        return {
          ok: true,
          status: 'submitted',
          prompt: enhancedPrompt,
          ...pick(result, ['videoUrl', 'downloadUrl', 'operationId', 'jobId']),
        };
      }

      // Real text-to-video via Fal.ai (Veo 3 fast) when FAL is configured.
      // This is the same provider wired into routes/video.js, so a chat
      // request like "créame un video de 8s del producto" produces an actual
      // MP4 — not just a storyboard. Any failure falls through to the
      // storyboard below, so the user always gets a usable deliverable and
      // there is no regression when Veo is unavailable.
      const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.TAL_AI_API_KEY;
      if (falKey) {
        try {
          // eslint-disable-next-line global-require
          const { fal } = require('@fal-ai/client');
          fal.config({ credentials: falKey });
          const secs = Math.min(Math.max(Number(duration) || 8, 4), 15);
          const sourceImageUrl = String(imageUrl || '').trim() || null;

          // Resolve the requested model against the fal video catalog (any
          // cataloged model works; an attached image flips the endpoint to
          // the model's image-to-video variant). Unknown / incompatible
          // requests fall back to Veo 3 fast instead of failing the turn.
          const DEFAULT_FAL_VIDEO_ENDPOINT = 'fal-ai/veo3/fast';
          let endpoint = DEFAULT_FAL_VIDEO_ENDPOINT;
          const requestedVideoModel = String(model || '').trim();
          // eslint-disable-next-line global-require
          const falVideoCatalog = require('../fal-video-model-catalog');
          const resolution = falVideoCatalog.resolveFalVideoModelRequest(
            requestedVideoModel && !/^veo[-_]?fast$/i.test(requestedVideoModel)
              ? requestedVideoModel
              : DEFAULT_FAL_VIDEO_ENDPOINT,
            { hasImage: Boolean(sourceImageUrl), imageCount: sourceImageUrl ? 1 : 0 }
          );
          if (resolution && resolution.ok && resolution.endpoint) {
            endpoint = resolution.endpoint;
          } else if (resolution && resolution.ok === false && requestedVideoModel) {
            emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: `${resolution.message || 'Modelo de video no disponible'}; usando Veo 3 fast…`, partial: true });
          }

          // Veo supports 16:9 / 9:16 — map anything else to 16:9.
          const falAspect = (aspectRatio === '16:9' || aspectRatio === '9:16') ? aspectRatio : '16:9';
          const falInput = falVideoCatalog.buildFalVideoInputPayload({
            endpoint,
            prompt: enhancedPrompt,
            aspectRatio: falAspect,
            duration: secs,
            imageUrl: sourceImageUrl,
            resolution: '720p',
            audio: true,
          });
          emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: `Generando video real con ${endpoint} (${secs}s)…`, partial: true });
          const falResult = await fal.subscribe(endpoint, { input: falInput, logs: false });
          const veoUrl = falVideoCatalog.extractFalVideoUrl(falResult)
            || (falResult && falResult.data && falResult.data.video && falResult.data.video.url);
          if (veoUrl) {
            const dl = await fetch(veoUrl, { signal: ctx.signal });
            if (dl && dl.ok) {
              const videoBuf = Buffer.from(await dl.arrayBuffer());
              const filename = `video_${crypto.randomBytes(4).toString('hex')}.mp4`;
              const artifact = finalizeArtifact({ filename, buffer: videoBuf, mime: 'video/mp4', ctx });
              emitEvent(ctx, 'file_artifact', {
                artifact: {
                  id: artifact.id,
                  filename: artifact.filename,
                  format: 'mp4',
                  mime: 'video/mp4',
                  sizeBytes: artifact.sizeBytes,
                  downloadUrl: artifact.downloadUrl,
                },
              });
              emitEvent(ctx, 'tool_output', {
                tool: 'generate_video',
                ok: true,
                preview: `Video listo: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024 / 1024 * 10) / 10} MB)`,
              });
              return {
                ok: true,
                id: artifact.id,
                filename: artifact.filename,
                sizeBytes: artifact.sizeBytes,
                downloadUrl: artifact.downloadUrl,
                mime: 'video/mp4',
                provider: `fal/${endpoint.replace(/^fal-ai\//, '')}`,
                model: endpoint,
                generationType: sourceImageUrl ? 'image-to-video' : 'text-to-video',
                prompt: enhancedPrompt,
                duration: secs,
                aspectRatio: falAspect,
              };
            }
          }
          emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: 'Veo no devolvió un video; generando storyboard como alternativa…', partial: true });
        } catch (falErr) {
          const fm = (falErr && falErr.message) ? String(falErr.message).slice(0, 100) : 'error';
          emitEvent(ctx, 'tool_output', { tool: 'generate_video', preview: `Veo no disponible (${fm}); generando storyboard…`, partial: true });
        }
      }

      // Fallback: no video API configured — generate a storyboard document
      // instead of returning an error. The agent can present this as an
      // artifact with scene-by-scene descriptions, visual direction, etc.
      emitEvent(ctx, 'tool_output', {
        tool: 'generate_video',
        preview: 'Servicio de video no configurado. Generando storyboard detallado como alternativa…',
        partial: true,
      });

      try {
        // Helper: split prompt into scenes for storyboard
        const scenes = generateScenesFromPrompt(enhancedPrompt, duration);

        // Build SVG storyboard with thumbnail previews per scene
        const storyW = 880;
        const sceneH = 200;
        const headerH = 110;
        const pad = 24;
        const thumbW = 220;
        const thumbH = sceneH - 32;
        const totalH = headerH + scenes.length * sceneH + pad * 2;

        const sceneCards = scenes.map((scene, i) => {
          const sy = headerH + pad + i * sceneH;
          const safeDesc = xmlEscape(scene.description || '').slice(0, 230);
          const safeAction = xmlEscape(scene.action || '').slice(0, 140);
          const safeVisual = xmlEscape(scene.visualStyle || '').slice(0, 140);
          const safeAudio = xmlEscape(scene.audio || '').slice(0, 100);
          const accent = scene.color || '#3B82F6';
          const tx = pad + thumbW + 24;
          // Build a stylized thumbnail using gradient + abstract shapes derived from scene index
          const gradId = `grad-scene-${i}`;
          const shapeKind = i % 4;
          let shapes = '';
          if (shapeKind === 0) {
            shapes = `<circle cx="${pad + 60}" cy="${sy + 60}" r="36" fill="#fff" opacity="0.25"/><circle cx="${pad + 150}" cy="${sy + 110}" r="20" fill="#fff" opacity="0.18"/>`;
          } else if (shapeKind === 1) {
            shapes = `<polygon points="${pad + 30},${sy + 130} ${pad + 80},${sy + 50} ${pad + 130},${sy + 110} ${pad + 180},${sy + 80} ${pad + 200},${sy + 140}" fill="#fff" opacity="0.25"/>`;
          } else if (shapeKind === 2) {
            shapes = `<rect x="${pad + 30}" y="${sy + 90}" width="40" height="60" fill="#fff" opacity="0.22" rx="3"/><rect x="${pad + 80}" y="${sy + 60}" width="40" height="90" fill="#fff" opacity="0.28" rx="3"/><rect x="${pad + 130}" y="${sy + 80}" width="40" height="70" fill="#fff" opacity="0.20" rx="3"/>`;
          } else {
            shapes = `<path d="M ${pad + 20} ${sy + 130} Q ${pad + 70} ${sy + 50} ${pad + 120} ${sy + 110} T ${pad + 210} ${sy + 100}" fill="none" stroke="#fff" stroke-width="3" opacity="0.45"/>`;
          }
          return `
  <!-- Scene ${i + 1} -->
  <defs>
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect x="${pad}" y="${sy}" width="${storyW - 2 * pad}" height="${sceneH - 12}" rx="10" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1" filter="url(#vis-shadow)"/>
  <rect x="${pad + 12}" y="${sy + 16}" width="${thumbW}" height="${thumbH}" rx="6" fill="url(#${gradId})"/>
  ${shapes}
  <text x="${pad + 12 + thumbW / 2}" y="${sy + thumbH + 8}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff" opacity="0.9">SCENE ${String(i + 1).padStart(2, '0')}</text>
  <text x="${tx}" y="${sy + 28}" font-family="Arial" font-size="13" font-weight="bold" fill="#1E293B">Escena ${i + 1} · ${xmlEscape(scene.timeRange || `${scene.duration}s`)}</text>
  <text x="${tx}" y="${sy + 50}" font-family="Arial" font-size="11" fill="#475569">${safeDesc}</text>
  ${safeAction ? `<text x="${tx}" y="${sy + 92}" font-family="Arial" font-size="11" fill="#64748B">▶ ${safeAction}</text>` : ''}
  ${safeVisual ? `<text x="${tx}" y="${sy + 116}" font-family="Arial" font-size="10" fill="#94A3B8">◆ ${safeVisual}</text>` : ''}
  ${safeAudio ? `<text x="${tx}" y="${sy + 138}" font-family="Arial" font-size="10" fill="#94A3B8">♪ ${safeAudio}</text>` : ''}
  <text x="${storyW - pad - 16}" y="${sy + 28}" text-anchor="end" font-family="Arial" font-size="20" font-weight="bold" fill="${accent}" opacity="0.15">${String(i + 1).padStart(2, '0')}</text>`;
        }).join('\n');

        const storyboardSvg = [
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${storyW} ${totalH}">`,
          `  <defs><filter id="vis-shadow"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.08"/></filter></defs>`,
          `  <rect width="${storyW}" height="${totalH}" fill="#F8FAFC" rx="12"/>`,
          `  <rect x="0" y="0" width="${storyW}" height="${headerH}" fill="#1E293B" rx="0"/>`,
          `  <text x="${storyW / 2}" y="40" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#FFFFFF">${xmlEscape(String(title || enhancedPrompt).slice(0, 100))}</text>`,
          `  <text x="${storyW / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#94A3B8">Storyboard · ${scenes.length} escenas · ${duration}s · ${xmlEscape(style || '')}</text>`,
          `  <text x="${storyW / 2}" y="84" text-anchor="middle" font-family="Arial" font-size="10" fill="#64748B">Generado como alternativa — conecta VIDEO_API_URL para generación real de video</text>`,
          sceneCards,
          `</svg>`,
        ].join('\n');

        const buffer = Buffer.from(storyboardSvg, 'utf8');
        const filename = `storyboard_${crypto.randomBytes(4).toString('hex')}.svg`;
        const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

        emitEvent(ctx, 'file_artifact', {
          artifact: {
            id: artifact.id,
            filename: artifact.filename,
            format: 'svg',
            mime: 'image/svg+xml',
            sizeBytes: artifact.sizeBytes,
            downloadUrl: artifact.downloadUrl,
          },
        });

        emitEvent(ctx, 'tool_output', {
          tool: 'generate_video',
          ok: true,
          preview: `Storyboard listo: ${artifact.filename} (${scenes.length} escenas, ${Math.round(artifact.sizeBytes / 1024)} KB). Configura VIDEO_API_URL para generación real de video.`,
        });

        return {
          ok: true,
          id: artifact.id,
          filename: artifact.filename,
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
          storyboard: true,
          scenes: scenes.length,
          prompt: enhancedPrompt,
          duration,
          aspectRatio,
          message: 'No se configuró VIDEO_API_URL. Se generó un storyboard como alternativa.',
        };
      } catch (storyErr) {
        const msg = storyErr?.message || String(storyErr);
        emitEvent(ctx, 'tool_output', { tool: 'generate_video', ok: false, preview: `Error generando storyboard: ${msg}` });
        return { ok: false, error: msg, prompt: enhancedPrompt };
      }
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'generate_video', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 8: create_timeline
// ─────────────────────────────────────────────────────────────────────────

const createTimeline = {
  name: 'create_timeline',
  description: 'Generate a horizontal chronological timeline as an SVG file. Use for project roadmaps, historical events, milestones, product launches, or any sequence of dated events. Each event has a date, title, optional description, and optional category color.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Timeline title (e.g. "Product Roadmap 2026").' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date or label for the event (e.g. "Q1 2026", "Mar 15", "1969").' },
            title: { type: 'string', description: 'Short event title.' },
            description: { type: 'string', description: 'Optional 1-2 sentence description.' },
            category: { type: 'string', description: 'Optional category for grouping/coloring (e.g. "milestone", "launch").' },
            color: { type: 'string', description: 'Optional hex color override.' },
          },
          required: ['date', 'title'],
        },
        description: '2-12 chronological events.',
      },
      orientation: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Timeline orientation. Default: "horizontal".' },
      theme: { type: 'string', enum: ['professional', 'modern', 'warm', 'cool', 'dark'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'events'],
    additionalProperties: false,
  },
  async execute({ title, events = [], orientation = 'horizontal', theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_timeline', preview: title });

    try {
      if (!Array.isArray(events) || events.length === 0) {
        emitEvent(ctx, 'tool_output', { tool: 'create_timeline', ok: false, preview: 'Se requiere al menos un evento.' });
        return { ok: false, error: 'events array is empty' };
      }

      const themes = {
        professional: { bg: '#FAFBFC', card: '#FFFFFF', line: '#94A3B8', accent: '#2563EB', text: '#1E293B', muted: '#64748B', border: '#E2E8F0' },
        modern:       { bg: '#0B1121', card: '#1E293B', line: '#475569', accent: '#818CF8', text: '#F1F5F9', muted: '#94A3B8', border: '#334155' },
        warm:         { bg: '#FFF7ED', card: '#FFFFFF', line: '#FB923C', accent: '#EA580C', text: '#7C2D12', muted: '#9A3412', border: '#FED7AA' },
        cool:         { bg: '#ECFEFF', card: '#FFFFFF', line: '#06B6D4', accent: '#0891B2', text: '#164E63', muted: '#155E75', border: '#A5F3FC' },
        dark:         { bg: '#0F172A', card: '#1E293B', line: '#475569', accent: '#F59E0B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155' },
      };
      const t = themes[theme] || themes.professional;
      const palette = ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const events12 = events.slice(0, 12);

      let svgBody = '';
      let W, H;

      if (orientation === 'vertical') {
        const eventH = 110;
        const headerH = 90;
        const pad = 30;
        const lineX = 130;
        H = headerH + events12.length * eventH + pad * 2;
        W = 760;

        svgBody += `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
        svgBody += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
        svgBody += `<text x="${W / 2}" y="38" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
        svgBody += `<text x="${W / 2}" y="62" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${events12.length} eventos · vertical</text>`;
        // Vertical line
        svgBody += `<line x1="${lineX}" y1="${headerH + pad}" x2="${lineX}" y2="${H - pad}" stroke="${t.line}" stroke-width="3"/>`;

        events12.forEach((ev, i) => {
          const cy = headerH + pad + i * eventH + eventH / 2;
          const color = ev.color || palette[i % palette.length];
          const date = xmlEscape(String(ev.date || '').slice(0, 24));
          const tt = xmlEscape(String(ev.title || '').slice(0, 80));
          const desc = xmlEscape(String(ev.description || '').slice(0, 180));
          const cat = ev.category ? xmlEscape(String(ev.category).slice(0, 24)) : '';
          // Date column
          svgBody += `<text x="${lineX - 18}" y="${cy - 2}" text-anchor="end" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${date}</text>`;
          if (cat) svgBody += `<text x="${lineX - 18}" y="${cy + 14}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${cat}</text>`;
          // Marker
          svgBody += `<circle cx="${lineX}" cy="${cy}" r="9" fill="${color}" stroke="${t.bg}" stroke-width="3"/>`;
          // Card
          const cardX = lineX + 22;
          const cardW = W - cardX - pad;
          svgBody += `<rect x="${cardX}" y="${cy - eventH / 2 + 12}" width="${cardW}" height="${eventH - 24}" rx="8" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>`;
          svgBody += `<rect x="${cardX}" y="${cy - eventH / 2 + 12}" width="4" height="${eventH - 24}" rx="2" fill="${color}"/>`;
          svgBody += `<text x="${cardX + 16}" y="${cy - 8}" font-family="Arial" font-size="14" font-weight="bold" fill="${t.text}">${tt}</text>`;
          if (desc) svgBody += `<text x="${cardX + 16}" y="${cy + 14}" font-family="Arial" font-size="11" fill="${t.muted}">${desc}</text>`;
        });
      } else {
        const headerH = 90;
        const pad = 40;
        const minStep = 160;
        const stepW = Math.max(minStep, Math.min(220, 1200 / events12.length));
        W = Math.max(800, pad * 2 + events12.length * stepW);
        const lineY = 220;
        const cardH = 120;
        H = headerH + 360;

        svgBody += `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
        svgBody += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
        svgBody += `<text x="${W / 2}" y="38" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
        svgBody += `<text x="${W / 2}" y="62" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${events12.length} eventos</text>`;

        // Main horizontal line
        svgBody += `<line x1="${pad}" y1="${lineY}" x2="${W - pad}" y2="${lineY}" stroke="${t.line}" stroke-width="3" stroke-linecap="round"/>`;

        events12.forEach((ev, i) => {
          const cx = pad + (i + 0.5) * stepW;
          const above = i % 2 === 0;
          const color = ev.color || palette[i % palette.length];
          const date = xmlEscape(String(ev.date || '').slice(0, 20));
          const tt = xmlEscape(String(ev.title || '').slice(0, 50));
          const desc = xmlEscape(String(ev.description || '').slice(0, 110));
          const cat = ev.category ? xmlEscape(String(ev.category).slice(0, 20)) : '';

          // Marker
          svgBody += `<circle cx="${cx}" cy="${lineY}" r="11" fill="${color}" stroke="${t.bg}" stroke-width="3"/>`;
          svgBody += `<circle cx="${cx}" cy="${lineY}" r="5" fill="#fff"/>`;

          // Card position
          const cy = above ? lineY - cardH - 30 : lineY + 30;
          const cardW = stepW - 20;
          const cardX = cx - cardW / 2;
          // Connector
          svgBody += `<line x1="${cx}" y1="${lineY}" x2="${cx}" y2="${above ? cy + cardH : cy}" stroke="${color}" stroke-width="2" opacity="0.6"/>`;
          // Card
          svgBody += `<rect x="${cardX}" y="${cy}" width="${cardW}" height="${cardH}" rx="8" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
          svgBody += `<rect x="${cardX}" y="${cy}" width="${cardW}" height="4" rx="2" fill="${color}"/>`;
          svgBody += `<text x="${cardX + 12}" y="${cy + 26}" font-family="Arial" font-size="12" font-weight="bold" fill="${color}">${date}</text>`;
          if (cat) svgBody += `<text x="${cardX + cardW - 12}" y="${cy + 26}" text-anchor="end" font-family="Arial" font-size="9" fill="${t.muted}" opacity="0.8">${cat.toUpperCase()}</text>`;
          svgBody += `<text x="${cardX + 12}" y="${cy + 50}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${tt}</text>`;
          if (desc) {
            // crude word-wrap into 2 lines
            const words = desc.split(' ');
            const halfIdx = Math.ceil(words.length / 2);
            const line1 = words.slice(0, halfIdx).join(' ');
            const line2 = words.slice(halfIdx).join(' ');
            svgBody += `<text x="${cardX + 12}" y="${cy + 72}" font-family="Arial" font-size="10" fill="${t.muted}">${line1}</text>`;
            if (line2) svgBody += `<text x="${cardX + 12}" y="${cy + 88}" font-family="Arial" font-size="10" fill="${t.muted}">${line2}</text>`;
          }
        });
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Timeline: ${safeTitle}`,
        body: svgBody,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `timeline_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_timeline',
        ok: true,
        preview: `Línea de tiempo lista: ${artifact.filename} (${events12.length} eventos, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        events: events12.length,
        orientation,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_timeline', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 9: create_kanban_board
// ─────────────────────────────────────────────────────────────────────────

const createKanbanBoard = {
  name: 'create_kanban_board',
  description: 'Generate a Kanban board as an SVG file with columns (e.g. "To Do", "In Progress", "Done") and cards. Use for sprint boards, project task tracking, workflow visualizations, or any column-based task layout.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Board title (e.g. "Sprint 12 Board").' },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Column name (e.g. "To Do", "In Progress", "Done").' },
            color: { type: 'string', description: 'Optional hex color for the column header.' },
            cards: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Card title.' },
                  description: { type: 'string', description: 'Optional 1-2 sentence description.' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority badge.' },
                  assignee: { type: 'string', description: 'Optional assignee name or initials.' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
                },
                required: ['title'],
              },
              description: 'Cards in this column.',
            },
          },
          required: ['name'],
        },
        description: '2-6 columns.',
      },
      theme: { type: 'string', enum: ['light', 'dark', 'corporate'], description: 'Visual theme. Default: "light".' },
    },
    required: ['title', 'columns'],
    additionalProperties: false,
  },
  async execute({ title, columns = [], theme = 'light' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_kanban_board', preview: title });

    try {
      if (!Array.isArray(columns) || columns.length === 0) {
        return { ok: false, error: 'columns array is empty' };
      }

      const themes = {
        light:     { bg: '#F1F5F9', col: '#FFFFFF', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', headerText: '#0F172A' },
        dark:      { bg: '#0F172A', col: '#1E293B', card: '#334155', text: '#F1F5F9', muted: '#94A3B8', border: '#475569', headerText: '#F1F5F9' },
        corporate: { bg: '#F8FAFC', col: '#FFFFFF', card: '#FFFFFF', text: '#1E293B', muted: '#475569', border: '#CBD5E1', headerText: '#0F172A' },
      };
      const t = themes[theme] || themes.light;
      const palette = ['#3B82F6', '#F59E0B', '#10B981', '#EC4899', '#8B5CF6', '#EF4444'];
      const priorityColors = { low: '#10B981', medium: '#F59E0B', high: '#EF4444', critical: '#7C2D12' };

      const cols = columns.slice(0, 6);
      const colW = 240;
      const colGap = 16;
      const cardH = 90;
      const cardGap = 10;
      const headerH = 80;
      const colHeaderH = 44;
      const pad = 24;

      const maxCards = Math.max(1, ...cols.map(c => (c.cards || []).length));
      const colInnerH = colHeaderH + maxCards * (cardH + cardGap) + 20;
      const W = pad * 2 + cols.length * colW + (cols.length - 1) * colGap;
      const H = headerH + colInnerH + pad * 2;

      const safeTitle = xmlEscape(String(title).slice(0, 120));

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.col}" stroke="${t.border}" stroke-width="1"/>`;
      body += `<text x="${pad}" y="36" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="${t.headerText}">${safeTitle}</text>`;
      const totalCards = cols.reduce((s, c) => s + (c.cards || []).length, 0);
      body += `<text x="${pad}" y="58" font-family="Arial" font-size="12" fill="${t.muted}">${cols.length} columnas · ${totalCards} tarjetas · ${new Date().toISOString().slice(0, 10)}</text>`;

      cols.forEach((col, ci) => {
        const colX = pad + ci * (colW + colGap);
        const colY = headerH + pad;
        const colColor = col.color || palette[ci % palette.length];
        // Column background
        body += `<rect x="${colX}" y="${colY}" width="${colW}" height="${colInnerH}" rx="8" fill="${t.col}" stroke="${t.border}" stroke-width="1"/>`;
        // Column header
        body += `<rect x="${colX}" y="${colY}" width="${colW}" height="${colHeaderH}" rx="8" fill="${colColor}" opacity="0.12"/>`;
        body += `<rect x="${colX}" y="${colY + colHeaderH - 3}" width="${colW}" height="3" fill="${colColor}"/>`;
        body += `<text x="${colX + 14}" y="${colY + 28}" font-family="Arial" font-size="14" font-weight="bold" fill="${t.headerText}">${xmlEscape(String(col.name || '').slice(0, 28))}</text>`;
        const colCards = col.cards || [];
        body += `<text x="${colX + colW - 14}" y="${colY + 28}" text-anchor="end" font-family="Arial" font-size="12" fill="${colColor}" font-weight="bold">${colCards.length}</text>`;

        colCards.slice(0, 8).forEach((card, ki) => {
          const cy = colY + colHeaderH + 10 + ki * (cardH + cardGap);
          const cx = colX + 10;
          const cardW = colW - 20;
          // Card
          body += `<rect x="${cx}" y="${cy}" width="${cardW}" height="${cardH}" rx="6" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
          // Priority badge
          if (card.priority) {
            const pColor = priorityColors[card.priority] || colColor;
            body += `<rect x="${cx}" y="${cy}" width="4" height="${cardH}" rx="2" fill="${pColor}"/>`;
          }
          // Title
          const title = xmlEscape(String(card.title || '').slice(0, 50));
          body += `<text x="${cx + 14}" y="${cy + 22}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${title}</text>`;
          // Description
          if (card.description) {
            const desc = xmlEscape(String(card.description).slice(0, 80));
            const halfIdx = Math.ceil(desc.length / 2);
            const cut = desc.lastIndexOf(' ', halfIdx) > 0 ? desc.lastIndexOf(' ', halfIdx) : halfIdx;
            const line1 = desc.slice(0, cut);
            const line2 = desc.slice(cut).trim();
            body += `<text x="${cx + 14}" y="${cy + 40}" font-family="Arial" font-size="10" fill="${t.muted}">${line1}</text>`;
            if (line2) body += `<text x="${cx + 14}" y="${cy + 54}" font-family="Arial" font-size="10" fill="${t.muted}">${line2}</text>`;
          }
          // Tags
          if (Array.isArray(card.tags) && card.tags.length) {
            let tx = cx + 14;
            card.tags.slice(0, 3).forEach((tag) => {
              const safeTag = xmlEscape(String(tag).slice(0, 12));
              const tagW = Math.max(40, safeTag.length * 6 + 12);
              body += `<rect x="${tx}" y="${cy + cardH - 22}" width="${tagW}" height="16" rx="8" fill="${colColor}" opacity="0.18"/>`;
              body += `<text x="${tx + tagW / 2}" y="${cy + cardH - 10}" text-anchor="middle" font-family="Arial" font-size="9" fill="${colColor}" font-weight="bold">${safeTag}</text>`;
              tx += tagW + 4;
            });
          }
          // Assignee
          if (card.assignee) {
            const ass = String(card.assignee).slice(0, 20);
            const initials = ass.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
            body += `<circle cx="${cx + cardW - 18}" cy="${cy + cardH - 16}" r="11" fill="${colColor}" opacity="0.85"/>`;
            body += `<text x="${cx + cardW - 18}" y="${cy + cardH - 12}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="bold" fill="#fff">${xmlEscape(initials)}</text>`;
          }
        });
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Kanban board: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `kanban_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_kanban_board',
        ok: true,
        preview: `Kanban listo: ${artifact.filename} (${cols.length} columnas, ${totalCards} tarjetas, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        columns: cols.length,
        cards: totalCards,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_kanban_board', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 10: create_comparison_table
// ─────────────────────────────────────────────────────────────────────────

const createComparisonTable = {
  name: 'create_comparison_table',
  description: 'Generate a side-by-side comparison table as an SVG file. Use for product/plan comparisons, feature matrices, vendor analysis, or any tabular comparison with categories and check/cross/value cells. Cells can contain text, numeric values, or boolean (✓/✗) indicators.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Comparison title (e.g. "Plan Comparison").' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Column headers (e.g. ["Free", "Pro", "Enterprise"]).' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            feature: { type: 'string', description: 'Row label / feature name.' },
            values: { type: 'array', items: { type: ['string', 'number', 'boolean'] }, description: 'One value per column. Booleans render as check/cross icons.' },
            highlight: { type: 'boolean', description: 'Mark this row as a highlighted/important row.' },
          },
          required: ['feature', 'values'],
        },
        description: 'Rows of comparison data.',
      },
      highlightColumn: { type: 'integer', minimum: 0, description: 'Index of the recommended column to highlight (0-based).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'dark'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'columns', 'rows'],
    additionalProperties: false,
  },
  async execute({ title, columns = [], rows = [], highlightColumn = -1, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_comparison_table', preview: title });

    try {
      if (!Array.isArray(columns) || columns.length === 0) {
        return { ok: false, error: 'columns array is empty' };
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, error: 'rows array is empty' };
      }

      const themes = {
        professional: { bg: '#FAFBFC', card: '#FFFFFF', accent: '#2563EB', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', alt: '#F8FAFC', highlightBg: '#EFF6FF', highlightAccent: '#2563EB', check: '#10B981', cross: '#EF4444' },
        modern:       { bg: '#0B1121', card: '#1E293B', accent: '#818CF8', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', alt: '#162033', highlightBg: '#312E81', highlightAccent: '#A78BFA', check: '#34D399', cross: '#F87171' },
        minimal:      { bg: '#FFFFFF', card: '#FFFFFF', accent: '#0F172A', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', alt: '#F8FAFC', highlightBg: '#F1F5F9', highlightAccent: '#0F172A', check: '#10B981', cross: '#EF4444' },
        dark:         { bg: '#0F172A', card: '#1E293B', accent: '#F59E0B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', alt: '#0F172A', highlightBg: '#451A03', highlightAccent: '#F59E0B', check: '#10B981', cross: '#EF4444' },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const cols = columns.slice(0, 6).map(c => xmlEscape(String(c).slice(0, 30)));
      const rowList = rows.slice(0, 30);

      const featureColW = 240;
      const colW = Math.min(220, Math.max(140, 740 / cols.length));
      const rowH = 48;
      const headerH = 90;
      const colHeaderH = 64;
      const pad = 24;
      const W = featureColW + cols.length * colW + pad * 2;
      const H = headerH + colHeaderH + rowList.length * rowH + pad * 2 + 30;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="40" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="64" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${cols.length} columnas · ${rowList.length} filas</text>`;

      // Column headers
      const tableY = headerH + pad;
      const tableX = pad;
      // Feature column header
      body += `<rect x="${tableX}" y="${tableY}" width="${featureColW}" height="${colHeaderH}" fill="${t.alt}" stroke="${t.border}" stroke-width="1" rx="8"/>`;
      body += `<text x="${tableX + 16}" y="${tableY + colHeaderH / 2 + 6}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.muted}">CARACTERÍSTICA</text>`;

      cols.forEach((col, ci) => {
        const cx = tableX + featureColW + ci * colW;
        const isHl = ci === highlightColumn;
        const fill = isHl ? t.highlightBg : t.card;
        const stroke = isHl ? t.highlightAccent : t.border;
        body += `<rect x="${cx}" y="${tableY}" width="${colW}" height="${colHeaderH}" fill="${fill}" stroke="${stroke}" stroke-width="${isHl ? 2 : 1}" rx="8"/>`;
        if (isHl) {
          body += `<rect x="${cx + colW / 2 - 30}" y="${tableY - 12}" width="60" height="20" fill="${t.highlightAccent}" rx="10"/>`;
          body += `<text x="${cx + colW / 2}" y="${tableY + 2}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="#fff">RECOMENDADO</text>`;
        }
        body += `<text x="${cx + colW / 2}" y="${tableY + colHeaderH / 2 + 6}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${isHl ? t.highlightAccent : t.text}">${col}</text>`;
      });

      // Rows
      rowList.forEach((row, ri) => {
        const ry = tableY + colHeaderH + ri * rowH;
        const isAlt = ri % 2 === 1;
        const isHlRow = !!row.highlight;
        const rowBg = isHlRow ? t.highlightBg : (isAlt ? t.alt : t.card);
        // Feature cell
        body += `<rect x="${tableX}" y="${ry}" width="${featureColW}" height="${rowH}" fill="${rowBg}" stroke="${t.border}" stroke-width="0.5"/>`;
        const featureName = xmlEscape(String(row.feature || '').slice(0, 60));
        body += `<text x="${tableX + 16}" y="${ry + rowH / 2 + 5}" font-family="Arial" font-size="13" font-weight="${isHlRow ? 'bold' : '600'}" fill="${t.text}">${featureName}</text>`;

        // Value cells
        const vals = Array.isArray(row.values) ? row.values : [];
        cols.forEach((_, ci) => {
          const cx = tableX + featureColW + ci * colW;
          const isHlCol = ci === highlightColumn;
          const cellBg = isHlCol ? t.highlightBg : rowBg;
          body += `<rect x="${cx}" y="${ry}" width="${colW}" height="${rowH}" fill="${cellBg}" stroke="${t.border}" stroke-width="0.5"/>`;
          const v = vals[ci];
          if (v === true) {
            // Check
            const ix = cx + colW / 2;
            const iy = ry + rowH / 2;
            body += `<circle cx="${ix}" cy="${iy}" r="11" fill="${t.check}" opacity="0.18"/>`;
            body += `<path d="M ${ix - 6} ${iy + 1} L ${ix - 1} ${iy + 5} L ${ix + 7} ${iy - 4}" stroke="${t.check}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
          } else if (v === false) {
            // Cross
            const ix = cx + colW / 2;
            const iy = ry + rowH / 2;
            body += `<circle cx="${ix}" cy="${iy}" r="11" fill="${t.cross}" opacity="0.15"/>`;
            body += `<path d="M ${ix - 5} ${iy - 5} L ${ix + 5} ${iy + 5} M ${ix + 5} ${iy - 5} L ${ix - 5} ${iy + 5}" stroke="${t.cross}" stroke-width="2.5" stroke-linecap="round"/>`;
          } else if (v !== undefined && v !== null) {
            const safeVal = xmlEscape(String(v).slice(0, 28));
            body += `<text x="${cx + colW / 2}" y="${ry + rowH / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="${isHlCol ? 'bold' : 'normal'}" fill="${isHlCol ? t.highlightAccent : t.text}">${safeVal}</text>`;
          } else {
            body += `<text x="${cx + colW / 2}" y="${ry + rowH / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="13" fill="${t.muted}">—</text>`;
          }
        });
      });

      // Bottom rounding
      const lastY = tableY + colHeaderH + rowList.length * rowH;
      body += `<rect x="${tableX}" y="${tableY}" width="${featureColW + cols.length * colW}" height="${lastY - tableY}" fill="none" stroke="${t.border}" stroke-width="1" rx="8"/>`;

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Comparison table: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `comparison_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_comparison_table',
        ok: true,
        preview: `Comparativa lista: ${artifact.filename} (${cols.length}×${rowList.length}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        columns: cols.length,
        rows: rowList.length,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_comparison_table', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 11: create_process_flow
// ─────────────────────────────────────────────────────────────────────────

const createProcessFlow = {
  name: 'create_process_flow',
  description: 'Generate a step-by-step process flow as an SVG file. Numbered steps connected by arrows, with optional descriptions per step. Use for onboarding flows, customer journeys, workflow documentation, or any sequential process explanation.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Flow title (e.g. "Customer Onboarding").' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short step name.' },
            description: { type: 'string', description: 'Optional 1-2 sentence detail.' },
            icon: { type: 'string', enum: ['chart', 'bulb', 'star', 'target', 'gear', 'shield', 'globe', 'people', 'clock', 'rocket', 'check', 'lock', 'mail', 'money', 'growth', 'warning'], description: 'Optional icon type.' },
            color: { type: 'string', description: 'Optional hex color override.' },
          },
          required: ['label'],
        },
        description: '2-8 sequential steps.',
      },
      orientation: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Flow direction. Default: "horizontal".' },
      style: { type: 'string', enum: ['arrows', 'chevrons', 'circles'], description: 'Connection style. Default: "arrows".' },
      theme: { type: 'string', enum: ['professional', 'modern', 'warm', 'minimal'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'steps'],
    additionalProperties: false,
  },
  async execute({ title, steps = [], orientation = 'horizontal', style = 'arrows', theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_process_flow', preview: title });

    try {
      if (!Array.isArray(steps) || steps.length === 0) {
        return { ok: false, error: 'steps array is empty' };
      }

      const themes = {
        professional: { bg: '#FAFBFC', step: '#FFFFFF', accent: '#2563EB', text: '#1E293B', muted: '#64748B', border: '#E2E8F0' },
        modern:       { bg: '#0B1121', step: '#1E293B', accent: '#818CF8', text: '#F1F5F9', muted: '#94A3B8', border: '#334155' },
        warm:         { bg: '#FFF7ED', step: '#FFFFFF', accent: '#EA580C', text: '#7C2D12', muted: '#9A3412', border: '#FED7AA' },
        minimal:      { bg: '#FFFFFF', step: '#F8FAFC', accent: '#0F172A', text: '#0F172A', muted: '#64748B', border: '#CBD5E1' },
      };
      const t = themes[theme] || themes.professional;
      const palette = ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];
      const stepList = steps.slice(0, 8);

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const headerH = 90;
      const pad = 30;

      let body = '';
      let W, H;

      if (orientation === 'horizontal') {
        const stepW = 180;
        const stepH = 130;
        const gapW = 32;
        W = pad * 2 + stepList.length * stepW + (stepList.length - 1) * gapW;
        H = headerH + pad * 2 + stepH + 40;

        body += `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
        body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
        body += `<text x="${W / 2}" y="40" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
        body += `<text x="${W / 2}" y="64" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${stepList.length} pasos · flujo ${style}</text>`;

        stepList.forEach((step, i) => {
          const sx = pad + i * (stepW + gapW);
          const sy = headerH + pad;
          const color = step.color || palette[i % palette.length];
          const safeLabel = xmlEscape(String(step.label || '').slice(0, 30));
          const safeDesc = xmlEscape(String(step.description || '').slice(0, 90));

          if (style === 'chevrons') {
            // Chevron arrow shape
            const arrowW = 22;
            body += `<path d="M ${sx} ${sy} L ${sx + stepW - arrowW} ${sy} L ${sx + stepW} ${sy + stepH / 2} L ${sx + stepW - arrowW} ${sy + stepH} L ${sx} ${sy + stepH} L ${sx + arrowW} ${sy + stepH / 2} Z" fill="${color}" opacity="0.85" stroke="#fff" stroke-width="1.5"/>`;
            body += `<text x="${sx + stepW / 2}" y="${sy + stepH / 2 - 4}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#fff">${i + 1}. ${safeLabel}</text>`;
            if (safeDesc) body += `<text x="${sx + stepW / 2}" y="${sy + stepH / 2 + 16}" text-anchor="middle" font-family="Arial" font-size="10" fill="#fff" opacity="0.9">${safeDesc.slice(0, 35)}</text>`;
          } else if (style === 'circles') {
            const cx = sx + stepW / 2;
            const cy = sy + 50;
            body += `<circle cx="${cx}" cy="${cy}" r="36" fill="${color}" stroke="#fff" stroke-width="3" filter="url(#vis-shadow)"/>`;
            body += `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="Arial" font-size="22" font-weight="bold" fill="#fff">${i + 1}</text>`;
            body += `<text x="${cx}" y="${cy + 56}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${safeLabel}</text>`;
            if (safeDesc) body += `<text x="${cx}" y="${cy + 74}" text-anchor="middle" font-family="Arial" font-size="10" fill="${t.muted}">${safeDesc.slice(0, 38)}</text>`;
            // Connector
            if (i < stepList.length - 1) {
              const x1 = cx + 38, x2 = sx + stepW + gapW + stepW / 2 - 38;
              body += `<line x1="${x1}" y1="${cy}" x2="${x2 - 8}" y2="${cy}" stroke="${t.muted}" stroke-width="2" opacity="0.5"/>`;
              body += `<polygon points="${x2 - 8},${cy - 5} ${x2},${cy} ${x2 - 8},${cy + 5}" fill="${t.muted}" opacity="0.5"/>`;
            }
          } else {
            // arrows (default)
            body += `<rect x="${sx}" y="${sy}" width="${stepW}" height="${stepH}" rx="10" fill="${t.step}" stroke="${color}" stroke-width="2" filter="url(#vis-shadow)"/>`;
            body += `<rect x="${sx}" y="${sy}" width="${stepW}" height="6" rx="3" fill="${color}"/>`;
            body += `<circle cx="${sx + 28}" cy="${sy + 36}" r="18" fill="${color}"/>`;
            body += `<text x="${sx + 28}" y="${sy + 42}" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">${i + 1}</text>`;
            body += `<text x="${sx + 56}" y="${sy + 42}" font-family="Arial" font-size="14" font-weight="bold" fill="${t.text}">${safeLabel}</text>`;
            if (safeDesc) {
              const halfIdx = Math.ceil(safeDesc.length / 2);
              const cut = safeDesc.lastIndexOf(' ', halfIdx) > 0 ? safeDesc.lastIndexOf(' ', halfIdx) : halfIdx;
              const l1 = safeDesc.slice(0, cut), l2 = safeDesc.slice(cut).trim();
              body += `<text x="${sx + 16}" y="${sy + 80}" font-family="Arial" font-size="11" fill="${t.muted}">${l1}</text>`;
              if (l2) body += `<text x="${sx + 16}" y="${sy + 96}" font-family="Arial" font-size="11" fill="${t.muted}">${l2}</text>`;
            }
            // Connector arrow
            if (i < stepList.length - 1) {
              const ax1 = sx + stepW + 4;
              const ax2 = sx + stepW + gapW - 4;
              const ay = sy + stepH / 2;
              body += `<line x1="${ax1}" y1="${ay}" x2="${ax2 - 8}" y2="${ay}" stroke="${t.muted}" stroke-width="2.5" opacity="0.6"/>`;
              body += `<polygon points="${ax2 - 8},${ay - 6} ${ax2},${ay} ${ax2 - 8},${ay + 6}" fill="${t.muted}" opacity="0.7"/>`;
            }
          }
        });
      } else {
        // vertical
        const stepW = 460;
        const stepH = 90;
        const gapH = 40;
        W = stepW + pad * 2;
        H = headerH + pad * 2 + stepList.length * stepH + (stepList.length - 1) * gapH + 20;

        body += `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
        body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
        body += `<text x="${W / 2}" y="40" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
        body += `<text x="${W / 2}" y="64" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${stepList.length} pasos</text>`;

        stepList.forEach((step, i) => {
          const sy = headerH + pad + i * (stepH + gapH);
          const sx = pad;
          const color = step.color || palette[i % palette.length];
          const safeLabel = xmlEscape(String(step.label || '').slice(0, 50));
          const safeDesc = xmlEscape(String(step.description || '').slice(0, 140));

          body += `<rect x="${sx}" y="${sy}" width="${stepW}" height="${stepH}" rx="10" fill="${t.step}" stroke="${color}" stroke-width="2" filter="url(#vis-shadow)"/>`;
          body += `<rect x="${sx}" y="${sy}" width="6" height="${stepH}" rx="3" fill="${color}"/>`;
          body += `<circle cx="${sx + 38}" cy="${sy + stepH / 2}" r="22" fill="${color}"/>`;
          body += `<text x="${sx + 38}" y="${sy + stepH / 2 + 6}" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#fff">${i + 1}</text>`;
          body += `<text x="${sx + 76}" y="${sy + 32}" font-family="Arial" font-size="15" font-weight="bold" fill="${t.text}">${safeLabel}</text>`;
          if (safeDesc) body += `<text x="${sx + 76}" y="${sy + 56}" font-family="Arial" font-size="11" fill="${t.muted}">${safeDesc}</text>`;

          if (i < stepList.length - 1) {
            const ay1 = sy + stepH + 4;
            const ay2 = sy + stepH + gapH - 4;
            const ax = sx + 38;
            body += `<line x1="${ax}" y1="${ay1}" x2="${ax}" y2="${ay2 - 8}" stroke="${t.muted}" stroke-width="2.5" opacity="0.6"/>`;
            body += `<polygon points="${ax - 6},${ay2 - 8} ${ax},${ay2} ${ax + 6},${ay2 - 8}" fill="${t.muted}" opacity="0.7"/>`;
          }
        });
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Process flow: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `processflow_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_process_flow',
        ok: true,
        preview: `Flujo listo: ${artifact.filename} (${stepList.length} pasos, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        steps: stepList.length,
        orientation,
        style,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_process_flow', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 12: create_swot_analysis
// ─────────────────────────────────────────────────────────────────────────

const createSwotAnalysis = {
  name: 'create_swot_analysis',
  description: 'Generate a SWOT analysis as an SVG file: a 2x2 strategic matrix with Strengths (internal positive), Weaknesses (internal negative), Opportunities (external positive), and Threats (external negative). Use for business strategy, market analysis, product reviews, competitive positioning, or any situational analysis. Each quadrant lists 1-8 bullet points.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'SWOT title (e.g. "Q1 2026 Product Review").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. brand, market, period).' },
      strengths: { type: 'array', items: { type: 'string' }, description: 'Internal positive factors (1-8 items).' },
      weaknesses: { type: 'array', items: { type: 'string' }, description: 'Internal negative factors (1-8 items).' },
      opportunities: { type: 'array', items: { type: 'string' }, description: 'External positive factors (1-8 items).' },
      threats: { type: 'array', items: { type: 'string' }, description: 'External negative factors (1-8 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'strengths', 'weaknesses', 'opportunities', 'threats'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', strengths = [], weaknesses = [], opportunities = [], threats = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_swot_analysis', preview: title });

    try {
      const quadInputs = [strengths, weaknesses, opportunities, threats];
      if (!quadInputs.every(q => Array.isArray(q))) {
        return { ok: false, error: 'strengths/weaknesses/opportunities/threats must be arrays' };
      }
      const totalItems = quadInputs.reduce((s, q) => s + q.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all quadrants are empty — provide at least one item' };
      }

      // Quadrant palettes encode meaning: green/blue for positive,
      // amber/red for negative; left column internal, right column external.
      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          strengths:     { fill: '#ECFDF5', bar: '#10B981', label: '#065F46' },
          weaknesses:    { fill: '#FEF3C7', bar: '#F59E0B', label: '#92400E' },
          opportunities: { fill: '#EFF6FF', bar: '#3B82F6', label: '#1E40AF' },
          threats:       { fill: '#FEE2E2', bar: '#EF4444', label: '#991B1B' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          strengths:     { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0' },
          weaknesses:    { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A' },
          opportunities: { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE' },
          threats:       { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          strengths:     { fill: '#F1F5F9', bar: '#10B981', label: '#0F172A' },
          weaknesses:    { fill: '#F1F5F9', bar: '#F59E0B', label: '#0F172A' },
          opportunities: { fill: '#F1F5F9', bar: '#3B82F6', label: '#0F172A' },
          threats:       { fill: '#F1F5F9', bar: '#EF4444', label: '#0F172A' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          strengths:     { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20' },
          weaknesses:    { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00' },
          opportunities: { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91' },
          threats:       { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14' },
        },
      };
      const t = themes[theme] || themes.professional;

      // Layout: header + 2x2 grid. Quadrant height grows with bullet count
      // so neither column gets clipped when one side has more items.
      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const quadW = 360;
      const quadGap = 16;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 88;
      const quadHeaderH = 56;
      const lineH = 22;
      const lineMaxChars = 56;

      const QUADS = [
        { key: 'strengths',     pal: t.strengths,     label: 'STRENGTHS',     subLabel: 'Internal · Positive', items: strengths,     icon: '+' },
        { key: 'weaknesses',    pal: t.weaknesses,    label: 'WEAKNESSES',    subLabel: 'Internal · Negative', items: weaknesses,    icon: '−' },
        { key: 'opportunities', pal: t.opportunities, label: 'OPPORTUNITIES', subLabel: 'External · Positive', items: opportunities, icon: '↑' },
        { key: 'threats',       pal: t.threats,       label: 'THREATS',       subLabel: 'External · Negative', items: threats,       icon: '!' },
      ];
      // Trim each quadrant + line lengths.
      const trimmed = QUADS.map(q => ({
        ...q,
        items: (q.items || []).slice(0, 8).map(it => xmlEscape(String(it || '').slice(0, lineMaxChars))).filter(Boolean),
      }));
      const topRowItems = Math.max(trimmed[0].items.length, trimmed[1].items.length, 1);
      const botRowItems = Math.max(trimmed[2].items.length, trimmed[3].items.length, 1);
      const topRowH = quadHeaderH + topRowItems * lineH + 28;
      const botRowH = quadHeaderH + botRowItems * lineH + 28;

      const W = pad * 2 + quadW * 2 + quadGap;
      const H = headerH + pad + topRowH + quadGap + botRowH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header band
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const headerMeta = `${trimmed[0].items.length} S · ${trimmed[1].items.length} W · ${trimmed[2].items.length} O · ${trimmed[3].items.length} T`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${headerMeta}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      function drawQuadrant(q, x, y, h) {
        let out = '';
        // Card
        out += `<rect x="${x}" y="${y}" width="${quadW}" height="${h}" rx="10" fill="${q.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        // Color bar
        out += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${q.pal.bar}"/>`;
        // Icon circle
        out += `<circle cx="${x + 32}" cy="${y + 28}" r="14" fill="${q.pal.bar}"/>`;
        out += `<text x="${x + 32}" y="${y + 33}" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">${xmlEscape(q.icon)}</text>`;
        // Label
        out += `<text x="${x + 56}" y="${y + 26}" font-family="Arial" font-size="15" font-weight="bold" fill="${q.pal.label}">${q.label}</text>`;
        out += `<text x="${x + 56}" y="${y + 44}" font-family="Arial" font-size="11" fill="${t.muted}">${q.subLabel}</text>`;
        // Separator
        out += `<line x1="${x + 16}" y1="${y + quadHeaderH}" x2="${x + quadW - 16}" y2="${y + quadHeaderH}" stroke="${t.border}" stroke-width="1"/>`;
        // Items
        if (q.items.length === 0) {
          out += `<text x="${x + quadW / 2}" y="${y + quadHeaderH + 32}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin elementos —</text>`;
        } else {
          q.items.forEach((line, idx) => {
            const ly = y + quadHeaderH + 22 + idx * lineH;
            out += `<circle cx="${x + 22}" cy="${ly - 4}" r="3" fill="${q.pal.bar}"/>`;
            out += `<text x="${x + 32}" y="${ly}" font-family="Arial" font-size="12" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      const topY = headerH + pad;
      const leftX = pad;
      const rightX = pad + quadW + quadGap;
      const botY = topY + topRowH + quadGap;

      body += drawQuadrant(trimmed[0], leftX,  topY, topRowH);
      body += drawQuadrant(trimmed[1], rightX, topY, topRowH);
      body += drawQuadrant(trimmed[2], leftX,  botY, botRowH);
      body += drawQuadrant(trimmed[3], rightX, botY, botRowH);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `SWOT analysis: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `swot_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_swot_analysis',
        ok: true,
        preview: `SWOT listo: ${artifact.filename} (S:${trimmed[0].items.length} W:${trimmed[1].items.length} O:${trimmed[2].items.length} T:${trimmed[3].items.length}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts: {
          strengths:     trimmed[0].items.length,
          weaknesses:    trimmed[1].items.length,
          opportunities: trimmed[2].items.length,
          threats:       trimmed[3].items.length,
        },
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_swot_analysis', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 13: create_eisenhower_matrix
// ─────────────────────────────────────────────────────────────────────────

const createEisenhowerMatrix = {
  name: 'create_eisenhower_matrix',
  description: 'Generate an Eisenhower urgency/importance matrix as an SVG file: a 2x2 productivity grid (Do / Schedule / Delegate / Eliminate). Use for prioritization, task triage, sprint planning, executive decision-making, or any urgent-vs-important categorisation. Each quadrant lists 1-8 bullet items.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Matrix title (e.g. "Sprint 14 Triage").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. period, owner).' },
      do: { type: 'array', items: { type: 'string' }, description: 'Urgent AND important — do now (1-8 items).' },
      schedule: { type: 'array', items: { type: 'string' }, description: 'Important but NOT urgent — schedule (1-8 items).' },
      delegate: { type: 'array', items: { type: 'string' }, description: 'Urgent but NOT important — delegate (1-8 items).' },
      eliminate: { type: 'array', items: { type: 'string' }, description: 'Neither urgent NOR important — eliminate (1-8 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'do', 'schedule', 'delegate', 'eliminate'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', do: doItems = [], schedule = [], delegate = [], eliminate = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_eisenhower_matrix', preview: title });

    try {
      const quadInputs = [doItems, schedule, delegate, eliminate];
      if (!quadInputs.every(q => Array.isArray(q))) {
        return { ok: false, error: 'do/schedule/delegate/eliminate must be arrays' };
      }
      const totalItems = quadInputs.reduce((s, q) => s + q.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all quadrants are empty — provide at least one item' };
      }

      // Eisenhower colour semantics: red = act now, blue = strategic plan,
      // amber = delegate, neutral grey = drop. Distinct from SWOT to keep
      // the two readings independent when both appear in a deck.
      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#0F172A', axisText: '#475569',
          do:        { fill: '#FEE2E2', bar: '#DC2626', label: '#7F1D1D', verb: 'DO' },
          schedule:  { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A', verb: 'SCHEDULE' },
          delegate:  { fill: '#FEF3C7', bar: '#D97706', label: '#78350F', verb: 'DELEGATE' },
          eliminate: { fill: '#F1F5F9', bar: '#64748B', label: '#334155', verb: 'ELIMINATE' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8', axisText: '#CBD5E1',
          do:        { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA', verb: 'DO' },
          schedule:  { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE', verb: 'SCHEDULE' },
          delegate:  { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A', verb: 'DELEGATE' },
          eliminate: { fill: '#334155', bar: '#94A3B8', label: '#E2E8F0', verb: 'ELIMINATE' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A', axisText: '#475569',
          do:        { fill: '#F8FAFC', bar: '#DC2626', label: '#0F172A', verb: 'DO' },
          schedule:  { fill: '#F8FAFC', bar: '#2563EB', label: '#0F172A', verb: 'SCHEDULE' },
          delegate:  { fill: '#F8FAFC', bar: '#D97706', label: '#0F172A', verb: 'DELEGATE' },
          eliminate: { fill: '#F8FAFC', bar: '#64748B', label: '#0F172A', verb: 'ELIMINATE' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF', axisText: '#334155',
          do:        { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14', verb: 'DO' },
          schedule:  { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91', verb: 'SCHEDULE' },
          delegate:  { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00', verb: 'DELEGATE' },
          eliminate: { fill: '#F1F3F4', bar: '#5F6368', label: '#202124', verb: 'ELIMINATE' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const quadW = 360;
      const quadGap = 16;
      const axisGutter = 64;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 88;
      const quadHeaderH = 60;
      const lineH = 22;
      const lineMaxChars = 56;
      const axisLabelH = 28;

      // Quadrant order matters: visually, Y axis points UP (important on
      // top) and X axis points RIGHT (urgent on right) — the canonical
      // Eisenhower layout used in every productivity textbook.
      const QUADS = [
        // Top-left: important + NOT urgent → Schedule (Quadrant II)
        { key: 'schedule',  pal: t.schedule,  items: schedule,  axisX: 'left',  axisY: 'top',    subLabel: 'Important · Not urgent' },
        // Top-right: important + urgent → Do (Quadrant I)
        { key: 'do',        pal: t.do,        items: doItems,   axisX: 'right', axisY: 'top',    subLabel: 'Important · Urgent' },
        // Bottom-left: NOT important + NOT urgent → Eliminate (Quadrant IV)
        { key: 'eliminate', pal: t.eliminate, items: eliminate, axisX: 'left',  axisY: 'bottom', subLabel: 'Not important · Not urgent' },
        // Bottom-right: NOT important + urgent → Delegate (Quadrant III)
        { key: 'delegate',  pal: t.delegate,  items: delegate,  axisX: 'right', axisY: 'bottom', subLabel: 'Not important · Urgent' },
      ];
      const trimmed = QUADS.map(q => ({
        ...q,
        items: (q.items || []).slice(0, 8).map(it => xmlEscape(String(it || '').slice(0, lineMaxChars))).filter(Boolean),
      }));
      const topRowItems = Math.max(trimmed[0].items.length, trimmed[1].items.length, 1);
      const botRowItems = Math.max(trimmed[2].items.length, trimmed[3].items.length, 1);
      const topRowH = quadHeaderH + topRowItems * lineH + 28;
      const botRowH = quadHeaderH + botRowItems * lineH + 28;

      const gridW = quadW * 2 + quadGap;
      const W = pad * 2 + axisGutter + gridW;
      const H = headerH + pad + axisLabelH + topRowH + quadGap + botRowH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header band
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const headerMeta = `${trimmed[1].items.length} DO · ${trimmed[0].items.length} SCHEDULE · ${trimmed[3].items.length} DELEGATE · ${trimmed[2].items.length} ELIMINATE`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${headerMeta}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // X-axis label ("Urgency: Not urgent ← → Urgent")
      const axisRowY = headerH + pad;
      const leftQuadX = pad + axisGutter;
      const rightQuadX = leftQuadX + quadW + quadGap;
      body += `<text x="${leftQuadX + quadW / 2}" y="${axisRowY + 18}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}">NOT URGENT</text>`;
      body += `<text x="${rightQuadX + quadW / 2}" y="${axisRowY + 18}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}">URGENT</text>`;

      const topY = axisRowY + axisLabelH;
      const botY = topY + topRowH + quadGap;

      // Y-axis label (vertical text on the left gutter)
      const yAxisX = pad + axisGutter / 2;
      body += `<text x="${yAxisX}" y="${topY + topRowH / 2}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}" transform="rotate(-90, ${yAxisX}, ${topY + topRowH / 2})">IMPORTANT</text>`;
      body += `<text x="${yAxisX}" y="${botY + botRowH / 2}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}" transform="rotate(-90, ${yAxisX}, ${botY + botRowH / 2})">NOT IMPORTANT</text>`;

      function drawQuadrant(q, x, y, h) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${quadW}" height="${h}" rx="10" fill="${q.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${q.pal.bar}"/>`;
        // Verb pill in top-right of card
        const pillW = Math.max(78, q.pal.verb.length * 9 + 18);
        out += `<rect x="${x + quadW - pillW - 14}" y="${y + 14}" width="${pillW}" height="24" rx="12" fill="${q.pal.bar}"/>`;
        out += `<text x="${x + quadW - pillW / 2 - 14}" y="${y + 30}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#fff">${xmlEscape(q.pal.verb)}</text>`;
        // Quadrant sub-label
        out += `<text x="${x + 22}" y="${y + 28}" font-family="Arial" font-size="13" font-weight="bold" fill="${q.pal.label}">${xmlEscape(q.subLabel)}</text>`;
        out += `<text x="${x + 22}" y="${y + 46}" font-family="Arial" font-size="11" fill="${t.muted}">${q.items.length} item${q.items.length === 1 ? '' : 's'}</text>`;
        // Separator
        out += `<line x1="${x + 16}" y1="${y + quadHeaderH}" x2="${x + quadW - 16}" y2="${y + quadHeaderH}" stroke="${t.border}" stroke-width="1"/>`;
        // Items
        if (q.items.length === 0) {
          out += `<text x="${x + quadW / 2}" y="${y + quadHeaderH + 32}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin elementos —</text>`;
        } else {
          q.items.forEach((line, idx) => {
            const ly = y + quadHeaderH + 22 + idx * lineH;
            out += `<circle cx="${x + 22}" cy="${ly - 4}" r="3" fill="${q.pal.bar}"/>`;
            out += `<text x="${x + 32}" y="${ly}" font-family="Arial" font-size="12" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      body += drawQuadrant(trimmed[0], leftQuadX,  topY, topRowH);
      body += drawQuadrant(trimmed[1], rightQuadX, topY, topRowH);
      body += drawQuadrant(trimmed[2], leftQuadX,  botY, botRowH);
      body += drawQuadrant(trimmed[3], rightQuadX, botY, botRowH);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Eisenhower matrix: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `eisenhower_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_eisenhower_matrix',
        ok: true,
        preview: `Eisenhower listo: ${artifact.filename} (Do:${trimmed[1].items.length} Sch:${trimmed[0].items.length} Del:${trimmed[3].items.length} Elim:${trimmed[2].items.length}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts: {
          do:        trimmed[1].items.length,
          schedule:  trimmed[0].items.length,
          delegate:  trimmed[3].items.length,
          eliminate: trimmed[2].items.length,
        },
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_eisenhower_matrix', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 14: create_raci_matrix
// ─────────────────────────────────────────────────────────────────────────

const createRaciMatrix = {
  name: 'create_raci_matrix',
  description: 'Generate a RACI Responsibility Assignment Matrix as an SVG file: tasks (rows) × roles/people (columns), with each cell marked R (Responsible), A (Accountable), C (Consulted), I (Informed), or blank. Use for project governance, role clarification, hand-off planning, or any task-vs-stakeholder responsibility map.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Matrix title (e.g. "Deploy Pipeline RACI").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. team, project, period).' },
      roles: { type: 'array', items: { type: 'string' }, description: 'Column headers — roles or people (2-8 items).' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task / activity / deliverable.' },
            assignments: {
              type: 'array',
              items: { type: 'string', enum: ['R', 'A', 'C', 'I', 'r', 'a', 'c', 'i', ''] },
              description: 'One assignment letter per role (R/A/C/I or empty), in the same order as roles[].',
            },
          },
          required: ['task', 'assignments'],
        },
        description: '1-20 task rows.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'roles', 'rows'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', roles = [], rows = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_raci_matrix', preview: title });

    try {
      if (!Array.isArray(roles) || roles.length === 0) {
        return { ok: false, error: 'roles array is empty' };
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, error: 'rows array is empty' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB', altRow: '#F8FAFC', taskCol: '#F1F5F9',
          R: { fill: '#10B981', label: '#FFFFFF' },
          A: { fill: '#2563EB', label: '#FFFFFF' },
          C: { fill: '#F59E0B', label: '#FFFFFF' },
          I: { fill: '#94A3B8', label: '#FFFFFF' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8', altRow: '#162033', taskCol: '#0F172A',
          R: { fill: '#34D399', label: '#0F172A' },
          A: { fill: '#60A5FA', label: '#0F172A' },
          C: { fill: '#FBBF24', label: '#0F172A' },
          I: { fill: '#94A3B8', label: '#0F172A' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A', altRow: '#F8FAFC', taskCol: '#F1F5F9',
          R: { fill: '#0F172A', label: '#FFFFFF' },
          A: { fill: '#475569', label: '#FFFFFF' },
          C: { fill: '#94A3B8', label: '#FFFFFF' },
          I: { fill: '#CBD5E1', label: '#0F172A' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF', altRow: '#F1F5F9', taskCol: '#E8F0FE',
          R: { fill: '#0F9D58', label: '#FFFFFF' },
          A: { fill: '#1A73E8', label: '#FFFFFF' },
          C: { fill: '#F9AB00', label: '#FFFFFF' },
          I: { fill: '#5F6368', label: '#FFFFFF' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      // Caps prevent absurd outputs while keeping the canonical use cases.
      const roleList = roles.slice(0, 8).map(r => xmlEscape(String(r || '').slice(0, 24)));
      const rowList = rows.slice(0, 20);

      const taskColW = 240;
      const roleColW = Math.max(70, Math.min(120, 720 / Math.max(roleList.length, 1)));
      const rowH = 40;
      const headerH = safeSubtitle ? 108 : 86;
      const colHeaderH = 56;
      const legendH = 36;
      const pad = 24;
      const W = pad * 2 + taskColW + roleList.length * roleColW;
      const H = headerH + pad + colHeaderH + rowList.length * rowH + legendH + pad + 12;

      // Count assignment types for the result summary
      const tally = { R: 0, A: 0, C: 0, I: 0 };

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="40" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="62" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${roleList.length} roles · ${rowList.length} tareas</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="86" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Column headers
      const tableY = headerH + pad;
      const tableX = pad;
      body += `<rect x="${tableX}" y="${tableY}" width="${taskColW}" height="${colHeaderH}" fill="${t.taskCol}" stroke="${t.border}" stroke-width="1" rx="8"/>`;
      body += `<text x="${tableX + 16}" y="${tableY + colHeaderH / 2 + 5}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.muted}">TAREA / ACTIVIDAD</text>`;

      roleList.forEach((role, ri) => {
        const rx = tableX + taskColW + ri * roleColW;
        body += `<rect x="${rx}" y="${tableY}" width="${roleColW}" height="${colHeaderH}" fill="${t.card}" stroke="${t.border}" stroke-width="1" rx="8"/>`;
        body += `<text x="${rx + roleColW / 2}" y="${tableY + colHeaderH / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${role}</text>`;
      });

      // Rows
      rowList.forEach((row, idx) => {
        const ry = tableY + colHeaderH + idx * rowH;
        const isAlt = idx % 2 === 1;
        const rowBg = isAlt ? t.altRow : t.card;
        const safeTask = xmlEscape(String(row.task || '').slice(0, 64));
        // Task cell
        body += `<rect x="${tableX}" y="${ry}" width="${taskColW}" height="${rowH}" fill="${rowBg}" stroke="${t.border}" stroke-width="0.5"/>`;
        body += `<text x="${tableX + 16}" y="${ry + rowH / 2 + 5}" font-family="Arial" font-size="13" font-weight="600" fill="${t.text}">${safeTask}</text>`;
        // Assignment cells
        const assignments = Array.isArray(row.assignments) ? row.assignments : [];
        roleList.forEach((_, ri) => {
          const rx = tableX + taskColW + ri * roleColW;
          body += `<rect x="${rx}" y="${ry}" width="${roleColW}" height="${rowH}" fill="${rowBg}" stroke="${t.border}" stroke-width="0.5"/>`;
          const raw = String(assignments[ri] || '').trim().toUpperCase();
          if (raw === 'R' || raw === 'A' || raw === 'C' || raw === 'I') {
            const pal = t[raw];
            tally[raw] += 1;
            const cx = rx + roleColW / 2;
            const cy = ry + rowH / 2;
            // Pill background — slightly smaller than cell to feel breathable
            body += `<rect x="${cx - 14}" y="${cy - 12}" width="28" height="24" rx="12" fill="${pal.fill}"/>`;
            body += `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${pal.label}">${raw}</text>`;
          }
          // empty cell: nothing to draw beyond the cell background
        });
      });

      // Outer table border
      const tableH = colHeaderH + rowList.length * rowH;
      body += `<rect x="${tableX}" y="${tableY}" width="${taskColW + roleList.length * roleColW}" height="${tableH}" fill="none" stroke="${t.border}" stroke-width="1" rx="8"/>`;

      // Legend strip
      const legendY = tableY + tableH + 8;
      const legendEntries = [
        { k: 'R', label: 'Responsible — ejecuta' },
        { k: 'A', label: 'Accountable — responde por el resultado' },
        { k: 'C', label: 'Consulted — aporta input' },
        { k: 'I', label: 'Informed — se le informa' },
      ];
      let lx = tableX;
      legendEntries.forEach((entry) => {
        const pal = t[entry.k];
        body += `<rect x="${lx}" y="${legendY}" width="22" height="22" rx="11" fill="${pal.fill}"/>`;
        body += `<text x="${lx + 11}" y="${legendY + 16}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${pal.label}">${entry.k}</text>`;
        body += `<text x="${lx + 30}" y="${legendY + 16}" font-family="Arial" font-size="11" fill="${t.muted}">${xmlEscape(entry.label)}</text>`;
        lx += 30 + entry.label.length * 5.8 + 14;
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `RACI matrix: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `raci_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_raci_matrix',
        ok: true,
        preview: `RACI listo: ${artifact.filename} (${roleList.length}×${rowList.length}, R:${tally.R} A:${tally.A} C:${tally.C} I:${tally.I}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        roles: roleList.length,
        rows: rowList.length,
        tally,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_raci_matrix', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 15: create_business_model_canvas
// ─────────────────────────────────────────────────────────────────────────

const createBusinessModelCanvas = {
  name: 'create_business_model_canvas',
  description: "Generate Osterwalder's 9-block Business Model Canvas as an SVG file: Key Partners, Key Activities, Key Resources, Value Propositions, Customer Relationships, Channels, Customer Segments (top section, 5 columns), plus Cost Structure and Revenue Streams (bottom section). Use for startup pitches, business model design, strategic reviews, or any one-page business overview. Each block accepts 1-8 bullet items.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Canvas title (e.g. "SiraGPT BMC — 2026").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. company, period, iteration).' },
      keyPartners:           { type: 'array', items: { type: 'string' }, description: 'Strategic alliances, suppliers, key vendors (1-8 items).' },
      keyActivities:         { type: 'array', items: { type: 'string' }, description: 'Most important activities required to deliver value (1-8 items).' },
      keyResources:          { type: 'array', items: { type: 'string' }, description: 'Most important assets (physical, intellectual, human, financial) (1-8 items).' },
      valuePropositions:     { type: 'array', items: { type: 'string' }, description: 'Products/services that create value for the customer segment (1-8 items).' },
      customerRelationships: { type: 'array', items: { type: 'string' }, description: 'Type of relationship with each customer segment (1-8 items).' },
      channels:              { type: 'array', items: { type: 'string' }, description: 'How the value reaches customers (sales/distribution/comms) (1-8 items).' },
      customerSegments:      { type: 'array', items: { type: 'string' }, description: 'Distinct groups of people/orgs the business serves (1-8 items).' },
      costStructure:         { type: 'array', items: { type: 'string' }, description: 'Major cost drivers of the business model (1-8 items).' },
      revenueStreams:        { type: 'array', items: { type: 'string' }, description: 'Cash flow generated by each customer segment (1-8 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    keyPartners = [],
    keyActivities = [],
    keyResources = [],
    valuePropositions = [],
    customerRelationships = [],
    channels = [],
    customerSegments = [],
    costStructure = [],
    revenueStreams = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_business_model_canvas', preview: title });

    try {
      const allBlocks = [keyPartners, keyActivities, keyResources, valuePropositions, customerRelationships, channels, customerSegments, costStructure, revenueStreams];
      if (!allBlocks.every(b => Array.isArray(b))) {
        return { ok: false, error: 'all block inputs must be arrays of strings' };
      }
      const totalItems = allBlocks.reduce((s, b) => s + b.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 9 blocks are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Each canonical BMC block has a recognised colour family in
          // strategy decks; preserving that hint helps readers navigate.
          kp: '#7C3AED', ka: '#2563EB', kr: '#0EA5E9', vp: '#DC2626', cr: '#F59E0B', ch: '#F97316', cs: '#10B981',
          cost: '#475569', rev: '#16A34A',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          kp: '#A78BFA', ka: '#60A5FA', kr: '#38BDF8', vp: '#F87171', cr: '#FBBF24', ch: '#FB923C', cs: '#34D399',
          cost: '#94A3B8', rev: '#4ADE80',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          kp: '#0F172A', ka: '#0F172A', kr: '#0F172A', vp: '#0F172A', cr: '#0F172A', ch: '#0F172A', cs: '#0F172A',
          cost: '#0F172A', rev: '#0F172A',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          kp: '#673AB7', ka: '#1A73E8', kr: '#039BE5', vp: '#D93025', cr: '#F9AB00', ch: '#E8710A', cs: '#0F9D58',
          cost: '#5F6368', rev: '#137333',
        },
      };
      const t = themes[theme] || themes.professional;

      // Canonical BMC layout: 5 equal-width columns up top, 2 equal halves
      // at the bottom. KP/VP/CS span both top rows (tall blocks); KA/KR
      // and CR/CH stack vertically (short blocks).
      const cellW = 224;
      const halfH = 132;
      const tallH = halfH * 2 + 6; // small gap accounted for visually
      const bottomH = 132;
      const gap = 6;
      const pad = 24;
      const headerH = subtitle ? 110 : 86;
      const W = pad * 2 + cellW * 5 + gap * 4;
      const topH = tallH;
      const H = headerH + pad + topH + gap + bottomH + pad;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const lineH = 16;
      const lineMaxChars = 38;
      const itemsCapPerBlock = 8;
      function fmt(items) {
        return (items || []).slice(0, itemsCapPerBlock).map(it => xmlEscape(String(it || '').slice(0, lineMaxChars))).filter(Boolean);
      }

      const blocks = {
        kp: { label: 'KEY PARTNERS',           items: fmt(keyPartners) },
        ka: { label: 'KEY ACTIVITIES',         items: fmt(keyActivities) },
        kr: { label: 'KEY RESOURCES',          items: fmt(keyResources) },
        vp: { label: 'VALUE PROPOSITIONS',     items: fmt(valuePropositions) },
        cr: { label: 'CUSTOMER RELATIONSHIPS', items: fmt(customerRelationships) },
        ch: { label: 'CHANNELS',               items: fmt(channels) },
        cs: { label: 'CUSTOMER SEGMENTS',      items: fmt(customerSegments) },
        cost: { label: 'COST STRUCTURE',  items: fmt(costStructure) },
        rev:  { label: 'REVENUE STREAMS', items: fmt(revenueStreams) },
      };

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header band
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const totalsLine = `${totalItems} ítems across 9 blocks`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalsLine}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      function drawBlock(block, color, x, y, w, h, blockMaxLines = 8) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="${w}" height="4" rx="2" fill="${color}"/>`;
        out += `<text x="${x + 12}" y="${y + 24}" font-family="Arial" font-size="11" font-weight="bold" fill="${color}">${xmlEscape(block.label)}</text>`;
        out += `<text x="${x + w - 12}" y="${y + 24}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${block.items.length}</text>`;
        // Items list
        const lines = block.items.slice(0, blockMaxLines);
        if (lines.length === 0) {
          out += `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" font-style="italic">— vacío —</text>`;
        } else {
          lines.forEach((line, idx) => {
            const ly = y + 44 + idx * lineH;
            if (ly > y + h - 10) return; // overflow guard for tight bottom row
            out += `<circle cx="${x + 16}" cy="${ly - 4}" r="2.5" fill="${color}"/>`;
            out += `<text x="${x + 24}" y="${ly}" font-family="Arial" font-size="10.5" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      const topY = headerH + pad;
      const col1X = pad;
      const col2X = col1X + cellW + gap;
      const col3X = col2X + cellW + gap;
      const col4X = col3X + cellW + gap;
      const col5X = col4X + cellW + gap;

      // Top section
      body += drawBlock(blocks.kp, t.kp, col1X, topY, cellW, tallH);
      body += drawBlock(blocks.ka, t.ka, col2X, topY, cellW, halfH);
      body += drawBlock(blocks.kr, t.kr, col2X, topY + halfH + gap, cellW, halfH);
      body += drawBlock(blocks.vp, t.vp, col3X, topY, cellW, tallH);
      body += drawBlock(blocks.cr, t.cr, col4X, topY, cellW, halfH);
      body += drawBlock(blocks.ch, t.ch, col4X, topY + halfH + gap, cellW, halfH);
      body += drawBlock(blocks.cs, t.cs, col5X, topY, cellW, tallH);

      // Bottom section: Cost (left half), Revenue (right half)
      const botY = topY + topH + gap;
      const halfW = (W - pad * 2 - gap) / 2;
      body += drawBlock(blocks.cost, t.cost, pad,                   botY, halfW, bottomH, 6);
      body += drawBlock(blocks.rev,  t.rev,  pad + halfW + gap,     botY, halfW, bottomH, 6);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Business Model Canvas: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `bmc_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        keyPartners: blocks.kp.items.length,
        keyActivities: blocks.ka.items.length,
        keyResources: blocks.kr.items.length,
        valuePropositions: blocks.vp.items.length,
        customerRelationships: blocks.cr.items.length,
        channels: blocks.ch.items.length,
        customerSegments: blocks.cs.items.length,
        costStructure: blocks.cost.items.length,
        revenueStreams: blocks.rev.items.length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_business_model_canvas',
        ok: true,
        preview: `BMC listo: ${artifact.filename} (${totalItems} ítems en 9 bloques, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_business_model_canvas', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 16: create_pyramid_diagram
// ─────────────────────────────────────────────────────────────────────────

const createPyramidDiagram = {
  name: 'create_pyramid_diagram',
  description: 'Generate a hierarchical pyramid diagram as an SVG file: N stacked triangular layers from base (widest) to apex (narrowest), each with a label and optional description. Use for Maslow hierarchies, KPI cascades, learning levels (Bloom), organizational tiers, or any hierarchical/foundational concept. Supports 2-8 levels, inverted orientation, and 4 themes.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Pyramid title (e.g. "Maslow Hierarchy of Needs").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      levels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Level label (short).' },
            description: { type: 'string', description: 'Optional 1-line description for the level.' },
            color: { type: 'string', description: 'Optional hex color override (e.g. "#3B82F6").' },
          },
          required: ['label'],
        },
        description: '2-8 levels ordered FROM TOP (apex) TO BOTTOM (base). The first item is the narrowest layer.',
      },
      inverted: { type: 'boolean', description: 'When true, draw an inverted pyramid (widest at top). Default: false.' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'levels'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', levels = [], inverted = false, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_pyramid_diagram', preview: title });

    try {
      if (!Array.isArray(levels) || levels.length === 0) {
        return { ok: false, error: 'levels array is empty' };
      }
      if (levels.length < 2) {
        return { ok: false, error: 'pyramid requires at least 2 levels' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', accent: '#2563EB', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', label: '#FFFFFF',
          // Gradient from apex (cool/aspirational) to base (warm/fundamental)
          palette: ['#7C3AED', '#2563EB', '#0EA5E9', '#10B981', '#F59E0B', '#F97316', '#EF4444', '#7F1D1D'],
        },
        modern: {
          bg: '#0B1121', accent: '#818CF8', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', label: '#0F172A',
          palette: ['#A78BFA', '#60A5FA', '#38BDF8', '#34D399', '#FBBF24', '#FB923C', '#F87171', '#FCA5A5'],
        },
        minimal: {
          bg: '#FFFFFF', accent: '#0F172A', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', label: '#FFFFFF',
          palette: ['#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'],
        },
        corporate: {
          bg: '#F8FAFC', accent: '#1E40AF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', label: '#FFFFFF',
          palette: ['#673AB7', '#1A73E8', '#039BE5', '#0F9D58', '#F9AB00', '#E8710A', '#D93025', '#5F6368'],
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const levelList = levels.slice(0, 8);
      const n = levelList.length;

      // Pyramid geometry: apex at top (or bottom if inverted), each layer
      // is a trapezoid (or the apex triangle). Height is divided equally
      // among layers; width grows linearly from the apex.
      const apexW = 80;
      const baseW = 540;
      const layerH = 76;
      const pyramidH = n * layerH;
      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      const descCol = 240; // right-side column for level descriptions
      const W = pad * 2 + baseW + 32 + descCol;
      const H = headerH + pad + pyramidH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const orientLabel = inverted ? 'invertida · base arriba' : 'apex arriba · base abajo';
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n} niveles · ${orientLabel}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      const cx = pad + baseW / 2;
      const topY = headerH + pad;

      // Build each layer as a trapezoid. We compute the top-width and
      // bottom-width for layer i based on its position in the pyramid.
      // Layer 0 is at the TOP unless `inverted` is true (then layer 0 is bottom).
      function layerWidth(idx) {
        // Standard pyramid: apex (idx=0) = apexW, base (idx=n-1) = baseW.
        // Linear interpolation.
        const tFactor = n === 1 ? 1 : idx / (n - 1);
        return apexW + (baseW - apexW) * tFactor;
      }

      levelList.forEach((level, i) => {
        // For inverted, flip the visual position by reversing the index.
        const visualIdx = inverted ? n - 1 - i : i;
        const yTop = topY + visualIdx * layerH;
        const yBot = yTop + layerH;
        const topW = layerWidth(i);
        const botW = i + 1 < n ? layerWidth(i + 1) : layerWidth(i);

        // For an inverted pyramid, swap top/bot widths so the layer visually
        // matches its position: a wider layer should be at the top.
        let trapTopW = topW;
        let trapBotW = botW;
        if (inverted) {
          trapTopW = botW;
          trapBotW = topW;
        }

        const xTopL = cx - trapTopW / 2;
        const xTopR = cx + trapTopW / 2;
        const xBotL = cx - trapBotW / 2;
        const xBotR = cx + trapBotW / 2;

        const color = level.color && /^#[0-9A-Fa-f]{6}$/.test(level.color)
          ? level.color
          : t.palette[i % t.palette.length];

        // Trapezoid path
        body += `<path d="M ${xTopL} ${yTop} L ${xTopR} ${yTop} L ${xBotR} ${yBot} L ${xBotL} ${yBot} Z" fill="${color}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;

        // Layer label (centered)
        const safeLabel = xmlEscape(String(level.label || '').slice(0, 40));
        const labelY = yTop + layerH / 2 + 5;
        body += `<text x="${cx}" y="${labelY}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.label}">${safeLabel}</text>`;

        // Level number bubble on the left
        const levelNum = inverted ? n - i : i + 1;
        body += `<circle cx="${pad + 14}" cy="${yTop + layerH / 2}" r="14" fill="${color}" stroke="${t.bg}" stroke-width="3"/>`;
        body += `<text x="${pad + 14}" y="${yTop + layerH / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="${t.label}">${levelNum}</text>`;

        // Description on the right side, if provided
        if (level.description) {
          const safeDesc = xmlEscape(String(level.description).slice(0, 110));
          const descX = pad + baseW + 32;
          // Connector dot + line
          body += `<circle cx="${cx + trapTopW / 2 + 8}" cy="${(yTop + yBot) / 2}" r="3" fill="${color}"/>`;
          body += `<line x1="${cx + trapTopW / 2 + 12}" y1="${(yTop + yBot) / 2}" x2="${descX - 8}" y2="${(yTop + yBot) / 2}" stroke="${color}" stroke-width="1.5" opacity="0.5"/>`;
          // Description text — wrap to up to 2 lines
          const halfIdx = Math.ceil(safeDesc.length / 2);
          const cut = safeDesc.lastIndexOf(' ', halfIdx) > 0 ? safeDesc.lastIndexOf(' ', halfIdx) : Math.min(halfIdx, safeDesc.length);
          const l1 = safeDesc.slice(0, cut);
          const l2 = safeDesc.slice(cut).trim();
          body += `<text x="${descX}" y="${(yTop + yBot) / 2 - 4}" font-family="Arial" font-size="11" fill="${t.text}">${l1}</text>`;
          if (l2) body += `<text x="${descX}" y="${(yTop + yBot) / 2 + 12}" font-family="Arial" font-size="11" fill="${t.muted}">${l2}</text>`;
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Pyramid diagram: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `pyramid_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_pyramid_diagram',
        ok: true,
        preview: `Pirámide lista: ${artifact.filename} (${n} niveles${inverted ? ', invertida' : ''}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        levels: n,
        inverted,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_pyramid_diagram', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 17: create_porters_five_forces
// ─────────────────────────────────────────────────────────────────────────

const createPortersFiveForces = {
  name: 'create_porters_five_forces',
  description: "Generate Porter's Five Forces industry-structure analysis as an SVG file: Industry Rivalry at the centre surrounded by Threat of New Entrants (top), Threat of Substitutes (bottom), Bargaining Power of Suppliers (left), and Bargaining Power of Buyers (right). Each force accepts 1-6 bullet items and an optional intensity (low/medium/high). Use for industry analysis, market positioning, strategic planning, or competitive deep-dives.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Analysis title (e.g. "AI Chat Platforms — Five Forces").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. market, period).' },
      rivalry:      { type: 'object', description: 'Industry Rivalry (centre). { items: [], intensity?: "low"|"medium"|"high" }' },
      newEntrants:  { type: 'object', description: 'Threat of New Entrants (top). { items: [], intensity?: "low"|"medium"|"high" }' },
      substitutes:  { type: 'object', description: 'Threat of Substitutes (bottom). { items: [], intensity?: "low"|"medium"|"high" }' },
      suppliers:    { type: 'object', description: 'Bargaining Power of Suppliers (left). { items: [], intensity?: "low"|"medium"|"high" }' },
      buyers:       { type: 'object', description: 'Bargaining Power of Buyers (right). { items: [], intensity?: "low"|"medium"|"high" }' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    rivalry = {},
    newEntrants = {},
    substitutes = {},
    suppliers = {},
    buyers = {},
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_porters_five_forces', preview: title });

    try {
      const forces = [rivalry, newEntrants, substitutes, suppliers, buyers];
      // Coerce missing inputs to empty objects without throwing — the
      // canonical use case provides at least Rivalry but agents may
      // start with a sparse skeleton and fill blocks iteratively.
      const normalisedForces = forces.map(f => (f && typeof f === 'object' && !Array.isArray(f)) ? f : {});
      const totalItems = normalisedForces.reduce((s, f) => s + ((Array.isArray(f.items) ? f.items.length : 0)), 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all five forces are empty — provide at least one item in any force' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          center:      { fill: '#FEE2E2', bar: '#DC2626', label: '#7F1D1D' },
          newEntrants: { fill: '#FEF3C7', bar: '#D97706', label: '#78350F' },
          substitutes: { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A' },
          suppliers:   { fill: '#ECFDF5', bar: '#10B981', label: '#065F46' },
          buyers:      { fill: '#EDE9FE', bar: '#7C3AED', label: '#4C1D95' },
          intensityLow: '#10B981', intensityMed: '#F59E0B', intensityHigh: '#EF4444',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          center:      { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA' },
          newEntrants: { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A' },
          substitutes: { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE' },
          suppliers:   { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0' },
          buyers:      { fill: '#4C1D95', bar: '#A78BFA', label: '#DDD6FE' },
          intensityLow: '#34D399', intensityMed: '#FBBF24', intensityHigh: '#F87171',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          center:      { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A' },
          newEntrants: { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          substitutes: { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          suppliers:   { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          buyers:      { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          intensityLow: '#10B981', intensityMed: '#F59E0B', intensityHigh: '#EF4444',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          center:      { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14' },
          newEntrants: { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00' },
          substitutes: { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91' },
          suppliers:   { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20' },
          buyers:      { fill: '#F3E8FD', bar: '#673AB7', label: '#3A1A6E' },
          intensityLow: '#0F9D58', intensityMed: '#F9AB00', intensityHigh: '#D93025',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const cellW = 260;
      const cellH = 180;
      const gap = 24;
      const pad = 24;
      const headerH = safeSubtitle ? 110 : 86;
      const W = pad * 2 + cellW * 3 + gap * 2;
      const H = headerH + pad + cellH * 3 + gap * 2 + pad;

      function clipItem(s) { return xmlEscape(String(s || '').slice(0, 48)); }
      function intensityColor(level) {
        const lv = String(level || '').trim().toLowerCase();
        if (lv === 'high') return t.intensityHigh;
        if (lv === 'medium') return t.intensityMed;
        if (lv === 'low') return t.intensityLow;
        return null;
      }

      function drawForce(force, pal, label, x, y, w, h, isCenter = false) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${pal.fill}" stroke="${t.border}" stroke-width="${isCenter ? 2 : 1}" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${pal.bar}"/>`;
        out += `<text x="${x + 18}" y="${y + 26}" font-family="Arial" font-size="13" font-weight="bold" fill="${pal.label}">${xmlEscape(label)}</text>`;

        // Intensity pill (right side)
        const ic = intensityColor(force.intensity);
        if (ic) {
          const intText = String(force.intensity).toUpperCase();
          const pillW = Math.max(56, intText.length * 8 + 12);
          out += `<rect x="${x + w - pillW - 12}" y="${y + 14}" width="${pillW}" height="22" rx="11" fill="${ic}"/>`;
          out += `<text x="${x + w - pillW / 2 - 12}" y="${y + 29}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${xmlEscape(intText)}</text>`;
        }

        // Separator
        out += `<line x1="${x + 16}" y1="${y + 44}" x2="${x + w - 16}" y2="${y + 44}" stroke="${t.border}" stroke-width="1"/>`;

        const items = Array.isArray(force.items) ? force.items : [];
        const itemList = items.slice(0, 6).map(clipItem).filter(Boolean);
        if (itemList.length === 0) {
          out += `<text x="${x + w / 2}" y="${y + h / 2 + 10}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin elementos —</text>`;
        } else {
          itemList.forEach((line, idx) => {
            const ly = y + 60 + idx * 18;
            if (ly > y + h - 12) return;
            out += `<circle cx="${x + 18}" cy="${ly - 4}" r="2.5" fill="${pal.bar}"/>`;
            out += `<text x="${x + 26}" y="${ly}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      // Layout: 3x3 grid, only the 5 force cells used (cross pattern)
      // [ . ][NE ][ . ]
      // [Sup][Riv][Buy]
      // [ . ][Sub][ . ]
      const baseY = headerH + pad;
      const col0X = pad;
      const col1X = col0X + cellW + gap;
      const col2X = col1X + cellW + gap;
      const row0Y = baseY;
      const row1Y = baseY + cellH + gap;
      const row2Y = row1Y + cellH + gap;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">5 forces · ${totalItems} ítems</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Connector lines from centre to each surrounding force
      const cx = col1X + cellW / 2;
      const cy = row1Y + cellH / 2;
      // Top connector
      body += `<line x1="${cx}" y1="${row1Y}" x2="${cx}" y2="${row0Y + cellH}" stroke="${t.border}" stroke-width="2" stroke-dasharray="4,4" opacity="0.5"/>`;
      // Bottom
      body += `<line x1="${cx}" y1="${row1Y + cellH}" x2="${cx}" y2="${row2Y}" stroke="${t.border}" stroke-width="2" stroke-dasharray="4,4" opacity="0.5"/>`;
      // Left
      body += `<line x1="${col1X}" y1="${cy}" x2="${col0X + cellW}" y2="${cy}" stroke="${t.border}" stroke-width="2" stroke-dasharray="4,4" opacity="0.5"/>`;
      // Right
      body += `<line x1="${col1X + cellW}" y1="${cy}" x2="${col2X}" y2="${cy}" stroke="${t.border}" stroke-width="2" stroke-dasharray="4,4" opacity="0.5"/>`;

      // Forces
      body += drawForce(normalisedForces[1], t.newEntrants, 'THREAT OF NEW ENTRANTS', col1X, row0Y, cellW, cellH);
      body += drawForce(normalisedForces[3], t.suppliers,   'BARGAINING POWER OF SUPPLIERS', col0X, row1Y, cellW, cellH);
      body += drawForce(normalisedForces[0], t.center,      'INDUSTRY RIVALRY', col1X, row1Y, cellW, cellH, true);
      body += drawForce(normalisedForces[4], t.buyers,      'BARGAINING POWER OF BUYERS', col2X, row1Y, cellW, cellH);
      body += drawForce(normalisedForces[2], t.substitutes, 'THREAT OF SUBSTITUTES', col1X, row2Y, cellW, cellH);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Porter's Five Forces: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `porters_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        rivalry:      Array.isArray(normalisedForces[0].items) ? normalisedForces[0].items.length : 0,
        newEntrants:  Array.isArray(normalisedForces[1].items) ? normalisedForces[1].items.length : 0,
        substitutes:  Array.isArray(normalisedForces[2].items) ? normalisedForces[2].items.length : 0,
        suppliers:    Array.isArray(normalisedForces[3].items) ? normalisedForces[3].items.length : 0,
        buyers:       Array.isArray(normalisedForces[4].items) ? normalisedForces[4].items.length : 0,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_porters_five_forces',
        ok: true,
        preview: `5 Forces: ${artifact.filename} (Riv:${counts.rivalry} NE:${counts.newEntrants} Sub:${counts.substitutes} Sup:${counts.suppliers} Buy:${counts.buyers}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_porters_five_forces', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 18: create_risk_matrix
// ─────────────────────────────────────────────────────────────────────────

const createRiskMatrix = {
  name: 'create_risk_matrix',
  description: 'Generate a probability × impact risk matrix as an SVG file: an N×N heatmap (3×3, 4×4 or 5×5) with risk score colors (green→yellow→orange→red) and individual risks plotted as labelled markers in the appropriate cell. Use for risk registers, project risk reviews, safety/compliance docs, or operational risk dashboards. Each risk has a label, probability (1-N), impact (1-N), and optional category.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Matrix title (e.g. "Q2 Project Risk Register").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      size: { type: 'integer', enum: [3, 4, 5], description: 'Grid size N×N. Default: 5.' },
      risks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short risk label.' },
            probability: { type: 'integer', minimum: 1, description: 'Likelihood, 1 (rare) to size (almost certain).' },
            impact: { type: 'integer', minimum: 1, description: 'Severity, 1 (minimal) to size (catastrophic).' },
            category: { type: 'string', description: 'Optional category (e.g. "tech", "legal", "operational").' },
          },
          required: ['label', 'probability', 'impact'],
        },
        description: '1-20 risks plotted in the matrix.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'risks'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', size = 5, risks = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_risk_matrix', preview: title });

    try {
      if (!Array.isArray(risks) || risks.length === 0) {
        return { ok: false, error: 'risks array is empty' };
      }
      const n = [3, 4, 5].includes(size) ? size : 5;

      // Risk score = probability × impact. We color cells on a green→red
      // gradient by their normalised score so the visual matches the
      // shared meaning across industries.
      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Heat scale: low (1/16 of max) → high (max). 5 stops.
          heat: ['#10B981', '#84CC16', '#EAB308', '#F97316', '#EF4444'],
          marker: '#0F172A', markerText: '#FFFFFF',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          heat: ['#064E3B', '#365314', '#78350F', '#7C2D12', '#7F1D1D'],
          marker: '#F1F5F9', markerText: '#0F172A',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          heat: ['#F8FAFC', '#E2E8F0', '#CBD5E1', '#94A3B8', '#475569'],
          marker: '#0F172A', markerText: '#FFFFFF',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          heat: ['#0F9D58', '#A5D86C', '#F9AB00', '#E8710A', '#D93025'],
          marker: '#202124', markerText: '#FFFFFF',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const cellSize = 100;
      const axisLabelW = 56;
      const axisLabelH = 36;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const legendH = 56;
      const gridW = cellSize * n;
      const gridH = cellSize * n;
      const W = pad * 2 + axisLabelW + gridW + 200; // extra for risk legend on right
      const H = headerH + pad + gridH + axisLabelH + legendH + pad;

      // Score → heat index: divide score range into the palette length.
      // For size=5: max score = 25; bands of 5 = palette[0..4].
      const maxScore = n * n;
      function heatColor(score) {
        const pct = score / maxScore;
        const idx = Math.min(t.heat.length - 1, Math.floor(pct * t.heat.length));
        return t.heat[idx];
      }
      // For "risk level" badge text
      function riskLevel(score) {
        const pct = score / maxScore;
        if (pct >= 0.7) return 'CRITICAL';
        if (pct >= 0.4) return 'HIGH';
        if (pct >= 0.2) return 'MEDIUM';
        return 'LOW';
      }

      // Header
      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n}×${n} grid · ${risks.length} riesgos</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      const gridX = pad + axisLabelW;
      const gridY = headerH + pad;

      // Heatmap cells
      // Convention: row 0 = highest impact (top), col 0 = lowest probability (left).
      // Score = probability × impact (both 1..n).
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const impact = n - r;
          const probability = c + 1;
          const score = probability * impact;
          const x = gridX + c * cellSize;
          const y = gridY + r * cellSize;
          body += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${heatColor(score)}" stroke="${t.border}" stroke-width="1" opacity="0.92"/>`;
          // Score number in the corner
          body += `<text x="${x + cellSize - 8}" y="${y + 16}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.text}" opacity="0.65">${score}</text>`;
        }
      }

      // X axis labels (probability)
      for (let c = 0; c < n; c++) {
        const x = gridX + c * cellSize + cellSize / 2;
        body += `<text x="${x}" y="${gridY + gridH + 22}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}">${c + 1}</text>`;
      }
      body += `<text x="${gridX + gridW / 2}" y="${gridY + gridH + 36}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}">PROBABILIDAD →</text>`;

      // Y axis labels (impact, top = highest)
      for (let r = 0; r < n; r++) {
        const y = gridY + r * cellSize + cellSize / 2 + 4;
        const impact = n - r;
        body += `<text x="${gridX - 8}" y="${y}" text-anchor="end" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}">${impact}</text>`;
      }
      body += `<text x="${pad + 8}" y="${gridY + gridH / 2}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" transform="rotate(-90, ${pad + 8}, ${gridY + gridH / 2})">↑ IMPACTO</text>`;

      // Plot risks. Multiple risks in the same cell stack vertically.
      const cellOccupants = new Map(); // key: "r,c" → array of risk indices
      const plottedRisks = risks.slice(0, 20).map((risk, idx) => {
        const p = Math.max(1, Math.min(n, Math.round(Number(risk.probability) || 1)));
        const i = Math.max(1, Math.min(n, Math.round(Number(risk.impact) || 1)));
        const c = p - 1;
        const r = n - i;
        const key = `${r},${c}`;
        if (!cellOccupants.has(key)) cellOccupants.set(key, []);
        cellOccupants.get(key).push(idx);
        return { ...risk, _p: p, _i: i, _r: r, _c: c, _score: p * i, _id: idx + 1 };
      });

      plottedRisks.forEach((risk) => {
        const cellOccupantList = cellOccupants.get(`${risk._r},${risk._c}`) || [];
        const subIdx = cellOccupantList.indexOf(risk._id - 1);
        const subTotal = cellOccupantList.length;
        const x = gridX + risk._c * cellSize + 30;
        const stackY = gridY + risk._r * cellSize + 36 + subIdx * 22;
        // Marker circle with number
        body += `<circle cx="${x}" cy="${stackY}" r="11" fill="${t.marker}" stroke="#fff" stroke-width="1.5"/>`;
        body += `<text x="${x}" y="${stackY + 4}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.markerText}">${risk._id}</text>`;
        // (Within-cell overflow is intentionally just clipped — labels live in the legend.)
        if (subTotal > 3 && subIdx === 3) {
          body += `<text x="${x + 16}" y="${stackY + 4}" font-family="Arial" font-size="9" fill="${t.text}">+${subTotal - 3}</text>`;
        }
      });

      // Risk legend on the right
      const legendX = gridX + gridW + 24;
      let lY = gridY + 8;
      body += `<text x="${legendX}" y="${lY}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">RIESGOS</text>`;
      lY += 18;
      plottedRisks.slice(0, 14).forEach((risk) => {
        const label = xmlEscape(String(risk.label || '').slice(0, 32));
        const cat = risk.category ? ` · ${xmlEscape(String(risk.category).slice(0, 14))}` : '';
        const level = riskLevel(risk._score);
        const levelColor = heatColor(risk._score);
        body += `<circle cx="${legendX + 8}" cy="${lY - 4}" r="9" fill="${t.marker}" stroke="#fff" stroke-width="1"/>`;
        body += `<text x="${legendX + 8}" y="${lY - 1}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="bold" fill="${t.markerText}">${risk._id}</text>`;
        body += `<text x="${legendX + 22}" y="${lY}" font-family="Arial" font-size="11" fill="${t.text}">${label}${cat}</text>`;
        body += `<rect x="${legendX + 22}" y="${lY + 4}" width="${level.length * 7 + 8}" height="14" rx="7" fill="${levelColor}"/>`;
        body += `<text x="${legendX + 26 + (level.length * 7) / 2}" y="${lY + 14}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="bold" fill="#fff">${level}</text>`;
        lY += 28;
      });
      if (plottedRisks.length > 14) {
        body += `<text x="${legendX}" y="${lY + 4}" font-family="Arial" font-size="10" fill="${t.muted}" font-style="italic">+ ${plottedRisks.length - 14} más</text>`;
      }

      // Heat legend (bottom strip)
      const heatLegendY = gridY + gridH + axisLabelH + 14;
      const heatLegendW = 320;
      const heatLegendX = gridX;
      const heatBandW = heatLegendW / t.heat.length;
      body += `<text x="${heatLegendX}" y="${heatLegendY - 4}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">NIVEL DE RIESGO</text>`;
      t.heat.forEach((color, idx) => {
        const x = heatLegendX + idx * heatBandW;
        body += `<rect x="${x}" y="${heatLegendY}" width="${heatBandW}" height="14" fill="${color}"/>`;
      });
      body += `<text x="${heatLegendX}" y="${heatLegendY + 30}" font-family="Arial" font-size="10" fill="${t.muted}">bajo</text>`;
      body += `<text x="${heatLegendX + heatLegendW}" y="${heatLegendY + 30}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">crítico</text>`;

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Risk matrix: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `riskmatrix_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const tally = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
      plottedRisks.forEach((r) => { tally[riskLevel(r._score)] += 1; });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_risk_matrix',
        ok: true,
        preview: `Matriz riesgo: ${artifact.filename} (${n}×${n}, ${plottedRisks.length} riesgos · L:${tally.LOW} M:${tally.MEDIUM} H:${tally.HIGH} C:${tally.CRITICAL}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        size: n,
        risks: plottedRisks.length,
        tally,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_risk_matrix', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 19: create_funnel_diagram
// ─────────────────────────────────────────────────────────────────────────

const createFunnelDiagram = {
  name: 'create_funnel_diagram',
  description: 'Generate a conversion funnel diagram as an SVG file: N vertical trapezoidal stages with per-stage count + automatic conversion-rate from previous stage + drop-off indicators on the side. Use for sales pipelines, marketing conversion analyses, onboarding flows, signup funnels, or any sequential filter. Distinct from chartType:funnel (which is a generic chart) — this is a dedicated funnel with stage labels, % conversion, and drop-off arrows.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Funnel title (e.g. "Q2 Signup Funnel").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Stage name (e.g. "Visitors", "Signups", "Activated").' },
            value: { type: 'number', description: 'Count at this stage (e.g. 10000, 500, 50).' },
            description: { type: 'string', description: 'Optional 1-line description.' },
            color: { type: 'string', description: 'Optional hex color override.' },
          },
          required: ['label', 'value'],
        },
        description: '2-8 ordered stages from top (widest) to bottom (narrowest).',
      },
      showConversion: { type: 'boolean', description: 'Show per-stage conversion-from-previous %. Default: true.' },
      showDropoff: { type: 'boolean', description: 'Show drop-off arrows + absolute losses on the right. Default: true.' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'stages'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', stages = [], showConversion = true, showDropoff = true, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_funnel_diagram', preview: title });

    try {
      if (!Array.isArray(stages) || stages.length === 0) {
        return { ok: false, error: 'stages array is empty' };
      }
      if (stages.length < 2) {
        return { ok: false, error: 'funnel requires at least 2 stages' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Stage colors transition from cool top (lots of traffic) to warm bottom (precious conversions)
          palette: ['#3B82F6', '#06B6D4', '#10B981', '#84CC16', '#EAB308', '#F59E0B', '#F97316', '#EF4444'],
          dropoff: '#94A3B8', conversion: '#10B981',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          palette: ['#60A5FA', '#22D3EE', '#34D399', '#A3E635', '#FBBF24', '#FB923C', '#F87171', '#F472B6'],
          dropoff: '#94A3B8', conversion: '#34D399',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          palette: ['#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'],
          dropoff: '#94A3B8', conversion: '#10B981',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          palette: ['#1A73E8', '#039BE5', '#0F9D58', '#A5D86C', '#F9AB00', '#E8710A', '#D93025', '#9C27B0'],
          dropoff: '#5F6368', conversion: '#0F9D58',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const stageList = stages.slice(0, 8);
      const n = stageList.length;

      // Validate values: use Math.max with 0 to avoid negative widths
      const values = stageList.map(s => Math.max(0, Number(s.value) || 0));
      const topValue = values[0] || 1;
      // Stage widths are linear with value/topValue. Cap min width so labels
      // remain readable even when the bottom stage is tiny.
      const maxStageW = 520;
      const minStageW = 110;
      function stageWidth(value) {
        const pct = value / topValue;
        return Math.max(minStageW, maxStageW * pct);
      }

      const stageH = 76;
      const stageGap = 8;
      const sideAnnotationW = 200;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const W = pad * 2 + maxStageW + (showDropoff ? sideAnnotationW : 0);
      const H = headerH + pad + n * (stageH + stageGap) + pad + 20;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const totalConversion = topValue > 0 ? ((values[n - 1] / topValue) * 100).toFixed(1) : '0.0';
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n} etapas · ${totalConversion}% end-to-end</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      const cx = pad + maxStageW / 2;
      const baseY = headerH + pad;

      // Format large numbers with separators (e.g. 10,000)
      function fmtNum(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
        if (n >= 1000) return `${Math.round(n).toLocaleString('en-US')}`;
        return String(Math.round(n));
      }

      stageList.forEach((stage, i) => {
        const value = values[i];
        const sy = baseY + i * (stageH + stageGap);
        const topW = stageWidth(value);
        const nextValue = i + 1 < n ? values[i + 1] : value;
        const botW = stageWidth(nextValue);
        // Stage as trapezoid (top wider than bottom)
        const xTopL = cx - topW / 2;
        const xTopR = cx + topW / 2;
        const xBotL = cx - botW / 2;
        const xBotR = cx + botW / 2;
        const color = stage.color && /^#[0-9A-Fa-f]{6}$/.test(stage.color)
          ? stage.color
          : t.palette[i % t.palette.length];

        body += `<path d="M ${xTopL} ${sy} L ${xTopR} ${sy} L ${xBotR} ${sy + stageH} L ${xBotL} ${sy + stageH} Z" fill="${color}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;

        // Label (centred)
        const safeLabel = xmlEscape(String(stage.label || '').slice(0, 30));
        body += `<text x="${cx}" y="${sy + stageH / 2 - 4}" text-anchor="middle" font-family="Arial" font-size="15" font-weight="bold" fill="#fff">${safeLabel}</text>`;
        // Count
        body += `<text x="${cx}" y="${sy + stageH / 2 + 16}" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.95">${fmtNum(value)}</text>`;
        // Optional description
        if (stage.description) {
          const safeDesc = xmlEscape(String(stage.description).slice(0, 60));
          body += `<text x="${cx}" y="${sy + stageH - 8}" text-anchor="middle" font-family="Arial" font-size="10" fill="#fff" opacity="0.85">${safeDesc}</text>`;
        }

        // Conversion-from-previous on the left
        if (showConversion && i > 0) {
          const prevValue = values[i - 1] || 1;
          const conversionPct = prevValue > 0 ? (value / prevValue) * 100 : 0;
          const convLabel = `${conversionPct.toFixed(1)}%`;
          // Pill above the stage's top edge, on the left
          const pillX = pad + 6;
          const pillY = sy - 12;
          body += `<rect x="${pillX}" y="${pillY}" width="68" height="22" rx="11" fill="${t.conversion}" stroke="${t.bg}" stroke-width="1.5"/>`;
          body += `<text x="${pillX + 34}" y="${pillY + 15}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${convLabel}</text>`;
        }

        // Drop-off on the right
        if (showDropoff && i > 0) {
          const prevValue = values[i - 1] || 0;
          const dropAbs = Math.max(0, prevValue - value);
          const dropPct = prevValue > 0 ? (dropAbs / prevValue) * 100 : 0;
          const aX = pad + maxStageW + 14;
          // Drop-off marker — only render when there's actual drop
          if (dropAbs > 0) {
            body += `<text x="${aX}" y="${sy + 14}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.dropoff}">↓ ${fmtNum(dropAbs)}</text>`;
            body += `<text x="${aX}" y="${sy + 30}" font-family="Arial" font-size="10" fill="${t.muted}">−${dropPct.toFixed(1)}%</text>`;
          } else {
            body += `<text x="${aX}" y="${sy + 14}" font-family="Arial" font-size="11" fill="${t.muted}">—</text>`;
          }
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Conversion funnel: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `funnel_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_funnel_diagram',
        ok: true,
        preview: `Embudo listo: ${artifact.filename} (${n} etapas, conversión total ${totalConversion}%, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        stages: n,
        topValue,
        endValue: values[n - 1],
        totalConversionPct: Number(totalConversion),
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_funnel_diagram', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 20: create_value_proposition_canvas
// ─────────────────────────────────────────────────────────────────────────

const createValuePropositionCanvas = {
  name: 'create_value_proposition_canvas',
  description: "Generate Strategyzer's Value Proposition Canvas as an SVG file: a circular Customer Profile (Customer Jobs / Pains / Gains) on the left + a square Value Map (Products & Services / Pain Relievers / Gain Creators) on the right. Use for product-market-fit work, persona-to-product mapping, value design, or any complement to a Business Model Canvas. Each of the 6 sub-sections accepts 1-6 bullet items.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Canvas title (e.g. "SiraGPT VPC — SMB segment").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. segment, period).' },
      // Customer Profile (circle, left)
      customerJobs:     { type: 'array', items: { type: 'string' }, description: 'Functional/social/emotional tasks the customer is trying to get done (1-6 items).' },
      pains:            { type: 'array', items: { type: 'string' }, description: 'Bad outcomes, risks, obstacles BEFORE/DURING/AFTER the job (1-6 items).' },
      gains:            { type: 'array', items: { type: 'string' }, description: 'Desired outcomes, benefits, aspirations (1-6 items).' },
      // Value Map (square, right)
      productsServices: { type: 'array', items: { type: 'string' }, description: 'List of products / services that make up your value proposition (1-6 items).' },
      painRelievers:    { type: 'array', items: { type: 'string' }, description: 'How your products kill specific customer pains (1-6 items).' },
      gainCreators:     { type: 'array', items: { type: 'string' }, description: 'How your products create specific customer gains (1-6 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    customerJobs = [],
    pains = [],
    gains = [],
    productsServices = [],
    painRelievers = [],
    gainCreators = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_value_proposition_canvas', preview: title });

    try {
      const allSections = [customerJobs, pains, gains, productsServices, painRelievers, gainCreators];
      if (!allSections.every(s => Array.isArray(s))) {
        return { ok: false, error: 'all 6 section inputs must be arrays of strings' };
      }
      const totalItems = allSections.reduce((s, sec) => s + sec.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 6 sections are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          customerSide:  '#0EA5E9', // sky — outside-in
          valueSide:     '#10B981', // emerald — inside-out
          jobs:    '#3B82F6', pains: '#EF4444', gains: '#10B981',
          products:'#0EA5E9', painR: '#F59E0B', gainC: '#84CC16',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          customerSide: '#38BDF8', valueSide: '#34D399',
          jobs: '#60A5FA', pains: '#F87171', gains: '#34D399',
          products: '#38BDF8', painR: '#FBBF24', gainC: '#A3E635',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          customerSide: '#0F172A', valueSide: '#0F172A',
          jobs: '#0F172A', pains: '#0F172A', gains: '#0F172A',
          products: '#0F172A', painR: '#0F172A', gainC: '#0F172A',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          customerSide: '#039BE5', valueSide: '#0F9D58',
          jobs: '#1A73E8', pains: '#D93025', gains: '#0F9D58',
          products: '#039BE5', painR: '#F9AB00', gainC: '#A5D86C',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      const sideGap = 36;
      const sideW = 380;
      // sideH sized so each of the 3 sub-sections has ~155 px after
      // the header band — enough to fit 6 bullet items at 18px spacing
      // (header 38px + 6 × 18 = 146 < 155 budget).
      const sideH = 525;
      const W = pad * 2 + sideW * 2 + sideGap;
      const H = headerH + pad + sideH + 60 + pad;
      const lineMaxChars = 36;

      function fmt(items) {
        return (items || []).slice(0, 6).map(s => xmlEscape(String(s || '').slice(0, lineMaxChars))).filter(Boolean);
      }
      const blocks = {
        jobs:     fmt(customerJobs),
        pains:    fmt(pains),
        gains:    fmt(gains),
        products: fmt(productsServices),
        painR:    fmt(painRelievers),
        gainC:    fmt(gainCreators),
      };

      // Header
      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalItems} ítems · 6 secciones</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Side labels (FIT badge bridge between the two halves)
      const sideY = headerH + pad;
      const leftCx = pad + sideW / 2;
      const rightCx = pad + sideW + sideGap + sideW / 2;

      // Connecting "FIT" arrow between halves
      const fitY = sideY + 24;
      body += `<line x1="${pad + sideW + 8}" y1="${fitY}" x2="${pad + sideW + sideGap - 8}" y2="${fitY}" stroke="${t.muted}" stroke-width="2" stroke-dasharray="4,4" opacity="0.5"/>`;
      body += `<rect x="${pad + sideW - 4}" y="${fitY - 14}" width="${sideGap + 8}" height="28" rx="14" fill="${t.accent}"/>`;
      body += `<text x="${(pad + sideW) + sideGap / 2}" y="${fitY + 5}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#fff">FIT ⇄</text>`;

      // ── LEFT: Customer Profile (rounded square that hosts a circle motif) ──
      // We draw a CARD with a circular accent to honour the canonical
      // VPC visual without sacrificing readability inside actual segments.
      body += `<rect x="${pad}" y="${sideY}" width="${sideW}" height="${sideH}" rx="${sideW / 2}" fill="${t.card}" stroke="${t.customerSide}" stroke-width="2" filter="url(#vis-shadow)"/>`;
      body += `<text x="${leftCx}" y="${sideY + 28}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.customerSide}">CUSTOMER PROFILE</text>`;
      body += `<text x="${leftCx}" y="${sideY + 46}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}">outside-in</text>`;

      // ── RIGHT: Value Map (square) ──
      body += `<rect x="${pad + sideW + sideGap}" y="${sideY}" width="${sideW}" height="${sideH}" rx="14" fill="${t.card}" stroke="${t.valueSide}" stroke-width="2" filter="url(#vis-shadow)"/>`;
      body += `<text x="${rightCx}" y="${sideY + 28}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.valueSide}">VALUE MAP</text>`;
      body += `<text x="${rightCx}" y="${sideY + 46}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}">inside-out</text>`;

      // Each side has 3 sub-sections stacked vertically.
      // Sub-section rendering
      function drawSubSection({ x, y, w, h, label, items, color }) {
        let out = '';
        out += `<line x1="${x + 16}" y1="${y}" x2="${x + w - 16}" y2="${y}" stroke="${t.border}" stroke-width="1"/>`;
        out += `<rect x="${x + 16}" y="${y + 8}" width="${(label.length * 7) + 22}" height="22" rx="11" fill="${color}"/>`;
        out += `<text x="${x + 27}" y="${y + 23}" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${xmlEscape(label)}</text>`;
        out += `<text x="${x + w - 22}" y="${y + 23}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${items.length}</text>`;
        const inner = items.slice(0, 6);
        if (inner.length === 0) {
          out += `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" font-style="italic">— vacío —</text>`;
        } else {
          inner.forEach((line, idx) => {
            const ly = y + 46 + idx * 18;
            if (ly > y + h - 10) return;
            out += `<circle cx="${x + 22}" cy="${ly - 4}" r="2.5" fill="${color}"/>`;
            out += `<text x="${x + 30}" y="${ly}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      const subStart = sideY + 60;
      const subH = (sideH - 60 - 8) / 3;
      // LEFT side: Jobs (top), Pains, Gains
      body += drawSubSection({ x: pad,        y: subStart,             w: sideW, h: subH, label: 'Customer Jobs', items: blocks.jobs,  color: t.jobs });
      body += drawSubSection({ x: pad,        y: subStart + subH,      w: sideW, h: subH, label: 'Pains',          items: blocks.pains, color: t.pains });
      body += drawSubSection({ x: pad,        y: subStart + subH * 2,  w: sideW, h: subH, label: 'Gains',          items: blocks.gains, color: t.gains });
      // RIGHT side: Products & Services (top), Pain Relievers, Gain Creators
      body += drawSubSection({ x: pad + sideW + sideGap, y: subStart,             w: sideW, h: subH, label: 'Products & Services', items: blocks.products, color: t.products });
      body += drawSubSection({ x: pad + sideW + sideGap, y: subStart + subH,      w: sideW, h: subH, label: 'Pain Relievers',      items: blocks.painR,    color: t.painR });
      body += drawSubSection({ x: pad + sideW + sideGap, y: subStart + subH * 2,  w: sideW, h: subH, label: 'Gain Creators',       items: blocks.gainC,    color: t.gainC });

      // Bottom: legend / fit-guidance
      const legendY = sideY + sideH + 14;
      body += `<text x="${pad}" y="${legendY + 14}" font-family="Arial" font-size="11" fill="${t.muted}">PROBLEM ← CUSTOMER PROFILE describes who you serve · VALUE MAP describes how you serve them → SOLUTION</text>`;

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Value Proposition Canvas: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `vpc_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        customerJobs: blocks.jobs.length,
        pains: blocks.pains.length,
        gains: blocks.gains.length,
        productsServices: blocks.products.length,
        painRelievers: blocks.painR.length,
        gainCreators: blocks.gainC.length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_value_proposition_canvas',
        ok: true,
        preview: `VPC listo: ${artifact.filename} (${totalItems} ítems · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_value_proposition_canvas', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 21: create_pestel_analysis
// ─────────────────────────────────────────────────────────────────────────

const createPestelAnalysis = {
  name: 'create_pestel_analysis',
  description: 'Generate a PESTEL macro-environmental analysis as an SVG file: 6 sections (Political, Economic, Social, Technological, Environmental, Legal) laid out in a 3×2 grid. Use for strategic external scans, market entry analyses, regulatory landscape reviews, or any macro-environmental sweep. Each section accepts 1-6 bullet items.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Analysis title (e.g. "LATAM AI market — PESTEL").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. region, period).' },
      political:      { type: 'array', items: { type: 'string' }, description: 'Government policies, political stability, tax, trade restrictions (1-6 items).' },
      economic:       { type: 'array', items: { type: 'string' }, description: 'GDP, inflation, interest rates, exchange rates, growth trends (1-6 items).' },
      social:         { type: 'array', items: { type: 'string' }, description: 'Demographics, culture, lifestyles, education, social trends (1-6 items).' },
      technological:  { type: 'array', items: { type: 'string' }, description: 'Innovation rate, automation, R&D, tech adoption (1-6 items).' },
      environmental:  { type: 'array', items: { type: 'string' }, description: 'Climate, sustainability, ESG pressure, resource scarcity (1-6 items).' },
      legal:          { type: 'array', items: { type: 'string' }, description: 'Regulations, employment law, consumer protection, IP (1-6 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    political = [],
    economic = [],
    social = [],
    technological = [],
    environmental = [],
    legal = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_pestel_analysis', preview: title });

    try {
      const allSections = [political, economic, social, technological, environmental, legal];
      if (!allSections.every(s => Array.isArray(s))) {
        return { ok: false, error: 'all 6 section inputs must be arrays of strings' };
      }
      const totalItems = allSections.reduce((s, sec) => s + sec.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 6 sections are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Each PESTEL dimension has a recognised colour family in strategy decks
          P: { bar: '#DC2626', fill: '#FEE2E2', label: '#7F1D1D', letter: 'P' }, // Political — red
          E: { bar: '#F59E0B', fill: '#FEF3C7', label: '#78350F', letter: 'E' }, // Economic — amber
          S: { bar: '#8B5CF6', fill: '#EDE9FE', label: '#4C1D95', letter: 'S' }, // Social — violet
          T: { bar: '#2563EB', fill: '#DBEAFE', label: '#1E3A8A', letter: 'T' }, // Technological — blue
          V: { bar: '#10B981', fill: '#ECFDF5', label: '#065F46', letter: 'E' }, // Environmental — green (V to avoid duplicate key)
          L: { bar: '#64748B', fill: '#F1F5F9', label: '#334155', letter: 'L' }, // Legal — slate
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          P: { bar: '#F87171', fill: '#7F1D1D', label: '#FECACA', letter: 'P' },
          E: { bar: '#FBBF24', fill: '#78350F', label: '#FDE68A', letter: 'E' },
          S: { bar: '#A78BFA', fill: '#4C1D95', label: '#DDD6FE', letter: 'S' },
          T: { bar: '#60A5FA', fill: '#1E3A8A', label: '#BFDBFE', letter: 'T' },
          V: { bar: '#34D399', fill: '#064E3B', label: '#A7F3D0', letter: 'E' },
          L: { bar: '#94A3B8', fill: '#334155', label: '#E2E8F0', letter: 'L' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          P: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'P' },
          E: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'E' },
          S: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'S' },
          T: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'T' },
          V: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'E' },
          L: { bar: '#0F172A', fill: '#F8FAFC', label: '#0F172A', letter: 'L' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          P: { bar: '#D93025', fill: '#FCE8E6', label: '#7C1D14', letter: 'P' },
          E: { bar: '#F9AB00', fill: '#FFF8E1', label: '#7C4A00', letter: 'E' },
          S: { bar: '#673AB7', fill: '#F3E8FD', label: '#3A1A6E', letter: 'S' },
          T: { bar: '#1A73E8', fill: '#E8F0FE', label: '#0B3D91', letter: 'T' },
          V: { bar: '#0F9D58', fill: '#E6F4EA', label: '#1B5E20', letter: 'E' },
          L: { bar: '#5F6368', fill: '#F1F3F4', label: '#202124', letter: 'L' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const cellW = 280;
      const cellH = 240;
      const gap = 12;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const W = pad * 2 + cellW * 3 + gap * 2;
      const H = headerH + pad + cellH * 2 + gap + pad;
      const lineMaxChars = 36;

      function fmt(items) {
        return (items || []).slice(0, 6).map(s => xmlEscape(String(s || '').slice(0, lineMaxChars))).filter(Boolean);
      }

      const SECTIONS = [
        { key: 'P', pal: t.P, fullName: 'POLITICAL',      items: fmt(political),     col: 0, row: 0 },
        { key: 'E', pal: t.E, fullName: 'ECONOMIC',       items: fmt(economic),      col: 1, row: 0 },
        { key: 'S', pal: t.S, fullName: 'SOCIAL',         items: fmt(social),        col: 2, row: 0 },
        { key: 'T', pal: t.T, fullName: 'TECHNOLOGICAL', items: fmt(technological), col: 0, row: 1 },
        { key: 'V', pal: t.V, fullName: 'ENVIRONMENTAL', items: fmt(environmental), col: 1, row: 1 },
        { key: 'L', pal: t.L, fullName: 'LEGAL',          items: fmt(legal),         col: 2, row: 1 },
      ];

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalItems} ítems · PESTEL 6 dimensiones</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      const topY = headerH + pad;
      SECTIONS.forEach((section) => {
        const x = pad + section.col * (cellW + gap);
        const y = topY + section.row * (cellH + gap);
        // Card
        body += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="10" fill="${section.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        body += `<rect x="${x}" y="${y}" width="6" height="${cellH}" rx="3" fill="${section.pal.bar}"/>`;
        // Letter badge (big)
        body += `<circle cx="${x + 36}" cy="${y + 36}" r="18" fill="${section.pal.bar}"/>`;
        body += `<text x="${x + 36}" y="${y + 43}" text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#fff">${xmlEscape(section.pal.letter)}</text>`;
        // Full name
        body += `<text x="${x + 64}" y="${y + 30}" font-family="Arial" font-size="13" font-weight="bold" fill="${section.pal.label}">${xmlEscape(section.fullName)}</text>`;
        body += `<text x="${x + 64}" y="${y + 48}" font-family="Arial" font-size="11" fill="${t.muted}">${section.items.length} factor${section.items.length === 1 ? '' : 'es'}</text>`;
        // Separator
        body += `<line x1="${x + 16}" y1="${y + 66}" x2="${x + cellW - 16}" y2="${y + 66}" stroke="${t.border}" stroke-width="1"/>`;
        // Items
        if (section.items.length === 0) {
          body += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 20}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin elementos —</text>`;
        } else {
          section.items.slice(0, 6).forEach((line, idx) => {
            const ly = y + 88 + idx * 22;
            body += `<circle cx="${x + 22}" cy="${ly - 4}" r="2.5" fill="${section.pal.bar}"/>`;
            body += `<text x="${x + 30}" y="${ly}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
          });
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `PESTEL analysis: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `pestel_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        political: SECTIONS[0].items.length,
        economic: SECTIONS[1].items.length,
        social: SECTIONS[2].items.length,
        technological: SECTIONS[3].items.length,
        environmental: SECTIONS[4].items.length,
        legal: SECTIONS[5].items.length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_pestel_analysis',
        ok: true,
        preview: `PESTEL listo: ${artifact.filename} (${totalItems} factores · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_pestel_analysis', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 22: create_radar_chart
// ─────────────────────────────────────────────────────────────────────────

const createRadarChart = {
  name: 'create_radar_chart',
  description: 'Generate a radar (spider) chart as an SVG file: N axes (3-8) radiating from a centre point, with one or more data series plotted as semi-transparent polygons over the grid. Use for vendor/competitor benchmarking, skill matrices, performance reviews, feature scorecards, or any N-dimensional comparison. Distinct from the create_chart subtypes — this is a dedicated radar with multi-series support.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Chart title (e.g. "Vendor scorecard").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      axes: { type: 'array', items: { type: 'string' }, description: '3-8 axis labels (e.g. ["Price", "Support", "API", "Docs", "Uptime"]).' },
      series: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:   { type: 'string', description: 'Series name.' },
            values: { type: 'array', items: { type: 'number' }, description: 'One value per axis (in the same order as axes). 0..max.' },
            color:  { type: 'string', description: 'Optional hex color override.' },
          },
          required: ['name', 'values'],
        },
        description: '1-4 data series.',
      },
      max: { type: 'number', description: 'Max scale value (axes go 0..max). Default: auto from data.' },
      rings: { type: 'integer', minimum: 2, maximum: 8, description: 'Number of concentric grid rings. Default: 5.' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'axes', 'series'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', axes = [], series = [], max, rings = 5, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_radar_chart', preview: title });

    try {
      if (!Array.isArray(axes) || axes.length < 3) {
        return { ok: false, error: 'radar chart requires at least 3 axes' };
      }
      if (axes.length > 8) {
        return { ok: false, error: 'radar chart supports at most 8 axes' };
      }
      if (!Array.isArray(series) || series.length === 0) {
        return { ok: false, error: 'series array is empty' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          grid: '#E2E8F0', axis: '#94A3B8',
          palette: ['#2563EB', '#10B981', '#F59E0B', '#EF4444'],
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          grid: '#334155', axis: '#64748B',
          palette: ['#60A5FA', '#34D399', '#FBBF24', '#F87171'],
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          grid: '#E2E8F0', axis: '#94A3B8',
          palette: ['#0F172A', '#475569', '#94A3B8', '#CBD5E1'],
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          grid: '#CBD5E1', axis: '#5F6368',
          palette: ['#1A73E8', '#0F9D58', '#F9AB00', '#D93025'],
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const axisLabels = axes.slice(0, 8).map(a => xmlEscape(String(a || '').slice(0, 24)));
      const n = axisLabels.length;
      const seriesList = series.slice(0, 4);
      const ringCount = Math.max(2, Math.min(8, Math.round(Number(rings) || 5)));

      // Auto-detect max if not provided
      let dataMax = 0;
      seriesList.forEach(s => {
        if (Array.isArray(s.values)) {
          s.values.forEach(v => {
            const num = Number(v);
            if (Number.isFinite(num) && num > dataMax) dataMax = num;
          });
        }
      });
      const scaleMax = Number.isFinite(Number(max)) && Number(max) > 0
        ? Number(max)
        : (dataMax > 0 ? dataMax : 1);

      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      const legendH = 32 + seriesList.length * 22;
      const radius = 200;
      const plotSize = radius * 2 + 100; // extra for axis labels
      const W = pad * 2 + plotSize + 240; // extra for legend
      const H = headerH + pad + plotSize + legendH + pad;

      const cx = pad + plotSize / 2;
      const cy = headerH + pad + plotSize / 2;

      // Axis angles. Start from top (-90°) and go clockwise.
      function axisAngle(i) {
        return (-Math.PI / 2) + (2 * Math.PI * i) / n;
      }
      function pointOnAxis(i, magnitude /* 0..1 */) {
        const ang = axisAngle(i);
        return {
          x: cx + Math.cos(ang) * radius * magnitude,
          y: cy + Math.sin(ang) * radius * magnitude,
        };
      }

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n} ejes · ${seriesList.length} serie${seriesList.length === 1 ? '' : 's'} · max ${scaleMax}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Concentric grid rings (polygonal — matches the axes count)
      for (let r = 1; r <= ringCount; r++) {
        const mag = r / ringCount;
        const points = [];
        for (let i = 0; i < n; i++) {
          const p = pointOnAxis(i, mag);
          points.push(`${p.x},${p.y}`);
        }
        body += `<polygon points="${points.join(' ')}" fill="none" stroke="${t.grid}" stroke-width="1" opacity="${0.5 + (r / ringCount) * 0.25}"/>`;
        // Tick label on the right-pointing axis (axis 0 may be top — pick a representative axis for ring labels)
        // Use the topmost axis at index 0
        if (r === ringCount || r === Math.ceil(ringCount / 2)) {
          const tickValue = (scaleMax * mag).toFixed(scaleMax >= 10 ? 0 : 1);
          const tickPoint = pointOnAxis(0, mag);
          body += `<text x="${tickPoint.x + 4}" y="${tickPoint.y + 3}" font-family="Arial" font-size="9" fill="${t.muted}">${tickValue}</text>`;
        }
      }

      // Axes
      for (let i = 0; i < n; i++) {
        const p = pointOnAxis(i, 1);
        body += `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="${t.axis}" stroke-width="1.5"/>`;
        // Axis label outside the polygon
        const labelP = pointOnAxis(i, 1.18);
        // text-anchor based on position
        let anchor = 'middle';
        if (labelP.x < cx - 10) anchor = 'end';
        else if (labelP.x > cx + 10) anchor = 'start';
        body += `<text x="${labelP.x}" y="${labelP.y + 4}" text-anchor="${anchor}" font-family="Arial" font-size="12" font-weight="bold" fill="${t.text}">${axisLabels[i]}</text>`;
      }

      // Series polygons (back to front, semi-transparent fills)
      seriesList.forEach((s, sIdx) => {
        const color = s.color && /^#[0-9A-Fa-f]{6}$/.test(s.color)
          ? s.color
          : t.palette[sIdx % t.palette.length];
        const vals = Array.isArray(s.values) ? s.values : [];
        const points = [];
        const dots = [];
        for (let i = 0; i < n; i++) {
          const raw = Number(vals[i]);
          const v = Number.isFinite(raw) ? Math.max(0, raw) : 0;
          const mag = scaleMax > 0 ? Math.min(1, v / scaleMax) : 0;
          const p = pointOnAxis(i, mag);
          points.push(`${p.x},${p.y}`);
          dots.push({ x: p.x, y: p.y, v });
        }
        body += `<polygon points="${points.join(' ')}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2.5"/>`;
        dots.forEach(d => {
          body += `<circle cx="${d.x}" cy="${d.y}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
        });
      });

      // Legend (right side)
      const legendX = cx + radius + 60;
      let lY = cy - radius;
      body += `<text x="${legendX}" y="${lY}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">SERIES</text>`;
      lY += 18;
      seriesList.forEach((s, sIdx) => {
        const color = s.color && /^#[0-9A-Fa-f]{6}$/.test(s.color)
          ? s.color
          : t.palette[sIdx % t.palette.length];
        const safeName = xmlEscape(String(s.name || `Serie ${sIdx + 1}`).slice(0, 32));
        body += `<rect x="${legendX}" y="${lY - 10}" width="14" height="14" rx="3" fill="${color}" fill-opacity="0.6" stroke="${color}" stroke-width="1.5"/>`;
        body += `<text x="${legendX + 22}" y="${lY}" font-family="Arial" font-size="12" fill="${t.text}">${safeName}</text>`;
        // Sum the values to show a tiny "total"
        const sum = (Array.isArray(s.values) ? s.values : [])
          .map(v => Number(v))
          .filter(Number.isFinite)
          .reduce((acc, v) => acc + v, 0);
        const avg = (s.values && s.values.length) ? (sum / s.values.length) : 0;
        body += `<text x="${legendX + 22}" y="${lY + 14}" font-family="Arial" font-size="10" fill="${t.muted}">avg ${avg.toFixed(1)}</text>`;
        lY += 36;
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Radar chart: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `radar_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_radar_chart',
        ok: true,
        preview: `Radar listo: ${artifact.filename} (${n} ejes, ${seriesList.length} series, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        axes: n,
        series: seriesList.length,
        max: scaleMax,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_radar_chart', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 23: create_user_journey_map
// ─────────────────────────────────────────────────────────────────────────

const createUserJourneyMap = {
  name: 'create_user_journey_map',
  description: 'Generate a customer/user journey map as an SVG file: N stages (columns) × multiple lanes (Touchpoints, Actions, Thoughts, Pain Points, Opportunities) plus an emotion curve plotted at the top connecting per-stage emotion scores (1-5). Use for UX research, customer-experience reviews, onboarding redesigns, or service-blueprint sketches.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Journey title (e.g. "First-time buyer journey").' },
      subtitle: { type: 'string', description: 'Optional persona / context line.' },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:          { type: 'string', description: 'Stage label (e.g. "Awareness", "Onboarding", "Activation").' },
            touchpoints:   { type: 'array', items: { type: 'string' }, description: 'Channels / surfaces the user encounters in this stage.' },
            actions:       { type: 'array', items: { type: 'string' }, description: 'What the user actively does in this stage.' },
            thoughts:      { type: 'array', items: { type: 'string' }, description: 'Internal monologue / questions / doubts.' },
            painPoints:    { type: 'array', items: { type: 'string' }, description: 'Frustrations / blockers in this stage.' },
            opportunities: { type: 'array', items: { type: 'string' }, description: 'Improvement opportunities for the team.' },
            emotion:       { type: 'number', minimum: 1, maximum: 5, description: 'Emotion score 1 (very sad) to 5 (delighted). Plotted on the top curve.' },
          },
          required: ['name'],
        },
        description: '3-8 ordered stages.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'stages'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', stages = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_user_journey_map', preview: title });

    try {
      if (!Array.isArray(stages) || stages.length === 0) {
        return { ok: false, error: 'stages array is empty' };
      }
      if (stages.length < 2) {
        return { ok: false, error: 'journey map requires at least 2 stages' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          touchpoints: '#0EA5E9', actions: '#10B981', thoughts: '#8B5CF6', painPoints: '#EF4444', opportunities: '#F59E0B',
          emotionCurve: '#2563EB', emotionGrid: '#E2E8F0',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          touchpoints: '#38BDF8', actions: '#34D399', thoughts: '#A78BFA', painPoints: '#F87171', opportunities: '#FBBF24',
          emotionCurve: '#818CF8', emotionGrid: '#334155',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          touchpoints: '#0F172A', actions: '#475569', thoughts: '#94A3B8', painPoints: '#0F172A', opportunities: '#475569',
          emotionCurve: '#0F172A', emotionGrid: '#E2E8F0',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          touchpoints: '#039BE5', actions: '#0F9D58', thoughts: '#673AB7', painPoints: '#D93025', opportunities: '#F9AB00',
          emotionCurve: '#1A73E8', emotionGrid: '#CBD5E1',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const stageList = stages.slice(0, 8);
      const n = stageList.length;
      const lineMaxChars = 28;

      function fmtList(items) {
        return (Array.isArray(items) ? items : []).slice(0, 5)
          .map(s => xmlEscape(String(s || '').slice(0, lineMaxChars)))
          .filter(Boolean);
      }

      const stageData = stageList.map((s, i) => ({
        name:          xmlEscape(String(s.name || `Stage ${i + 1}`).slice(0, 32)),
        touchpoints:   fmtList(s.touchpoints),
        actions:       fmtList(s.actions),
        thoughts:      fmtList(s.thoughts),
        painPoints:    fmtList(s.painPoints),
        opportunities: fmtList(s.opportunities),
        emotion:       Math.max(1, Math.min(5, Number(s.emotion) || 3)),
      }));

      const LANES = [
        { key: 'touchpoints',   label: 'TOUCHPOINTS',    color: t.touchpoints },
        { key: 'actions',       label: 'USER ACTIONS',   color: t.actions },
        { key: 'thoughts',      label: 'THOUGHTS',       color: t.thoughts },
        { key: 'painPoints',    label: 'PAIN POINTS',    color: t.painPoints },
        { key: 'opportunities', label: 'OPPORTUNITIES',  color: t.opportunities },
      ];

      const stageColW = 220;
      const laneLabelW = 130;
      const laneH = 130;
      const emotionH = 130;
      const pad = 24;
      const headerH = safeSubtitle ? 110 : 86;
      const stageBandH = 50;
      const W = pad * 2 + laneLabelW + stageColW * n;
      const H = headerH + pad + emotionH + stageBandH + laneH * LANES.length + pad + 20;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n} etapas · journey map</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // ── Emotion curve ──
      const emoY = headerH + pad;
      // 5 horizontal grid lines (1..5)
      for (let lvl = 1; lvl <= 5; lvl++) {
        const y = emoY + emotionH - ((lvl - 1) / 4) * (emotionH - 20) - 10;
        body += `<line x1="${pad + laneLabelW}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="${t.emotionGrid}" stroke-width="${lvl === 3 ? 1 : 0.5}" stroke-dasharray="${lvl === 3 ? '4,4' : ''}"/>`;
      }
      body += `<text x="${pad + 8}" y="${emoY + 20}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">EMOCIÓN</text>`;
      // Emotion-axis emoji legend
      body += `<text x="${pad + 8}" y="${emoY + 36}" font-family="Arial" font-size="14">😀</text>`;
      body += `<text x="${pad + 8}" y="${emoY + emotionH - 10}" font-family="Arial" font-size="14">😞</text>`;

      // Emotion curve through stage emotions
      const emotionPoints = stageData.map((s, i) => {
        const x = pad + laneLabelW + (i + 0.5) * stageColW;
        const y = emoY + emotionH - ((s.emotion - 1) / 4) * (emotionH - 20) - 10;
        return { x, y };
      });
      if (emotionPoints.length >= 2) {
        const pathParts = emotionPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`);
        body += `<path d="${pathParts.join(' ')}" fill="none" stroke="${t.emotionCurve}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      emotionPoints.forEach((p, i) => {
        const emoji = stageData[i].emotion >= 4 ? '😀' : (stageData[i].emotion >= 3 ? '🙂' : (stageData[i].emotion >= 2 ? '😕' : '😞'));
        body += `<circle cx="${p.x}" cy="${p.y}" r="14" fill="${t.card}" stroke="${t.emotionCurve}" stroke-width="2"/>`;
        body += `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-family="Arial" font-size="14">${emoji}</text>`;
      });

      // ── Stage band ──
      const stageY = emoY + emotionH;
      body += `<rect x="${pad + laneLabelW}" y="${stageY}" width="${stageColW * n}" height="${stageBandH}" fill="${t.accent}" opacity="0.92"/>`;
      stageData.forEach((s, i) => {
        const sx = pad + laneLabelW + i * stageColW;
        body += `<line x1="${sx}" y1="${stageY}" x2="${sx}" y2="${stageY + stageBandH}" stroke="#fff" stroke-width="1" opacity="0.4"/>`;
        body += `<text x="${sx + stageColW / 2}" y="${stageY + 22}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="#fff">${s.name}</text>`;
        body += `<text x="${sx + stageColW / 2}" y="${stageY + 38}" text-anchor="middle" font-family="Arial" font-size="10" fill="#fff" opacity="0.8">stage ${i + 1}</text>`;
      });

      // ── Lanes ──
      const laneStartY = stageY + stageBandH;
      LANES.forEach((lane, lIdx) => {
        const ly = laneStartY + lIdx * laneH;
        const isAlt = lIdx % 2 === 1;
        // Lane label cell
        body += `<rect x="${pad}" y="${ly}" width="${laneLabelW}" height="${laneH}" fill="${lane.color}" opacity="0.15" stroke="${t.border}" stroke-width="0.5"/>`;
        body += `<rect x="${pad}" y="${ly}" width="6" height="${laneH}" fill="${lane.color}"/>`;
        body += `<text x="${pad + 16}" y="${ly + laneH / 2 - 4}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">${xmlEscape(lane.label)}</text>`;

        // Each stage column for this lane
        stageData.forEach((stage, sIdx) => {
          const sx = pad + laneLabelW + sIdx * stageColW;
          body += `<rect x="${sx}" y="${ly}" width="${stageColW}" height="${laneH}" fill="${isAlt ? t.bg : t.card}" stroke="${t.border}" stroke-width="0.5"/>`;
          const items = stage[lane.key] || [];
          if (items.length === 0) {
            body += `<text x="${sx + stageColW / 2}" y="${ly + laneH / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="10" fill="${t.muted}" font-style="italic">—</text>`;
          } else {
            items.slice(0, 5).forEach((line, idx) => {
              const lyText = ly + 18 + idx * 20;
              if (lyText > ly + laneH - 6) return;
              body += `<circle cx="${sx + 14}" cy="${lyText - 4}" r="2.5" fill="${lane.color}"/>`;
              body += `<text x="${sx + 22}" y="${lyText}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
            });
          }
        });
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `User journey map: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `journey_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      // Average emotion across stages
      const avgEmotion = stageData.reduce((s, x) => s + x.emotion, 0) / n;

      emitEvent(ctx, 'tool_output', {
        tool: 'create_user_journey_map',
        ok: true,
        preview: `Journey listo: ${artifact.filename} (${n} etapas · emoción avg ${avgEmotion.toFixed(1)}/5, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        stages: n,
        lanes: LANES.length,
        avgEmotion: Number(avgEmotion.toFixed(2)),
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_user_journey_map', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 24: create_okr_dashboard
// ─────────────────────────────────────────────────────────────────────────

const createOkrDashboard = {
  name: 'create_okr_dashboard',
  description: 'Generate an OKR (Objectives & Key Results) dashboard as an SVG file: N Objective cards (1-6) each with 1-5 Key Result rows showing progress bars, current vs target values, and color-coded status (red/amber/green). Use for quarterly OKR reviews, team status reports, strategy execution dashboards, or any goal-tracking summary.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Dashboard title (e.g. "Q2 2026 OKRs").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. team, period, owner).' },
      objectives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Objective title.' },
            owner: { type: 'string', description: 'Optional owner / team.' },
            keyResults: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label:   { type: 'string', description: 'KR description (what success looks like).' },
                  current: { type: 'number', description: 'Current value.' },
                  target:  { type: 'number', description: 'Target value to reach.' },
                  unit:    { type: 'string', description: 'Optional unit (e.g. "%", "users", "$M").' },
                },
                required: ['label', 'current', 'target'],
              },
              description: '1-5 key results per objective.',
            },
          },
          required: ['title', 'keyResults'],
        },
        description: '1-6 objectives.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'objectives'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', objectives = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_okr_dashboard', preview: title });

    try {
      if (!Array.isArray(objectives) || objectives.length === 0) {
        return { ok: false, error: 'objectives array is empty' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Status thresholds: red < 33, amber 33-67, green > 67
          red: '#EF4444', amber: '#F59E0B', green: '#10B981',
          barBg: '#F1F5F9',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          red: '#F87171', amber: '#FBBF24', green: '#34D399',
          barBg: '#334155',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          red: '#0F172A', amber: '#475569', green: '#0F172A',
          barBg: '#F1F5F9',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          red: '#D93025', amber: '#F9AB00', green: '#0F9D58',
          barBg: '#F1F5F9',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const objList = objectives.slice(0, 6);

      function statusColor(pct) {
        if (pct >= 0.67) return t.green;
        if (pct >= 0.33) return t.amber;
        return t.red;
      }
      function statusLabel(pct) {
        if (pct >= 0.67) return 'ON TRACK';
        if (pct >= 0.33) return 'AT RISK';
        return 'BEHIND';
      }
      function fmtNumber(n) {
        if (!Number.isFinite(n)) return '0';
        if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
        if (Number.isInteger(n)) return String(n);
        return n.toFixed(1);
      }

      // Pre-compute progress for each objective
      const objData = objList.map(obj => {
        const krs = (Array.isArray(obj.keyResults) ? obj.keyResults : []).slice(0, 5).map(kr => {
          // Avoid `|| 0` / `|| 1` so legit zero values aren't coerced
          // — distinguishing target=0 (degenerate but meaningful) from
          // target=undefined matters for the 0/0 → 100% rule below.
          const rawCurrent = Number(kr.current);
          const rawTarget = Number(kr.target);
          const current = Number.isFinite(rawCurrent) ? rawCurrent : 0;
          const target = Number.isFinite(rawTarget) ? rawTarget : 0;
          // Progress relative to target. Target=0 → treat as 100% if current also 0, else 0.
          let pct = 0;
          if (target > 0) pct = Math.max(0, Math.min(1, current / target));
          else if (target === 0 && current === 0) pct = 1;
          return {
            label: xmlEscape(String(kr.label || '').slice(0, 80)),
            current,
            target,
            unit: xmlEscape(String(kr.unit || '').slice(0, 8)),
            pct,
          };
        });
        const objPct = krs.length > 0 ? krs.reduce((s, k) => s + k.pct, 0) / krs.length : 0;
        return {
          title: xmlEscape(String(obj.title || '').slice(0, 80)),
          owner: xmlEscape(String(obj.owner || '').slice(0, 36)),
          krs,
          pct: objPct,
        };
      });

      // Layout: cards in a 2-column grid (or 1 column when only 1 objective).
      const cardW = 540;
      const cardGap = 16;
      const cols = Math.min(2, objList.length);
      const rows = Math.ceil(objList.length / cols);
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;

      const krRowH = 50;
      // Card height = obj header + KR rows + footer
      function cardHeight(obj) {
        return 76 + Math.max(1, obj.krs.length) * krRowH + 24;
      }
      // Compute per-row heights so cards in the same row align
      const rowHeights = [];
      for (let r = 0; r < rows; r++) {
        let maxH = 0;
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx < objData.length) {
            const h = cardHeight(objData[idx]);
            if (h > maxH) maxH = h;
          }
        }
        rowHeights.push(maxH);
      }
      const totalCardsH = rowHeights.reduce((s, h) => s + h, 0) + (rows - 1) * cardGap;

      const W = pad * 2 + cardW * cols + cardGap * (cols - 1);
      const H = headerH + pad + totalCardsH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      // Overall avg progress
      const overallPct = objData.length > 0 ? objData.reduce((s, o) => s + o.pct, 0) / objData.length : 0;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${objList.length} objetivos · ${(overallPct * 100).toFixed(0)}% progreso global</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Cards
      let cardY = headerH + pad;
      objData.forEach((obj, idx) => {
        const c = idx % cols;
        const r = Math.floor(idx / cols);
        const x = pad + c * (cardW + cardGap);
        // Position by accumulated row heights
        let y = headerH + pad;
        for (let i = 0; i < r; i++) y += rowHeights[i] + cardGap;
        const h = rowHeights[r];
        const objColor = statusColor(obj.pct);

        // Card
        body += `<rect x="${x}" y="${y}" width="${cardW}" height="${h}" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        body += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${objColor}"/>`;

        // Objective header
        body += `<text x="${x + 22}" y="${y + 28}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}">OBJETIVO ${idx + 1}</text>`;
        body += `<text x="${x + 22}" y="${y + 50}" font-family="Arial" font-size="15" font-weight="bold" fill="${t.text}">${obj.title}</text>`;
        if (obj.owner) {
          body += `<text x="${x + 22}" y="${y + 68}" font-family="Arial" font-size="11" fill="${t.muted}">${obj.owner}</text>`;
        }
        // Big progress pill at right
        const pctText = `${(obj.pct * 100).toFixed(0)}%`;
        const statusText = statusLabel(obj.pct);
        body += `<rect x="${x + cardW - 130}" y="${y + 18}" width="116" height="38" rx="8" fill="${objColor}"/>`;
        body += `<text x="${x + cardW - 72}" y="${y + 38}" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#fff">${pctText}</text>`;
        body += `<text x="${x + cardW - 72}" y="${y + 52}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="bold" fill="#fff" opacity="0.85">${statusText}</text>`;

        // KR rows
        const krBase = y + 76;
        if (obj.krs.length === 0) {
          body += `<text x="${x + cardW / 2}" y="${krBase + krRowH / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin key results —</text>`;
        } else {
          obj.krs.forEach((kr, krIdx) => {
            const ky = krBase + krIdx * krRowH;
            const krColor = statusColor(kr.pct);
            // KR label
            body += `<text x="${x + 22}" y="${ky + 16}" font-family="Arial" font-size="12" font-weight="600" fill="${t.text}">KR${krIdx + 1}: ${kr.label}</text>`;
            // Progress bar bg
            const barX = x + 22;
            const barY = ky + 24;
            const barW = cardW - 180;
            const barH = 12;
            body += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="6" fill="${t.barBg}"/>`;
            // Progress bar fill
            const fillW = barW * kr.pct;
            body += `<rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="6" fill="${krColor}"/>`;
            // Current/target text
            const valueText = `${fmtNumber(kr.current)} / ${fmtNumber(kr.target)}${kr.unit ? ' ' + kr.unit : ''}`;
            body += `<text x="${x + cardW - 22}" y="${ky + 16}" text-anchor="end" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">${valueText}</text>`;
            body += `<text x="${x + cardW - 22}" y="${barY + 9}" text-anchor="end" font-family="Arial" font-size="10" fill="${krColor}" font-weight="bold">${(kr.pct * 100).toFixed(0)}%</text>`;
          });
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `OKR dashboard: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `okr_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const tally = { onTrack: 0, atRisk: 0, behind: 0 };
      objData.forEach(o => {
        if (o.pct >= 0.67) tally.onTrack += 1;
        else if (o.pct >= 0.33) tally.atRisk += 1;
        else tally.behind += 1;
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_okr_dashboard',
        ok: true,
        preview: `OKR dashboard: ${artifact.filename} (${objList.length} obj · ${(overallPct * 100).toFixed(0)}% · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        objectives: objList.length,
        overallPct: Number((overallPct * 100).toFixed(1)),
        tally,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_okr_dashboard', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 25: create_empathy_map
// ─────────────────────────────────────────────────────────────────────────

const createEmpathyMap = {
  name: 'create_empathy_map',
  description: 'Generate an Empathy Map as an SVG file: a persona at the centre + 4 canonical quadrants (Says, Thinks, Does, Feels) + optional Pains and Gains strips at the bottom. Use for design thinking workshops, persona research, UX kickoffs, or product-discovery interviews. Each quadrant accepts 1-6 bullet items.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Map title (e.g. "SiraGPT — SMB power user").' },
      persona: { type: 'string', description: 'Persona name or short description shown at the centre.' },
      says:    { type: 'array', items: { type: 'string' }, description: 'Direct quotes / verbalisations.' },
      thinks:  { type: 'array', items: { type: 'string' }, description: 'Internal monologue / preoccupations.' },
      does:    { type: 'array', items: { type: 'string' }, description: 'Observed behaviours / actions.' },
      feels:   { type: 'array', items: { type: 'string' }, description: 'Emotional states / moods.' },
      pains:   { type: 'array', items: { type: 'string' }, description: 'Optional pains strip at the bottom (frustrations, blockers).' },
      gains:   { type: 'array', items: { type: 'string' }, description: 'Optional gains strip at the bottom (aspirations, rewards).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    persona = '',
    says = [],
    thinks = [],
    does = [],
    feels = [],
    pains = [],
    gains = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_empathy_map', preview: title });

    try {
      const all = [says, thinks, does, feels, pains, gains];
      if (!all.every(a => Array.isArray(a))) {
        return { ok: false, error: 'all quadrant inputs (says/thinks/does/feels/pains/gains) must be arrays of strings' };
      }
      const totalItems = all.reduce((s, a) => s + a.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all quadrants are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Each empathy zone has a recognised colour family
          says:   { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A', icon: '💬' },
          thinks: { fill: '#EDE9FE', bar: '#7C3AED', label: '#4C1D95', icon: '💭' },
          does:   { fill: '#ECFDF5', bar: '#10B981', label: '#065F46', icon: '🦶' },
          feels:  { fill: '#FEE2E2', bar: '#EF4444', label: '#7F1D1D', icon: '❤️' },
          pains:  { fill: '#FEF3C7', bar: '#F59E0B', label: '#78350F' },
          gains:  { fill: '#ECFDF5', bar: '#10B981', label: '#065F46' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          says:   { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE', icon: '💬' },
          thinks: { fill: '#4C1D95', bar: '#A78BFA', label: '#DDD6FE', icon: '💭' },
          does:   { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0', icon: '🦶' },
          feels:  { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA', icon: '❤️' },
          pains:  { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A' },
          gains:  { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          says:   { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A', icon: '💬' },
          thinks: { fill: '#F8FAFC', bar: '#475569', label: '#0F172A', icon: '💭' },
          does:   { fill: '#F8FAFC', bar: '#475569', label: '#0F172A', icon: '🦶' },
          feels:  { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A', icon: '❤️' },
          pains:  { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          gains:  { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          says:   { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91', icon: '💬' },
          thinks: { fill: '#F3E8FD', bar: '#673AB7', label: '#3A1A6E', icon: '💭' },
          does:   { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20', icon: '🦶' },
          feels:  { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14', icon: '❤️' },
          pains:  { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00' },
          gains:  { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safePersona = xmlEscape(String(persona || 'Persona').slice(0, 60));
      const hasPains = pains.length > 0;
      const hasGains = gains.length > 0;
      const showStrip = hasPains || hasGains;

      const quadW = 360;
      const quadH = 240;
      const gap = 6;
      const pad = 28;
      const centerR = 60; // central persona badge radius
      const headerH = 86;
      const stripH = showStrip ? 130 : 0;
      const W = pad * 2 + quadW * 2 + gap;
      const H = headerH + pad + quadH * 2 + gap + (showStrip ? gap + stripH : 0) + pad;
      const lineMaxChars = 38;

      function fmt(items) {
        return (items || []).slice(0, 6).map(s => xmlEscape(String(s || '').slice(0, lineMaxChars))).filter(Boolean);
      }

      const QUADS = {
        says:   { pal: t.says,   label: 'SAYS',   items: fmt(says) },
        thinks: { pal: t.thinks, label: 'THINKS', items: fmt(thinks) },
        does:   { pal: t.does,   label: 'DOES',   items: fmt(does) },
        feels:  { pal: t.feels,  label: 'FEELS',  items: fmt(feels) },
      };

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const stripsTxt = (hasPains ? ` · Pains:${pains.length}` : '') + (hasGains ? ` · Gains:${gains.length}` : '');
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalItems} ítems${stripsTxt}</text>`;

      // Quadrants
      const topY = headerH + pad;
      const leftX = pad;
      const rightX = pad + quadW + gap;
      const botY = topY + quadH + gap;

      function drawQuad(q, x, y, w, h) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${q.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${q.pal.bar}"/>`;
        // Icon + label
        const iconLeft = x + 22;
        out += `<text x="${iconLeft}" y="${y + 32}" font-family="Arial" font-size="22">${q.pal.icon}</text>`;
        out += `<text x="${iconLeft + 36}" y="${y + 30}" font-family="Arial" font-size="14" font-weight="bold" fill="${q.pal.label}">${q.label}</text>`;
        out += `<text x="${x + w - 22}" y="${y + 30}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${q.items.length}</text>`;
        // Separator
        out += `<line x1="${x + 16}" y1="${y + 46}" x2="${x + w - 16}" y2="${y + 46}" stroke="${t.border}" stroke-width="1"/>`;
        // Items
        if (q.items.length === 0) {
          out += `<text x="${x + w / 2}" y="${y + h / 2 + 6}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" font-style="italic">— vacío —</text>`;
        } else {
          q.items.forEach((line, idx) => {
            const ly = y + 70 + idx * 22;
            if (ly > y + h - 10) return;
            out += `<circle cx="${x + 22}" cy="${ly - 4}" r="2.5" fill="${q.pal.bar}"/>`;
            out += `<text x="${x + 30}" y="${ly}" font-family="Arial" font-size="12" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      body += drawQuad(QUADS.says,   leftX,  topY, quadW, quadH);
      body += drawQuad(QUADS.thinks, rightX, topY, quadW, quadH);
      body += drawQuad(QUADS.does,   leftX,  botY, quadW, quadH);
      body += drawQuad(QUADS.feels,  rightX, botY, quadW, quadH);

      // Central persona badge (drawn on top of quadrants)
      const cx = pad + quadW + gap / 2;
      const cy = topY + quadH + gap / 2;
      body += `<circle cx="${cx}" cy="${cy}" r="${centerR + 6}" fill="${t.bg}"/>`;
      body += `<circle cx="${cx}" cy="${cy}" r="${centerR}" fill="${t.accent}" stroke="#fff" stroke-width="3"/>`;
      body += `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#fff" opacity="0.85">PERSONA</text>`;
      body += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="#fff">${safePersona.slice(0, 28)}</text>`;
      if (safePersona.length > 28) {
        body += `<text x="${cx}" y="${cy + 28}" text-anchor="middle" font-family="Arial" font-size="11" fill="#fff" opacity="0.85">${safePersona.slice(28, 56)}</text>`;
      }

      // ── Optional Pains / Gains strips ──
      if (showStrip) {
        const stripY = botY + quadH + gap;
        if (hasPains) {
          const stripW = hasGains ? (W - pad * 2 - gap) / 2 : (W - pad * 2);
          const stripX = pad;
          const pq = { pal: t.pains, label: '✖ PAINS', items: fmt(pains) };
          body += `<rect x="${stripX}" y="${stripY}" width="${stripW}" height="${stripH}" rx="10" fill="${pq.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
          body += `<rect x="${stripX}" y="${stripY}" width="6" height="${stripH}" rx="3" fill="${pq.pal.bar}"/>`;
          body += `<text x="${stripX + 22}" y="${stripY + 26}" font-family="Arial" font-size="14" font-weight="bold" fill="${pq.pal.label}">${pq.label}</text>`;
          pq.items.slice(0, 6).forEach((line, idx) => {
            const ly = stripY + 50 + idx * 18;
            if (ly > stripY + stripH - 10) return;
            body += `<circle cx="${stripX + 22}" cy="${ly - 4}" r="2.5" fill="${pq.pal.bar}"/>`;
            body += `<text x="${stripX + 30}" y="${ly}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
          });
        }
        if (hasGains) {
          const stripW = hasPains ? (W - pad * 2 - gap) / 2 : (W - pad * 2);
          const stripX = hasPains ? pad + stripW + gap : pad;
          const gq = { pal: t.gains, label: '✓ GAINS', items: fmt(gains) };
          body += `<rect x="${stripX}" y="${stripY}" width="${stripW}" height="${stripH}" rx="10" fill="${gq.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
          body += `<rect x="${stripX}" y="${stripY}" width="6" height="${stripH}" rx="3" fill="${gq.pal.bar}"/>`;
          body += `<text x="${stripX + 22}" y="${stripY + 26}" font-family="Arial" font-size="14" font-weight="bold" fill="${gq.pal.label}">${gq.label}</text>`;
          gq.items.slice(0, 6).forEach((line, idx) => {
            const ly = stripY + 50 + idx * 18;
            if (ly > stripY + stripH - 10) return;
            body += `<circle cx="${stripX + 22}" cy="${ly - 4}" r="2.5" fill="${gq.pal.bar}"/>`;
            body += `<text x="${stripX + 30}" y="${ly}" font-family="Arial" font-size="11" fill="${t.text}">${line}</text>`;
          });
        }
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Empathy map: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `empathy_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        says: QUADS.says.items.length,
        thinks: QUADS.thinks.items.length,
        does: QUADS.does.items.length,
        feels: QUADS.feels.items.length,
        pains: fmt(pains).length,
        gains: fmt(gains).length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_empathy_map',
        ok: true,
        preview: `Empathy listo: ${artifact.filename} (${totalItems} ítems · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        persona,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_empathy_map', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 26: create_lean_canvas
// ─────────────────────────────────────────────────────────────────────────

const createLeanCanvas = {
  name: 'create_lean_canvas',
  description: "Generate Ash Maurya's Lean Canvas as an SVG file: a 9-block startup-focused alternative to the Business Model Canvas (Problem, Customer Segments, Unique Value Proposition, Solution, Unfair Advantage, Channels, Revenue Streams, Cost Structure, Key Metrics). Use for startup pitches, MVP planning, customer-discovery loops, or any seed-stage business modeling. Each block accepts 1-8 bullet items.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Canvas title (e.g. "SiraGPT Lean Canvas").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. iteration, period).' },
      problem:             { type: 'array', items: { type: 'string' }, description: '1-3 top problems the customer has (1-8 items).' },
      customerSegments:    { type: 'array', items: { type: 'string' }, description: 'Target customers / users / early adopters (1-8 items).' },
      uniqueValueProposition: { type: 'array', items: { type: 'string' }, description: 'Single, clear, compelling message that turns visitors into customers (1-8 items).' },
      solution:            { type: 'array', items: { type: 'string' }, description: '1-3 simple solutions to each top problem (1-8 items).' },
      unfairAdvantage:     { type: 'array', items: { type: 'string' }, description: "What can't be easily copied or bought (1-8 items)." },
      channels:            { type: 'array', items: { type: 'string' }, description: 'How customers reach your product (1-8 items).' },
      revenueStreams:      { type: 'array', items: { type: 'string' }, description: 'Revenue model / lifetime value / margins (1-8 items).' },
      costStructure:       { type: 'array', items: { type: 'string' }, description: 'Customer acquisition costs, distribution, hosting, people (1-8 items).' },
      keyMetrics:          { type: 'array', items: { type: 'string' }, description: 'Key activities you measure (1-8 items).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    problem = [],
    customerSegments = [],
    uniqueValueProposition = [],
    solution = [],
    unfairAdvantage = [],
    channels = [],
    revenueStreams = [],
    costStructure = [],
    keyMetrics = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_lean_canvas', preview: title });

    try {
      const all = [problem, customerSegments, uniqueValueProposition, solution, unfairAdvantage, channels, revenueStreams, costStructure, keyMetrics];
      if (!all.every(a => Array.isArray(a))) {
        return { ok: false, error: 'all 9 block inputs must be arrays of strings' };
      }
      const totalItems = all.reduce((s, a) => s + a.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 9 blocks are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#7C3AED',
          // Each Lean Canvas block has a recognised colour family in startup decks
          problem:  '#EF4444', segments: '#10B981', uvp: '#7C3AED', solution: '#3B82F6', unfair: '#F59E0B',
          channels: '#F97316', revenue: '#16A34A', cost: '#64748B', metrics: '#06B6D4',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#A78BFA',
          problem: '#F87171', segments: '#34D399', uvp: '#A78BFA', solution: '#60A5FA', unfair: '#FBBF24',
          channels: '#FB923C', revenue: '#4ADE80', cost: '#94A3B8', metrics: '#22D3EE',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          problem: '#0F172A', segments: '#0F172A', uvp: '#0F172A', solution: '#0F172A', unfair: '#0F172A',
          channels: '#0F172A', revenue: '#0F172A', cost: '#0F172A', metrics: '#0F172A',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#673AB7',
          problem: '#D93025', segments: '#0F9D58', uvp: '#673AB7', solution: '#1A73E8', unfair: '#F9AB00',
          channels: '#E8710A', revenue: '#137333', cost: '#5F6368', metrics: '#039BE5',
        },
      };
      const t = themes[theme] || themes.professional;

      // Canonical Lean Canvas layout: 5 equal-width columns up top, 2 equal
      // halves at the bottom. Problem / UVP / Customer Segments span both
      // top rows (tall blocks); Solution/KeyMetrics and UVP-extra/Channels
      // stack vertically (short blocks). Unfair Advantage sits on top-right
      // adjacent to Customer Segments.
      // Standard Lean Canvas slots:
      //   col1 (tall) = Problem (with Existing alternatives below)
      //   col2 = Solution (top) / Key Metrics (bottom)
      //   col3 (tall) = UVP
      //   col4 = Unfair Advantage (top) / Channels (bottom)
      //   col5 (tall) = Customer Segments
      //   bottom row = Cost Structure | Revenue Streams
      const cellW = 224;
      const halfH = 142;
      const tallH = halfH * 2 + 6;
      const bottomH = 132;
      const gap = 6;
      const pad = 24;
      const headerH = subtitle ? 110 : 86;
      const W = pad * 2 + cellW * 5 + gap * 4;
      const H = headerH + pad + tallH + gap + bottomH + pad;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const lineH = 16;
      const lineMaxChars = 38;
      const itemsCapPerBlock = 8;
      function fmt(items) {
        return (items || []).slice(0, itemsCapPerBlock).map(s => xmlEscape(String(s || '').slice(0, lineMaxChars))).filter(Boolean);
      }

      const blocks = {
        problem:  { label: 'PROBLEM',                items: fmt(problem) },
        solution: { label: 'SOLUTION',               items: fmt(solution) },
        metrics:  { label: 'KEY METRICS',            items: fmt(keyMetrics) },
        uvp:      { label: 'UNIQUE VALUE PROPOSITION', items: fmt(uniqueValueProposition) },
        unfair:   { label: 'UNFAIR ADVANTAGE',       items: fmt(unfairAdvantage) },
        channels: { label: 'CHANNELS',               items: fmt(channels) },
        segments: { label: 'CUSTOMER SEGMENTS',      items: fmt(customerSegments) },
        cost:     { label: 'COST STRUCTURE',         items: fmt(costStructure) },
        revenue:  { label: 'REVENUE STREAMS',        items: fmt(revenueStreams) },
      };

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header (purple/violet accent — distinguishes Lean Canvas from BMC at a glance)
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalItems} ítems across 9 blocks · Lean Canvas</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      function drawBlock(block, color, x, y, w, h, blockMaxLines = 8) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="${w}" height="4" rx="2" fill="${color}"/>`;
        out += `<text x="${x + 12}" y="${y + 24}" font-family="Arial" font-size="11" font-weight="bold" fill="${color}">${xmlEscape(block.label)}</text>`;
        out += `<text x="${x + w - 12}" y="${y + 24}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${block.items.length}</text>`;
        const lines = block.items.slice(0, blockMaxLines);
        if (lines.length === 0) {
          out += `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" font-style="italic">— vacío —</text>`;
        } else {
          lines.forEach((line, idx) => {
            const ly = y + 44 + idx * lineH;
            if (ly > y + h - 10) return;
            out += `<circle cx="${x + 16}" cy="${ly - 4}" r="2.5" fill="${color}"/>`;
            out += `<text x="${x + 24}" y="${ly}" font-family="Arial" font-size="10.5" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      const topY = headerH + pad;
      const col1X = pad;
      const col2X = col1X + cellW + gap;
      const col3X = col2X + cellW + gap;
      const col4X = col3X + cellW + gap;
      const col5X = col4X + cellW + gap;

      // Top section
      body += drawBlock(blocks.problem,  t.problem,  col1X, topY, cellW, tallH);
      body += drawBlock(blocks.solution, t.solution, col2X, topY, cellW, halfH);
      body += drawBlock(blocks.metrics,  t.metrics,  col2X, topY + halfH + gap, cellW, halfH);
      body += drawBlock(blocks.uvp,      t.uvp,      col3X, topY, cellW, tallH);
      body += drawBlock(blocks.unfair,   t.unfair,   col4X, topY, cellW, halfH);
      body += drawBlock(blocks.channels, t.channels, col4X, topY + halfH + gap, cellW, halfH);
      body += drawBlock(blocks.segments, t.segments, col5X, topY, cellW, tallH);

      // Bottom section: Cost (left half), Revenue (right half)
      const botY = topY + tallH + gap;
      const halfW = (W - pad * 2 - gap) / 2;
      body += drawBlock(blocks.cost,    t.cost,    pad,                 botY, halfW, bottomH, 6);
      body += drawBlock(blocks.revenue, t.revenue, pad + halfW + gap,   botY, halfW, bottomH, 6);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Lean Canvas: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `lean_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        problem: blocks.problem.items.length,
        customerSegments: blocks.segments.items.length,
        uniqueValueProposition: blocks.uvp.items.length,
        solution: blocks.solution.items.length,
        unfairAdvantage: blocks.unfair.items.length,
        channels: blocks.channels.items.length,
        revenueStreams: blocks.revenue.items.length,
        costStructure: blocks.cost.items.length,
        keyMetrics: blocks.metrics.items.length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_lean_canvas',
        ok: true,
        preview: `Lean Canvas: ${artifact.filename} (${totalItems} ítems en 9 bloques, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_lean_canvas', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 27: create_balanced_scorecard
// ─────────────────────────────────────────────────────────────────────────

const createBalancedScorecard = {
  name: 'create_balanced_scorecard',
  description: "Generate Kaplan-Norton's Balanced Scorecard as an SVG file: 4 horizontal perspective bands (Financial top → Customer → Internal Process → Learning & Growth bottom) with strategic objectives in each, plus an optional cause-effect arrow on the left showing how lower perspectives drive upper ones. Use for strategy execution dashboards, performance management reviews, or aligning operational metrics to financial outcomes.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Scorecard title (e.g. "Q2 2026 Balanced Scorecard").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      financial:        { type: 'array', items: { type: 'object' }, description: '1-6 financial-perspective objectives: { objective, measure?, target?, current?, status?: "ahead"|"on_track"|"at_risk"|"behind" }.' },
      customer:         { type: 'array', items: { type: 'object' }, description: '1-6 customer-perspective objectives (same shape).' },
      internalProcess:  { type: 'array', items: { type: 'object' }, description: '1-6 internal-process-perspective objectives (same shape).' },
      learningGrowth:   { type: 'array', items: { type: 'object' }, description: '1-6 learning-&-growth-perspective objectives (same shape).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    financial = [],
    customer = [],
    internalProcess = [],
    learningGrowth = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_balanced_scorecard', preview: title });

    try {
      const all = [financial, customer, internalProcess, learningGrowth];
      if (!all.every(a => Array.isArray(a))) {
        return { ok: false, error: 'all 4 perspective inputs must be arrays of objectives' };
      }
      const totalItems = all.reduce((s, a) => s + a.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 4 perspectives are empty — provide at least one objective' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Each perspective has a recognised colour family in BSC literature
          financial:       { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A' },
          customer:        { fill: '#FEF3C7', bar: '#F59E0B', label: '#78350F' },
          internalProcess: { fill: '#ECFDF5', bar: '#10B981', label: '#065F46' },
          learningGrowth:  { fill: '#EDE9FE', bar: '#7C3AED', label: '#4C1D95' },
          ahead: '#10B981', onTrack: '#22C55E', atRisk: '#F59E0B', behind: '#EF4444',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          financial:       { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE' },
          customer:        { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A' },
          internalProcess: { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0' },
          learningGrowth:  { fill: '#4C1D95', bar: '#A78BFA', label: '#DDD6FE' },
          ahead: '#34D399', onTrack: '#4ADE80', atRisk: '#FBBF24', behind: '#F87171',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          financial:       { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A' },
          customer:        { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          internalProcess: { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          learningGrowth:  { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A' },
          ahead: '#10B981', onTrack: '#22C55E', atRisk: '#F59E0B', behind: '#EF4444',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          financial:       { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91' },
          customer:        { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00' },
          internalProcess: { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20' },
          learningGrowth:  { fill: '#F3E8FD', bar: '#673AB7', label: '#3A1A6E' },
          ahead: '#0F9D58', onTrack: '#34A853', atRisk: '#F9AB00', behind: '#D93025',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const lineMaxChars = 38;

      function fmtObj(obj) {
        return {
          objective: xmlEscape(String(obj.objective || '').slice(0, lineMaxChars)),
          measure: obj.measure ? xmlEscape(String(obj.measure).slice(0, 32)) : '',
          target: obj.target,
          current: obj.current,
          status: ['ahead', 'on_track', 'at_risk', 'behind'].includes(String(obj.status)) ? String(obj.status) : null,
        };
      }
      function fmtList(items) {
        return (items || []).slice(0, 6).map(fmtObj).filter(o => o.objective);
      }

      const BANDS = [
        { key: 'financial',       pal: t.financial,       label: 'FINANCIAL',          subLabel: '¿Qué esperan los stakeholders?', items: fmtList(financial) },
        { key: 'customer',        pal: t.customer,        label: 'CUSTOMER',           subLabel: '¿Cómo nos ven los clientes?',   items: fmtList(customer) },
        { key: 'internalProcess', pal: t.internalProcess, label: 'INTERNAL PROCESS',   subLabel: '¿En qué procesos sobresalir?',  items: fmtList(internalProcess) },
        { key: 'learningGrowth',  pal: t.learningGrowth,  label: 'LEARNING & GROWTH',  subLabel: '¿Cómo mantener cambio y mejora?',items: fmtList(learningGrowth) },
      ];

      const bandH = 160;
      const headerH = safeSubtitle ? 110 : 86;
      const causalArrowW = 56;
      const labelW = 200;
      const pad = 24;
      const W = pad * 2 + causalArrowW + labelW + 720;
      const H = headerH + pad + bandH * 4 + 12 + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${totalItems} objetivos · 4 perspectivas</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      const topY = headerH + pad;

      // ── Cause-effect arrow on the left (pointing up — value cascades upward) ──
      const arrowX = pad + 8;
      const arrowYTop = topY + 20;
      const arrowYBottom = topY + bandH * 4 - 20;
      body += `<line x1="${arrowX + causalArrowW / 2 - 8}" y1="${arrowYBottom}" x2="${arrowX + causalArrowW / 2 - 8}" y2="${arrowYTop}" stroke="${t.accent}" stroke-width="3" opacity="0.7"/>`;
      // Arrowhead
      body += `<polygon points="${arrowX + causalArrowW / 2 - 16},${arrowYTop + 8} ${arrowX + causalArrowW / 2 - 8},${arrowYTop} ${arrowX + causalArrowW / 2},${arrowYTop + 8}" fill="${t.accent}" opacity="0.85"/>`;
      // Arrow tail label (rotated text on the side)
      const arrowMid = (arrowYTop + arrowYBottom) / 2;
      body += `<text x="${arrowX + causalArrowW / 2 + 6}" y="${arrowMid}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="${t.muted}" transform="rotate(-90, ${arrowX + causalArrowW / 2 + 6}, ${arrowMid})">CAUSA → EFECTO</text>`;

      // Bands
      BANDS.forEach((band, i) => {
        const y = topY + i * bandH;
        // Label cell (left side, after arrow)
        const labelX = pad + causalArrowW;
        body += `<rect x="${labelX}" y="${y}" width="${labelW}" height="${bandH - 6}" rx="10" fill="${band.pal.fill}" stroke="${t.border}" stroke-width="1"/>`;
        body += `<rect x="${labelX}" y="${y}" width="6" height="${bandH - 6}" rx="3" fill="${band.pal.bar}"/>`;
        body += `<text x="${labelX + 18}" y="${y + 30}" font-family="Arial" font-size="13" font-weight="bold" fill="${band.pal.label}">${xmlEscape(band.label)}</text>`;
        // Sub-label (wrap to up to 2 lines)
        const subWords = band.subLabel.split(' ');
        let line1 = '';
        let line2 = '';
        for (const w of subWords) {
          if ((line1 + ' ' + w).trim().length < 28) line1 = (line1 + ' ' + w).trim();
          else line2 = (line2 + ' ' + w).trim();
        }
        body += `<text x="${labelX + 18}" y="${y + 50}" font-family="Arial" font-size="10" fill="${t.muted}">${xmlEscape(line1)}</text>`;
        if (line2) body += `<text x="${labelX + 18}" y="${y + 64}" font-family="Arial" font-size="10" fill="${t.muted}">${xmlEscape(line2)}</text>`;
        // Count badge
        body += `<circle cx="${labelX + labelW - 24}" cy="${y + 30}" r="14" fill="${band.pal.bar}"/>`;
        body += `<text x="${labelX + labelW - 24}" y="${y + 35}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="#fff">${band.items.length}</text>`;

        // Objective chips (right of label cell)
        const chipsAreaX = labelX + labelW + 12;
        const chipsAreaW = W - chipsAreaX - pad;
        if (band.items.length === 0) {
          body += `<text x="${chipsAreaX + chipsAreaW / 2}" y="${y + bandH / 2}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin objetivos —</text>`;
        } else {
          // Lay out chips in up to 2 rows × up to 3 cols
          const chipW = 220;
          const chipH = 64;
          const chipGap = 8;
          const cols = 3;
          band.items.slice(0, 6).forEach((obj, idx) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const cx = chipsAreaX + col * (chipW + chipGap);
            const cy = y + 16 + row * (chipH + chipGap);
            const statusCol = obj.status === 'ahead' ? t.ahead
                             : obj.status === 'on_track' ? t.onTrack
                             : obj.status === 'at_risk' ? t.atRisk
                             : obj.status === 'behind' ? t.behind
                             : null;
            body += `<rect x="${cx}" y="${cy}" width="${chipW}" height="${chipH}" rx="6" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
            body += `<rect x="${cx}" y="${cy}" width="4" height="${chipH}" rx="2" fill="${band.pal.bar}"/>`;
            body += `<text x="${cx + 12}" y="${cy + 18}" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">${obj.objective}</text>`;
            if (obj.measure) {
              body += `<text x="${cx + 12}" y="${cy + 34}" font-family="Arial" font-size="9" fill="${t.muted}">📏 ${obj.measure}</text>`;
            }
            if (obj.target !== undefined || obj.current !== undefined) {
              const cur = obj.current !== undefined ? obj.current : '';
              const tgt = obj.target !== undefined ? obj.target : '';
              body += `<text x="${cx + 12}" y="${cy + 48}" font-family="Arial" font-size="9" fill="${t.text}">${cur} / ${tgt}</text>`;
            }
            if (statusCol) {
              const sLabel = obj.status.replace('_', ' ').toUpperCase();
              const pillW = sLabel.length * 5.4 + 14;
              body += `<rect x="${cx + chipW - pillW - 8}" y="${cy + 8}" width="${pillW}" height="14" rx="7" fill="${statusCol}"/>`;
              body += `<text x="${cx + chipW - 8 - pillW / 2}" y="${cy + 18}" text-anchor="middle" font-family="Arial" font-size="8" font-weight="bold" fill="#fff">${sLabel}</text>`;
            }
          });
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Balanced Scorecard: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `bsc_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const counts = {
        financial: BANDS[0].items.length,
        customer: BANDS[1].items.length,
        internalProcess: BANDS[2].items.length,
        learningGrowth: BANDS[3].items.length,
      };

      emitEvent(ctx, 'tool_output', {
        tool: 'create_balanced_scorecard',
        ok: true,
        preview: `BSC listo: ${artifact.filename} (${totalItems} objetivos · 4 perspectivas · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts,
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_balanced_scorecard', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 28: create_ansoff_matrix
// ─────────────────────────────────────────────────────────────────────────

const createAnsoffMatrix = {
  name: 'create_ansoff_matrix',
  description: 'Generate an Ansoff growth-strategy matrix as an SVG file: a 2×2 grid with Market axis (existing vs new) and Product axis (existing vs new), producing 4 canonical growth strategies — Market Penetration (low risk), Market Development (medium risk), Product Development (medium risk), and Diversification (high risk). Each quadrant accepts 1-8 strategic initiatives. Use for growth-strategy reviews, expansion planning, or risk-balanced portfolio sweeps.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Matrix title (e.g. "2026-2027 Growth strategy").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      marketPenetration:  { type: 'array', items: { type: 'string' }, description: 'Existing product × existing market initiatives (low risk).' },
      marketDevelopment:  { type: 'array', items: { type: 'string' }, description: 'Existing product × new market initiatives (medium risk).' },
      productDevelopment: { type: 'array', items: { type: 'string' }, description: 'New product × existing market initiatives (medium risk).' },
      diversification:    { type: 'array', items: { type: 'string' }, description: 'New product × new market initiatives (high risk).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({
    title,
    subtitle = '',
    marketPenetration = [],
    marketDevelopment = [],
    productDevelopment = [],
    diversification = [],
    theme = 'professional',
  }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_ansoff_matrix', preview: title });

    try {
      const quadInputs = [marketPenetration, marketDevelopment, productDevelopment, diversification];
      if (!quadInputs.every(q => Array.isArray(q))) {
        return { ok: false, error: 'marketPenetration / marketDevelopment / productDevelopment / diversification must be arrays' };
      }
      const totalItems = quadInputs.reduce((s, q) => s + q.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 4 strategies are empty — provide at least one initiative' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB', axisText: '#475569',
          // Colour by risk: green (low) → amber (medium) → red (high)
          mp: { fill: '#ECFDF5', bar: '#10B981', label: '#065F46', risk: 'LOW' },
          md: { fill: '#FEF3C7', bar: '#F59E0B', label: '#78350F', risk: 'MEDIUM' },
          pd: { fill: '#FEF3C7', bar: '#F59E0B', label: '#78350F', risk: 'MEDIUM' },
          dv: { fill: '#FEE2E2', bar: '#EF4444', label: '#7F1D1D', risk: 'HIGH' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8', axisText: '#CBD5E1',
          mp: { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0', risk: 'LOW' },
          md: { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A', risk: 'MEDIUM' },
          pd: { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A', risk: 'MEDIUM' },
          dv: { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA', risk: 'HIGH' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A', axisText: '#475569',
          mp: { fill: '#F1F5F9', bar: '#10B981', label: '#0F172A', risk: 'LOW' },
          md: { fill: '#F1F5F9', bar: '#F59E0B', label: '#0F172A', risk: 'MEDIUM' },
          pd: { fill: '#F1F5F9', bar: '#F59E0B', label: '#0F172A', risk: 'MEDIUM' },
          dv: { fill: '#F1F5F9', bar: '#EF4444', label: '#0F172A', risk: 'HIGH' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF', axisText: '#334155',
          mp: { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20', risk: 'LOW' },
          md: { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00', risk: 'MEDIUM' },
          pd: { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00', risk: 'MEDIUM' },
          dv: { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14', risk: 'HIGH' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const quadW = 360;
      const quadGap = 16;
      const axisGutter = 64;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const quadHeaderH = 70;
      const lineH = 22;
      const lineMaxChars = 56;
      const axisLabelH = 28;

      // Canonical Ansoff layout:
      //   top row    = Existing Product  (low column gap)
      //   bottom row = New Product
      //   left col   = Existing Market
      //   right col  = New Market
      //
      //   top-left      = Market Penetration  (existing P × existing M)
      //   top-right     = Market Development  (existing P × new M)
      //   bottom-left   = Product Development (new P × existing M)
      //   bottom-right  = Diversification     (new P × new M)
      const QUADS = [
        { key: 'mp', pal: t.mp, items: marketPenetration,  label: 'MARKET PENETRATION',  subLabel: 'Existing market · Existing product' },
        { key: 'md', pal: t.md, items: marketDevelopment,  label: 'MARKET DEVELOPMENT',  subLabel: 'New market · Existing product' },
        { key: 'pd', pal: t.pd, items: productDevelopment, label: 'PRODUCT DEVELOPMENT', subLabel: 'Existing market · New product' },
        { key: 'dv', pal: t.dv, items: diversification,    label: 'DIVERSIFICATION',     subLabel: 'New market · New product' },
      ];
      const trimmed = QUADS.map(q => ({
        ...q,
        items: (q.items || []).slice(0, 8).map(it => xmlEscape(String(it || '').slice(0, lineMaxChars))).filter(Boolean),
      }));
      const topRowItems = Math.max(trimmed[0].items.length, trimmed[1].items.length, 1);
      const botRowItems = Math.max(trimmed[2].items.length, trimmed[3].items.length, 1);
      const topRowH = quadHeaderH + topRowItems * lineH + 28;
      const botRowH = quadHeaderH + botRowItems * lineH + 28;

      const gridW = quadW * 2 + quadGap;
      const W = pad * 2 + axisGutter + gridW;
      const H = headerH + pad + axisLabelH + topRowH + quadGap + botRowH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const headerMeta = `MP:${trimmed[0].items.length} · MD:${trimmed[1].items.length} · PD:${trimmed[2].items.length} · DV:${trimmed[3].items.length}`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${headerMeta}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // X-axis labels — Market axis
      const axisRowY = headerH + pad;
      const leftQuadX = pad + axisGutter;
      const rightQuadX = leftQuadX + quadW + quadGap;
      body += `<text x="${leftQuadX + quadW / 2}" y="${axisRowY + 18}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}">EXISTING MARKET</text>`;
      body += `<text x="${rightQuadX + quadW / 2}" y="${axisRowY + 18}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}">NEW MARKET</text>`;

      const topY = axisRowY + axisLabelH;
      const botY = topY + topRowH + quadGap;

      // Y-axis label (vertical text on the left gutter)
      const yAxisX = pad + axisGutter / 2;
      body += `<text x="${yAxisX}" y="${topY + topRowH / 2}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}" transform="rotate(-90, ${yAxisX}, ${topY + topRowH / 2})">EXISTING PRODUCT</text>`;
      body += `<text x="${yAxisX}" y="${botY + botRowH / 2}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="${t.axisText}" transform="rotate(-90, ${yAxisX}, ${botY + botRowH / 2})">NEW PRODUCT</text>`;

      function drawQuad(q, x, y, h) {
        let out = '';
        out += `<rect x="${x}" y="${y}" width="${quadW}" height="${h}" rx="10" fill="${q.pal.fill}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        out += `<rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${q.pal.bar}"/>`;
        // Risk pill in top-right
        const riskPillW = Math.max(70, q.pal.risk.length * 8 + 22);
        out += `<rect x="${x + quadW - riskPillW - 14}" y="${y + 14}" width="${riskPillW}" height="22" rx="11" fill="${q.pal.bar}"/>`;
        out += `<text x="${x + quadW - riskPillW / 2 - 14}" y="${y + 29}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${q.pal.risk} RISK</text>`;
        // Title
        out += `<text x="${x + 22}" y="${y + 28}" font-family="Arial" font-size="14" font-weight="bold" fill="${q.pal.label}">${xmlEscape(q.label)}</text>`;
        // Sub-label
        out += `<text x="${x + 22}" y="${y + 48}" font-family="Arial" font-size="11" fill="${t.muted}">${xmlEscape(q.subLabel)}</text>`;
        out += `<text x="${x + 22}" y="${y + 62}" font-family="Arial" font-size="11" fill="${t.muted}">${q.items.length} initiative${q.items.length === 1 ? '' : 's'}</text>`;
        // Separator
        out += `<line x1="${x + 16}" y1="${y + quadHeaderH}" x2="${x + quadW - 16}" y2="${y + quadHeaderH}" stroke="${t.border}" stroke-width="1"/>`;
        // Items
        if (q.items.length === 0) {
          out += `<text x="${x + quadW / 2}" y="${y + quadHeaderH + 32}" text-anchor="middle" font-family="Arial" font-size="12" fill="${t.muted}" font-style="italic">— sin iniciativas —</text>`;
        } else {
          q.items.forEach((line, idx) => {
            const ly = y + quadHeaderH + 22 + idx * lineH;
            out += `<circle cx="${x + 22}" cy="${ly - 4}" r="3" fill="${q.pal.bar}"/>`;
            out += `<text x="${x + 32}" y="${ly}" font-family="Arial" font-size="12" fill="${t.text}">${line}</text>`;
          });
        }
        return out;
      }

      body += drawQuad(trimmed[0], leftQuadX,  topY, topRowH);
      body += drawQuad(trimmed[1], rightQuadX, topY, topRowH);
      body += drawQuad(trimmed[2], leftQuadX,  botY, botRowH);
      body += drawQuad(trimmed[3], rightQuadX, botY, botRowH);

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Ansoff matrix: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `ansoff_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_ansoff_matrix',
        ok: true,
        preview: `Ansoff listo: ${artifact.filename} (${totalItems} iniciativas · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts: {
          marketPenetration:  trimmed[0].items.length,
          marketDevelopment:  trimmed[1].items.length,
          productDevelopment: trimmed[2].items.length,
          diversification:    trimmed[3].items.length,
        },
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_ansoff_matrix', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 29: create_bcg_matrix
// ─────────────────────────────────────────────────────────────────────────

const createBcgMatrix = {
  name: 'create_bcg_matrix',
  description: 'Generate a BCG (Boston Consulting Group) portfolio matrix as an SVG file: Market Share (X axis) × Market Growth (Y axis), with each product/SBU plotted as a bubble in one of 4 canonical quadrants — Stars (high growth, high share), Cash Cows (low growth, high share), Question Marks (high growth, low share), Dogs (low growth, low share). Bubble size encodes revenue. Use for product portfolio reviews, investment allocation decisions, or strategic divestment analyses.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Matrix title (e.g. "SiraGPT product portfolio 2026").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:         { type: 'string', description: 'Product / SBU name.' },
            marketShare:  { type: 'number', description: 'Market share 0-2 (relative to competitor; 1 = parity, >1 = leader).' },
            marketGrowth: { type: 'number', description: 'Market growth % per year (typically 0-30%).' },
            revenue:      { type: 'number', description: 'Optional revenue used to scale bubble size.' },
          },
          required: ['name', 'marketShare', 'marketGrowth'],
        },
        description: '1-20 products plotted in the matrix.',
      },
      growthThreshold: { type: 'number', description: 'Y-axis split between high/low growth. Default: 10 (10%).' },
      shareThreshold:  { type: 'number', description: 'X-axis split between high/low share. Default: 1.0 (parity with competitor).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'products'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', products = [], growthThreshold, shareThreshold, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_bcg_matrix', preview: title });

    try {
      if (!Array.isArray(products) || products.length === 0) {
        return { ok: false, error: 'products array is empty' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB', axisText: '#475569',
          star:     { fill: '#FEF3C7', bar: '#F59E0B', icon: '⭐', label: 'STARS' },
          cashCow:  { fill: '#ECFDF5', bar: '#10B981', icon: '🐄', label: 'CASH COWS' },
          question: { fill: '#DBEAFE', bar: '#2563EB', icon: '❓', label: 'QUESTION MARKS' },
          dog:      { fill: '#FEE2E2', bar: '#EF4444', icon: '🐕', label: 'DOGS' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8', axisText: '#CBD5E1',
          star:     { fill: '#78350F', bar: '#FBBF24', icon: '⭐', label: 'STARS' },
          cashCow:  { fill: '#064E3B', bar: '#34D399', icon: '🐄', label: 'CASH COWS' },
          question: { fill: '#1E3A8A', bar: '#60A5FA', icon: '❓', label: 'QUESTION MARKS' },
          dog:      { fill: '#7F1D1D', bar: '#F87171', icon: '🐕', label: 'DOGS' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A', axisText: '#475569',
          star:     { fill: '#F8FAFC', bar: '#F59E0B', icon: '⭐', label: 'STARS' },
          cashCow:  { fill: '#F8FAFC', bar: '#10B981', icon: '🐄', label: 'CASH COWS' },
          question: { fill: '#F8FAFC', bar: '#2563EB', icon: '❓', label: 'QUESTION MARKS' },
          dog:      { fill: '#F8FAFC', bar: '#EF4444', icon: '🐕', label: 'DOGS' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF', axisText: '#334155',
          star:     { fill: '#FFF8E1', bar: '#F9AB00', icon: '⭐', label: 'STARS' },
          cashCow:  { fill: '#E6F4EA', bar: '#0F9D58', icon: '🐄', label: 'CASH COWS' },
          question: { fill: '#E8F0FE', bar: '#1A73E8', icon: '❓', label: 'QUESTION MARKS' },
          dog:      { fill: '#FCE8E6', bar: '#D93025', icon: '🐕', label: 'DOGS' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const growthSplit = Number.isFinite(Number(growthThreshold)) ? Number(growthThreshold) : 10;
      const shareSplit = Number.isFinite(Number(shareThreshold)) ? Number(shareThreshold) : 1.0;
      const productList = products.slice(0, 20);

      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const axisGutter = 60;
      const gridSize = 560;
      const legendW = 240;
      const W = pad * 2 + axisGutter + gridSize + legendW + 24;
      const H = headerH + pad + gridSize + 60 + pad;

      const gridX = pad + axisGutter;
      const gridY = headerH + pad;
      const halfW = gridSize / 2;
      const halfH = gridSize / 2;
      const cx = gridX + halfW;
      const cy = gridY + halfH;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${productList.length} productos · BCG portfolio matrix</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Quadrant backgrounds (BCG convention: high growth top, high share LEFT
      // — but most modern BCG renderings put high share on the RIGHT.
      // We'll use the modern convention: high share = right, high growth = top.
      //  Q1 top-right    = STARS         (high growth, high share)
      //  Q2 top-left     = QUESTION MARKS (high growth, low share)
      //  Q3 bottom-right = CASH COWS     (low growth, high share)
      //  Q4 bottom-left  = DOGS          (low growth, low share)
      body += `<rect x="${gridX}" y="${gridY}" width="${halfW}" height="${halfH}" fill="${t.question.fill}" stroke="${t.border}" stroke-width="1"/>`;
      body += `<rect x="${cx}" y="${gridY}" width="${halfW}" height="${halfH}" fill="${t.star.fill}" stroke="${t.border}" stroke-width="1"/>`;
      body += `<rect x="${gridX}" y="${cy}" width="${halfW}" height="${halfH}" fill="${t.dog.fill}" stroke="${t.border}" stroke-width="1"/>`;
      body += `<rect x="${cx}" y="${cy}" width="${halfW}" height="${halfH}" fill="${t.cashCow.fill}" stroke="${t.border}" stroke-width="1"/>`;

      // Quadrant labels
      body += `<text x="${gridX + halfW / 2}" y="${gridY + 24}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.question.bar}">${xmlEscape(t.question.icon + ' ' + t.question.label)}</text>`;
      body += `<text x="${cx + halfW / 2}" y="${gridY + 24}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.star.bar}">${xmlEscape(t.star.icon + ' ' + t.star.label)}</text>`;
      body += `<text x="${gridX + halfW / 2}" y="${cy + 24}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.dog.bar}">${xmlEscape(t.dog.icon + ' ' + t.dog.label)}</text>`;
      body += `<text x="${cx + halfW / 2}" y="${cy + 24}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="${t.cashCow.bar}">${xmlEscape(t.cashCow.icon + ' ' + t.cashCow.label)}</text>`;

      // Plot products as bubbles
      // marketShare range: 0..2 → x in gridX..gridX+gridSize (clamped)
      // marketGrowth range: 0..30 → y inverted (higher growth → top); clamped
      // revenue → bubble radius (8..36)
      const maxRevenue = productList.reduce((max, p) => {
        const r = Number(p.revenue);
        return Number.isFinite(r) && r > max ? r : max;
      }, 1);
      const SHARE_MAX = Math.max(2, shareSplit * 2);
      const GROWTH_MAX = Math.max(20, growthSplit * 2);
      function shareToX(s) {
        const clamped = Math.max(0, Math.min(SHARE_MAX, Number(s) || 0));
        return gridX + (clamped / SHARE_MAX) * gridSize;
      }
      function growthToY(g) {
        const clamped = Math.max(0, Math.min(GROWTH_MAX, Number(g) || 0));
        return gridY + gridSize - (clamped / GROWTH_MAX) * gridSize;
      }
      function classifyProduct(p) {
        const g = Number(p.marketGrowth) || 0;
        const s = Number(p.marketShare) || 0;
        if (g >= growthSplit && s >= shareSplit) return 'star';
        if (g >= growthSplit && s < shareSplit) return 'question';
        if (g < growthSplit && s >= shareSplit) return 'cashCow';
        return 'dog';
      }

      const classified = productList.map((p, idx) => {
        const cls = classifyProduct(p);
        return {
          ...p,
          _cls: cls,
          _x: shareToX(p.marketShare),
          _y: growthToY(p.marketGrowth),
          _r: Number.isFinite(Number(p.revenue))
            ? Math.max(10, Math.min(36, 10 + (Number(p.revenue) / maxRevenue) * 26))
            : 16,
          _idx: idx + 1,
        };
      });

      // Draw bubbles
      classified.forEach((p) => {
        const pal = t[p._cls];
        body += `<circle cx="${p._x}" cy="${p._y}" r="${p._r}" fill="${pal.bar}" fill-opacity="0.7" stroke="${pal.bar}" stroke-width="2"/>`;
        body += `<text x="${p._x}" y="${p._y + 5}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="#fff">${p._idx}</text>`;
      });

      // Axis lines on top of quadrants
      body += `<line x1="${cx}" y1="${gridY}" x2="${cx}" y2="${gridY + gridSize}" stroke="${t.axisText}" stroke-width="2" stroke-dasharray="6,4" opacity="0.5"/>`;
      body += `<line x1="${gridX}" y1="${cy}" x2="${gridX + gridSize}" y2="${cy}" stroke="${t.axisText}" stroke-width="2" stroke-dasharray="6,4" opacity="0.5"/>`;

      // Axis labels
      body += `<text x="${gridX + gridSize / 2}" y="${gridY + gridSize + 24}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}">RELATIVE MARKET SHARE  →  (high = right)</text>`;
      body += `<text x="${pad + 16}" y="${gridY + gridSize / 2}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}" transform="rotate(-90, ${pad + 16}, ${gridY + gridSize / 2})">↑ MARKET GROWTH RATE (%)</text>`;
      // Tick numbers
      body += `<text x="${gridX}" y="${gridY + gridSize + 42}" font-family="Arial" font-size="10" fill="${t.muted}">0</text>`;
      body += `<text x="${cx}" y="${gridY + gridSize + 42}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="${t.accent}">${shareSplit}× (parity)</text>`;
      body += `<text x="${gridX + gridSize}" y="${gridY + gridSize + 42}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${SHARE_MAX}×</text>`;
      body += `<text x="${gridX - 8}" y="${gridY + gridSize}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">0%</text>`;
      body += `<text x="${gridX - 8}" y="${cy + 4}" text-anchor="end" font-family="Arial" font-size="10" font-weight="bold" fill="${t.accent}">${growthSplit}%</text>`;
      body += `<text x="${gridX - 8}" y="${gridY + 4}" text-anchor="end" font-family="Arial" font-size="10" fill="${t.muted}">${GROWTH_MAX}%</text>`;

      // Legend on the right
      const legendX = gridX + gridSize + 24;
      let lY = gridY + 8;
      body += `<text x="${legendX}" y="${lY}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">PORTFOLIO</text>`;
      lY += 18;
      classified.slice(0, 14).forEach((p) => {
        const pal = t[p._cls];
        body += `<circle cx="${legendX + 10}" cy="${lY - 4}" r="10" fill="${pal.bar}" fill-opacity="0.7"/>`;
        body += `<text x="${legendX + 10}" y="${lY - 1}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="#fff">${p._idx}</text>`;
        const name = xmlEscape(String(p.name || '').slice(0, 22));
        body += `<text x="${legendX + 24}" y="${lY}" font-family="Arial" font-size="11" font-weight="600" fill="${t.text}">${name}</text>`;
        const revText = Number.isFinite(Number(p.revenue)) ? ` · $${Number(p.revenue).toLocaleString('en-US')}` : '';
        body += `<text x="${legendX + 24}" y="${lY + 14}" font-family="Arial" font-size="9" fill="${t.muted}">share ${p.marketShare}× · growth ${p.marketGrowth}%${revText}</text>`;
        lY += 30;
      });
      if (classified.length > 14) {
        body += `<text x="${legendX}" y="${lY + 4}" font-family="Arial" font-size="10" fill="${t.muted}" font-style="italic">+ ${classified.length - 14} más</text>`;
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `BCG matrix: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `bcg_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      const tally = { stars: 0, cashCows: 0, questionMarks: 0, dogs: 0 };
      classified.forEach((p) => {
        if (p._cls === 'star') tally.stars += 1;
        else if (p._cls === 'cashCow') tally.cashCows += 1;
        else if (p._cls === 'question') tally.questionMarks += 1;
        else tally.dogs += 1;
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_bcg_matrix',
        ok: true,
        preview: `BCG listo: ${artifact.filename} (⭐:${tally.stars} 🐄:${tally.cashCows} ❓:${tally.questionMarks} 🐕:${tally.dogs}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        products: classified.length,
        tally,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_bcg_matrix', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 30: create_moscow_chart
// ─────────────────────────────────────────────────────────────────────────

const createMoscowChart = {
  name: 'create_moscow_chart',
  description: 'Generate a MoSCoW prioritization chart as an SVG file: 4 vertical columns categorising features / tasks by priority — Must Have, Should Have, Could Have, Won\'t Have (this time). Each column accepts 1-10 items. Use for agile backlog grooming, MVP scope decisions, requirement triage, or release planning.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Chart title (e.g. "MVP backlog — Sprint 14").' },
      subtitle: { type: 'string', description: 'Optional context line (e.g. release, team).' },
      mustHave:   { type: 'array', items: { type: 'string' }, description: 'Critical items required for the release to succeed (1-10).' },
      shouldHave: { type: 'array', items: { type: 'string' }, description: 'Important items but not critical for launch (1-10).' },
      couldHave:  { type: 'array', items: { type: 'string' }, description: 'Nice-to-have items that improve the release if time permits (1-10).' },
      wontHave:   { type: 'array', items: { type: 'string' }, description: 'Items explicitly excluded from this release (1-10).' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', mustHave = [], shouldHave = [], couldHave = [], wontHave = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_moscow_chart', preview: title });

    try {
      const all = [mustHave, shouldHave, couldHave, wontHave];
      if (!all.every(a => Array.isArray(a))) {
        return { ok: false, error: 'mustHave / shouldHave / couldHave / wontHave must be arrays' };
      }
      const totalItems = all.reduce((s, a) => s + a.length, 0);
      if (totalItems === 0) {
        return { ok: false, error: 'all 4 priority buckets are empty — provide at least one item' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          // Standard MoSCoW colour scheme (priority decreases red → amber → blue → grey)
          must:   { fill: '#FEE2E2', bar: '#DC2626', label: '#7F1D1D' },
          should: { fill: '#FEF3C7', bar: '#F59E0B', label: '#78350F' },
          could:  { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A' },
          wont:   { fill: '#F1F5F9', bar: '#64748B', label: '#334155' },
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          must:   { fill: '#7F1D1D', bar: '#F87171', label: '#FECACA' },
          should: { fill: '#78350F', bar: '#FBBF24', label: '#FDE68A' },
          could:  { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE' },
          wont:   { fill: '#334155', bar: '#94A3B8', label: '#E2E8F0' },
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          must:   { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A' },
          should: { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          could:  { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          wont:   { fill: '#F8FAFC', bar: '#94A3B8', label: '#0F172A' },
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          must:   { fill: '#FCE8E6', bar: '#D93025', label: '#7C1D14' },
          should: { fill: '#FFF8E1', bar: '#F9AB00', label: '#7C4A00' },
          could:  { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91' },
          wont:   { fill: '#F1F3F4', bar: '#5F6368', label: '#202124' },
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));

      const COLUMNS = [
        { key: 'must',   pal: t.must,   label: 'MUST HAVE',   subLabel: 'Critical · sin esto el release falla',         items: mustHave },
        { key: 'should', pal: t.should, label: 'SHOULD HAVE', subLabel: 'Importante · pero no crítico para launch',     items: shouldHave },
        { key: 'could',  pal: t.could,  label: 'COULD HAVE',  subLabel: 'Mejora si hay tiempo · prescindible',          items: couldHave },
        { key: 'wont',   pal: t.wont,   label: 'WON\'T HAVE', subLabel: 'Out of scope this release · revisar después',  items: wontHave },
      ];

      const colW = 260;
      const colGap = 12;
      const cardH = 50;
      const cardGap = 8;
      const colHeaderH = 80;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const lineMaxChars = 40;

      const formatted = COLUMNS.map(c => ({
        ...c,
        items: (c.items || []).slice(0, 10).map(x => xmlEscape(String(x || '').slice(0, lineMaxChars))).filter(Boolean),
      }));
      const maxItems = Math.max(...formatted.map(c => c.items.length), 1);
      const colInnerH = colHeaderH + maxItems * (cardH + cardGap) + 16;
      const W = pad * 2 + 4 * colW + 3 * colGap;
      const H = headerH + pad + colInnerH + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const headerMeta = `M:${formatted[0].items.length} · S:${formatted[1].items.length} · C:${formatted[2].items.length} · W:${formatted[3].items.length}`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${headerMeta}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Columns
      const topY = headerH + pad;
      formatted.forEach((col, ci) => {
        const cx = pad + ci * (colW + colGap);
        // Column background
        body += `<rect x="${cx}" y="${topY}" width="${colW}" height="${colInnerH}" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1" filter="url(#vis-shadow)"/>`;
        // Column header (color-coded)
        body += `<rect x="${cx}" y="${topY}" width="${colW}" height="${colHeaderH}" rx="10" fill="${col.pal.fill}"/>`;
        body += `<rect x="${cx}" y="${topY + colHeaderH - 3}" width="${colW}" height="3" fill="${col.pal.bar}"/>`;
        // Big M/S/C/W letter
        body += `<circle cx="${cx + 26}" cy="${topY + 30}" r="18" fill="${col.pal.bar}"/>`;
        body += `<text x="${cx + 26}" y="${topY + 37}" text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#fff">${col.label[0]}</text>`;
        // Label + sublabel
        body += `<text x="${cx + 52}" y="${topY + 30}" font-family="Arial" font-size="14" font-weight="bold" fill="${col.pal.label}">${xmlEscape(col.label)}</text>`;
        // Sub-label wrap
        const subWords = col.subLabel.split(' ');
        let line1 = '';
        let line2 = '';
        for (const w of subWords) {
          if ((line1 + ' ' + w).trim().length < 30) line1 = (line1 + ' ' + w).trim();
          else line2 = (line2 + ' ' + w).trim();
        }
        body += `<text x="${cx + 52}" y="${topY + 46}" font-family="Arial" font-size="10" fill="${t.muted}">${xmlEscape(line1)}</text>`;
        if (line2) body += `<text x="${cx + 52}" y="${topY + 60}" font-family="Arial" font-size="10" fill="${t.muted}">${xmlEscape(line2)}</text>`;
        // Count badge top-right
        body += `<text x="${cx + colW - 16}" y="${topY + 30}" text-anchor="end" font-family="Arial" font-size="14" font-weight="bold" fill="${col.pal.bar}">${col.items.length}</text>`;

        // Cards
        if (col.items.length === 0) {
          body += `<text x="${cx + colW / 2}" y="${topY + colHeaderH + 40}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.muted}" font-style="italic">— sin items —</text>`;
        } else {
          col.items.forEach((line, idx) => {
            const ky = topY + colHeaderH + 12 + idx * (cardH + cardGap);
            const kx = cx + 10;
            const kW = colW - 20;
            body += `<rect x="${kx}" y="${ky}" width="${kW}" height="${cardH}" rx="6" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>`;
            body += `<rect x="${kx}" y="${ky}" width="4" height="${cardH}" rx="2" fill="${col.pal.bar}"/>`;
            // Title (wrap to up to 2 lines if needed)
            const words = line.split(' ');
            let l1 = '';
            let l2 = '';
            for (const w of words) {
              if ((l1 + ' ' + w).trim().length < 32) l1 = (l1 + ' ' + w).trim();
              else l2 = (l2 + ' ' + w).trim();
            }
            body += `<text x="${kx + 14}" y="${ky + 22}" font-family="Arial" font-size="12" font-weight="600" fill="${t.text}">${l1}</text>`;
            if (l2) body += `<text x="${kx + 14}" y="${ky + 38}" font-family="Arial" font-size="11" fill="${t.muted}">${l2}</text>`;
          });
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `MoSCoW chart: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `moscow_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_moscow_chart',
        ok: true,
        preview: `MoSCoW listo: ${artifact.filename} (${totalItems} items, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        counts: {
          mustHave:   formatted[0].items.length,
          shouldHave: formatted[1].items.length,
          couldHave:  formatted[2].items.length,
          wontHave:   formatted[3].items.length,
        },
        total: totalItems,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_moscow_chart', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 31: create_decision_tree
// ─────────────────────────────────────────────────────────────────────────

const createDecisionTree = {
  name: 'create_decision_tree',
  description: 'Generate a decision tree as an SVG file: a top-down branching diagram with a root decision and recursive yes/no/labelled branches leading to outcome leaves. Use for decision flowcharts, classifier explainability, triage trees, eligibility checks, or any branching logic visualisation. Supports up to 4 levels deep and up to 4 branches per node.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Tree title (e.g. "Account eligibility decision").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      root: {
        type: 'object',
        description: 'Root node — has the top-level decision. Recursive { text, isOutcome?, branches?: [{ label, node }] }.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'root'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', root, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_decision_tree', preview: title });

    try {
      if (!root || typeof root !== 'object' || !root.text) {
        return { ok: false, error: 'root node missing or invalid — provide { text, branches? }' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          decision: { fill: '#DBEAFE', bar: '#2563EB', label: '#1E3A8A' },
          outcome:  { fill: '#ECFDF5', bar: '#10B981', label: '#065F46' },
          edge: '#94A3B8',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          decision: { fill: '#1E3A8A', bar: '#60A5FA', label: '#BFDBFE' },
          outcome:  { fill: '#064E3B', bar: '#34D399', label: '#A7F3D0' },
          edge: '#94A3B8',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          decision: { fill: '#F8FAFC', bar: '#0F172A', label: '#0F172A' },
          outcome:  { fill: '#F8FAFC', bar: '#475569', label: '#0F172A' },
          edge: '#94A3B8',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          decision: { fill: '#E8F0FE', bar: '#1A73E8', label: '#0B3D91' },
          outcome:  { fill: '#E6F4EA', bar: '#0F9D58', label: '#1B5E20' },
          edge: '#5F6368',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const MAX_DEPTH = 4;
      const MAX_BRANCHES = 4;
      const NODE_W = 200;
      const NODE_H = 60;
      const V_SPACE = 110;
      const H_SPACE_MIN = 28;

      // Normalise the tree (recursive): trim each branch's children to
      // MAX_BRANCHES and stop expanding past MAX_DEPTH (forcing those
      // nodes to become leaves). Compute leafCount per subtree so we
      // can later allocate horizontal space proportionally.
      function normalise(node, depth) {
        if (!node || typeof node !== 'object') {
          return { text: '?', isOutcome: true, branches: [], leafCount: 1, depth };
        }
        const isAtMaxDepth = depth >= MAX_DEPTH - 1;
        const rawBranches = Array.isArray(node.branches) ? node.branches.slice(0, MAX_BRANCHES) : [];
        const isOutcomeFlag = !!node.isOutcome || rawBranches.length === 0 || isAtMaxDepth;
        const branches = isOutcomeFlag
          ? []
          : rawBranches
            .filter(b => b && typeof b === 'object' && b.node)
            .map(b => ({
              label: xmlEscape(String(b.label || '').slice(0, 18)),
              node: normalise(b.node, depth + 1),
            }));
        const leafCount = branches.length === 0
          ? 1
          : branches.reduce((s, b) => s + b.node.leafCount, 0);
        return {
          text: xmlEscape(String(node.text || '').slice(0, 50)),
          isOutcome: isOutcomeFlag,
          branches,
          leafCount,
          depth,
        };
      }
      const tree = normalise(root, 0);

      // Position each node: x is the centre of its allocated horizontal
      // slot (one unit per descendant leaf), y is depth × V_SPACE.
      // Returns flattened nodes + edges for SVG render.
      function layout(node, leftX, rightX, depth, nodes, edges, parentCenter) {
        const centerX = (leftX + rightX) / 2;
        const y = depth * V_SPACE;
        nodes.push({ x: centerX, y, node });
        if (parentCenter) {
          edges.push({ x1: parentCenter.x, y1: parentCenter.y + NODE_H, x2: centerX, y2: y, label: parentCenter.label });
        }
        if (node.branches.length === 0) return;
        let cursor = leftX;
        node.branches.forEach((branch) => {
          const slotW = ((rightX - leftX) * branch.node.leafCount) / node.leafCount;
          const childLeft = cursor;
          const childRight = cursor + slotW;
          layout(branch.node, childLeft, childRight, depth + 1, nodes, edges, {
            x: centerX, y, label: branch.label,
          });
          cursor += slotW;
        });
      }
      const nodes = [];
      const edges = [];
      const totalWidth = Math.max(tree.leafCount * (NODE_W + H_SPACE_MIN), NODE_W + 80);
      layout(tree, 0, totalWidth, 0, nodes, edges, null);

      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      // Compute bounding box from positioned nodes
      const minX = Math.min(...nodes.map(n => n.x - NODE_W / 2));
      const maxX = Math.max(...nodes.map(n => n.x + NODE_W / 2));
      const maxDepth = Math.max(...nodes.map(n => n.node.depth));
      const offsetX = pad - minX;
      const offsetY = headerH + pad;
      const W = pad * 2 + (maxX - minX);
      const H = headerH + pad + (maxDepth * V_SPACE) + NODE_H + pad + 40;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const outcomeCount = nodes.filter(n => n.node.isOutcome).length;
      const decisionCount = nodes.length - outcomeCount;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${decisionCount} decisión${decisionCount === 1 ? '' : 'es'} · ${outcomeCount} resultado${outcomeCount === 1 ? '' : 's'} · prof ${maxDepth + 1}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Render edges first (so nodes sit on top)
      edges.forEach((e) => {
        const x1 = e.x1 + offsetX;
        const y1 = e.y1 + offsetY;
        const x2 = e.x2 + offsetX;
        const y2 = e.y2 + offsetY;
        // Smooth curve from bottom of parent to top of child (cubic)
        const midY = (y1 + y2) / 2;
        const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
        body += `<path d="${path}" stroke="${t.edge}" stroke-width="1.5" fill="none" opacity="0.7"/>`;
        // Branch label at the midpoint
        if (e.label) {
          const labelW = Math.max(40, e.label.length * 6 + 12);
          body += `<rect x="${(x1 + x2) / 2 - labelW / 2}" y="${midY - 10}" width="${labelW}" height="20" rx="10" fill="${t.card}" stroke="${t.edge}" stroke-width="1"/>`;
          body += `<text x="${(x1 + x2) / 2}" y="${midY + 4}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.text}">${e.label}</text>`;
        }
      });

      // Render nodes
      nodes.forEach((n) => {
        const x = n.x + offsetX - NODE_W / 2;
        const y = n.y + offsetY;
        const pal = n.node.isOutcome ? t.outcome : t.decision;
        // Shape: rounded rectangle for decision; squared with strong corners for outcome
        const rx = n.node.isOutcome ? 14 : 8;
        body += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="${rx}" fill="${pal.fill}" stroke="${pal.bar}" stroke-width="${n.node.isOutcome ? 2 : 1.5}" filter="url(#vis-shadow)"/>`;
        body += `<rect x="${x}" y="${y}" width="6" height="${NODE_H}" rx="3" fill="${pal.bar}"/>`;
        // Icon
        const icon = n.node.isOutcome ? '▶' : '?';
        body += `<text x="${x + 22}" y="${y + NODE_H / 2 + 5}" font-family="Arial" font-size="16" font-weight="bold" fill="${pal.bar}">${icon}</text>`;
        // Text (wrap to up to 2 lines, ~22 chars per line)
        const text = n.node.text;
        let l1 = '';
        let l2 = '';
        const words = text.split(' ');
        for (const w of words) {
          if ((l1 + ' ' + w).trim().length < 22) l1 = (l1 + ' ' + w).trim();
          else l2 = (l2 + ' ' + w).trim();
        }
        if (l2) {
          body += `<text x="${x + 38}" y="${y + NODE_H / 2 - 2}" font-family="Arial" font-size="12" font-weight="bold" fill="${pal.label}">${l1}</text>`;
          body += `<text x="${x + 38}" y="${y + NODE_H / 2 + 14}" font-family="Arial" font-size="11" fill="${pal.label}">${l2}</text>`;
        } else {
          body += `<text x="${x + 38}" y="${y + NODE_H / 2 + 5}" font-family="Arial" font-size="13" font-weight="bold" fill="${pal.label}">${l1}</text>`;
        }
      });

      // Legend at the bottom
      const legendY = H - 28;
      body += `<rect x="${pad}" y="${legendY - 14}" width="14" height="14" rx="3" fill="${t.decision.fill}" stroke="${t.decision.bar}" stroke-width="1.5"/>`;
      body += `<text x="${pad + 22}" y="${legendY - 3}" font-family="Arial" font-size="11" fill="${t.text}">? Decisión</text>`;
      body += `<rect x="${pad + 110}" y="${legendY - 14}" width="14" height="14" rx="7" fill="${t.outcome.fill}" stroke="${t.outcome.bar}" stroke-width="2"/>`;
      body += `<text x="${pad + 132}" y="${legendY - 3}" font-family="Arial" font-size="11" fill="${t.text}">▶ Resultado</text>`;

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Decision tree: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `dtree_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_decision_tree',
        ok: true,
        preview: `Decision tree: ${artifact.filename} (${nodes.length} nodos · prof ${maxDepth + 1}, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        nodes: nodes.length,
        outcomes: outcomeCount,
        decisions: decisionCount,
        depth: maxDepth + 1,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_decision_tree', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 32: create_concept_map
// ─────────────────────────────────────────────────────────────────────────

const createConceptMap = {
  name: 'create_concept_map',
  description: 'Generate a concept map as an SVG file: an undirected node-link graph laid out radially with N concept nodes (2-12) and M labelled edges representing semantic relations between them. Use for knowledge maps, taxonomy diagrams, semantic-network visualisations, or any free-form node-link graph. Distinct from create_decision_tree (hierarchical) and create_organigram (parent-child).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Map title (e.g. "AI agent components").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id:       { type: 'string', description: 'Unique node identifier.' },
            label:    { type: 'string', description: 'Display label.' },
            category: { type: 'string', description: 'Optional category for color grouping.' },
          },
          required: ['id', 'label'],
        },
        description: '2-12 nodes.',
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from:  { type: 'string', description: 'Source node id.' },
            to:    { type: 'string', description: 'Target node id.' },
            label: { type: 'string', description: 'Optional relation label.' },
          },
          required: ['from', 'to'],
        },
        description: '0-30 edges between node ids.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'nodes'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', nodes = [], edges = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_concept_map', preview: title });

    try {
      if (!Array.isArray(nodes) || nodes.length < 2) {
        return { ok: false, error: 'concept map requires at least 2 nodes' };
      }
      if (nodes.length > 12) {
        return { ok: false, error: 'concept map supports at most 12 nodes' };
      }
      const edgeList = Array.isArray(edges) ? edges.slice(0, 30) : [];

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          edge: '#94A3B8',
          palette: ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'],
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          edge: '#94A3B8',
          palette: ['#60A5FA', '#34D399', '#FBBF24', '#F87171', '#A78BFA', '#F472B6', '#22D3EE', '#A3E635'],
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          edge: '#94A3B8',
          palette: ['#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'],
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          edge: '#5F6368',
          palette: ['#1A73E8', '#0F9D58', '#F9AB00', '#D93025', '#673AB7', '#E91E63', '#039BE5', '#A5D86C'],
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const labelMaxChars = 22;

      // Validate node IDs and labels
      const nodeMap = new Map();
      const nodeList = nodes.slice(0, 12).map((n, idx) => {
        const id = String(n.id || `n${idx}`);
        const node = {
          id,
          label: xmlEscape(String(n.label || '').slice(0, labelMaxChars)),
          category: xmlEscape(String(n.category || '').slice(0, 16)),
          _idx: idx,
        };
        nodeMap.set(id, node);
        return node;
      });

      // Determine category-color assignments (one palette colour per distinct category)
      const categorySeen = new Map();
      nodeList.forEach((n) => {
        const cat = n.category || '__default__';
        if (!categorySeen.has(cat)) categorySeen.set(cat, categorySeen.size);
        n._color = t.palette[categorySeen.get(cat) % t.palette.length];
      });

      // Circular layout: place nodes evenly around a circle
      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      const radius = 200;
      const plotSize = radius * 2 + 120; // padding for labels
      const legendW = categorySeen.size > 1 ? 200 : 0;
      const W = pad * 2 + plotSize + (legendW > 0 ? legendW + 24 : 0);
      const H = headerH + pad + plotSize + pad;
      const cx = pad + plotSize / 2;
      const cy = headerH + pad + plotSize / 2;
      const NODE_R = 38;

      function nodeAngle(idx) {
        return (-Math.PI / 2) + (2 * Math.PI * idx) / nodeList.length;
      }
      nodeList.forEach((n) => {
        const ang = nodeAngle(n._idx);
        n._x = cx + Math.cos(ang) * radius;
        n._y = cy + Math.sin(ang) * radius;
      });

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${nodeList.length} concepto${nodeList.length === 1 ? '' : 's'} · ${edgeList.length} relación${edgeList.length === 1 ? '' : 'es'}</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Render edges first
      const validEdges = edgeList
        .filter(e => e && nodeMap.has(String(e.from)) && nodeMap.has(String(e.to)))
        .map(e => ({
          from: nodeMap.get(String(e.from)),
          to:   nodeMap.get(String(e.to)),
          label: e.label ? xmlEscape(String(e.label).slice(0, 24)) : '',
        }));
      validEdges.forEach((e) => {
        // Calculate edge endpoints just outside the node circles
        const dx = e.to._x - e.from._x;
        const dy = e.to._y - e.from._y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return;
        const ux = dx / dist;
        const uy = dy / dist;
        const x1 = e.from._x + ux * NODE_R;
        const y1 = e.from._y + uy * NODE_R;
        const x2 = e.to._x - ux * NODE_R;
        const y2 = e.to._y - uy * NODE_R;
        // Slight curve through the centre region for visual breathability
        const midX = (x1 + x2) / 2 + (cy - (y1 + y2) / 2) * 0.04;
        const midY = (y1 + y2) / 2 - (cx - (x1 + x2) / 2) * 0.04;
        body += `<path d="M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}" stroke="${t.edge}" stroke-width="1.5" fill="none" opacity="0.7"/>`;
        if (e.label) {
          const labelW = Math.max(40, e.label.length * 6 + 12);
          body += `<rect x="${midX - labelW / 2}" y="${midY - 10}" width="${labelW}" height="18" rx="9" fill="${t.card}" stroke="${t.edge}" stroke-width="1"/>`;
          body += `<text x="${midX}" y="${midY + 3}" text-anchor="middle" font-family="Arial" font-size="10" fill="${t.text}">${e.label}</text>`;
        }
      });

      // Render nodes
      nodeList.forEach((n) => {
        body += `<circle cx="${n._x}" cy="${n._y}" r="${NODE_R}" fill="${n._color}" stroke="${t.card}" stroke-width="3" filter="url(#vis-shadow)"/>`;
        // Wrap label to 2 lines (~12 chars per line)
        const words = n.label.split(' ');
        let l1 = '';
        let l2 = '';
        for (const w of words) {
          if ((l1 + ' ' + w).trim().length < 12) l1 = (l1 + ' ' + w).trim();
          else l2 = (l2 + ' ' + w).trim();
        }
        if (l2) {
          body += `<text x="${n._x}" y="${n._y - 2}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${l1}</text>`;
          body += `<text x="${n._x}" y="${n._y + 12}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${l2}</text>`;
        } else {
          body += `<text x="${n._x}" y="${n._y + 4}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#fff">${l1}</text>`;
        }
      });

      // Legend (if multiple categories)
      if (legendW > 0) {
        const legendX = cx + plotSize / 2 + 24;
        let lY = cy - radius;
        body += `<text x="${legendX}" y="${lY}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">CATEGORÍAS</text>`;
        lY += 18;
        const seenLegend = new Set();
        nodeList.forEach((n) => {
          const cat = n.category || '__default__';
          if (seenLegend.has(cat)) return;
          seenLegend.add(cat);
          const labelName = n.category || '(sin categoría)';
          body += `<circle cx="${legendX + 10}" cy="${lY - 4}" r="8" fill="${n._color}"/>`;
          body += `<text x="${legendX + 24}" y="${lY}" font-family="Arial" font-size="11" fill="${t.text}">${xmlEscape(labelName)}</text>`;
          lY += 22;
        });
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Concept map: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `concept_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_concept_map',
        ok: true,
        preview: `Concept map: ${artifact.filename} (${nodeList.length} nodos, ${validEdges.length} relaciones · ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        nodes: nodeList.length,
        edges: validEdges.length,
        categories: categorySeen.size,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_concept_map', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 33: create_mindmap_radial
// ─────────────────────────────────────────────────────────────────────────

const createMindmapRadial = {
  name: 'create_mindmap_radial',
  description: 'Generate a radial mindmap as an SVG file: a central topic with 2-8 main branches radiating outward, each main branch with 0-5 sub-branches. Use for brainstorming, knowledge organization, project planning, content outlines, or any hierarchical-radial visualization. Distinct from create_decision_tree (top-down) and create_concept_map (free graph) — this is the canonical mindmap shape.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Mindmap title (e.g. "Sprint planning").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      centralTopic: { type: 'string', description: 'Text in the central node (the root topic).' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label:    { type: 'string', description: 'Main branch label.' },
            color:    { type: 'string', description: 'Optional hex color override.' },
            children: { type: 'array', items: { type: 'string' }, description: '0-5 sub-branch labels.' },
          },
          required: ['label'],
        },
        description: '2-8 main branches radiating from the centre.',
      },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'centralTopic', 'branches'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', centralTopic = '', branches = [], theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_mindmap_radial', preview: title });

    try {
      if (!Array.isArray(branches) || branches.length === 0) {
        return { ok: false, error: 'branches array is empty' };
      }
      if (branches.length < 2) {
        return { ok: false, error: 'mindmap requires at least 2 main branches' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          centerFill: '#2563EB', centerText: '#FFFFFF',
          palette: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'],
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          centerFill: '#818CF8', centerText: '#0F172A',
          palette: ['#60A5FA', '#34D399', '#FBBF24', '#F87171', '#A78BFA', '#F472B6', '#22D3EE', '#A3E635'],
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          centerFill: '#0F172A', centerText: '#FFFFFF',
          palette: ['#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'],
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          centerFill: '#1E40AF', centerText: '#FFFFFF',
          palette: ['#1A73E8', '#0F9D58', '#F9AB00', '#D93025', '#673AB7', '#E91E63', '#039BE5', '#A5D86C'],
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const safeCentral = xmlEscape(String(centralTopic || 'Topic').slice(0, 28));
      const branchList = branches.slice(0, 8).map((b, idx) => ({
        label: xmlEscape(String(b.label || '').slice(0, 24)),
        children: (Array.isArray(b.children) ? b.children : []).slice(0, 5).map(c => xmlEscape(String(c || '').slice(0, 22))).filter(Boolean),
        color: b.color && /^#[0-9A-Fa-f]{6}$/.test(b.color) ? b.color : t.palette[idx % t.palette.length],
        _idx: idx,
      }));
      const n = branchList.length;

      const headerH = safeSubtitle ? 110 : 86;
      const pad = 28;
      const centerR = 58;
      const branchR = radiusAround => 170;
      const childR = 290;
      const plotSize = childR * 2 + 220; // padding for child labels
      const W = pad * 2 + plotSize;
      const H = headerH + pad + plotSize + pad;
      const cx = pad + plotSize / 2;
      const cy = headerH + pad + plotSize / 2;

      function branchAngle(i) {
        return (-Math.PI / 2) + (2 * Math.PI * i) / n;
      }

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      const totalChildren = branchList.reduce((s, b) => s + b.children.length, 0);
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${n} ramas · ${totalChildren} sub-temas</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Render branches (lines + child fan, before nodes so they sit underneath)
      branchList.forEach((br) => {
        const ang = branchAngle(br._idx);
        const bx = cx + Math.cos(ang) * branchR();
        const by = cy + Math.sin(ang) * branchR();

        // Trunk line from centre edge to branch node
        const trunkStartX = cx + Math.cos(ang) * centerR;
        const trunkStartY = cy + Math.sin(ang) * centerR;
        body += `<line x1="${trunkStartX}" y1="${trunkStartY}" x2="${bx}" y2="${by}" stroke="${br.color}" stroke-width="3" stroke-linecap="round" opacity="0.8"/>`;

        // Children fan out from branch node
        if (br.children.length > 0) {
          // Spread children in a ±35° arc around the branch direction
          const childSpread = Math.PI / 2.4; // ~75 degrees total
          const childCount = br.children.length;
          br.children.forEach((child, idx) => {
            const offset = childCount === 1 ? 0 : (idx / (childCount - 1) - 0.5) * childSpread;
            const childAng = ang + offset;
            const ccx = cx + Math.cos(childAng) * childR;
            const ccy = cy + Math.sin(childAng) * childR;
            // Curve from branch node to child
            const midX = (bx + ccx) / 2;
            const midY = (by + ccy) / 2;
            body += `<path d="M ${bx} ${by} Q ${midX} ${midY}, ${ccx} ${ccy}" stroke="${br.color}" stroke-width="2" fill="none" opacity="0.6"/>`;
            // Child marker
            const labelW = Math.max(80, child.length * 6.5 + 16);
            const labelH = 26;
            body += `<rect x="${ccx - labelW / 2}" y="${ccy - labelH / 2}" width="${labelW}" height="${labelH}" rx="13" fill="${t.card}" stroke="${br.color}" stroke-width="1.5"/>`;
            body += `<text x="${ccx}" y="${ccy + 5}" text-anchor="middle" font-family="Arial" font-size="11" fill="${t.text}">${child}</text>`;
          });
        }

        // Branch node (rendered on top of trunk)
        const branchNodeR = 36;
        body += `<circle cx="${bx}" cy="${by}" r="${branchNodeR}" fill="${br.color}" stroke="${t.card}" stroke-width="3" filter="url(#vis-shadow)"/>`;
        // Branch label (wrap to 2 lines at ~10 chars)
        const words = br.label.split(' ');
        let l1 = '';
        let l2 = '';
        for (const w of words) {
          if ((l1 + ' ' + w).trim().length < 10) l1 = (l1 + ' ' + w).trim();
          else l2 = (l2 + ' ' + w).trim();
        }
        if (l2) {
          body += `<text x="${bx}" y="${by - 2}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${l1}</text>`;
          body += `<text x="${bx}" y="${by + 12}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${l2}</text>`;
        } else {
          body += `<text x="${bx}" y="${by + 4}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#fff">${l1}</text>`;
        }
      });

      // Render central node on top
      body += `<circle cx="${cx}" cy="${cy}" r="${centerR}" fill="${t.centerFill}" stroke="${t.card}" stroke-width="4" filter="url(#vis-shadow)"/>`;
      // Wrap central topic to up to 2 lines
      const centralWords = safeCentral.split(' ');
      let cl1 = '';
      let cl2 = '';
      for (const w of centralWords) {
        if ((cl1 + ' ' + w).trim().length < 14) cl1 = (cl1 + ' ' + w).trim();
        else cl2 = (cl2 + ' ' + w).trim();
      }
      if (cl2) {
        body += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="Georgia, serif" font-size="14" font-weight="bold" fill="${t.centerText}">${cl1}</text>`;
        body += `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="Georgia, serif" font-size="14" font-weight="bold" fill="${t.centerText}">${cl2}</text>`;
      } else {
        body += `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="Georgia, serif" font-size="15" font-weight="bold" fill="${t.centerText}">${cl1}</text>`;
      }

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Radial mindmap: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `mindmap_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_mindmap_radial',
        ok: true,
        preview: `Mindmap: ${artifact.filename} (${n} ramas · ${totalChildren} sub-temas, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        centralTopic: safeCentral,
        branches: n,
        subtopics: totalChildren,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_mindmap_radial', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 34: create_swimlane_diagram
// ─────────────────────────────────────────────────────────────────────────

const createSwimlaneDiagram = {
  name: 'create_swimlane_diagram',
  description: 'Generate a BPM swimlane diagram as an SVG file: a grid of N actor/role lanes (rows) × M sequential stages (columns). Each task is placed in a specific (lane, stage) cell, and adjacent tasks connect with arrows showing handoffs. Distinct from create_raci_matrix (task × role table) and create_process_flow (linear single-actor flow) — swimlane shows how a process flows across multiple actors AND stages.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Diagram title (e.g. "Customer onboarding").' },
      subtitle: { type: 'string', description: 'Optional context line.' },
      lanes: { type: 'array', items: { type: 'string' }, description: '2-6 lane labels (actors/roles).' },
      stages: { type: 'array', items: { type: 'string' }, description: '2-7 stage labels (time progression).' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Task label.' },
            lane:  { type: 'integer', description: 'Lane index (0-based, in the order of lanes[]).' },
            stage: { type: 'integer', description: 'Stage index (0-based, in the order of stages[]).' },
            color: { type: 'string', description: 'Optional hex color override.' },
          },
          required: ['label', 'lane', 'stage'],
        },
        description: '1-30 tasks placed across lanes × stages.',
      },
      showHandoffs: { type: 'boolean', description: 'Draw arrows between consecutive tasks (by stage order). Default: true.' },
      theme: { type: 'string', enum: ['professional', 'modern', 'minimal', 'corporate'], description: 'Visual theme. Default: "professional".' },
    },
    required: ['title', 'lanes', 'stages', 'tasks'],
    additionalProperties: false,
  },
  async execute({ title, subtitle = '', lanes = [], stages = [], tasks = [], showHandoffs = true, theme = 'professional' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'create_swimlane_diagram', preview: title });

    try {
      if (!Array.isArray(lanes) || lanes.length === 0) {
        return { ok: false, error: 'lanes array is empty' };
      }
      if (lanes.length < 2) {
        return { ok: false, error: 'swimlane requires at least 2 lanes' };
      }
      if (!Array.isArray(stages) || stages.length === 0) {
        return { ok: false, error: 'stages array is empty' };
      }
      if (stages.length < 2) {
        return { ok: false, error: 'swimlane requires at least 2 stages' };
      }
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { ok: false, error: 'tasks array is empty' };
      }

      const themes = {
        professional: {
          bg: '#FAFBFC', card: '#FFFFFF', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', accent: '#2563EB',
          stageBand: '#F1F5F9', laneAlt: '#F8FAFC',
          palette: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
          arrow: '#94A3B8',
        },
        modern: {
          bg: '#0B1121', card: '#1E293B', text: '#F1F5F9', muted: '#94A3B8', border: '#334155', accent: '#818CF8',
          stageBand: '#162033', laneAlt: '#0F172A',
          palette: ['#60A5FA', '#34D399', '#FBBF24', '#F87171', '#A78BFA', '#F472B6'],
          arrow: '#94A3B8',
        },
        minimal: {
          bg: '#FFFFFF', card: '#FFFFFF', text: '#0F172A', muted: '#64748B', border: '#CBD5E1', accent: '#0F172A',
          stageBand: '#F1F5F9', laneAlt: '#F8FAFC',
          palette: ['#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8'],
          arrow: '#94A3B8',
        },
        corporate: {
          bg: '#F8FAFC', card: '#FFFFFF', text: '#0F172A', muted: '#475569', border: '#CBD5E1', accent: '#1E40AF',
          stageBand: '#E8F0FE', laneAlt: '#F1F5F9',
          palette: ['#1A73E8', '#0F9D58', '#F9AB00', '#D93025', '#673AB7', '#E91E63'],
          arrow: '#5F6368',
        },
      };
      const t = themes[theme] || themes.professional;

      const safeTitle = xmlEscape(String(title).slice(0, 120));
      const safeSubtitle = xmlEscape(String(subtitle || '').slice(0, 140));
      const laneList = lanes.slice(0, 6).map(l => xmlEscape(String(l || '').slice(0, 24)));
      const stageList = stages.slice(0, 7).map(s => xmlEscape(String(s || '').slice(0, 24)));
      const validTasks = tasks
        .slice(0, 30)
        .map((t, i) => ({
          label: xmlEscape(String(t.label || '').slice(0, 28)),
          lane: Math.max(0, Math.min(laneList.length - 1, Math.round(Number(t.lane) || 0))),
          stage: Math.max(0, Math.min(stageList.length - 1, Math.round(Number(t.stage) || 0))),
          color: t.color && /^#[0-9A-Fa-f]{6}$/.test(t.color) ? t.color : null,
          _idx: i,
        }))
        .filter(t => t.label);

      const laneLabelW = 140;
      const stageColW = 180;
      const stageBandH = 50;
      const laneH = 100;
      const pad = 28;
      const headerH = safeSubtitle ? 110 : 86;
      const W = pad * 2 + laneLabelW + stageColW * stageList.length;
      const H = headerH + pad + stageBandH + laneH * laneList.length + pad;

      let body = `<rect width="${W}" height="${H}" fill="${t.bg}" rx="12"/>`;
      // Header
      body += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${t.accent}"/>`;
      body += `<text x="${W / 2}" y="42" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-weight="bold" fill="#fff">${safeTitle}</text>`;
      body += `<text x="${W / 2}" y="66" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff" opacity="0.85">${laneList.length} actores × ${stageList.length} etapas · ${validTasks.length} tareas</text>`;
      if (safeSubtitle) {
        body += `<text x="${W / 2}" y="92" text-anchor="middle" font-family="Arial" font-size="13" fill="#fff" opacity="0.92">${safeSubtitle}</text>`;
      }

      // Stage band (top)
      const bandY = headerH + pad;
      const gridX = pad + laneLabelW;
      body += `<rect x="${gridX}" y="${bandY}" width="${stageColW * stageList.length}" height="${stageBandH}" fill="${t.stageBand}" stroke="${t.border}" stroke-width="1"/>`;
      stageList.forEach((label, i) => {
        const x = gridX + i * stageColW;
        body += `<line x1="${x}" y1="${bandY}" x2="${x}" y2="${bandY + stageBandH}" stroke="${t.border}" stroke-width="1"/>`;
        body += `<text x="${x + stageColW / 2}" y="${bandY + 22}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="${t.muted}">ETAPA ${i + 1}</text>`;
        body += `<text x="${x + stageColW / 2}" y="${bandY + 38}" text-anchor="middle" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${label}</text>`;
      });

      // Lane labels + lane backgrounds
      const lanesY = bandY + stageBandH;
      laneList.forEach((label, i) => {
        const ly = lanesY + i * laneH;
        const isAlt = i % 2 === 1;
        // Lane label cell
        const laneColor = t.palette[i % t.palette.length];
        body += `<rect x="${pad}" y="${ly}" width="${laneLabelW}" height="${laneH}" fill="${laneColor}" opacity="0.12" stroke="${t.border}" stroke-width="0.5"/>`;
        body += `<rect x="${pad}" y="${ly}" width="6" height="${laneH}" fill="${laneColor}"/>`;
        body += `<text x="${pad + 18}" y="${ly + laneH / 2 - 4}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${label}</text>`;
        body += `<text x="${pad + 18}" y="${ly + laneH / 2 + 14}" font-family="Arial" font-size="10" fill="${t.muted}">ACTOR ${i + 1}</text>`;
        // Lane grid (cells)
        body += `<rect x="${gridX}" y="${ly}" width="${stageColW * stageList.length}" height="${laneH}" fill="${isAlt ? t.laneAlt : t.card}" stroke="${t.border}" stroke-width="0.5"/>`;
        // Vertical column separators within the lane
        stageList.forEach((_, si) => {
          if (si > 0) {
            const sx = gridX + si * stageColW;
            body += `<line x1="${sx}" y1="${ly}" x2="${sx}" y2="${ly + laneH}" stroke="${t.border}" stroke-width="0.5" stroke-dasharray="3,3"/>`;
          }
        });
      });

      // Task positions for handoff arrows
      const taskRects = validTasks.map((task) => {
        const x = gridX + task.stage * stageColW;
        const y = lanesY + task.lane * laneH;
        // Task card sized so it fits within cell with padding
        const tx = x + 16;
        const ty = y + 18;
        const tw = stageColW - 32;
        const th = laneH - 36;
        const color = task.color || t.palette[task.lane % t.palette.length];
        return { task, x: tx, y: ty, w: tw, h: th, color };
      });

      // Handoff arrows (sorted by stage so they show natural flow)
      if (showHandoffs && taskRects.length >= 2) {
        const sortedRects = [...taskRects].sort((a, b) => {
          if (a.task.stage !== b.task.stage) return a.task.stage - b.task.stage;
          return a.task.lane - b.task.lane;
        });
        for (let i = 0; i < sortedRects.length - 1; i++) {
          const a = sortedRects[i];
          const b = sortedRects[i + 1];
          if (a.task.stage === b.task.stage) continue; // same column — not a handoff
          const ax = a.x + a.w;
          const ay = a.y + a.h / 2;
          const bx = b.x;
          const by = b.y + b.h / 2;
          // Smooth curve from (ax, ay) to (bx, by)
          const midX = (ax + bx) / 2;
          body += `<path d="M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}" fill="none" stroke="${t.arrow}" stroke-width="1.5" opacity="0.6"/>`;
          // Arrowhead at b
          body += `<polygon points="${bx - 6},${by - 4} ${bx},${by} ${bx - 6},${by + 4}" fill="${t.arrow}" opacity="0.7"/>`;
        }
      }

      // Task cards (rendered on top of arrows)
      taskRects.forEach(({ task, x, y, w, h, color }) => {
        body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.card}" stroke="${color}" stroke-width="2" filter="url(#vis-shadow)"/>`;
        body += `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${color}"/>`;
        // Wrap label to 2 lines at ~18 chars
        const words = task.label.split(' ');
        let l1 = '';
        let l2 = '';
        for (const w of words) {
          if ((l1 + ' ' + w).trim().length < 18) l1 = (l1 + ' ' + w).trim();
          else l2 = (l2 + ' ' + w).trim();
        }
        if (l2) {
          body += `<text x="${x + 14}" y="${y + h / 2 - 4}" font-family="Arial" font-size="12" font-weight="bold" fill="${t.text}">${l1}</text>`;
          body += `<text x="${x + 14}" y="${y + h / 2 + 12}" font-family="Arial" font-size="11" fill="${t.muted}">${l2}</text>`;
        } else {
          body += `<text x="${x + 14}" y="${y + h / 2 + 5}" font-family="Arial" font-size="13" font-weight="bold" fill="${t.text}">${l1}</text>`;
        }
      });

      const svg = svgDocument({
        width: W,
        height: H,
        title: safeTitle,
        description: `Swimlane diagram: ${safeTitle}`,
        body,
      });

      const buffer = Buffer.from(svg, 'utf8');
      const filename = `swimlane_${crypto.randomBytes(4).toString('hex')}.svg`;
      const artifact = finalizeArtifact({ filename, buffer, mime: EXTENSION_TO_MIME.svg, ctx });

      emitEvent(ctx, 'file_artifact', {
        artifact: {
          id: artifact.id,
          filename: artifact.filename,
          format: 'svg',
          mime: 'image/svg+xml',
          sizeBytes: artifact.sizeBytes,
          downloadUrl: artifact.downloadUrl,
        },
      });

      emitEvent(ctx, 'tool_output', {
        tool: 'create_swimlane_diagram',
        ok: true,
        preview: `Swimlane: ${artifact.filename} (${laneList.length}×${stageList.length} grid, ${validTasks.length} tareas, ${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        title,
        lanes: laneList.length,
        stages: stageList.length,
        tasks: validTasks.length,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'create_swimlane_diagram', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ── All visual/media tools for the agent ──────────────────────────────

const VISUAL_MEDIA_TOOLS = [
  generateImage,
  editImage,
  createChart,
  createOrganigram,
  createMermaidDiagram,
  createInfographicSvg,
  createDashboardHtml,
  generateVideo,
  createTimeline,
  createKanbanBoard,
  createComparisonTable,
  createProcessFlow,
  createSwotAnalysis,
  createEisenhowerMatrix,
  createRaciMatrix,
  createBusinessModelCanvas,
  createPyramidDiagram,
  createPortersFiveForces,
  createRiskMatrix,
  createFunnelDiagram,
  createValuePropositionCanvas,
  createPestelAnalysis,
  createRadarChart,
  createUserJourneyMap,
  createOkrDashboard,
  createEmpathyMap,
  createLeanCanvas,
  createBalancedScorecard,
  createAnsoffMatrix,
  createBcgMatrix,
  createMoscowChart,
  createDecisionTree,
  createConceptMap,
  createMindmapRadial,
  createSwimlaneDiagram,
];

// Internal helpers exposed for unit testing — NOT part of the public agent
// surface. Anything imported from `__test_helpers` is implementation detail
// and may change without notice.
const __test_helpers = {
  generateScenesFromPrompt,
  svgDocument,
  xmlEscape,
};

module.exports = { VISUAL_MEDIA_TOOLS, __test_helpers };
