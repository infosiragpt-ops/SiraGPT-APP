/**
 * artifact-generator — natural-language brief → self-contained React
 * JSX component that runs live in the chat inside a sandboxed iframe.
 *
 * This is what ChatGPT/Claude call "interactive artifacts":
 *   · Calculadora de Cronbach's alpha donde el usuario pega Likert.
 *   · Simulador SMED con inputs de tiempos internos / externos.
 *   · Quiz con preguntas embebidas.
 *   · Dashboard de progreso de tesis con filtros.
 *   · Visualizador S-curve EVM que recalcula al cambiar inputs.
 *   · Editor APA 7 con validación en tiempo real.
 *   · Mapa interactivo con zonas clickeables.
 *
 * The LLM emits ONLY the JSX component body. The client wraps it in a
 * HTML shell that loads React 18 + Babel standalone + a curated set
 * of CDN libraries (recharts, lucide, lodash, d3, mathjs, plotly,
 * papaparse, sheetjs, three.js) plus a small async window.storage API,
 * and mounts the component inside an
 * iframe sandbox="allow-scripts" (no allow-same-origin — the
 * artifact cannot reach the parent's cookies / localStorage / DOM).
 */

const OpenAI = require('openai');

function clientForModel(modelName) {
  if (!modelName) return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
  const m = String(modelName);
  if (/^(anthropic|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|google|moonshotai)\//i.test(m)
      || m.includes('/gpt-oss')) {
    return { provider: 'OpenRouter', client: new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }) };
  }
  if (m.includes('gemini')) {
    return { provider: 'Gemini', client: new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }) };
  }
  return { provider: 'OpenAI', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) };
}

const SYSTEM_PROMPT = `You are a senior frontend engineer producing interactive React ARTIFACTS for the siraGPT chat.

Return ONE JSON object (no fences, no prose, no markdown):

{
  "title": string,          // short title shown above the artefact (user's language, default Spanish)
  "explanation": string,    // 1-3 short sentences telling the user what the component does
  "jsx": string             // JSX source for the root component. See rules below.
}

How the sandbox runs your code (DO NOT try to change this):
- Your JSX is inserted inside an HTML document as:
    <script type="text/babel" data-presets="env,react">
      {YOUR JSX}
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    </script>
  So the final snippet MUST define \`const App = () => { ... }\` (or function App). Do NOT call createRoot yourself — the shell does it.
- Available GLOBALS (no imports — they are on window):
    React, ReactDOM, (hooks: React.useState, React.useEffect, React.useMemo, React.useRef, React.useCallback, React.useReducer)
    Recharts (window.Recharts → { LineChart, BarChart, AreaChart, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Line, Bar, Area, ScatterChart, Scatter })
    lucide (window.lucide → icons as functions, but prefer inline SVG to avoid version mismatch)
    _ (lodash)
    d3
    math (mathjs)
    Plotly
    Papa (papaparse)
    XLSX (sheetjs)
    THREE (three.js)
    storage: async key-value API scoped to this artifact:
      await storage.get(key, fallbackValue)
      await storage.set(key, jsonSerializableValue)
      await storage.delete(key)
      await storage.list()
- Tailwind CSS is loaded via CDN → use utility classes freely. Prefer neutral palette, generous spacing, rounded-xl cards.
- NO external network calls (fetch / XHR) — the iframe has no network-origin trust.
- NO imports / requires. No bundler. You write one JSX block that the Babel-standalone transpiler accepts.
- Make it responsive, accessible (aria-label on inputs), and keyboard-usable.

UX rules:
- Title at the top (<h2 class="text-xl font-semibold">).
- Primary CTA is a single visually dominant button when applicable; secondary actions are subtle.
- When the component computes something, show the result in a large, legible card — preferably with a short explanation of what was computed.
- For quizzes: track score, show feedback per question, final score screen at the end.
- For calculators: live recompute on input change (no Submit button needed).
- For professional dashboards/tools, include empty-state handling, validation messages, reset/export controls when useful, and concise helper text so the user understands what to paste or change.
- If using storage, load saved state on mount and persist only small JSON-safe values. Never store secrets or API keys.
- If using THREE, dispose geometries/materials/renderers in cleanup and keep the scene lightweight enough to run inside an iframe.

Typical patterns for common asks:
- "Calculadora de Cronbach's alpha" → textarea where user pastes rows of numbers (comma / tab separated), parse with papaparse, compute alpha = (k/(k-1)) * (1 - sum(var_i)/var_total), show in a card.
- "Quiz con N preguntas" → array-of-questions embedded in the code, step through them, track answers.
- "Simulador SMED" → inputs for internal/external times, compute reduction pct, show a before/after bar.
- "Dashboard de tesis" → static data embedded, Recharts LineChart + stat cards.
- "Tracker de tesis persistente" → use storage.get/set in useEffect to remember chapter/progress between reloads.
- "Animación 3D" → use THREE with a requestAnimationFrame loop, cleanup in useEffect, and keep geometry lightweight.

Return exactly ONE JSON object with the three fields. The jsx field must be a JSON-escaped string (newlines as \\n). Keep jsx under 250 lines.`;

function extractJson(raw) {
  if (!raw) throw new Error('empty');
  const tries = [raw];
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  tries.push(stripped);
  const i = stripped.indexOf('{');
  const j = stripped.lastIndexOf('}');
  if (i >= 0 && j > i) tries.push(stripped.slice(i, j + 1));
  let lastErr;
  for (const t of tries) { try { return JSON.parse(t); } catch (e) { lastErr = e; } }
  throw new Error(`JSON parse failed: ${lastErr?.message}`);
}

async function callLlm({ prompt, model, signal }) {
  const routed = clientForModel(model);
  if (!routed.client) throw new Error(`artifact-generator: no API key for "${model}"`);
  const callModel = async (useJsonMode) => {
    const params = {
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 6000,
    };
    if (useJsonMode && routed.provider !== 'Gemini') params.response_format = { type: 'json_object' };
    return routed.client.chat.completions.create(params, { signal });
  };
  let resp;
  try { resp = await callModel(true); }
  catch (err) {
    if (/response_format|json_object|invalid.*param/i.test(err?.message || '')) resp = await callModel(false);
    else throw err;
  }
  return extractJson(resp.choices?.[0]?.message?.content || '');
}

function buildArtefact(parsed) {
  const file = {
    type: 'artifact',
    runtime: 'react',
    title: parsed.title || 'Artefacto interactivo',
    explanation: parsed.explanation || '',
    jsx: parsed.jsx || '',
  };
  const content = [
    `**${parsed.title || 'Artefacto interactivo'}**`,
    '',
    parsed.explanation || '',
  ].filter(Boolean).join('\n');
  return { content, file };
}

async function generateArtifact({ prompt, model, signal }) {
  const parsed = await callLlm({ prompt, model, signal });
  return { parsed, ...buildArtefact(parsed) };
}

async function* streamArtifact({ prompt, model, signal }) {
  yield { type: 'stage', label: 'Diseñando el componente', pct: 8 };
  let parsed;
  try {
    yield { type: 'stage', label: 'Generando JSX', pct: 30 };
    parsed = await callLlm({ prompt, model, signal });
  } catch (err) {
    if (err?.name === 'AbortError') { yield { type: 'error', error: 'aborted' }; return; }
    yield { type: 'error', error: err?.message || 'LLM failed' };
    return;
  }
  yield { type: 'stage', label: 'Empaquetando artefacto', pct: 88 };
  const { content, file } = buildArtefact(parsed);
  yield { type: 'final', content, file };
}

module.exports = { generateArtifact, streamArtifact, clientForModel };
