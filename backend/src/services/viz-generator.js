/**
 * viz-generator — natural-language brief → data visualisation.
 *
 * One pipeline that can emit any of six artefact formats, the LLM
 * picking the right one for the question:
 *
 *   format: "matplotlib"   → server-rendered PNG (base64 data URL).
 *                            Best for static academic/thesis figures
 *                            (S-curves, Pareto, Ishikawa, histograms,
 *                            scatter + regression, box plots).
 *   format: "plotly"       → Plotly JSON spec {data, layout} rendered
 *                            interactively on the client with
 *                            react-plotly.js. Zoom, hover, legend
 *                            toggle out of the box.
 *   format: "chartjs"      → Chart.js config {type, data, options}
 *                            rendered on the client with chart.js.
 *                            Clean defaults, lightweight.
 *   format: "recharts"     → Recharts component config {type,
 *                            data, xKey, yKey(s), stacked?} — the
 *                            frontend maps it to <LineChart>,
 *                            <BarChart>, <AreaChart>, <PieChart>,
 *                            <ScatterChart> for dashboards.
 *   format: "d3"           → Self-contained HTML with a <script> that
 *                            runs D3 in a sandboxed iframe. For
 *                            bespoke visuals (force-directed graphs,
 *                            sankey, treemaps).
 *   format: "mermaid"      → Mermaid source code rendered via
 *                            mermaid.ink (same pipeline as /figma).
 *                            For flow/ER/Gantt/sequence/class.
 *
 * Decision rule (encoded in the system prompt):
 *   · "reporte / tesis / académico / PDF"                    → matplotlib
 *   · "interactivo / hover / zoom / dashboard"               → plotly or recharts
 *   · "diagrama de flujo / ER / Gantt / secuencia / clase"   → mermaid
 *   · "force-directed / sankey / treemap / custom"           → d3
 *   · "simple / rápida / clean"                              → chartjs
 *
 * The server only *executes* Python for the matplotlib path (via the
 * local sandbox). All other formats are emitted as configuration
 * that the client renders with the libs already in the bundle.
 */

const { run } = require('./agents/code-sandbox');
const { clientForModel, completeStructured, publicGenerationError } = require('./ai/structured-generation');

const SYSTEM_PROMPT = `You are a senior data visualisation engineer for the siraGPT assistant.

Pick the best renderer for the user's brief and emit ONE valid JSON object with these fields (and nothing else):

{
  "format": "matplotlib" | "plotly" | "chartjs" | "recharts" | "d3" | "mermaid",
  "title": string,                // short title shown above the chart
  "explanation": string,          // 1-3 sentences (user's language, Spanish by default) describing what the chart shows
  "payload": { ... }              // format-specific (see below)
}

How to pick:
- "matplotlib": static academic/thesis figure (Pareto, Ishikawa fishbone, histogram, scatter + regression, box plot, S-curve EVM, control chart). Academic report tone. Seaborn allowed.
- "plotly": user asked for interactive (hover, zoom, toggle legend) OR heat map / 3D / large data.
- "chartjs": small clean quick chart with simple categorical data.
- "recharts": dashboard-style, multiple series, stacked bars, area, pie.
- "d3": custom visuals that the four libraries above don't do well — force-directed graph, sankey, treemap, chord diagram, radial tree.
- "mermaid": diagram (flowchart, sequence, ER, class, Gantt, state, user-journey, git graph). NEVER use mermaid for numeric charts.

Payload shape per format:

"matplotlib" → { "python": string }
  Self-contained Python using matplotlib/seaborn (imported by you). MUST save the final figure with:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    ... plt.savefig("/tmp/viz-out.png", dpi=150, bbox_inches="tight"); plt.close()
  Set a neutral style: plt.style.use("seaborn-v0_8-whitegrid") or similar. Figure size ~ (8,5). Keep to <60 lines. Data must be embedded in the code. Axes labelled.

"plotly" → { "data": [...], "layout": {...} }
  Pure Plotly.js JSON spec (same shape that Plotly.newPlot accepts). Include layout.title, margins, font, template: "simple_white".

"chartjs" → { "config": { "type": ..., "data": {...}, "options": {...} } }
  Valid Chart.js v4 config expressed as PURE JSON. Never include JavaScript functions, arrow functions, callbacks, formatters, undefined, NaN, comments or expressions. Omit tooltip/tick callbacks; use declarative labels, dataset labels and standard numeric formatting. Do not serialize function source as a string.

"recharts" → {
    "type": "line"|"bar"|"area"|"pie"|"scatter",
    "data": [ {...}, ... ],          // array of row objects
    "xKey": string,                   // key on each row used for X
    "series": [ { "key": string, "name": string, "color": string } ],  // one per line/bar/area
    "stacked": boolean,               // optional, default false
    "height": number                  // default 320
  }
  For "pie" use { "type":"pie", "data":[{"name":"A","value":12},...], "colors":["#...","..."], "height":320 }.

"d3" → { "html": string }
  A complete <!DOCTYPE html> document that imports D3 from https://cdn.jsdelivr.net/npm/d3@7 and renders the visualisation inside <body>. Use responsive SVG (viewBox). No external data fetches.

"mermaid" → { "code": string }
  Valid Mermaid v10 source, starting with the diagram-type keyword (flowchart TD, sequenceDiagram, classDiagram, erDiagram, gantt, stateDiagram-v2, journey, gitGraph). No fences.

Hard rules:
- Respond in the user's language (default Spanish) for "title" and "explanation".
- Return ONE JSON object, no markdown fences, no prose before or after.
- If the user's brief isn't about a chart, pick format "mermaid" with a "flowchart TD" placeholder and explain gently in "explanation".
- All numeric data must be plausible; if the user pasted actual numbers, use them verbatim; otherwise invent realistic sample data and note so in "explanation".
- Every professional visualization must include a clear title, labelled axes or labelled nodes, readable contrast, and a source/assumption note when data is synthetic.
- For thesis / academic / market-research visuals, prefer sober palettes, avoid decorative 3D effects, and make the figure export-ready for PDF/Word.
- For interactive visuals, include useful hover labels, legend toggles when there is more than one series, and responsive layout so the chart works inside the chat panel.
- For Mermaid diagrams, keep labels short and valid; quote labels that contain punctuation, accents, parentheses, or slashes.
`;

