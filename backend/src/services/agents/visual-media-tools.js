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
  description: 'Generate an image from a text description using an AI image model (DALL-E, Stable Diffusion, or the user\'s configured provider). The resulting image is saved as a downloadable artifact. Use for photos, illustrations, diagrams, concept art, product mockups, or any visual content.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate. More detail = better results.' },
      style: { type: 'string', description: 'Optional style hint: "realistic", "vivid", "natural", "photographic", "digital-art", "anime", "oil-painting", "line-art". Default: "vivid".' },
      aspectRatio: { type: 'string', enum: ['square', 'wide', 'portrait'], description: 'Aspect ratio hint. Default: "square" (1024×1024). wide → 1792×1024, portrait → 1024×1792.' },
      quality: { type: 'string', enum: ['standard', 'hd'], description: 'Quality level. Default: "standard".' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute({ prompt, style = 'vivid', aspectRatio = 'square', quality = 'standard' }, ctx = {}) {
    emitEvent(ctx, 'tool_call', { tool: 'generate_image', preview: prompt });

    try {
      const ai = getAiService();

      // Map aspect ratio to size
      const sizeMap = { square: '1024x1024', wide: '1792x1024', portrait: '1024x1792' };
      const size = sizeMap[aspectRatio] || '1024x1024';

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

      const imageB64 = await ai.generateImage(enhancedPrompt, 'OpenAI', 'dall-e-3');
      if (!imageB64) {
        emitEvent(ctx, 'tool_output', { tool: 'generate_image', ok: false, preview: 'El servicio de imágenes no devolvió resultado. Reintenta con un prompt más simple.' });
        return { ok: false, error: 'image generation returned empty result' };
      }

      const buffer = Buffer.from(imageB64, 'base64');
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
        preview: `Imagen lista: ${artifact.filename} (${Math.round(artifact.sizeBytes / 1024)} KB)`,
      });

      return {
        ok: true,
        id: artifact.id,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        mime: 'image/png',
        prompt: enhancedPrompt,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      emitEvent(ctx, 'tool_output', { tool: 'generate_image', ok: false, preview: `Error: ${msg}` });
      return { ok: false, error: msg };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Tool 2: create_chart
// ─────────────────────────────────────────────────────────────────────────

const createChart = {
  name: 'create_chart',
  description: 'Generate a data chart or graph (bar, line, pie, scatter, histogram, area, radar, donut, bubble) from structured data. The chart is rendered as an SVG file and saved as a downloadable artifact. For complex multi-series or interactive charts, describe the data in detail.',
  parameters: {
    type: 'object',
    properties: {
      chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'histogram', 'area', 'radar', 'donut', 'bubble', 'horizontal_bar'], description: 'Type of chart to generate.' },
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
      const W = chartType === 'horizontal_bar' ? 1000 : 800;
      const H = chartType === 'horizontal_bar' ? Math.max(400, labels.length * 50 + 120) : 500;
      const M = { top: 60, right: 40, bottom: 80, left: 80 };
      const innerW = W - M.left - M.right;
      const innerH = H - M.top - M.bottom;

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
      const colors = datasets.map((d, i) => d.color || palette[i % palette.length]);

      function buildChartBody() {
        if (chartType === 'pie' || chartType === 'donut') {
          return buildPieBody();
        }
        if (chartType === 'horizontal_bar') {
          return buildHBarBody();
        }
        return buildCartesianBody();
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
          const angle = (val / total) * 2 * Math.PI;
          const startAngle = cumulative;
          const endAngle = cumulative + angle;
          const startX = cx + r * Math.cos(startAngle);
          const startY = cy + r * Math.sin(startAngle);
          const endX = cx + r * Math.cos(endAngle);
          const endY = cy + r * Math.sin(endAngle);
          const largeArc = angle > Math.PI ? 1 : 0;
          const color = colors[0] || palette[i % palette.length];
          const midAngle = startAngle + angle / 2;
          const labelR = r + 24;
          const lx = cx + labelR * Math.cos(midAngle);
          const ly = cy + labelR * Math.sin(midAngle);

          slices += `<path d="M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z" fill="${color}" stroke="#fff" stroke-width="2"/>`;
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
          const parentBottom = n.absY - LEVEL_GAP - h;
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
          heading: { type: 'string', description: 'Section heading.' },
          content: { type: 'string', description: 'Section content text (1-3 sentences).' },
          icon: { type: 'string', enum: ['chart', 'bulb', 'star', 'target', 'gear', 'shield', 'globe', 'people', 'clock', 'rocket', 'check'], description: 'Optional icon type.' },
          metrics: { type: 'array', items: { type: 'object', properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            unit: { type: 'string' },
          } }, description: 'Optional numeric metrics to display.' },
          color: { type: 'string', description: 'Optional accent hex color.' },
        },
        required: ['heading', 'content'],
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
      };

      let sectionsSvg = '';
      sections.slice(0, maxSections).forEach((section, i) => {
        const sy = HEADER_H + PAD + i * SECTION_H;
        const accent = section.color || t.accent;
        const safeHeading = xmlEscape(String(section.heading).slice(0, 80));
        const safeContent = xmlEscape(String(section.content).slice(0, 300));
        const hasMetrics = Array.isArray(section.metrics) && section.metrics.length > 0;
        const iconHtml = iconSvg[section.icon] ? `<g transform="translate(${PAD + 8}, ${sy + 14})" color="${accent}" stroke-width="auto">${iconSvg[section.icon]}</g>` : '';

        sectionsSvg += `
  <!-- Section ${i + 1} -->
  <rect x="${PAD}" y="${sy}" width="${W - 2 * PAD}" height="${SECTION_H - 8}" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
  ${iconHtml}
  <text x="${iconHtml ? 80 : PAD + 16}" y="${sy + 28}" font-family="Arial" font-size="15" font-weight="bold" fill="${t.text}">${safeHeading}</text>
  <text x="${iconHtml ? 80 : PAD + 16}" y="${sy + 50}" font-family="Arial" font-size="12" fill="${t.muted}">${safeContent}</text>
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
        const color = m.color || t.accent;
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
          const color = ds.color || colors[di % colors.length];
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
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute({ prompt, title, duration = 8, aspectRatio = '16:9', style }, ctx = {}) {
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

        // Build SVG storyboard
        const storyW = 800;
        const sceneH = 240;
        const headerH = 100;
        const pad = 24;
        const totalH = headerH + scenes.length * sceneH + pad * 2;

        const sceneCards = scenes.map((scene, i) => {
          const sy = headerH + pad + i * sceneH;
          const safeDesc = xmlEscape(scene.description || '').slice(0, 250);
          const safeAction = xmlEscape(scene.action || '').slice(0, 150);
          const safeVisual = xmlEscape(scene.visualStyle || '').slice(0, 150);
          const safeAudio = xmlEscape(scene.audio || '').slice(0, 100);
          return `
  <!-- Scene ${i + 1} -->
  <rect x="${pad}" y="${sy}" width="${storyW - 2 * pad}" height="${sceneH - 8}" rx="10" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1" filter="url(#vis-shadow)"/>
  <rect x="${pad + 4}" y="${sy + 4}" width="4" height="${sceneH - 16}" rx="2" fill="${scene.color || '#3B82F6'}"/>
  <text x="${pad + 24}" y="${sy + 28}" font-family="Arial" font-size="13" font-weight="bold" fill="#1E293B">Escena ${i + 1} · ${xmlEscape(scene.timeRange || `${scene.duration}s`)}</text>
  <text x="${pad + 24}" y="${sy + 50}" font-family="Arial" font-size="11" fill="#475569">${safeDesc}</text>
  ${safeAction ? `<text x="${pad + 24}" y="${sy + 72}" font-family="Arial" font-size="11" fill="#64748B">🎬 ${safeAction}</text>` : ''}
  ${safeVisual ? `<text x="${pad + 24}" y="${sy + 92}" font-family="Arial" font-size="10" fill="#94A3B8">🎨 ${safeVisual}</text>` : ''}
  ${safeAudio ? `<text x="${pad + 24}" y="${sy + 110}" font-family="Arial" font-size="10" fill="#94A3B8">🔊 ${safeAudio}</text>` : ''}
  <text x="${storyW - pad - 16}" y="${sy + 28}" text-anchor="end" font-family="Arial" font-size="20" font-weight="bold" fill="${scene.color || '#3B82F6'}" opacity="0.15">${String(i + 1).padStart(2, '0')}</text>`;
        }).join('\n');

        const storyboardSvg = [
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${storyW} ${totalH}">`,
          `  <defs><filter id="vis-shadow"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.08"/></filter></defs>`,
          `  <rect width="${storyW}" height="${totalH}" fill="#F8FAFC" rx="12"/>`,
          `  <rect x="0" y="0" width="${storyW}" height="${headerH}" fill="#1E293B" rx="0"/>`,
          `  <text x="${storyW / 2}" y="38" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="#FFFFFF">${xmlEscape(String(title || enhancedPrompt).slice(0, 100))}</text>`,
          `  <text x="${storyW / 2}" y="64" text-anchor="middle" font-family="Arial" font-size="12" fill="#94A3B8">Storyboard · ${scenes.length} escenas · ${duration}s · ${xmlEscape(style || '')}</text>`,
          `  <text x="${storyW / 2}" y="80" text-anchor="middle" font-family="Arial" font-size="10" fill="#64748B">Generado como alternativa — conecta VIDEO_API_URL para generación real de video</text>`,
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

// ── All visual/media tools for the agent ──────────────────────────────

const VISUAL_MEDIA_TOOLS = [
  generateImage,
  createChart,
  createOrganigram,
  createMermaidDiagram,
  createInfographicSvg,
  createDashboardHtml,
  generateVideo,
];

module.exports = { VISUAL_MEDIA_TOOLS };