function validateViz(value) {
  if (typeof value.title !== 'string' || !value.title.trim() || typeof value.explanation !== 'string') return false;
  const payload = value.payload;
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(payload)) return false;
  const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
  const label = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  const numberOrGap = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  const chartTypes = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter', 'bubble'];
  switch (value.format) {
    case 'matplotlib': return nonempty(payload.python);
    case 'mermaid': return nonempty(payload.code);
    case 'd3': return nonempty(payload.html);
    case 'plotly': return Array.isArray(payload.data) && payload.data.length > 0 && payload.data.every(object)
      && (payload.layout === undefined || object(payload.layout));
    case 'chartjs': {
      const config = payload.config;
      if (!object(config) || !chartTypes.includes(config.type) || !object(config.data)
        || !Array.isArray(config.data.datasets) || !config.data.datasets.length
        || (config.options !== undefined && !object(config.options))) return false;
      // Callback strings are not executable JSON configuration either. Reject
      // unsupported formatting instead of delivering a chart that fails in UI.
      const pending = config.options ? [config.options] : [];
      while (pending.length) {
        for (const [key, child] of Object.entries(pending.pop())) {
          if (key === 'callback' || key === 'callbacks') return false;
          if (child !== null && typeof child === 'object') pending.push(child);
        }
      }
      return config.data.datasets.every((dataset) => object(dataset)
        && (dataset.type === undefined || chartTypes.includes(dataset.type))
        && (Array.isArray(dataset.data) || object(dataset.data)));
    }
    case 'recharts': return ['line', 'bar', 'area', 'pie', 'scatter'].includes(payload.type)
      && Array.isArray(payload.data) && payload.data.length > 0 && payload.data.every(object)
      && (payload.height === undefined || (Number.isFinite(payload.height) && payload.height > 0))
      && (payload.colors === undefined || (Array.isArray(payload.colors) && payload.colors.length > 0 && payload.colors.every(nonempty)))
      && (payload.type === 'pie'
        ? payload.data.every((row) => label(row.name) && numberOrGap(row.value))
        : nonempty(payload.xKey) && payload.data.every((row) => label(row[payload.xKey]))
          && Array.isArray(payload.series) && payload.series.length > 0
          && payload.series.every((series) => object(series) && nonempty(series.key)
            && (series.name === undefined || typeof series.name === 'string')
            && (series.color === undefined || nonempty(series.color))
            && payload.data.every((row) => numberOrGap(row[series.key]))));
    default: return false;
  }
}

async function callLlm({ prompt, model, signal, clientOptions }) {
  return completeStructured({ prompt, model, signal, clientOptions, systemPrompt: SYSTEM_PROMPT,
    temperature: 0.25, maxTokens: 4000, validate: validateViz });
}

// Minimal Python prelude — imports are the snippet's responsibility.
const MATPLOTLIB_PREFIX = `
import matplotlib
matplotlib.use("Agg")
`.trimStart();

async function renderMatplotlib(python) {
  const source = MATPLOTLIB_PREFIX + python;
  const result = await run({
    language: 'python',
    source,
    timeoutMs: 20_000,
  });
  if (result.timedOut) {
    return { ok: false, error: 'timeout rendering matplotlib' };
  }
  // The snippet writes /tmp/viz-out.png. We read it back — but the
  // sandbox forces HOME=/tmp and runs in its own temp dir, so the
  // snippet needs to save relative. Standardise on "viz-out.png"
  // next to main.py; the sandbox cleans up after itself so we must
  // inline the read and base64-encode it from Python before the
  // subprocess exits.
  //
  // Easiest fix: rewrite the snippet to print the base64 PNG at the
  // end instead of writing to disk. We do this transparently here
  // so the LLM can keep its natural "savefig; plt.close()" idiom.
  const instrumented = MATPLOTLIB_PREFIX + python + `
import io, base64, sys
buf = io.BytesIO()
# matplotlib may have called savefig already; in that case the
# current figure is closed and we re-render to buf from the last
# active axes via plt.gcf(). If no figure exists, emit a 1x1 png.
try:
    import matplotlib.pyplot as _plt
    _fig = _plt.gcf()
    _fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
except Exception as _e:
    from PIL import Image
    Image.new("RGB",(1,1),"white").save(buf, format="PNG")
sys.stdout.write("__PNG_B64__" + base64.b64encode(buf.getvalue()).decode("ascii"))
`;
  const result2 = await run({
    language: 'python',
    source: instrumented,
    timeoutMs: 20_000,
  });
  if (result2.timedOut) return { ok: false, error: 'timeout' };
  const out = result2.stdout || '';
  const marker = out.lastIndexOf('__PNG_B64__');
  if (marker === -1) {
    return {
      ok: false,
      error: result2.stderr || 'matplotlib produced no output',
      stderr: result2.stderr,
    };
  }
  const b64 = out.slice(marker + '__PNG_B64__'.length).trim();
  return {
    ok: true,
    imageDataUrl: `data:image/png;base64,${b64}`,
    stdout: out.slice(0, marker).trim(),
    stderr: result2.stderr,
  };
}

// Build the persisted message body. Returns { content, files }.
function buildArtefact({ parsed, renderedPng, renderStderr }) {
  const { format, title, explanation, payload } = parsed;
  const base = {
    type: 'viz',
    format,
    title: title || 'Visualización',
    explanation: explanation || '',
  };
  let file;
  switch (format) {
    case 'matplotlib':
      file = { ...base, imageUrl: renderedPng, pythonCode: payload?.python };
      break;
    case 'plotly':
      file = { ...base, data: payload?.data, layout: payload?.layout };
      break;
    case 'chartjs':
      file = { ...base, config: payload?.config };
      break;
    case 'recharts':
      file = { ...base, chart: payload };
      break;
    case 'd3':
      file = { ...base, html: payload?.html };
      break;
    case 'mermaid':
      file = { ...base, code: payload?.code };
      break;
    default:
      file = { ...base, payload };
  }
  const contentLines = [
    `**${title || 'Visualización'}**`,
    '',
    explanation || '',
  ];
  if (renderStderr && format === 'matplotlib' && !renderedPng) {
    contentLines.push('', '_⚠ No fue posible renderizar la figura — ver detalles._');
  }
  return { content: contentLines.filter(Boolean).join('\n'), file };
}

async function generateViz({ prompt, model, signal, clientOptions }) {
  const parsed = await callLlm({ prompt, model, signal, clientOptions });
  let renderedPng = null;
  let renderStderr = null;
  if (parsed.format === 'matplotlib') {
    const python = parsed.payload?.python;
    if (python && python.trim()) {
      const r = await renderMatplotlib(python);
      if (r.ok) renderedPng = r.imageDataUrl;
      else renderStderr = r.error || r.stderr;
    }
  }
  const { content, file } = buildArtefact({ parsed, renderedPng, renderStderr });
  return { parsed, content, file, renderStderr };
}

// Streaming variant for the SSE route.
async function* streamViz({ prompt, model, signal, clientOptions }) {
  yield { type: 'stage', label: 'Analizando la solicitud', pct: 5 };
  let parsed;
  try {
    yield { type: 'stage', label: 'Eligiendo renderizador', pct: 15 };
    parsed = await callLlm({ prompt, model, signal, clientOptions });
  } catch (err) {
    yield { type: 'error', ...publicGenerationError(err, signal) };
    return;
  }
  yield { type: 'stage', label: `Formato: ${parsed.format}`, pct: 40 };

  let renderedPng = null;
  let renderStderr = null;
  if (parsed.format === 'matplotlib') {
    yield { type: 'stage', label: 'Renderizando con matplotlib', pct: 60 };
    const python = parsed.payload?.python;
    if (python && python.trim()) {
      const r = await renderMatplotlib(python);
      if (r.ok) renderedPng = r.imageDataUrl;
      else renderStderr = r.error || r.stderr;
    }
  }
  yield { type: 'stage', label: 'Compilando artefacto', pct: 92 };
  const { content, file } = buildArtefact({ parsed, renderedPng, renderStderr });
  yield { type: 'final', content, file, format: parsed.format };
}

module.exports = { generateViz, streamViz, clientForModel };
