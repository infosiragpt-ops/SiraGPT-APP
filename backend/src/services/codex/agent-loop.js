'use strict';

/**
 * codex/agent-loop — the brain of a run, executed inside the BullMQ job
 * (feature 06). Emits DOMAIN events only (plan_proposed, narrative, reasoning,
 * actions, …); the run-processor owns the run_status transitions around it.
 * Returns a terminal outcome `{ status: 'waiting_approval' | 'done' | 'error', error? }`.
 *
 *  - mode `plan` → delegates to plan-mode (never mutates), ends waiting_approval.
 *  - mode `build` → LLM ↔ tools loop: streaming text → narrative_delta,
 *    reasoning → reasoning_*, tool calls → action_* grouped by consecutive
 *    burst (groupId) + a persisted CodexAction. Budgets: CODEX_MAX_STEPS and a
 *    per-turn tool cap; cancellation polled between steps; a tool error does NOT
 *    abort (it is fed back to the model); only an LLM transport error → error.
 *
 * Every dependency is injectable so the loop is fully testable with a scripted
 * llmTurn + a fake runner — zero network, zero DB.
 */

const planMode = require('./plan-mode');
const { randomUUID } = require('node:crypto');
const buildTools = require('./build-tools');
const actionStoreDefault = require('./action-store');
const checkpointService = require('./checkpoint-service');
const runMetrics = require('./run-metrics');
const progressLedger = require('./progress-ledger');
const proactiveMetrics = require('./proactive-metrics');
const proactiveSwarm = require('./proactive-swarm');
const toolScheduler = require('./tool-scheduler');
const projectHooks = require('./project-hooks');
const { classifyText, toActionRequired, benignAnnotation } = require('./error-patterns');
const { classifyTaskError } = require('../../utils/task-error-classifier');
const { createSandboxClient } = require('./sandbox-provider');
const { localCliCommand } = require('./local-cli');
const { scanBuffer } = require('../security/secret-scanner');
const { redactString } = require('../../utils/secret-redactor');

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOOLS_PER_TURN = 4;
// Transient model-step failures (502/503/504/timeout/ECONNRESET — a gateway
// blip, not a dead run) get a bounded retry with backoff before the step is
// allowed to fail the whole build. 402/auth/validation stay non-retryable: the
// user must act on those.
const MAX_LLM_STEP_RETRIES = 3;
const LLM_STEP_RETRY_BASE_MS = 2_000;
const DEFAULT_CONTEXT_MAX_CHARS = 60_000;
const DEFAULT_MAX_VERIFY_ROUNDS = 2;
// Optional runtime verification (flag-gated OFF by default): after a clean tsc
// (or when there is nothing to typecheck) the loop can additionally boot the
// project's dev server via the runner and feed real boot/runtime errors
// (module-not-found, Vite overlay, a server that never becomes ready) back to
// the model for a repair round — errors tsc alone can't catch.
const DEFAULT_VERIFY_DEV_TIMEOUT_MS = 60_000;
// Anti-thrash: how many consecutive writes to the SAME file before the loop
// nudges the model to stop rewriting it and advance to the next plan step.
const DEFAULT_MAX_SAME_FILE_WRITES = 3;
// How many times the loop will nudge a truncated (cut-off mid-tool-call) turn
// to retry with a smaller write before giving up and closing honestly. Bounds
// a pathological model that keeps overrunning its output budget.
const MAX_TRUNCATION_RETRIES = 3;
// Keep this many tail messages verbatim when compacting (the model needs the
// recent working set intact; older tool dumps compress well).
const COMPACT_KEEP_TAIL = 10;
const COMPACT_TOOL_RESULT_CAP = 300;
const CONTEXT_SUMMARY_INPUT_CAP = 48_000;
const CONTEXT_SUMMARY_CAP = 12_000;
const CONTEXT_SNAPSHOT_MESSAGE_CAP = 8_000;
const COMPACT_MESSAGE_FLOOR = 256;
const COMPACT_RECENT_MESSAGE_FLOOR = 512;
const COMPACT_SUMMARY_FLOOR = 1_024;
const COMPACT_SYSTEM_FLOOR = 2_048;
const STREAM_PROTOCOL_GUARD_CHARS = 20;
const REASONING_CONTEXT_CAP = 8_000;
const LIVE_FILE_PATCH_CAP = 16_000;
const BLOCKED_LIVE_PATCH_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials|secrets?|tokens?)(?:\/|\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|authorized_keys|known_hosts)(?:\.|$)/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flagEnabled(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

function productionFeatureEnabled(env, key) {
  const configured = env?.[key];
  if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
    return flagEnabled(configured);
  }
  return env?.NODE_ENV === 'production';
}

function boundedArgsPreview(value, maxChars = 4000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return JSON.parse(text);
    return { summary: `${text.slice(0, maxChars)}…[args recortados]` };
  } catch {
    return { summary: '[args no serializables]' };
  }
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (block?.type === 'image' || block?.type === 'image_url') return '[captura visual]';
      if (block?.type === 'document') return '[documento PDF]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

const recordedUsageByMetrics = new WeakMap();

function recordLlmUsageOnce(metrics, usage) {
  if (!metrics?.recordLlmUsage || !usage) return false;
  if (usage && typeof usage === 'object') {
    let seen = recordedUsageByMetrics.get(metrics);
    if (!seen) {
      seen = new WeakSet();
      recordedUsageByMetrics.set(metrics, seen);
    }
    if (seen.has(usage)) return false;
    seen.add(usage);
  }
  metrics.recordLlmUsage(usage);
  return true;
}

function contextBudgetChars(modelCapabilities = {}, env = process.env) {
  const explicit = Number.parseInt(env?.CODEX_CONTEXT_MAX_CHARS, 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const contextWindow = Math.max(8192, Number(modelCapabilities?.contextWindow) || 20_000);
  const outputTokens = Math.min(
    Math.max(2048, Number(modelCapabilities?.maxOutputTokens) || 4096),
    Math.floor(contextWindow / 4),
  );
  // Reserve output plus provider/tool framing. Three chars/token is deliberately
  // conservative for mixed Spanish, source code and JSON tool arguments.
  const reservedTokens = outputTokens + Math.max(2048, Math.floor(contextWindow * 0.04));
  const inputTokens = Math.max(4096, contextWindow - reservedTokens);
  return Math.min(750_000, Math.max(12_000, Math.floor(inputTokens * 3)));
}

function effortForStage({ tier = null, reasoningEffort = null, verifyRounds = 0, env = process.env } = {}) {
  const configured = String(env?.CODEX_REASONING_EFFORT || '').trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(configured)) return configured;
  if (verifyRounds > 0) return 'high';
  const requested = String(reasoningEffort || '').trim().toLowerCase();
  if (requested === 'max') return 'high';
  if (['low', 'medium', 'high'].includes(requested)) return requested;
  return String(tier || '').toLowerCase() === 'eco' ? 'low' : 'medium';
}

function createProtocolSafeTextStream(emit) {
  let raw = '';
  let emittedText = '';
  let stopped = false;

  const emitSlice = async (end) => {
    if (end <= emittedText.length) return;
    const delta = raw.slice(emittedText.length, end);
    emittedText += delta;
    if (delta) await emit(delta);
  };

  return {
    async push(delta) {
      if (stopped || !delta) return;
      raw += String(delta);
      const protocol = raw.search(/```(?:tool_call|json)\b/i);
      if (protocol >= 0) {
        stopped = true;
        await emitSlice(protocol);
        return;
      }
      await emitSlice(Math.max(emittedText.length, raw.length - STREAM_PROTOCOL_GUARD_CHARS));
    },
    async finish(finalText) {
      const final = String(finalText || '');
      if (!final) return;
      let suffix = '';
      if (!emittedText) suffix = final;
      else if (final.startsWith(emittedText)) suffix = final.slice(emittedText.length);
      else {
        const normalized = emittedText.trimStart();
        if (normalized && final.startsWith(normalized)) suffix = final.slice(normalized.length);
      }
      if (suffix) {
        emittedText += suffix;
        await emit(suffix);
      }
    },
    get emitted() {
      return emittedText.length > 0;
    },
    get text() {
      return emittedText;
    },
  };
}

function toolResultContent(toolName, observation, fallback = '', suffix = '') {
  const prefix = `[TOOL_RESULT ${toolName}] `;
  if (!Array.isArray(observation)) return `${prefix}${observation || fallback || ''}${suffix}`;
  const blocks = observation.map((block) => (
    block && typeof block === 'object' ? { ...block } : block
  ));
  const firstText = blocks.findIndex((block) => block?.type === 'text' && typeof block.text === 'string');
  if (firstText >= 0) {
    blocks[firstText] = { ...blocks[firstText], text: `${prefix}${blocks[firstText].text}${suffix}` };
  } else {
    blocks.unshift({ type: 'text', text: `${prefix}${fallback || ''}${suffix}` });
  }
  return blocks;
}

/** Plan tasks not yet completed → titles (plan-mode tasks carry no status: pending). */
function pendingPlanTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && t.status !== 'completed')
    .map((t) => String(t.title || t.id || 'tarea'));
}

function isAppsPrompt(text) {
  return /MODO APPS TIPO CODEX/i.test(String(text || ''));
}

function explicitlyRequestsNext(text) {
  const source = String(text || '').split(/SOLICITUD DEL USUARIO:/i).pop() || '';
  return /\bnext(?:\.js|js)?\b/i.test(source);
}

const COMMON_NEXT_ROUTE_ENTRIES = [
  'app/page.js',
  'app/page.jsx',
  'app/page.mdx',
  'app/page.ts',
  'app/page.tsx',
  'src/app/page.js',
  'src/app/page.jsx',
  'src/app/page.mdx',
  'src/app/page.ts',
  'src/app/page.tsx',
  'pages/index.js',
  'pages/index.jsx',
  'pages/index.mdx',
  'pages/index.ts',
  'pages/index.tsx',
  'src/pages/index.js',
  'src/pages/index.jsx',
  'src/pages/index.mdx',
  'src/pages/index.ts',
  'src/pages/index.tsx',
];

function isNextRouteEntryPath(value) {
  const path = String(value || '').trim().replace(/^\.\//, '');
  return /^(?:src\/)?app\/(?:[^/]+\/)*(?:page|route)\.(?:jsx?|tsx?|mdx)$/i.test(path)
    || /^(?:src\/)?pages\/(?!_(?:app|document|error)\.)(?:[^/]+\/)*[^/]+\.(?:jsx?|tsx?|mdx)$/i.test(path);
}

function fileTreeLooksLikeNextApplication(fileTree) {
  return String(fileTree || '')
    .split(/\r?\n/)
    .some((line) => {
      const match = line.trim().match(/^((?:src\/)?(?:app|pages)\/[^\s:]+\.(?:jsx?|tsx?|mdx))/i);
      return Boolean(match && isNextRouteEntryPath(match[1]));
    });
}

function userRequestFromPrompt(text) {
  const source = String(text || '');
  const parts = source.split(/SOLICITUD DEL USUARIO:/i);
  return (parts.length > 1 ? parts.pop() : source).trim();
}

function projectBriefText(project) {
  if (typeof project?.brief === 'string') return project.brief;
  if (typeof project?.brief?.instructions === 'string') return project.brief.instructions;
  return '';
}

function fileTreeHasBackend(fileTree) {
  return /(?:^|\n)[^\n]*(?:server\/(?:index|app|db)\.(?:[cm]?[jt]s)|(?:api|backend)\/)/i
    .test(String(fileTree || ''));
}

function fileTreeLooksLikeExpressStarter(fileTree) {
  const tree = String(fileTree || '');
  return /server\/index\.(?:[cm]?[jt]s)/i.test(tree) && /server\/db\.(?:[cm]?[jt]s)/i.test(tree);
}

function explicitlyRequestsCustomBackend(text) {
  return /\b(?:koa|fastify)\b/i.test(userRequestFromPrompt(text));
}

/**
 * APPS may start as a SPA or as the full-stack starter. Do not infer the
 * contract from the last assistant turn alone: a follow-up such as "cambia el
 * botón" still belongs to the existing Express/SQLite workspace.
 */
function appsHasFullStackContract({ sourcePrompt, project, fileTree, pkgText, serverIndexText, serverDbText, backendEntryText } = {}) {
  const request = userRequestFromPrompt(sourcePrompt);
  let intent = false;
  try {
    intent = require('./project-service').hasFullStackIntent(request)
      || require('./project-service').hasFullStackIntent(projectBriefText(project));
  } catch {
    // Keep the close path deterministic even if project-service cannot load.
    intent = /\b(?:full ?stack|backend|servidor|apis?|base de datos|database|sqlite|postgres|autenticaci[oó]n|authentication|multiusuario)\b/i.test(`${request}\n${projectBriefText(project)}`);
  }
  if (intent) return true;

  if (fileTreeHasBackend(fileTree)) return true;
  if (packageLooksFullStack(pkgText)) return true;
  return /\b(?:express|fastify|koa|bun:sqlite|node:sqlite|CREATE TABLE|\/api\/)\b/i
    .test(`${serverIndexText || ''}\n${serverDbText || ''}\n${backendEntryText || ''}`);
}

function titleFromRequest(text, fallback = 'App generada') {
  const raw = userRequestFromPrompt(text)
    .replace(/\s+/g, ' ')
    .replace(/^(crea|crear|construye|construir|haz|hacer|genera|generar)\s+(una?|el|la)?\s*/i, '')
    .replace(/^(web|landing|pagina|página|app)\s+(de|para)?\s*/i, '')
    .trim();
  if (!raw) return fallback;
  const short = raw.slice(0, 54).replace(/[.,;:!?]+$/g, '').trim();
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function appsFallbackFiles({ prompt, projectName }) {
  const title = titleFromRequest(prompt, projectName || 'App generada');
  const htmlTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  // Safe for embedding as JSX text (no tags/braces that break out of the node).
  const jsxTitle = String(title).replaceAll('<', '').replaceAll('>', '').replaceAll('{', '').replaceAll('}', '');
  const pkg = {
    name: 'siragpt-apps-vite-preview',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: {
      '@vitejs/plugin-react': '^4.5.2',
      // Keep in lockstep with starter-files.js: a repaired workspace must
      // still resolve the Tailwind idiom the agent writes everywhere else.
      '@tailwindcss/vite': '^4.1.0',
      tailwindcss: '^4.1.0',
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      typescript: '^5.5.4',
      vite: '^7.0.0',
    },
  };
  const viteConfig = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\n\n// server.allowedHosts: the proxy + browser verifier hit this by container hostname.\nexport default defineConfig({ plugins: [react(), tailwindcss()], server: { host: true, allowedHosts: true } })\n`;
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020', useDefineForClassFields: true, lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true,
      resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: 'react-jsx', strict: true,
    },
    include: ['src'],
  };
  const mainTsx = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n)\n`;
  const indexCss = `@import "tailwindcss";\n\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`;
  const appTsx = `const accent = '#ff0000'
const card = { border: '1px solid #e9e9ec', borderRadius: 8, overflow: 'hidden', background: '#fff' } as const

export default function App() {
  return (
    <div style={{ minHeight: '100vh', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: '#111113', background: '#fff' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px clamp(20px,5vw,72px)', borderBottom: '1px solid #e9e9ec' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.7rem', fontWeight: 800 }}>
          <span style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 8, background: accent, color: '#fff', fontWeight: 900 }}>S</span>
          <span>${jsxTitle}</span>
        </span>
        <nav style={{ display: 'flex', gap: '1rem', color: '#666a73', fontSize: '.92rem' }}>
          <a>Inicio</a><a>Catalogo</a><a href="#contacto">Contacto</a>
        </nav>
      </header>
      <main style={{ padding: 'clamp(38px,7vw,88px) clamp(20px,5vw,72px)', maxWidth: 1180, margin: '0 auto' }}>
        <section>
          <span style={{ display: 'inline-flex', border: '1px solid rgba(255,0,0,.22)', color: accent, borderRadius: 999, padding: '7px 11px', fontSize: '.78rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>SiraGPT Apps · Preview listo</span>
          <h1 style={{ margin: '18px 0 14px', fontSize: 'clamp(2.4rem,6vw,5rem)', lineHeight: .96 }}>${jsxTitle}</h1>
          <p style={{ color: '#666a73', fontSize: 'clamp(1rem,2vw,1.22rem)', lineHeight: 1.65, maxWidth: 650 }}>Una experiencia web minimalista, rapida y enfocada en conversion. Propuesta directa y contacto visible desde el primer vistazo.</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 30 }}>
            <a href="#contacto" style={{ border: '1px solid ' + accent, borderRadius: 8, padding: '13px 18px', fontWeight: 800, background: accent, color: '#fff', textDecoration: 'none' }}>Contactar ahora</a>
            <a href="#catalogo" style={{ border: '1px solid #e9e9ec', borderRadius: 8, padding: '13px 18px', fontWeight: 800, background: '#fff', color: '#111113', textDecoration: 'none' }}>Ver catalogo</a>
          </div>
        </section>
        <section id="catalogo" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16, marginTop: 'clamp(46px,8vw,88px)' }}>
          {['Opcion uno', 'Opcion dos', 'Opcion tres'].map((t) => (
            <article key={t} style={card}>
              <div style={{ height: 150, background: 'linear-gradient(135deg,#1d1d22,#4c4d55)' }} />
              <div style={{ padding: 18 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: '1.08rem' }}>{t}</h2>
                <p style={{ color: '#666a73', margin: 0 }}>Descripcion breve y clara del beneficio principal.</p>
                <div style={{ color: accent, fontWeight: 900, marginTop: 12 }}>Desde $0</div>
              </div>
            </article>
          ))}
        </section>
        <footer id="contacto" style={{ marginTop: 56, paddingTop: 20, borderTop: '1px solid #e9e9ec', color: '#666a73' }}>Contacto comercial: ventas@siragpt.com</footer>
      </main>
    </div>
  )
}
`;
  const indexHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
    <title>${htmlTitle} · SiraGPT Apps</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'vite.config.ts', content: viteConfig },
    { path: 'tsconfig.json', content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.tsx', content: mainTsx },
    { path: 'src/index.css', content: indexCss },
    { path: 'src/App.tsx', content: appTsx },
    { path: '.gitignore', content: 'node_modules\ndist\n' },
  ];
}

/** Default web_search adapter — lazy require so tests never pull it in. */
async function defaultWebSearch(query) {
  try {
    const { search } = require('../agents/web-search');
    return await search(query, { maxResults: 5 });
  } catch {
    return { results: [] };
  }
}

function buildSystemPrompt({
  project,
  plan,
  fileTree,
  sourcePrompt,
  projectNotes,
  progressContext = '',
  projectSettings = null,
  parallelSubagents = false,
  parallelTools = true,
  openclawPromptBlock = '',
  companySoul = '',
  preserveExistingNext = false,
}) {
  const appsMode = isAppsPrompt(sourcePrompt);
  // Existing Next applications are first-class imported workspaces. A follow-up
  // such as "cambia el encabezado" must not silently opt them into the Vite
  // starter merely because that individual instruction did not repeat "Next".
  const preserveNextApps = appsMode
    && (explicitlyRequestsNext(sourcePrompt) || preserveExistingNext);
  const forceViteApps = appsMode && !preserveNextApps;
  const fullStackApps = forceViteApps && appsHasFullStackContract({
    sourcePrompt,
    project,
    fileTree,
  });
  const existingCustomBackendApps = fullStackApps && (
    explicitlyRequestsCustomBackend(sourcePrompt)
    || (fileTreeHasBackend(fileTree) && !fileTreeLooksLikeExpressStarter(fileTree))
  );
  const starterContract = preserveNextApps
    ? 'Este workspace APPS usa Next.js por solicitud explícita o porque ya contiene un router Next ejecutable. Inspecciona package.json y extiende el proyecto en su estructura actual. Conserva app/, pages/, src/app/, src/pages/, next.config.* y next-env.d.ts cuando existan; NO conviertas el proyecto a Vite ni sustituyas sus scripts, routing o configuración Next.'
    : existingCustomBackendApps
      ? 'Este workspace APPS ya contiene un backend propio. Antes de editarlo, inspecciona package.json y su entry real; conserva exactamente el framework actual (por ejemplo Koa o Fastify), el tipo de módulos CJS/ESM, el archivo de entrada y sus scripts de arranque. Vite sigue siendo obligatorio para el frontend, pero NO sustituyas el backend por Express, NO inventes server/index.js y NO cambies package.json al starter Express.'
      : fullStackApps
        ? 'El workspace APPS ya viene provisionado con un starter FULL-STACK ejecutable: frontend React 18 + Vite 7 + TypeScript + Tailwind v4; backend Express en server/index.js; SQLite en server/db.js; proxy /api en vite.config.ts; y un script dev compuesto con concurrently que arranca API y web. Conserva y extiende TODAS esas capas: no reemplaces el backend, la base de datos, el proxy ni el script compuesto por una SPA.'
        : 'El workspace ya viene provisionado con un starter REACT 18 + VITE 7 + TypeScript + TAILWIND v4 ejecutable: package.json (react, react-dom, lucide-react para iconos, framer-motion para animación, recharts para gráficas, clsx, tailwindcss + @tailwindcss/vite, @vitejs/plugin-react, typescript, vite), vite.config.ts, tsconfig.json, index.html (carga /src/main.tsx), src/main.tsx, src/App.tsx, src/index.css, src/lib/ai.ts (helper askAI: IA real sin API keys) y src/lib/storage.ts (helper `storage`: PERSISTENCIA REAL server-side sin backend propio).';
  const persistenceContract = preserveNextApps
    ? 'PERSISTENCIA DEL PROYECTO NEXT EXISTENTE: conserva su ORM, driver, esquema, rutas API/server actions y variables actuales. No migres ni reemplaces esa capa salvo petición explícita del usuario.'
    : existingCustomBackendApps
      ? 'PERSISTENCIA DEL BACKEND EXISTENTE: conserva su driver, esquema y rutas actuales. No migres datos a localStorage ni reemplaces su capa de persistencia por SQLite/Express por defecto; amplía el contrato existente sólo después de leerlo.'
      : fullStackApps
        ? 'PERSISTENCIA FULL-STACK: los datos de dominio viven en SQLite y se exponen mediante rutas Express /api/* con validación server-side. El frontend consume la API usando import.meta.env.BASE_URL; no migres esos datos a localStorage ni al helper storage. Reserva storage únicamente para preferencias efímeras/personales que no pertenezcan al modelo de datos del servidor.'
        : 'PERSISTENCIA: cuando la app deba GUARDAR datos (notas, tareas, favoritos, ajustes, puntuaciones, diarios), usa `storage` de "./lib/storage" (o "../lib/storage"): `await storage.set(key, valor)` / `await storage.get<T>(key)` / `storage.remove(key)` / `storage.keys()` — ámbito PERSONAL por dispositivo; `storage.shared.*` para datos COMPARTIDOS entre todos los visitantes (leaderboards, muro común). Es async y cae a localStorage si el servicio falla. PREFIÉRELO sobre localStorage crudo para que los datos sobrevivan entre dispositivos/sesiones. Solo usa localStorage directo para estado efímero de UI.';
  const lines = [
    'Eres un agente de software senior trabajando dentro de un workspace aislado.',
    'Narras en PRIMERA PERSONA y en ESPAÑOL lo que vas haciendo, de forma breve y concreta.',
    'Construyes el proyecto usando las herramientas disponibles (no inventes resultados).',
    'Trabajas paso a paso: piensa, usa una herramienta, lee el resultado, continúa.',
    parallelTools
      ? 'Cuando varias lecturas, búsquedas o escrituras a archivos DISTINTOS sean independientes, puedes emitirlas en el mismo turno; el runtime preserva automáticamente las dependencias read-after-write.'
      : 'Emite herramientas de una en una; este runtime tiene desactivada la ejecución paralela.',
    starterContract,
    persistenceContract,
    preserveNextApps
      ? 'SISTEMA DE DISEÑO: conserva el sistema de estilos, componentes y tokens que ya usa el proyecto Next. No introduzcas Tailwind, Vite ni un kit alternativo sin leer primero la configuración existente y sin una petición explícita.'
      : 'SISTEMA DE DISEÑO: estiliza con clases Tailwind (NO estilos inline salvo valores dinámicos). Los tokens viven en src/index.css (:root → --bg/--surface/--fg/--muted/--accent/--line) y se usan como bg-bg, bg-surface, text-fg, text-muted, bg-accent, border-line; para re-temar la app (o pasarla a claro) edita SOLO esas variables. El kit src/ui/ trae Button, Card(+Header/Title/Description/Content/Footer), Input, Textarea, Label y Badge listos — impórtalos de "./ui" o "../ui" y extiéndelos con className; NO reinventes botones/tarjetas básicos. EXCEPCIÓN: si retomas un proyecto cuyo vite.config.ts NO incluye tailwindcss() (starter anterior), sigue el idioma de estilos que el proyecto ya use.',
    preserveNextApps
      ? 'NO ejecutes scaffolds interactivos ni reinicialices el framework. Lee las convenciones App Router/Pages Router existentes y edita sus archivos concretos con write_file/edit_file.'
      : 'NO inicialices frameworks ni ejecutes scaffolds interactivos (create-next-app/create-vite); construye componentes React (.tsx) editando/creando archivos en src/ con write_file/edit_file.',
    'Si necesitas estructura adicional, crea archivos concretos tú mismo. Para paquetes npm usa install_dependencies (no run_command); luego ejecuta type_check y dev_server_check. Usa run_command solo para comandos no interactivos de verificación o git. En este runner NO uses bunx para tsc, Vitest, Jest o ESLint: usa type_check y los scripts del package.json; los gates ejecutan los binarios locales con Node.',
    'Antes de editar un archivo existente, léelo (read_file) y usa edit_file con el fragmento EXACTO; usa repo_map (mapa rankeado de símbolos) al retomar un proyecto existente y list_files/grep_search para el detalle, en vez de adivinar rutas.',
    'NO reescribas un archivo que ya escribiste salvo para corregir un error concreto (uno que viste en type_check o dev_server_check). Construye archivo por archivo siguiendo el plan; NO intentes hacerlo "todo de una vez" reescribiendo el mismo archivo una y otra vez. Cuando un archivo esté listo, avanza al siguiente paso del plan.',
    'Antes de dar por terminado, asegúrate de que el proyecto compila (el sistema ejecutará una verificación de tipos al final y te devolverá los errores si los hay).',
    'Nunca dependas de prompts interactivos de terminal; los comandos deben terminar solos.',
    preserveNextApps
      ? 'VERIFICA tu trabajo como lo haría un ingeniero: después de editar o instalar dependencias usa type_check para leer errores reales de compilación, dev_server_check para confirmar que Next corre y browser_check para detectar excepciones de runtime, páginas en blanco u overlays; corrige lo que salga antes de dar el trabajo por terminado.'
      : 'VERIFICA tu trabajo como lo haría un ingeniero: después de crear, editar o instalar dependencias usa type_check para instalar/leer errores reales de compilación, dev_server_check para confirmar que la app corre y browser_check para ver la app con ojos de usuario (excepciones de runtime, página en blanco, overlay de Vite); corrige lo que salga antes de dar el trabajo por terminado.',
    require('./skills').skillsPromptLine(),
    'Para tareas grandes o especializadas delega con run_subagent: planner (plan de construcción), frontend_builder (UI React/TS), backend_engineer (APIs y capa de datos), db_architect (modelo de datos), qa_reviewer (revisión final), debugger (diagnóstico y fix de errores reales), enterprise_analyst (especificación de negocio). Si el proyecto define agentes custom en .sira/agents.json también puedes delegarles.',
    parallelSubagents
      ? 'Los subagentes son independientes: cuando dos tareas no dependen entre sí, puedes emitir VARIOS run_subagent en el MISMO turno y correrán en paralelo.'
      : 'Delega a los subagentes de uno en uno. Este workspace aún no usa worktrees separados, así que las delegaciones se serializan para impedir escrituras concurrentes sobre el mismo checkout.',
    'Si el usuario pide software de EMPRESA (CRM, ERP, inventario, facturación, RRHH, punto de venta, gestión de clientes/proveedores/proyectos), delega PRIMERO en enterprise_analyst para convertir el pedido en módulos, entidades, roles y flujos; luego construye una app multi-módulo con navegación lateral, dashboard con KPIs y datos de ejemplo realistas del dominio.',
    `Proyecto: ${project?.name || 'Codex'}.`,
  ];
  if (projectSettings) {
    lines.push(`Política del proyecto (.sira/settings.json): modo=${projectSettings.mode}; tools allow=${projectSettings.tools.allow.join(', ') || 'todas'}; deny=${projectSettings.tools.deny.join(', ') || 'ninguna'}; aprobación=${projectSettings.tools.requireApproval.join(', ') || (projectSettings.mode === 'confirm' ? 'acciones sensibles' : 'solo MCP externo')}. Respeta esta política; no intentes eludirla.`);
  }
  if (openclawPromptBlock) {
    lines.push(openclawPromptBlock);
  }
  if (companySoul) {
    lines.push('SOUL.md DE LA EMPRESA (generado desde Company; aplica a esta corrida y a todos sus subagentes):');
    lines.push(String(companySoul).slice(0, 8000));
  }
  if (forceViteApps) {
    lines.push('Este run viene de /apps. Stack OBLIGATORIO: React 18 + Vite 7 + TypeScript (el starter ya provisto). Construye componentes .tsx en src/; el entry es src/main.tsx que monta <App/> en #root.');
    lines.push(existingCustomBackendApps
      ? 'PROHIBIDO degradar el backend existente: conserva framework, CJS/ESM, entry y scripts actuales. Mantén Vite para el frontend y su integración con la API; no introduzcas Express/server/index.js salvo petición explícita del usuario.'
      : fullStackApps
        ? 'PROHIBIDO Next.js: NO crees next.config.mjs, app/ ni pages/. Mantén Vite para el frontend Y conserva Express + SQLite + el proxy /api y el script dev con concurrently; NO lo reduzcas a dev="vite". El resultado completo debe abrir en el preview de inmediato.'
        : 'PROHIBIDO Next.js: NO crees next.config.mjs, app/, pages/ ni cambies package.json a "next dev". Mantén el package.json Vite (script dev="vite"). El resultado debe abrir en el preview de inmediato.');
  }
  if (plan) {
    lines.push(preserveNextApps
      ? 'Plan aprobado por el usuario: sigue sus objetivos funcionales sin migrar el framework Next existente.'
      : 'Plan aprobado por el usuario (síguelo):');
    lines.push(JSON.stringify(plan));
    if (preserveNextApps) {
      lines.push('Si el plan menciona Vite, app/ SPA o src/main.tsx, trátalo como una suposición obsoleta del planificador: conserva Next.js y adapta las tareas a su App Router/Pages Router actual.');
    }
    lines.push('Mantén el checklist del plan al día con update_plan (como TodoWrite): ANTES de empezar una tarea, llama update_plan marcándola in_progress; al terminarla, llama update_plan marcándola completed, ANTES de avanzar a la siguiente. Pasa SIEMPRE la lista COMPLETA de tareas del plan (id + title + status) en cada llamada, no solo la que cambió. Usa exactamente los mismos id y title del plan.');
  }
  if (fileTree) {
    lines.push('Archivos actuales del workspace:');
    lines.push(fileTree);
  }
  if (projectNotes) {
    lines.push('MEMORIA DEL PROYECTO (SIRA.md + .sira/notes.md — instrucciones, decisiones y convenciones acumuladas; respétalas):');
    lines.push(projectNotes);
  }
  if (progressContext) {
    lines.push('MEMORIA ESTRUCTURADA DEL PROYECTO (objetivos y resultados reales de corridas anteriores):');
    lines.push(progressContext);
    lines.push('Usa este ledger para no repetir errores, conservar decisiones y avanzar los objetivos vigentes.');
  }
  lines.push('Mantén la memoria del proyecto: SIRA.md contiene instrucciones y convenciones duraderas; .sira/notes.md conserva notas operativas breves. Cuando tomes una decisión estructural o dejes trabajo pendiente, lee primero el archivo correspondiente y actualiza .sira/notes.md con edit_file; actualiza también SIRA.md cuando cambien instrucciones o convenciones duraderas (crea los archivos si no existen; evita duplicados y conserva lo más importante arriba).');
  // Deterministic skill auto-injection: when the prompt clearly matches a
  // builtin playbook, its full body ships with the system prompt — the E2E
  // validation showed models skip a passively-listed use_skill.
  try {
    const autoDetected = require('./skills').detectSkillForPrompt(sourcePrompt);
    const detected = existingCustomBackendApps && autoDetected?.name === 'backend-real'
      ? null
      : fullStackApps && !existingCustomBackendApps
      ? require('./skills').getSkill('backend-real')
      : autoDetected;
    if (detected) {
      lines.push(`PLAYBOOK APLICABLE (${detected.name}) — SÍGUELO como estándar de calidad de este trabajo:`);
      lines.push(detected.body);
    }
  } catch { /* skills are an aid, never a blocker */ }
  lines.push('Cuando el proyecto esté listo, deja de llamar herramientas y resume lo construido.');
  return lines.join('\n');
}

/**
 * In-place transcript compaction (Claude Code-style "microcompact"): when the
 * transcript exceeds the char budget, old `[TOOL_RESULT]` bodies — the bulk of
 * the growth — are truncated first. If the protected working set alone is too
 * large, progressively bound old, recent, task and system messages. The hard
 * fallback is deliberate: callers must never send more than `maxChars` after
 * compaction, even when the last ten messages are individually huge.
 */
function compactMessages(messages, { maxChars = DEFAULT_CONTEXT_MAX_CHARS } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const limit = Math.max(0, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : DEFAULT_CONTEXT_MAX_CHARS);
  const total = messageChars(messages);
  if (total <= limit) return 0;
  const compacted = new Set();
  const lastKeep = Math.max(2, messages.length - COMPACT_KEEP_TAIL);
  for (let i = 2; i < lastKeep; i += 1) {
    const m = messages[i];
    const content = typeof m?.content === 'string' ? m.content : '';
    if (m?.role === 'user' && content.startsWith('[TOOL_RESULT') && content.length > COMPACT_TOOL_RESULT_CAP + 60) {
      messages[i] = { ...m, content: `${content.slice(0, COMPACT_TOOL_RESULT_CAP)}\n…[resultado antiguo recortado; vuelve a leer el archivo si lo necesitas]` };
      compacted.add(i);
    }
  }

  const truncateAt = (index, floor) => {
    const message = messages[index];
    const text = messageContentText(message?.content);
    const excess = messageChars(messages) - limit;
    if (excess <= 0 || text.length <= floor) return;
    const target = Math.max(floor, text.length - excess);
    if (target >= text.length) return;
    if (target === 0) {
      messages[index] = { ...message, content: '' };
    } else {
      const marker = '\n…[contexto recortado por límite]…\n';
      const available = Math.max(0, target - marker.length);
      const head = Math.ceil(available * 0.6);
      const tail = Math.max(0, available - head);
      messages[index] = {
        ...message,
        content: `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`.slice(0, target),
      };
    }
    compacted.add(index);
  };

  const summaryIndex = messages.findIndex((message, index) => (
    index >= 2 && messageContentText(message?.content).startsWith('[COMPACTION · RESUMEN DE CONTEXTO]')
  ));
  const recentStart = Math.max(2, messages.length - COMPACT_KEEP_TAIL);

  // Old context is cheapest to recover through tools, so reduce it first.
  for (let i = 2; i < recentStart && messageChars(messages) > limit; i += 1) {
    truncateAt(i, i === summaryIndex ? COMPACT_SUMMARY_FLOOR : COMPACT_MESSAGE_FLOOR);
  }
  // Preserve more of the newest turns, but never let the tail violate the cap.
  for (let i = recentStart; i < messages.length && messageChars(messages) > limit; i += 1) {
    const floor = i === summaryIndex
      ? COMPACT_SUMMARY_FLOOR
      : (i >= messages.length - 2 ? COMPACT_RECENT_MESSAGE_FLOOR : COMPACT_MESSAGE_FLOOR);
    truncateAt(i, floor);
  }
  if (messageChars(messages) > limit && messages[1]) truncateAt(1, COMPACT_RECENT_MESSAGE_FLOOR);
  if (messageChars(messages) > limit && messages[0]) truncateAt(0, COMPACT_SYSTEM_FLOOR);

  // Extremely small explicit limits or very large message counts can make the
  // semantic floors impossible. Drop those floors oldest-first, then bound the
  // remaining longest payload until the invariant is satisfied.
  for (let i = 2; i < messages.length && messageChars(messages) > limit; i += 1) truncateAt(i, 0);
  if (messageChars(messages) > limit && messages[1]) truncateAt(1, 0);
  if (messageChars(messages) > limit && messages[0]) truncateAt(0, 0);

  return compacted.size;
}

function messageChars(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((total, message) => total + messageContentText(message?.content).length, 0);
}

function boundedTail(messages, count = COMPACT_KEEP_TAIL) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .slice(-Math.max(2, count))
    .map((message) => ({
      role: message.role,
      content: messageContentText(message.content).slice(0, CONTEXT_SNAPSHOT_MESSAGE_CAP),
    }));
}

function summaryInput(messages) {
  const rows = (Array.isArray(messages) ? messages : []).slice(2, -COMPACT_KEEP_TAIL);
  const parts = [];
  let remaining = CONTEXT_SUMMARY_INPUT_CAP;
  for (const row of rows) {
    if (remaining <= 0) break;
    const text = messageContentText(row?.content);
    if (!text) continue;
    const piece = `${String(row.role || 'unknown').toUpperCase()}:\n${text}\n`;
    parts.push(piece.slice(0, remaining));
    remaining -= piece.length;
  }
  return parts.join('\n').slice(0, CONTEXT_SUMMARY_INPUT_CAP);
}

async function summariseContextWithLlm({
  messages,
  llmTurn,
  signal,
  env,
  tier,
  metrics,
}) {
  if (typeof llmTurn !== 'function') return '';
  const input = summaryInput(messages);
  if (!input.trim()) return '';
  try {
    const turn = await llmTurn({
      messages: [
        {
          role: 'system',
          content: [
            'Resume el estado de una sesión de programación para que otro agente continúe sin repetir trabajo.',
            'Conserva: objetivo, decisiones, archivos leídos/modificados, resultados de tools, errores pendientes, plan y próximo paso.',
            'No inventes. Devuelve solo un resumen técnico compacto en español.',
          ].join('\n'),
        },
        { role: 'user', content: input },
      ],
      tools: [],
      signal,
      env,
      tier,
      effort: 'low',
    });
    recordLlmUsageOnce(metrics, turn?.usage);
    return String(turn?.text || '').trim().slice(0, CONTEXT_SUMMARY_CAP);
  } catch (error) {
    if (/^CODEX_PROJECT_(?:DAILY_)?BUDGET_/.test(String(error?.code || ''))) throw error;
    return '';
  }
}

async function loadLatestContextSnapshot({ runId, eventStore, prisma }) {
  if (!runId || typeof eventStore?.listEvents !== 'function') return null;
  try {
    const events = await eventStore.listEvents(runId, { afterSeq: 0, prisma });
    return [...events].reverse().find((event) => event?.type === 'context_snapshot')?.data || null;
  } catch {
    return null;
  }
}

async function loadResolvedToolPermissions({ runId, eventStore, prisma }) {
  const allowed = new Set();
  allowed.permissionIds = new Map();
  allowed.decisions = [];
  if (!runId || typeof eventStore?.listEvents !== 'function') return allowed;
  try {
    const events = await eventStore.listEvents(runId, { afterSeq: 0, prisma });
    for (const event of events) {
      const toolName = String(event.data?.toolName || '');
      const permissionId = String(event.data?.permissionId || '');
      const bindingHash = String(event.data?.bindingHash || '');
      if (!/^[a-f0-9]{64}$/.test(bindingHash)) continue;
      if (event?.type === 'tool_permission_resolved') {
        if (event.data?.decision === 'allow') {
          allowed.add(bindingHash);
          allowed.permissionIds.set(bindingHash, permissionId);
        }
        if (event.data?.decision === 'deny') {
          allowed.delete(bindingHash);
          allowed.permissionIds.delete(bindingHash);
        }
        allowed.decisions.push({ toolName, bindingHash, decision: event.data?.decision });
      }
      if (
        event?.type === 'tool_permission_consumed'
        && allowed.permissionIds.get(bindingHash) === permissionId
      ) {
        allowed.delete(bindingHash);
        allowed.permissionIds.delete(bindingHash);
      }
    }
  } catch { /* no persisted permission decisions yet */ }
  return allowed;
}

async function persistContextSnapshot({
  run,
  eventStore,
  prisma,
  summary = '',
  messages,
  state = {},
}) {
  if (!run?.id || typeof eventStore?.appendEvent !== 'function') return;
  await eventStore.appendEvent(
    run.id,
    'context_snapshot',
    {
      summary: String(summary || '').slice(0, CONTEXT_SUMMARY_CAP),
      tailMessages: boundedTail(messages),
      state: {
        verifyRounds: Math.max(0, Number(state.verifyRounds) || 0),
        planExtensionsUsed: Math.max(0, Number(state.planExtensionsUsed) || 0),
        planTasks: Array.isArray(state.planTasks) ? state.planTasks.slice(0, 80) : [],
      },
    },
    { prisma },
  ).catch(() => {});
}

/**
 * Optional runtime verification (flag-gated by CODEX_VERIFY_DEV_SERVER, OFF by
 * default). Boots the project's dev server through the runner and waits — with a
 * bounded timeout — for it to become ready. Reuses the `dev_server_check`
 * runner contract (devStatus/startDev). Returns:
 *   - { ran:true, ok:true }                     → dev server ready, no errors.
 *   - { ran:true, ok:false, errors }            → real runtime/boot error to feed back.
 *   - { ran:false, ok:true }                    → infra unavailable / cannot boot for
 *                                                 non-code reasons → degrade to "not
 *                                                 verified" (NEVER fails a good build).
 * Best-effort by contract: any runner/env failure is treated as "not verified",
 * exactly like the tsc path. When it started the server itself it stops it so the
 * verification never leaves a dev server hanging.
 */
function logTailSince(previousTail, currentTail) {
  const previous = Array.isArray(previousTail) ? previousTail.map((line) => String(line)) : [];
  const current = Array.isArray(currentTail) ? currentTail.map((line) => String(line)) : [];
  if (!previous.length || !current.length) return current;

  // The host runner exposes a bounded rolling tail, not timestamps/cursors.
  // Find the largest suffix/prefix overlap so a reused Vite server is judged
  // only by lines emitted during this probe. Current browser evidence remains
  // authoritative for HMR state that produced no new server log lines.
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previous[previous.length - overlap + index] !== current[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return current.slice(overlap);
  }
  return current;
}

async function verifyDevServer({
  runner,
  projectId,
  run,
  eventStore,
  prisma,
  metrics,
  clock,
  env = process.env,
  actionId,
  groupId,
  strict = false,
  browserCheck = null,
}) {
  if (!strict && String(env.CODEX_VERIFY_DEV_SERVER ?? '0') !== '1') return { ran: false, ok: true };
  if (typeof runner?.devStatus !== 'function' || typeof runner?.startDev !== 'function') {
    const errors = 'El runner no expone devStatus/startDev; no se puede demostrar que la aplicación arranca.';
    return strict
      ? { ran: true, ok: false, kind: 'infra', errors, devServer: { ran: false, ok: false }, browser: { ran: false, ok: false } }
      : { ran: false, ok: true };
  }

  const timeoutMs = readPosInt(env.CODEX_VERIFY_DEV_TIMEOUT_MS, DEFAULT_VERIFY_DEV_TIMEOUT_MS);
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

  await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: 'verificación runtime: dev server', groupId }, { prisma }).catch(() => {});
  const t0 = clock().getTime();
  let startedByUs = false;
  let status = null;
  let initialTail = [];
  try {
    status = await runner.devStatus(projectId);
    initialTail = Array.isArray(status?.tail) ? status.tail : [];
    // Not running (or running a DIFFERENT project) → (re)start it for this one.
    if (!status?.running || (status.project && status.project !== projectId)) {
      await runner.startDev(projectId);
      startedByUs = true;
    }
    const deadline = Date.now() + timeoutMs;
    do {
      await sleep(1500);
      status = await runner.devStatus(projectId);
      if (status?.ready || status?.error) break;
    } while (Date.now() < deadline);
  } catch (err) {
    // Runner/infra failure (not a code failure) → skip runtime verification
    // honestly, and stop a server we started so nothing hangs.
    if (startedByUs && typeof runner.stopDev === 'function') await runner.stopDev(projectId).catch(() => {});
    await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `verificación runtime no disponible: ${err.message}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
    const errors = `verificación runtime no disponible: ${err.message}`;
    return strict
      ? { ran: true, ok: false, kind: 'infra', errors, devServer: { ran: false, ok: false }, browser: { ran: false, ok: false } }
      : { ran: false, ok: true };
  }

  const durationMs = Math.max(0, clock().getTime() - t0);
  const currentTail = Array.isArray(status?.tail) ? status.tail : [];
  const probeTail = startedByUs ? currentTail : logTailSince(initialTail, currentTail);
  const tail = probeTail.join('\n');
  const errLines = tail.split('\n').filter((l) => /error|failed|cannot|not found|exception/i.test(l)).join('\n');
  const ok = Boolean(status?.ready) && !status?.error && !errLines;

  if (ok) {
    // Browser pass (bolt.diy loop-closer): the dev server answering is not the
    // same as the APP WORKING — a runtime exception leaves #root blank with a
    // clean server log. Drive the system Chromium against the dev URL and feed
    // real user-facing errors back to the repair loop. Best-effort by
    // contract: no browser/infra → still verified-ok. CODEX_VERIFY_BROWSER=0 disables.
    if (strict || String(env.CODEX_VERIFY_BROWSER || '1').trim() !== '0') {
      try {
        // Production resolves the real Chromium checker lazily. Tests may inject
        // the same small contract so the final fail-closed gate stays offline.
        // eslint-disable-next-line global-require
        const bc = browserCheck || require('./browser-check');
        const url = bc.devUrlFor(env, status?.port || 5173);
        const view = await bc.checkApp({ url, env });
        if (view.unavailable && strict) {
          const report = bc.formatReport(view, url);
          await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `browser_check obligatorio no disponible:\n${String(report).slice(0, 2000)}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
          return {
            ran: true,
            ok: false,
            kind: 'browser',
            errors: String(report).slice(0, 4000),
            devServer: { ran: true, ok: true },
            browser: { ran: false, ok: false, unavailable: true },
          };
        }
        if (!view.unavailable && !view.ok) {
          const report = bc.formatReport(view, url);
          await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `la app no funciona en el navegador:\n${String(report).slice(0, 2000)}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
          return {
            ran: true,
            ok: false,
            kind: 'browser',
            errors: String(report).slice(0, 4000),
            devServer: { ran: true, ok: true },
            browser: { ran: true, ok: false },
          };
        }
        if (!view.unavailable) {
          await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'done', outputSummary: 'dev server arranca y browser_check renderiza #root sin errores', durationMs }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
          return {
            ran: true,
            ok: true,
            kind: 'browser',
            devServer: { ran: true, ok: true },
            browser: { ran: true, ok: true },
          };
        }
      } catch (err) {
        if (strict) {
          const errors = `browser_check obligatorio falló: ${err.message}`;
          await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: errors, durationMs }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
          return {
            ran: true,
            ok: false,
            kind: 'browser',
            errors,
            devServer: { ran: true, ok: true },
            browser: { ran: false, ok: false, unavailable: true },
          };
        }
      }
    }
    await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'done', outputSummary: 'dev server arranca y la app renderiza en navegador', durationMs }, { prisma }).catch(() => {});
    if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
    return {
      ran: true,
      ok: true,
      kind: 'runtime',
      devServer: { ran: true, ok: true },
      browser: { ran: false, ok: !strict },
    };
  }

  // A dev server that never became ready and reported NO error/log tail is an
  // infra symptom (runner slot never answered), not a code defect: don't turn a
  // good build into a runtime failure — degrade to "not verified".
  if (!status?.ready && !status?.error && !errLines) {
    if (startedByUs && typeof runner.stopDev === 'function') await runner.stopDev(projectId).catch(() => {});
    await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: 'verificación runtime no disponible: el dev server no respondió a tiempo', durationMs }, { prisma }).catch(() => {});
    const errors = 'El dev server no respondió a tiempo y no produjo evidencia suficiente.';
    return strict
      ? { ran: true, ok: false, kind: 'infra', errors, devServer: { ran: false, ok: false }, browser: { ran: false, ok: false } }
      : { ran: false, ok: true };
  }

  const errors = (status?.error ? `${status.error}\n` : '') + (errLines || tail);
  await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `el dev server no arranca:\n${String(errors).slice(0, 2000)}`, durationMs }, { prisma }).catch(() => {});
  if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
  return {
    ran: true,
    ok: false,
    kind: 'runtime',
    errors: String(errors).slice(0, 4000),
    devServer: { ran: true, ok: false },
    browser: { ran: false, ok: false },
  };
}

/**
 * Run an existing Vitest/smoke-test script. A normal build only executes tests
 * when the workspace defines them; the periodic proactive QA cycle makes their
 * absence a blocking failure so the agent must add durable regression coverage.
 */
async function verifySmokeTests({
  runner,
  projectId,
  run,
  eventStore,
  prisma,
  metrics,
  clock,
  actionId,
  groupId,
  required = false,
}) {
  let pkg;
  try {
    const read = await runner.readFile(projectId, 'package.json');
    pkg = JSON.parse(String(read?.content || '{}'));
  } catch {
    const errors = 'package.json no existe o no es JSON válido; no se pueden ejecutar smoke tests.';
    return required
      ? { ran: true, ok: false, kind: 'smoke', errors }
      : { ran: false, ok: true };
  }
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  let command = null;
  if (scripts['test:smoke']) command = ['npm', 'run', 'test:smoke'];
  else if (scripts.test) {
    command = /\bvitest\b/i.test(String(scripts.test))
      ? ['npm', 'run', 'test', '--', '--run']
      : ['npm', 'run', 'test'];
  } else if (deps.vitest) command = localCliCommand('vitest', 'run');

  if (!command) {
    const errors = 'El ciclo QA exige smoke tests, pero package.json no define test/test:smoke ni incluye Vitest.';
    return required
      ? { ran: true, ok: false, kind: 'smoke', errors }
      : { ran: false, ok: true };
  }

  await eventStore.appendEvent(run.id, 'action_start', {
    actionId,
    kind: 'terminal',
    command: command.join(' '),
    groupId,
  }, { prisma }).catch(() => {});
  const t0 = clock().getTime();
  try {
    const out = await runner.exec(projectId, command, { timeoutMs: 120_000 });
    const durationMs = Math.max(0, clock().getTime() - t0);
    const output = String([out?.stdout, out?.stderr].filter(Boolean).join('\n')).slice(0, 4000);
    const ok = out?.exitCode === 0;
    await eventStore.appendEvent(run.id, 'action_end', {
      actionId,
      status: ok ? 'done' : 'error',
      outputSummary: ok ? 'smoke tests pasan' : (output || `smoke tests exit ${out?.exitCode}`),
      durationMs,
    }, { prisma }).catch(() => {});
    if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
    return ok
      ? { ran: true, ok: true, kind: 'smoke' }
      : { ran: true, ok: false, kind: 'smoke', errors: output || `smoke tests exit ${out?.exitCode}` };
  } catch (err) {
    const durationMs = Math.max(0, clock().getTime() - t0);
    const errors = `smoke tests no disponibles: ${err.message}`;
    await eventStore.appendEvent(run.id, 'action_end', {
      actionId,
      status: 'error',
      outputSummary: errors,
      durationMs,
    }, { prisma }).catch(() => {});
    if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
    return required
      ? { ran: true, ok: false, kind: 'smoke', errors }
      : { ran: false, ok: true, kind: 'smoke' };
  }
}

/**
 * Post-build verification (the missing "fifth leg" vs Claude Code): install
 * deps and typecheck the workspace, feeding failures back to the model for a
 * bounded number of repair rounds. Only runs when the workspace has a real
 * tsconfig.json — deterministic no-op otherwise (keeps scripted tests inert).
 * Emits action events so the timeline shows the verification like any tool.
 *
 * When CODEX_VERIFY_DEV_SERVER=1 (OFF by default), a CLEAN tsc (or a project
 * with nothing to typecheck) is followed by a runtime dev-server boot check; a
 * real runtime error is returned as `{ ok:false, kind:'runtime', errors }` so
 * the caller's existing repair-round loop feeds it back to the model. With the
 * flag unset/0 this is a no-op and behaviour is byte-identical to before.
 */
async function verifyWorkspace({
  runner,
  projectId,
  run,
  eventStore,
  prisma,
  metrics,
  clock,
  env = process.env,
  actionId,
  groupId,
  strict = false,
  requireSmoke = false,
  browserCheck = null,
}) {
  const gates = {
    typeCheck: { ran: false, ok: !strict },
    smoke: { ran: false, ok: !requireSmoke },
    devServer: { ran: false, ok: !strict },
    browser: { ran: false, ok: !strict },
  };
  if (!strict && String(env.CODEX_VERIFY_DISABLED || '') === '1') return { ran: false, ok: true, gates };
  if (typeof runner?.exec !== 'function' || typeof runner?.readFile !== 'function') {
    const errors = 'El runner no permite exec/readFile; el gate proactivo no puede verificar el workspace.';
    return strict ? { ran: true, ok: false, kind: 'infra', errors, gates } : { ran: false, ok: true, gates };
  }

  let tsconfig = '';
  try {
    const out = await runner.readFile(projectId, 'tsconfig.json');
    tsconfig = String(out?.content || '');
  } catch { /* no tsconfig → nothing to verify */ }
  let tsValid = false;
  if (tsconfig.trim()) {
    // Only verify REAL TypeScript projects: the tsconfig must parse (JSONC
    // comments tolerated). Garbage/placeholder content → not a TS project.
    try {
      JSON.parse(tsconfig.replace(/^\s*\/\/.*$/gm, ''));
      tsValid = true;
    } catch { /* not a real tsconfig */ }
  }

  let tscOk = true;
  if (tsValid) {
    await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: 'verificación: bun install + tsc --noEmit', groupId }, { prisma }).catch(() => {});
    const t0 = clock().getTime();
    let ok = false;
    let errors = '';
    try {
      const install = await runner.exec(projectId, ['bun', 'install'], { timeoutMs: 120_000 });
      if (install.exitCode !== 0) {
        errors = `bun install exit ${install.exitCode}\n${String(install.stderr || install.stdout || '').slice(0, 4000)}`;
      } else {
        const tsc = await runner.exec(
          projectId,
          localCliCommand('tsc', '--noEmit', '--pretty', 'false'),
          { timeoutMs: 120_000 },
        );
        if (tsc.exitCode === 0) ok = true;
        else errors = String([tsc.stdout, tsc.stderr].filter(Boolean).join('\n')).slice(0, 4000) || `tsc exit ${tsc.exitCode}`;
      }
    } catch (err) {
      // Runner/env failure (not a code failure) → skip verification honestly.
      await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `verificación no disponible: ${err.message}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
      const errors = `verificación no disponible: ${err.message}`;
      return strict
        ? { ran: true, ok: false, kind: 'infra', errors, gates }
        : { ran: false, ok: true, gates };
    }
    const durationMs = Math.max(0, clock().getTime() - t0);
    await eventStore.appendEvent(run.id, 'action_end', { actionId, status: ok ? 'done' : 'error', outputSummary: ok ? 'compila sin errores de tipos' : errors, durationMs }, { prisma }).catch(() => {});
    if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
    gates.typeCheck = { ran: true, ok };
    if (!ok) return { ran: true, ok: false, kind: 'tsc', errors, gates };
    tscOk = true;
  } else if (strict) {
    const errors = 'El gate proactivo exige un tsconfig.json válido para ejecutar type_check.';
    return { ran: true, ok: false, kind: 'tsc', errors, gates };
  }

  const smoke = await verifySmokeTests({
    runner,
    projectId,
    run,
    eventStore,
    prisma,
    metrics,
    clock,
    actionId: `${actionId}-smoke`,
    groupId,
    required: requireSmoke,
  });
  gates.smoke = { ran: smoke.ran, ok: smoke.ok };
  if (smoke.ran && !smoke.ok) return { ran: true, ok: false, kind: 'smoke', errors: smoke.errors, gates };

  // Optional runtime check (flag-gated OFF by default). Runs after a clean tsc,
  // or on its own for a project with no tsconfig to typecheck. Reuses the same
  // repair-round mechanism through the caller (kind:'runtime').
  if (tscOk) {
    const rt = await verifyDevServer({
      runner,
      projectId,
      run,
      eventStore,
      prisma,
      metrics,
      clock,
      env,
      actionId: `${actionId}-runtime`,
      groupId,
      strict,
      browserCheck,
    });
    if (rt.devServer) gates.devServer = rt.devServer;
    if (rt.browser) gates.browser = rt.browser;
    if (rt.ran && !rt.ok) return { ran: true, ok: false, kind: rt.kind || 'runtime', errors: rt.errors, gates };
    if (rt.ran) return { ran: true, ok: true, kind: rt.kind || 'runtime', gates };
  }

  // Nothing verified at all (no valid tsconfig + flag off) → deterministic no-op.
  if (!tsValid) return { ran: false, ok: true, gates };
  return { ran: true, ok: true, kind: 'tsc', gates };
}

/** Best-effort tracked-file listing for context. Never throws. */
async function safeFileTree(runner, projectId) {
  try {
    const out = await runner.exec(projectId, ['git', 'ls-files']);
    if (!out || out.exitCode !== 0 || !out.stdout) return '';
    const flat = String(out.stdout);
    const paths = flat.split('\n').map((l) => l.trim()).filter(Boolean);
    // Grown project → ranked repo map instead of a flat list (deterministic:
    // the E2E validation showed models skip passively-offered tools). Small
    // starters keep the flat tree — the map adds nothing there.
    const sourceCount = paths.filter((p) => /\.(tsx?|jsx?)$/.test(p) && !/(^|\/)node_modules\//.test(p)).length;
    if (sourceCount >= 6) {
      try {
        // eslint-disable-next-line global-require
        const { buildRepoMap } = require('./repo-map');
        const map = await buildRepoMap({ runner, project: projectId });
        if (map) return map.slice(0, 4600);
      } catch { /* map is an aid — fall back to the flat tree */ }
    }
    return flat.slice(0, 4000);
  } catch { /* ignore */ }
  return '';
}

/**
 * Project memory (CLAUDE.md pattern): root SIRA.md is the durable instruction
 * file and `.sira/notes.md` is the compact operational notebook. Both are
 * loaded on every run so a new session inherits conventions immediately.
 */
async function safeProjectNotes(runner, projectId) {
  const read = async (path) => {
    try {
      const out = await runner.readFile(projectId, path);
      return typeof out?.content === 'string' ? out.content.trim() : '';
    } catch {
      return '';
    }
  };
  const [instructions, notes] = await Promise.all([read('SIRA.md'), read('.sira/notes.md')]);
  if (!instructions) return notes.slice(0, 2400);
  const sections = [];
  if (instructions) sections.push(`## SIRA.md\n${instructions.slice(0, 5000)}`);
  if (notes) sections.push(`## .sira/notes.md\n${notes.slice(0, 3000)}`);
  return sections.join('\n\n').slice(0, 8000);
}

/** Load the approved plan from the plan run's plan_proposed event. */
async function loadApprovedPlan({ run, eventStore, prisma }) {
  if (!run.planRunId || !eventStore?.listEvents) return null;
  try {
    const events = await eventStore.listEvents(run.planRunId, { afterSeq: 0, prisma });
    const proposed = [...events].reverse().find((e) => e.type === 'plan_proposed');
    return proposed ? proposed.data : null;
  } catch {
    return null;
  }
}

async function resolveRunSourcePrompt({ run, prisma }) {
  if (run?.prompt) return run.prompt;
  if (!run?.planRunId || !prisma?.codexRun?.findUnique) return '';
  try {
    const planRun = await prisma.codexRun.findUnique({
      where: { id: run.planRunId },
      select: { prompt: true },
    });
    return planRun?.prompt || '';
  } catch {
    return '';
  }
}

async function runBuildLoop({ run, project, signal, isCancelled, deps }) {
  const { eventStore, prisma, env = process.env, clock = () => new Date() } = deps;
  // The metrics accumulator (feature 08) is fed during the loop and finalized at
  // close. Created here when the caller didn't inject one.
  const metrics = deps.metrics || runMetrics.createAccumulator({ run, clock });
  const baseLlmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));
  const runner = deps.runner || createSandboxClient();
  const checkpointServiceForRun = deps.checkpointService || checkpointService;
  const actionStore = deps.actionStore || actionStoreDefault;
  const webSearch = deps.webSearch || defaultWebSearch;
  const projectId = project?.id || run.projectId;
  const runBranchesEnabled = productionFeatureEnabled(env, 'CODEX_RUN_BRANCHES');
  // eslint-disable-next-line global-require
  const projectSettingsModule = require('./project-settings');
  const settingsState = deps.projectSettings?.settings
    ? deps.projectSettings
    : (deps.projectSettings
      ? { settings: deps.projectSettings, error: null, source: 'injected' }
      : await projectSettingsModule.loadProjectSettings({ runner, projectId, project }));
  const projectSettings = settingsState.settings;
  if (settingsState.error) {
    const error = `invalid .sira/settings.json: ${settingsState.error}`;
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `No inicié cambios porque la política del proyecto es inválida: ${settingsState.error}`,
    }, { prisma }).catch(() => {});
    return { status: 'error', error };
  }
  if (projectSettings.mode === 'plan-only') {
    const error = 'project mode plan-only: inicia un run en modo plan o cambia .sira/settings.json';
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: 'Este proyecto está en modo solo-plan. No ejecuté herramientas ni modifiqué archivos.',
    }, { prisma }).catch(() => {});
    return { status: 'error', error };
  }

  const projectBudget = deps.projectBudget || require('./project-budget');
  const budget = await projectBudget.checkProjectBudget({
    prisma,
    projectId,
    settings: projectSettings,
    env,
    now: clock(),
  });
  await eventStore.appendEvent(run.id, 'budget_status', {
    allowed: budget.allowed,
    reason: budget.reason,
    costTodayUsd: budget.costTodayUsd,
    dailyBudgetUsd: budget.dailyBudgetUsd,
    remainingUsd: budget.remainingUsd,
  }, { prisma }).catch(() => {});
  if (!budget.allowed) {
    const error = budget.reason === 'daily_budget_exceeded'
      ? `project daily budget exceeded: $${Number(budget.costTodayUsd || 0).toFixed(4)} of $${Number(budget.dailyBudgetUsd || 0).toFixed(2)}`
      : `project budget preflight failed: ${budget.error || budget.reason}`;
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: budget.reason === 'daily_budget_exceeded'
        ? `No inicié esta corrida: el proyecto alcanzó su presupuesto diario de $${Number(budget.dailyBudgetUsd || 0).toFixed(2)}.`
        : 'No inicié esta corrida porque no pude verificar de forma segura el presupuesto diario.',
    }, { prisma }).catch(() => {});
    return { status: 'error', error };
  }

  const companyBudgetEnabled = env?.NODE_ENV === 'production'
    || project?.brief?.proactive?.configuredDailyBudgetUsd != null
    || String(env?.CODEX_PROACTIVE_DAILY_BUDGET_USD ?? '').trim() !== '';
  let companyBudget = {
    allowed: true,
    reason: 'not_configured',
    dailyBudgetUsd: null,
  };
  if (companyBudgetEnabled) {
    companyBudget = await projectBudget.checkCompanyDailyBudget({
      prisma,
      project,
      env,
      now: clock(),
    });
    await eventStore.appendEvent(run.id, 'budget_status', {
      allowed: companyBudget.allowed,
      reason: companyBudget.reason,
      costTodayUsd: companyBudget.costTodayUsd,
      dailyBudgetUsd: companyBudget.dailyBudgetUsd,
      remainingUsd: companyBudget.remainingUsd,
      scope: 'company',
    }, { prisma }).catch(() => {});
    if (!companyBudget.allowed) {
      const error = companyBudget.reason === 'daily_budget_exceeded'
        ? `company daily budget exceeded: $${Number(companyBudget.costTodayUsd || 0).toFixed(4)} of $${Number(companyBudget.dailyBudgetUsd || 0).toFixed(2)}`
        : `company budget preflight failed: ${companyBudget.error || companyBudget.reason}`;
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: companyBudget.reason === 'daily_budget_exceeded'
          ? `No inicié esta corrida: la empresa alcanzó su presupuesto diario de $${Number(companyBudget.dailyBudgetUsd || 0).toFixed(2)}.`
          : 'No inicié esta corrida porque no pude verificar de forma segura el presupuesto diario de la empresa.',
      }, { prisma }).catch(() => {});
      return { status: 'error', error };
    }
  }

  let poolBudgetContext = null;
  if (run.departmentPoolId) {
    if (!run.swarmTaskId || !prisma?.codexSwarmTask?.findUnique) {
      const error = 'department pool budget preflight failed: swarm task attribution unavailable';
      await eventStore.appendEvent(run.id, 'budget_status', {
        allowed: false,
        reason: 'department_pool_task_missing',
        costTodayUsd: null,
        dailyBudgetUsd: null,
        remainingUsd: null,
        scope: 'department_pool',
      }, { prisma }).catch(() => {});
      return { status: 'error', error };
    }
    const poolTask = await prisma.codexSwarmTask.findUnique({
      where: { id: run.swarmTaskId },
      select: { id: true, input: true },
    }).catch(() => null);
    const poolTaskInput = poolTask?.input
      && typeof poolTask.input === 'object'
      && !Array.isArray(poolTask.input)
      ? poolTask.input
      : {};
    if (
      !poolTask
      || String(poolTaskInput.departmentPoolId || '') !== String(run.departmentPoolId)
    ) {
      const error = 'department pool budget preflight failed: swarm task attribution mismatch';
      await eventStore.appendEvent(run.id, 'budget_status', {
        allowed: false,
        reason: 'department_pool_task_mismatch',
        costTodayUsd: null,
        dailyBudgetUsd: null,
        remainingUsd: null,
        scope: 'department_pool',
      }, { prisma }).catch(() => {});
      return { status: 'error', error };
    }
    poolBudgetContext = {
      departmentPoolId: run.departmentPoolId,
      swarmTaskId: run.swarmTaskId,
      reservationUsd: Number.isFinite(Number(poolTaskInput.poolBudgetReservationUsd))
        ? Math.max(0, Number(poolTaskInput.poolBudgetReservationUsd))
        : null,
    };
    const poolBudget = await projectBudget.checkDepartmentPoolBudget({
      prisma,
      projectId,
      ...poolBudgetContext,
      env,
      now: clock(),
    });
    await eventStore.appendEvent(run.id, 'budget_status', {
      allowed: poolBudget.allowed,
      reason: poolBudget.reason,
      costTodayUsd: poolBudget.costTodayUsd ?? null,
      dailyBudgetUsd: poolBudget.dailyBudgetUsd ?? null,
      remainingUsd: poolBudget.remainingUsd ?? null,
      scope: 'department_pool',
      departmentPoolId: run.departmentPoolId,
      reservationUsd: poolBudget.reservationUsd ?? poolBudgetContext.reservationUsd,
    }, { prisma }).catch(() => {});
    if (!poolBudget.allowed) {
      const error = `department pool budget preflight failed: ${poolBudget.error || poolBudget.reason}`;
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: 'No inicié esta corrida porque el presupuesto del departamento no está disponible o no pudo verificarse.',
      }, { prisma }).catch(() => {});
      return { status: 'error', error };
    }
  }

  const resolveCost = deps.costResolver || require('./cost-resolver').resolveCost;
  let inRunCostOriginalUsd = 0;
  let inRunCostUsd = 0;
  let budgetTerminalError = null;

  const budgetError = (status) => {
    const error = new Error(status.reason === 'daily_budget_exceeded'
      ? `project daily budget exceeded during run: $${Number(status.costTodayUsd || 0).toFixed(4)} of $${Number(status.dailyBudgetUsd || 0).toFixed(2)}`
      : `project budget runtime check failed: ${status.error || status.reason}`);
    error.code = status.reason === 'daily_budget_exceeded'
      ? 'CODEX_PROJECT_DAILY_BUDGET_EXCEEDED'
      : 'CODEX_PROJECT_BUDGET_CHECK_FAILED';
    error.budget = status;
    return error;
  };
  const companyBudgetError = (status) => {
    const error = new Error(status.reason === 'daily_budget_exceeded'
      ? `company daily budget exceeded during run: $${Number(status.costTodayUsd || 0).toFixed(4)} of $${Number(status.dailyBudgetUsd || 0).toFixed(2)}`
      : `company budget runtime check failed: ${status.error || status.reason}`);
    error.code = status.reason === 'daily_budget_exceeded'
      ? 'CODEX_COMPANY_DAILY_BUDGET_EXCEEDED'
      : 'CODEX_COMPANY_BUDGET_CHECK_FAILED';
    error.budget = status;
    return error;
  };
  const poolBudgetError = (status) => {
    const error = new Error(
      `department pool budget runtime check failed: ${status.error || status.reason}`,
    );
    error.code = status.reason === 'department_pool_budget_limit'
      || status.reason === 'department_pool_run_reservation_exceeded'
      ? 'CODEX_DEPARTMENT_POOL_BUDGET_EXCEEDED'
      : 'CODEX_DEPARTMENT_POOL_BUDGET_CHECK_FAILED';
    error.budget = status;
    return error;
  };

  const activeProvider = (() => {
    try {
      const anthropic = require('./anthropic-turn').getAnthropicTurnConfig({ env, tier: run?.tier || null });
      if (anthropic.enabled && anthropic.tierEligible) {
        return { provider: 'anthropic', model: anthropic.model };
      }
      return require('./llm-provider').describeActiveProvider({ env });
    } catch {
      return { provider: null, model: run?.model || null };
    }
  })();
  const llmTurn = async (args) => {
    if (budgetTerminalError) throw budgetTerminalError;
    // Per-model canary telemetry: one record per LLM turn, success or failure.
    // Best-effort — telemetry must never alter run behavior.
    const modelTurnStarted = Date.now();
    let modelTtfbAt = null;
    const baseArgs = args;
    try {
      const turn = await baseLlmTurn({
        ...args,
        onTextDelta: args.onTextDelta
          ? (text) => { if (modelTtfbAt === null) modelTtfbAt = Date.now(); return args.onTextDelta(text); }
          : undefined,
      });
      const usage = turn?.usage;
      recordLlmUsageOnce(metrics, usage);
      try {
        require('./model-telemetry').recordLlmTurn({
          model: usage?.model || args.model || activeProvider?.model || null,
          provider: usage?.provider || activeProvider?.provider || null,
          agent: run?.mode === 'plan' ? 'codex_plan' : 'codex_build',
          outcome: 'ok',
          durationMs: Date.now() - modelTurnStarted,
          ttftMs: modelTtfbAt === null ? null : modelTtfbAt - modelTurnStarted,
          tokensIn: usage?.tokensIn,
          tokensOut: usage?.tokensOut,
        });
      } catch { /* optional */ }

    if (
      (
        budget.dailyBudgetUsd != null
        || companyBudget.dailyBudgetUsd != null
        || poolBudgetContext
      )
      && usage
    ) {
      let resolved;
      try {
        resolved = await resolveCost(usage, { env, fetchImpl: deps.fetchImpl });
      } catch (error) {
        const status = {
          allowed: !poolBudgetContext && env?.NODE_ENV !== 'production',
          reason: 'budget_cost_resolution_failed',
          error: String(error?.message || error).slice(0, 500),
          costTodayUsd: null,
          persistedCostTodayUsd: null,
          inRunCostUsd,
          dailyBudgetUsd: budget.dailyBudgetUsd,
          remainingUsd: null,
        };
        await eventStore.appendEvent(run.id, 'budget_status', status, { prisma }).catch(() => {});
        if (!status.allowed) {
          budgetTerminalError = budgetError(status);
          throw budgetTerminalError;
        }
      }
      if (resolved) {
        inRunCostOriginalUsd += Math.max(0, Number(resolved.costUsd) || 0);
        inRunCostUsd = inRunCostOriginalUsd;
      }
    }

    if (budget.dailyBudgetUsd != null) {
      const runtimeBudget = await projectBudget.checkProjectBudget({
        prisma,
        projectId,
        settings: projectSettings,
        env,
        now: clock(),
        inRunCostUsd,
      });
      await eventStore.appendEvent(run.id, 'budget_status', {
        allowed: runtimeBudget.allowed,
        reason: runtimeBudget.reason,
        costTodayUsd: runtimeBudget.costTodayUsd,
        persistedCostTodayUsd: runtimeBudget.persistedCostTodayUsd,
        inRunCostUsd: runtimeBudget.inRunCostUsd,
        dailyBudgetUsd: runtimeBudget.dailyBudgetUsd,
        remainingUsd: runtimeBudget.remainingUsd,
      }, { prisma }).catch(() => {});
      if (!runtimeBudget.allowed) {
        budgetTerminalError = budgetError(runtimeBudget);
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: runtimeBudget.reason === 'daily_budget_exceeded'
            ? `Detuve la corrida al alcanzar el presupuesto diario de $${Number(runtimeBudget.dailyBudgetUsd || 0).toFixed(2)}. No ejecuté las herramientas propuestas en esa respuesta.`
            : 'Detuve la corrida porque no pude volver a verificar de forma segura el presupuesto diario.',
        }, { prisma }).catch(() => {});
        throw budgetTerminalError;
      }
    }
    if (companyBudget.dailyBudgetUsd != null) {
      const runtimeCompanyBudget = await projectBudget.checkCompanyDailyBudget({
        prisma,
        project,
        env,
        now: clock(),
        inRunCostUsd,
      });
      await eventStore.appendEvent(run.id, 'budget_status', {
        allowed: runtimeCompanyBudget.allowed,
        reason: runtimeCompanyBudget.reason,
        costTodayUsd: runtimeCompanyBudget.costTodayUsd,
        persistedCostTodayUsd: runtimeCompanyBudget.persistedCostTodayUsd,
        inRunCostUsd: runtimeCompanyBudget.inRunCostUsd,
        dailyBudgetUsd: runtimeCompanyBudget.dailyBudgetUsd,
        remainingUsd: runtimeCompanyBudget.remainingUsd,
        scope: 'company',
      }, { prisma }).catch(() => {});
      if (!runtimeCompanyBudget.allowed) {
        budgetTerminalError = companyBudgetError(runtimeCompanyBudget);
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: runtimeCompanyBudget.reason === 'daily_budget_exceeded'
            ? `Detuve la corrida al alcanzar el presupuesto diario de la empresa de $${Number(runtimeCompanyBudget.dailyBudgetUsd || 0).toFixed(2)}. No ejecuté las herramientas propuestas en esa respuesta.`
            : 'Detuve la corrida porque no pude volver a verificar de forma segura el presupuesto diario de la empresa.',
        }, { prisma }).catch(() => {});
        throw budgetTerminalError;
      }
    }
    if (poolBudgetContext) {
      const runtimePoolBudget = await projectBudget.checkDepartmentPoolBudget({
        prisma,
        projectId,
        ...poolBudgetContext,
        env,
        now: clock(),
        inRunCostUsd,
      });
      await eventStore.appendEvent(run.id, 'budget_status', {
        allowed: runtimePoolBudget.allowed,
        reason: runtimePoolBudget.reason,
        costTodayUsd: runtimePoolBudget.costTodayUsd ?? null,
        dailyBudgetUsd: runtimePoolBudget.dailyBudgetUsd ?? null,
        remainingUsd: runtimePoolBudget.remainingUsd ?? null,
        scope: 'department_pool',
        departmentPoolId: run.departmentPoolId,
        reservationUsd: runtimePoolBudget.reservationUsd ?? poolBudgetContext.reservationUsd,
      }, { prisma }).catch(() => {});
      if (!runtimePoolBudget.allowed) {
        budgetTerminalError = poolBudgetError(runtimePoolBudget);
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: runtimePoolBudget.reason === 'department_pool_run_reservation_exceeded'
            ? 'Detuve la corrida al consumir su reserva de presupuesto del departamento.'
            : 'Detuve la corrida al alcanzar el presupuesto diario del departamento.',
        }, { prisma }).catch(() => {});
        throw budgetTerminalError;
      }
    }
    return turn;
    } catch (err) {
      try {
        require('./model-telemetry').recordLlmTurn({
          model: args.model || activeProvider?.model || null,
          provider: activeProvider?.provider || null,
          agent: run?.mode === 'plan' ? 'codex_plan' : 'codex_build',
          outcome: signal?.aborted ? 'cancelled' : 'error',
          error: err,
          durationMs: Date.now() - modelTurnStarted,
          ttftMs: modelTtfbAt === null ? null : modelTtfbAt - modelTurnStarted,
        });
      } catch { /* optional */ }
      throw err;
    }
  };

  if (runBranchesEnabled) {
    const branch = await checkpointServiceForRun.prepareRunBranch({
      run,
      project,
      deps: { runner },
    }).catch((error) => ({
      ok: false,
      code: 'run_branch_setup_failed',
      detail: String(error?.message || error).slice(0, 1000),
    }));
    if (!branch?.ok) {
      const error = `run branch setup failed (${branch?.code || 'unknown'}): ${String(branch?.detail || '').slice(0, 1000)}`;
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: `No inicié cambios porque no pude aislar la rama de esta corrida: ${error}`,
      }, { prisma }).catch(() => {});
      return { status: 'error', error };
    }
  }

  const baseMaxSteps = readPosInt(env.CODEX_MAX_STEPS, DEFAULT_MAX_STEPS);
  let maxSteps = baseMaxSteps;
  const maxToolsPerTurn = readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, DEFAULT_MAX_TOOLS_PER_TURN);
  const maxVerifyRounds = readPosInt(env.CODEX_MAX_VERIFY_ROUNDS, DEFAULT_MAX_VERIFY_ROUNDS);
  const maxSameFileWrites = readPosInt(env.CODEX_MAX_SAME_FILE_WRITES, DEFAULT_MAX_SAME_FILE_WRITES);
  // Parallel specialists are unsafe while they share one checkout: several
  // built-in and custom agents can write/edit the same files. Keep them
  // serialized until the sandbox provider assigns an independent worktree to
  // every writer. The opt-in exists only for controlled development/tests.
  const parallelSubagents = flagEnabled(env.CODEX_PARALLEL_WRITE_SUBAGENTS);
  // General tool parallelism is default-on, but the scheduler is conservative:
  // process-wide tools and any read/write dependency stay serialized.
  const parallelTools = String(env.CODEX_PARALLEL_TOOL_CALLS ?? '1').trim() !== '0';
  let registry = buildTools.toolRegistry()
    .filter((tool) => projectSettingsModule.toolDecision(projectSettings, tool.name).allowed);
  const dynamicTools = new Map();
  if (String(env.CODEX_MCP_DYNAMIC_TOOLS ?? '1').trim() !== '0') {
    try {
      const mcp = require('./mcp-tools');
      const dynamic = await mcp.buildDynamicMcpTools({
        runner,
        project: projectId,
        env,
        signal,
      });
      for (const [name, tool] of dynamic.tools) {
        if (!projectSettingsModule.toolDecision(projectSettings, name).allowed) continue;
        dynamicTools.set(name, tool);
        registry.push({ name, description: tool.description, parameters: tool.parameters });
      }
    } catch {
      // MCP is an optional extension; the built-in registry remains available.
    }
  }
  const modelCapabilities = (() => {
    try {
      return require('../agent-harness/model-capabilities').resolveModelCapabilities(
        activeProvider.model || run?.model || '',
        { provider: activeProvider.provider || '', env },
      );
    } catch {
      return { supportsImages: false };
    }
  })();
  const contextMaxChars = contextBudgetChars(modelCapabilities, env);

  const plan = deps.plan || (await loadApprovedPlan({ run, eventStore, prisma }));
  const sourcePrompt = deps.sourcePrompt != null ? deps.sourcePrompt : await resolveRunSourcePrompt({ run, prisma });
  const proactiveMeta = progressLedger.taskMetaFromPrompt(sourcePrompt);
  const strictProactiveGate = Boolean(proactiveMeta);
  // Skill-aware step budget: multi-module builds (enterprise apps, stores)
  // physically don't fit the standard budget — the cycle-14 CRM run finished
  // 'done' having only written the base types. When the prompt matches one of
  // the BIG playbooks, double the budget (bounded; env CODEX_MAX_STEPS_LARGE).
  try {
    const detectedSkill = require('./skills').detectSkillForPrompt(sourcePrompt);
    if (detectedSkill && ['app-empresarial', 'ecommerce-catalogo'].includes(detectedSkill.name)) {
      maxSteps = readPosInt(env.CODEX_MAX_STEPS_LARGE, baseMaxSteps * 2);
    }
  } catch { /* budget stays at the base */ }
  const fileTree = deps.fileTree != null ? deps.fileTree : await safeFileTree(runner, projectId);
  let preserveExistingNext = false;
  if (isAppsPrompt(sourcePrompt)) {
    const packageRead = await readRunnerFileResult(runner, projectId, 'package.json');
    preserveExistingNext = packageRead.ok
      ? await hasExistingNextApplication({ runner, projectId, pkgText: packageRead.content })
      // A temporary runner read failure cannot prove the framework. Only a
      // root-level Next route in the already-known tree activates fail-safe
      // preservation; ordinary Vite src/pages remains excluded by package read.
      : fileTreeLooksLikeNextApplication(fileTree);
  }
  const projectNotes = deps.projectNotes != null ? deps.projectNotes : await safeProjectNotes(runner, projectId);
  const companySoul = deps.companySoul != null
    ? deps.companySoul
    : String((await require('./company-operating-profile')
      .loadCompanySoul({ prisma, project })
      .catch(() => null))?.content || '');
  const progressContext = deps.progressContext != null
    ? deps.progressContext
    : progressLedger.formatProgressContext(project);
  const hookState = deps.projectHooks || await projectHooks.loadProjectHooks({ runner, projectId });
  const resolvedToolPermissions = await loadResolvedToolPermissions({
    runId: run.id,
    eventStore,
    prisma,
  });
  const resumeSnapshot = deps.resumeSnapshot || await loadLatestContextSnapshot({
    runId: run.id,
    eventStore,
    prisma,
  });
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        project,
        plan,
        fileTree,
        sourcePrompt,
        projectNotes,
        progressContext,
        projectSettings,
        parallelSubagents,
        parallelTools,
        openclawPromptBlock: deps.openclawPromptBlock || '',
        companySoul,
        preserveExistingNext,
      }),
    },
    { role: 'user', content: sourcePrompt || 'Construye el proyecto según el plan aprobado.' },
  ];
  let contextSummary = String(resumeSnapshot?.summary || '').slice(0, CONTEXT_SUMMARY_CAP);
  if (contextSummary) {
    messages.push({
      role: 'user',
      content: `[REANUDACIÓN · RESUMEN PERSISTIDO]\n${contextSummary}\nContinúa desde este estado y confirma el estado real con tools antes de editar.`,
    });
  }
  if (Array.isArray(resumeSnapshot?.tailMessages)) {
    messages.push(...resumeSnapshot.tailMessages
      .filter((message) => message && ['user', 'assistant'].includes(message.role))
      .slice(-COMPACT_KEEP_TAIL)
      .map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, CONTEXT_SNAPSHOT_MESSAGE_CAP),
      })));
  }
  if (hookState?.error) {
    messages.push({
      role: 'user',
      content: `[POLÍTICA] .sira/hooks.json no pudo cargarse y se ignoró de forma segura: ${String(hookState.error).slice(0, 500)}`,
    });
  }
  if (resolvedToolPermissions.decisions?.length) {
    const decisions = resolvedToolPermissions.decisions
      .slice(-8)
      .map((row) => `- ${row.toolName}: ${row.decision === 'allow' ? 'aprobada una vez' : 'denegada; busca una alternativa'}`)
      .join('\n');
    messages.push({ role: 'user', content: `[PERMISOS RESUELTOS]\n${decisions}` });
  }

  let actionCounter = 0;
  let groupCounter = 0;
  if (proactiveMeta?.swarm?.length) {
    const swarmGroupId = `g${++groupCounter}`;
    const swarm = await proactiveSwarm.runProactiveSwarm({
      meta: proactiveMeta,
      task: sourcePrompt,
      context: [
        progressContext,
        projectNotes ? `Notas del proyecto:\n${projectNotes}` : '',
      ].filter(Boolean).join('\n\n').slice(0, 12_000),
      deps: {
        runner,
        project: projectId,
        webSearch,
        llmTurn,
        env,
        signal,
        tier: run?.tier || null,
        model: run?.model || null,
        projectSettings,
        companySoul,
        onUsage: (usage) => {
          recordLlmUsageOnce(metrics, usage);
        },
        emitAgent: async ({ agent, task }) => {
          const actionId = `a${++actionCounter}`;
          await eventStore.appendEvent(run.id, 'action_start', {
            actionId,
            kind: 'agent',
            command: `${agent}: ${String(task || '').slice(0, 220)}`,
            groupId: swarmGroupId,
          }, { prisma }).catch(() => {});
          const startedAt = clock().getTime();
          return {
            end: async ({ status = 'done', outputSummary = '' } = {}) => {
              const durationMs = Math.max(0, clock().getTime() - startedAt);
              await eventStore.appendEvent(run.id, 'action_end', {
                actionId,
                status: status === 'error' ? 'error' : 'done',
                outputSummary,
                durationMs,
              }, { prisma }).catch(() => {});
              if (metrics?.recordAction) metrics.recordAction('agent', durationMs);
            },
          };
        },
        emitAction: async ({ kind, command, path } = {}) => {
          const actionId = `a${++actionCounter}`;
          const actionKind = kind || 'terminal';
          await eventStore.appendEvent(run.id, 'action_start', {
            actionId,
            kind: actionKind,
            command: command || undefined,
            path: path || undefined,
            groupId: swarmGroupId,
          }, { prisma }).catch(() => {});
          const startedAt = clock().getTime();
          return {
            end: async ({ status = 'done', outputSummary = '' } = {}) => {
              const durationMs = Math.max(0, clock().getTime() - startedAt);
              await eventStore.appendEvent(run.id, 'action_end', {
                actionId,
                status: status === 'error' ? 'error' : 'done',
                outputSummary,
                durationMs,
              }, { prisma }).catch(() => {});
              if (metrics?.recordAction) metrics.recordAction(actionKind, durationMs);
            },
          };
        },
      },
    });
    if (budgetTerminalError) {
      return { status: 'error', error: budgetTerminalError.message };
    }
    if (swarm.text) {
      messages.push({ role: 'user', content: swarm.text });
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: `Especialistas completados: ${swarm.completed}/${swarm.requested}. El agente principal ya incorporó sus informes.`,
      }, { prisma }).catch(() => {});
    }
  }
  let aborted = false;
  let verifyRounds = Math.max(0, Number(resumeSnapshot?.state?.verifyRounds) || 0);
  // Anti-thrash state. A model can loop rewriting one file and burn the budget
  // without progress. Two detectors, because the prod smoke showed BOTH shapes:
  //  - consecutive: src/index.css written 5× in a row (`sameWriteRun`).
  //  - interleaved: cliente.ts written 7× total but spread across other writes,
  //    which the consecutive counter never caught (`writeTotals`).
  let lastWritePath = null;
  let sameWriteRun = 0;
  const writeTotals = new Map();
  const nudgedPaths = new Set();
  // Truncation state: an eco-tier (Cerebras/prompted) model can overrun its
  // output budget mid-write, cutting off the tool_call fence. That yields zero
  // parsed calls — indistinguishable from "done" — so without this the build
  // would close with the file never written. Count retries so a chronically
  // overrunning model still terminates.
  let truncationRetries = 0;
  // Plan-aware budget extension ("auto-continue"): when the step budget runs
  // out while the approved plan still has pending tasks, extend the budget a
  // bounded number of times instead of closing a half-built app — the agent
  // keeps working until the plan is done (or the extensions/timeout cap it).
  // NaN-only parse: an explicit CODEX_PLAN_EXTENSIONS=0 disables the feature.
  const _rawPlanExt = Number.parseInt(env.CODEX_PLAN_EXTENSIONS ?? '', 10);
  const maxPlanExtensions = Number.isFinite(_rawPlanExt) && _rawPlanExt >= 0 ? _rawPlanExt : 2;
  let planExtensionsUsed = Math.max(0, Number(resumeSnapshot?.state?.planExtensionsUsed) || 0);
  let latestPlanTasks = Array.isArray(resumeSnapshot?.state?.planTasks) && resumeSnapshot.state.planTasks.length
    ? resumeSnapshot.state.planTasks
    : (Array.isArray(plan?.tasks) ? plan.tasks : null);
  const completedBackgroundTasks = [];
  const backgroundWatchers = new Set();

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { aborted = true; break; }
    if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };
    while (completedBackgroundTasks.length) {
      const completed = completedBackgroundTasks.shift();
      messages.push({
        role: 'user',
        content: `[BACKGROUND_TASK ${completed.taskId}] status=${completed.status}\n${completed.log || '(sin salida)'}`,
      });
    }

    const contextExceeded = messageChars(messages) > contextMaxChars;
    let nextSummary = '';
    if (String(env.CODEX_CONTEXT_SUMMARY ?? '1').trim() !== '0' && contextExceeded) {
      try {
        nextSummary = await summariseContextWithLlm({
          messages,
          llmTurn,
          signal,
          env,
          tier: run?.tier || null,
          metrics,
        });
      } catch (error) {
        return { status: 'error', error: String(error?.message || error) };
      }
      if (nextSummary) {
        const tail = boundedTail(messages);
        contextSummary = nextSummary;
        messages.splice(
          2,
          Math.max(0, messages.length - 2),
          {
            role: 'user',
            content: `[COMPACTION · RESUMEN DE CONTEXTO]\n${contextSummary}\nUsa tools para reconfirmar cualquier estado mutable antes de editar.`,
          },
          ...tail,
        );
      }
    }
    compactMessages(messages, { maxChars: contextMaxChars });
    if (nextSummary) {
      await persistContextSnapshot({
        run,
        eventStore,
        prisma,
        summary: contextSummary,
        messages,
        state: { verifyRounds, planExtensionsUsed, planTasks: latestPlanTasks },
      });
    }

    let turn;
    const streamingEnabled = String(env.CODEX_STREAMING ?? '1').trim() !== '0';
    const reasoningBlockId = `r${step}`;
    let streamedReasoning = '';
    let reasoningStreamStarted = false;
    const narrativeStream = createProtocolSafeTextStream(async (text) => {
      await eventStore.appendEvent(run.id, 'narrative_delta', { text }, { prisma }).catch(() => {});
    });
    const onReasoningDelta = async (text) => {
      const delta = String(text || '');
      if (!delta) return;
      if (!reasoningStreamStarted) {
        reasoningStreamStarted = true;
        await eventStore.appendEvent(run.id, 'reasoning_start', {
          blockId: reasoningBlockId,
          label: 'Razonando',
        }, { prisma }).catch(() => {});
      }
      streamedReasoning += delta;
      await eventStore.appendEvent(run.id, 'reasoning_delta', {
        blockId: reasoningBlockId,
        text: delta,
      }, { prisma }).catch(() => {});
    };
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          turn = await llmTurn({
            messages,
            tools: registry,
            signal,
            env,
            tier: run?.tier || null,
            model: run?.model || null,
            effort: effortForStage({
              tier: run?.tier || null,
              reasoningEffort: run?.reasoningEffort || null,
              verifyRounds,
              env,
            }),
            ...(streamingEnabled ? {
              onTextDelta: (text) => narrativeStream.push(text),
              onReasoningDelta,
            } : {}),
          });
          break;
        } catch (err) {
          // Cancellation is not a transient failure — never retry it.
          if (signal?.aborted) throw err;
          const msg = String(err?.message || err);
          // A blocking pattern (402, missing key, quota) is the user's problem:
          // surface the action_required card and end the run (feature 09).
          if (classifyText(msg)?.severity === 'blocking') throw err;
          // A provider that already streamed visible deltas must not be retried
          // — the retry would splice two different answers into one transcript.
          if (err?.partialResponse) throw err;
          // Only transient transport failures (502/503/504/timeout/ECONNRESET)
          // are worth another attempt; 401/402/413/validation fail immediately.
          if (!classifyTaskError(err).retryable) throw err;
          if (attempt >= MAX_LLM_STEP_RETRIES || step >= maxSteps - 1) {
            err.message = `${msg} (agotados ${MAX_LLM_STEP_RETRIES} reintentos transitorios del paso de modelo)`;
            throw err;
          }
          const backoffMs = LLM_STEP_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
          await eventStore.appendEvent(run.id, 'narrative_delta', {
            text: `⚠️ Fallo transitorio del proveedor de modelo (${msg.slice(0, 160)}). Reintento ${attempt + 1}/${MAX_LLM_STEP_RETRIES} en ${(backoffMs / 1000).toFixed(1)}s…`,
          }, { prisma }).catch(() => {});
          await new Promise((r) => setTimeout(r, backoffMs));
          if (signal?.aborted) { aborted = true; break; }
          if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };
        }
      }
    } catch (err) {
      // Transport error → run error. Feature 09: a blocking pattern (402, missing
      // key, quota) surfaces an action_required card before the run ends.
      const msg = String(err?.message || err);
      const cls = classifyText(msg);
      if (cls && cls.severity === 'blocking') {
        await eventStore.appendEvent(run.id, 'action_required', toActionRequired(cls.pattern, msg), { prisma }).catch(() => {});
      }
      return { status: 'error', error: msg };
    }
    if (aborted) break;
    recordLlmUsageOnce(metrics, turn?.usage);

    // Reasoning block (native or prompted).
    if (turn?.reasoning && (turn.reasoning.text || turn.reasoning.label)) {
      const r = turn.reasoning;
      if (!reasoningStreamStarted) {
        await eventStore.appendEvent(run.id, 'reasoning_start', { blockId: reasoningBlockId, label: r.label || 'Razonando' }, { prisma });
        if (r.text) await eventStore.appendEvent(run.id, 'reasoning_delta', { blockId: reasoningBlockId, text: String(r.text) }, { prisma });
      } else if (r.text && String(r.text).startsWith(streamedReasoning)) {
        const remaining = String(r.text).slice(streamedReasoning.length);
        if (remaining) await eventStore.appendEvent(run.id, 'reasoning_delta', { blockId: reasoningBlockId, text: remaining }, { prisma });
      }
      await eventStore.appendEvent(run.id, 'reasoning_end', { blockId: reasoningBlockId, durationMs: Number(r.durationMs) || 0 }, { prisma });
      if (r.text) {
        messages.push({
          role: 'assistant',
          content: `[REASONING_CONTEXT · NO MOSTRAR AL USUARIO]\n${String(r.text).slice(-REASONING_CONTEXT_CAP)}`,
        });
      }
    } else if (reasoningStreamStarted) {
      await eventStore.appendEvent(run.id, 'reasoning_end', { blockId: reasoningBlockId, durationMs: 0 }, { prisma });
    }

    // Narrative. Models sometimes regurgitate the transcript encoding into
    // their own prose ("…\n[TOOL_RESULT]\n# Skill: …") — everything from that
    // marker on is an echo of their input, not narration: it leaked playbook/
    // file bodies into the user-facing chat and bloated the context. Cut it.
    const narrativeText = String(turn?.text || '').split('[TOOL_RESULT')[0].trim();
    if (narrativeText) {
      if (streamingEnabled) await narrativeStream.finish(narrativeText);
      else await eventStore.appendEvent(run.id, 'narrative_delta', { text: narrativeText }, { prisma });
      messages.push({ role: 'assistant', content: narrativeText });
    }

    const allCalls = Array.isArray(turn?.toolCalls) ? turn.toolCalls : [];
    const calls = allCalls.slice(0, maxToolsPerTurn);
    // A truncated turn (cut off mid-tool-call, e.g. a large write overrunning
    // the eco tier's token budget) parses to ZERO calls — but the model is NOT
    // done. Nudge it to split the write instead of closing the build with the
    // file unwritten. Only when no complete call also came back this turn.
    if (calls.length === 0 && turn?.truncated && truncationRetries < MAX_TRUNCATION_RETRIES && step < maxSteps - 1) {
      truncationRetries += 1;
      messages.push({
        role: 'user',
        content: '[TRUNCADO] Tu último mensaje se cortó a mitad de un tool_call (probablemente un write_file demasiado grande superó el límite de salida). NO se ejecutó ninguna acción. Divide el trabajo: escribe el archivo en partes más pequeñas (crea el archivo con la primera mitad usando write_file, luego usa edit_file para añadir el resto), o crea archivos más pequeños. Reintenta ahora.',
      });
      continue;
    }
    if (calls.length === 0) {
      // Model produced no tool call → it thinks it's done. Verify before
      // closing: typecheck the workspace and feed failures back for a bounded
      // number of repair rounds (the Claude Code-style verification loop).
      if (verifyRounds < maxVerifyRounds && step < maxSteps - 1) {
        const v = await verifyWorkspace({
          runner, projectId, run, eventStore, prisma, metrics, clock, env,
          actionId: `a${++actionCounter}`, groupId: `g${++groupCounter}`,
          strict: strictProactiveGate,
          requireSmoke: Boolean(proactiveMeta?.qaCycle),
          browserCheck: deps.browserCheck,
        });
        if (v.ran && !v.ok) {
          verifyRounds += 1;
          const repairPrompt = strictProactiveGate
            ? `[GATE PROACTIVO · ${v.kind || 'quality'}] El run NO puede cerrarse hasta superar todos los gates. Delega primero en run_subagent con agent="debugger" y entrégale esta evidencia real:\n${v.errors}\nDespués aplica sus correcciones y vuelve a ejecutar type_check, dev_server_check y browser_check. En ciclo QA también deben pasar los smoke tests.`
            : (v.kind === 'runtime' || v.kind === 'browser'
              ? `[VERIFICACIÓN RUNTIME] El proyecto compila pero NO funciona en el dev server/navegador. Errores:\n${v.errors}\nDiagnostica la causa (imports rotos, module not found, dependencia sin declarar en package.json, error de sintaxis, overlay de Vite) con read_file/grep_search; si falta un paquete usa install_dependencies; si es código, corrígelo con read_file + edit_file. Cuando termines deja de llamar herramientas.`
              : `[VERIFICACIÓN] El proyecto NO compila o sus pruebas fallan. Errores:\n${v.errors}\nCorrige estos errores (si falta un paquete usa install_dependencies; si es código usa read_file + edit_file) y cuando termines deja de llamar herramientas.`);
          messages.push({ role: 'user', content: repairPrompt });
          continue;
        }
      }
      const stopHook = projectHooks.applyStopHooks(hookState?.hooks, {
        status: 'done',
        reason: 'model_completed',
        runId: run.id,
      });
      if (!stopHook.allowed) {
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: `No cerré la corrida porque el hook Stop la bloqueó: ${stopHook.message}`,
        }, { prisma }).catch(() => {});
        return { status: 'error', error: `stop hook denied: ${stopHook.message}` };
      }
      const closed = await closeBuild({
        run,
        project,
        runner,
        eventStore,
        prisma,
        llmTurn,
        clock,
        env,
        metrics,
        sourcePrompt,
        webSearch,
        checkpointService: checkpointServiceForRun,
        sessionService: deps.sessionService,
        backgroundTaskService: deps.backgroundTaskService,
        backgroundWatchers,
        browserCheck: deps.browserCheck,
      });
      if (budgetTerminalError) {
        return { status: 'error', error: budgetTerminalError.message };
      }
      return terminalOutcomeAfterClose(closed, stopHook, 'proactive quality gate failed');
    }
    if (allCalls.length > calls.length) {
      // Honest budget: tell the model what was dropped instead of letting it
      // believe those actions ran (they never did).
      const dropped = allCalls.slice(calls.length).map((c) => c.name).join(', ');
      messages.push({ role: 'user', content: `[BUDGET] Se omitieron ${allCalls.length - calls.length} tool calls de este turno por el límite de ${maxToolsPerTurn} por turno (${dropped}). Reintenta esas acciones en el siguiente turno.` });
    }

    const groupId = `g${++groupCounter}`;

    const executeCall = async (call) => {
      if (signal?.aborted || (typeof deps.executionGuard === 'function' && !deps.executionGuard())) {
        const error = new Error('codex execution aborted; tool side effect blocked');
        error.code = 'CODEX_RUN_ABORTED';
        throw error;
      }
      const tool = buildTools.getTool(call.name) || dynamicTools.get(call.name) || null;
      const actionId = `a${++actionCounter}`;
      const policyDecision = projectSettingsModule.toolDecision(projectSettings, call.name);
      if (!policyDecision.allowed) {
        const deniedKind = tool?.kind || 'terminal';
        await eventStore.appendEvent(run.id, 'action_start', {
          actionId,
          kind: deniedKind,
          command: String(call.name),
          groupId,
        }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', {
          actionId,
          status: 'error',
          outputSummary: policyDecision.reason,
          durationMs: 0,
        }, { prisma });
        if (metrics?.recordAction) metrics.recordAction(deniedKind, 0);
        return {
          message: `[TOOL_RESULT ${call.name}] Acción denegada por .sira/settings.json: ${policyDecision.reason}`,
          blocking: null,
        };
      }

      // update_plan is a plan-progress signal, not a workspace action: it emits a
      // `plan_updated` event (TodoWrite parity) instead of action_start/end, so it
      // never pollutes the action timeline. Best-effort — a failed emit never
      // aborts the loop; the observation is still fed back to the model.
      if (tool && call.name === 'update_plan') {
        const result = await tool.execute(call.args, { env });
        if (!result.isError && Array.isArray(result.planTasks)) {
          latestPlanTasks = result.planTasks;
          await eventStore.appendEvent(run.id, 'plan_updated', { tasks: result.planTasks }, { prisma }).catch(() => {});
        }
        return { message: `[TOOL_RESULT ${call.name}] ${result.observation || result.summary || ''}`, blocking: null };
      }

      if (!tool) {
        await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: String(call.name), groupId }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `herramienta desconocida: ${call.name}`, durationMs: 0 }, { prisma });
        // Honest counting (feature 08, spec req. 4): actionsCount = actions with
        // an action_end of ANY status. This unknown-tool path emits an action_end,
        // so it must be counted too — otherwise the "Work done" number undercounts.
        if (metrics?.recordAction) metrics.recordAction('terminal', 0);
        return { message: `[TOOL_RESULT ${call.name}] Error: herramienta desconocida.`, blocking: null };
      }

      const preHook = projectHooks.applyPreHooks(hookState?.hooks, call.name, call.args);
      const effectiveArgs = preHook.args;
      const command = tool.commandFor(effectiveArgs);
      const path = tool.pathFor(effectiveArgs);
      if (!preHook.allowed) {
        await eventStore.appendEvent(run.id, 'action_start', {
          actionId,
          kind: tool.kind,
          command: command || undefined,
          path: path || undefined,
          groupId,
        }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', {
          actionId,
          status: 'error',
          outputSummary: `hook preToolUse denegó ${call.name}: ${preHook.message}`,
          durationMs: 0,
        }, { prisma });
        if (metrics?.recordAction) metrics.recordAction(tool.kind, 0);
        return {
          message: `[TOOL_RESULT ${call.name}] Acción denegada por .sira/hooks.json: ${preHook.message}`,
          blocking: null,
        };
      }

      if (projectHooks.requiresApproval(project, call.name, effectiveArgs, projectSettings)) {
        const bindingHash = projectHooks.permissionBindingHash({
          runId: run.id,
          projectId,
          toolName: call.name,
          args: effectiveArgs,
        });
        if (resolvedToolPermissions.has(bindingHash)) {
          // Approval is one-shot. A later invocation of the same sensitive
          // tool asks again unless project policy is changed. Consume it
          // durably before execution so a worker restart cannot reuse it.
          const permissionId = resolvedToolPermissions.permissionIds.get(bindingHash);
          await eventStore.appendEvent(run.id, 'tool_permission_consumed', {
            permissionId,
            toolName: call.name,
            bindingHash,
          }, { prisma });
          resolvedToolPermissions.delete(bindingHash);
          resolvedToolPermissions.permissionIds.delete(bindingHash);
        } else {
          return {
            message: `[TOOL_RESULT ${call.name}] Pendiente de aprobación del usuario; la herramienta todavía NO se ejecutó.`,
            blocking: null,
            approval: {
              permissionId: `${run.id}:${actionId}:${randomUUID()}`,
              toolName: call.name,
              bindingHash,
              humanDescription: command || path || `Ejecutar ${call.name}`,
              argsPreview: boundedArgsPreview(effectiveArgs),
            },
          };
        }
      }

      await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: tool.kind, command: command || undefined, path: path || undefined, groupId }, { prisma });

      const t0 = clock().getTime();
      let result = await tool.execute(effectiveArgs, {
        runner,
        project: projectId,
        projectRecord: project,
        run,
        userId: run?.userId || null,
        webSearch,
        env,
        signal,
        llmTurn,
        // The run tier (composer Power selector) must reach subagents too, so a
        // delegation runs on the SAME engine as the main loop (Claude for paid
        // tiers) instead of silently dropping to the free Cerebras path.
        tier: run?.tier || null,
        effort: effortForStage({
          tier: run?.tier || null,
          reasoningEffort: run?.reasoningEffort || null,
          env,
        }),
        modelCapabilities,
        modelProvider: activeProvider.provider,
        projectSettings,
        companySoul,
        backgroundTaskService: deps.backgroundTaskService,
        watchBackgroundTask: (task, service) => {
          if (!task?.taskId || typeof service?.watch !== 'function') return;
          const watcher = Promise.resolve(service.watch({
            runner,
            project: projectId,
            taskId: task.taskId,
            signal,
            pollMs: env.CODEX_BACKGROUND_POLL_MS,
            onComplete: async (result) => {
              const status = String(result?.task?.status || 'lost');
              completedBackgroundTasks.push({
                taskId: task.taskId,
                status,
                log: String(result?.log || result?.error || '').slice(-8_000),
              });
              const text = `Tarea background ${task.taskId} terminó con estado ${status}. Usa task_logs para revisar la salida completa.`;
              await eventStore.appendEvent(run.id, 'narrative_delta', { text }, { prisma }).catch(() => {});
            },
          })).catch(() => {});
          backgroundWatchers.add(watcher);
          watcher.finally(() => backgroundWatchers.delete(watcher)).catch(() => {});
        },
        backgroundSubagentManager: deps.backgroundSubagentManager,
        notifyBackgroundSubagent: async (task) => {
          const text = task.status === 'done'
            ? `Subagente background ${task.agent} terminó (${task.taskId}). Usa subagent_status para incorporar su informe.`
            : `Subagente background ${task.agent} terminó con estado ${task.status} (${task.taskId})${task.error ? `: ${task.error}` : '.'}`;
          await eventStore.appendEvent(run.id, 'narrative_delta', { text }, { prisma }).catch(() => {});
        },
        onUsage: (u) => { recordLlmUsageOnce(metrics, u); },
        // Live visibility for delegations: the SDK surfaces every specialist
        // tool call as a nested action in the same group. The event store's
        // per-run seq gate makes concurrent appends safe.
        emitAction: async ({ kind, command: subCommand, path: subPath } = {}) => {
          const subActionId = `a${++actionCounter}`;
          const subKind = kind || 'terminal';
          await eventStore.appendEvent(run.id, 'action_start', { actionId: subActionId, kind: subKind, command: subCommand || undefined, path: subPath || undefined, groupId }, { prisma }).catch(() => {});
          const s0 = clock().getTime();
          return {
            end: async ({ status: subStatus = 'done', outputSummary: subSummary = '' } = {}) => {
              const d = Math.max(0, clock().getTime() - s0);
              await eventStore.appendEvent(run.id, 'action_end', { actionId: subActionId, status: subStatus === 'error' ? 'error' : 'done', outputSummary: subSummary, durationMs: d }, { prisma }).catch(() => {});
              if (metrics?.recordAction) metrics.recordAction(subKind, d);
            },
          };
        },
      });
      if (signal?.aborted || (typeof deps.executionGuard === 'function' && !deps.executionGuard())) {
        const error = new Error('codex execution aborted; post-tool side effect blocked');
        error.code = 'CODEX_RUN_ABORTED';
        throw error;
      }
      result = projectHooks.applyPostHooks(hookState?.hooks, call.name, result);
      const durationMs = Math.max(0, clock().getTime() - t0);
      const status = result.isError ? 'error' : 'done';

      // Feature 09: classify a failed action. A benign diagnostic (peer-deps
      // warning, vite port retry…) is annotated on the outputSummary and the
      // loop continues; a blocking pattern (402, missing key, runner down) emits
      // an action_required card and ends the run.
      let outputSummary = result.summary || '';
      let blockingPattern = null;
      if (result.isError) {
        const cls = classifyText(result.observation || outputSummary);
        if (cls && cls.severity === 'benign') {
          outputSummary = `${outputSummary}\n${benignAnnotation(cls.pattern)}`.trim();
        } else if (cls && cls.severity === 'blocking') {
          blockingPattern = cls.pattern;
        }
      }

      const endData = { actionId, status, outputSummary, durationMs };
      if (Number.isFinite(result.linesRead)) endData.linesRead = result.linesRead;
      await eventStore.appendEvent(run.id, 'action_end', endData, { prisma });

      if (!result.isError && tool.kind === 'file_write' && path) {
        const livePatch = await workspaceFilePatch({
          runner,
          projectId: project?.id || run.projectId,
          path,
        });
        if (livePatch) {
          await eventStore.appendEvent(run.id, 'file_patch', livePatch, { prisma }).catch(() => {});
          await eventStore.appendEvent(run.id, 'file_delta', {
            path: livePatch.path,
            hunk: livePatch.patch,
            truncated: livePatch.truncated,
          }, { prisma }).catch(() => {});
        }
      }

      try {
        await actionStore.recordAction({ runId: run.id, kind: tool.kind, command, path, status, outputSummary, durationMs, linesRead: result.linesRead, groupId, prisma });
      } catch { /* persistence best-effort; the event timeline is the source of truth */ }

      if (metrics?.recordAction) metrics.recordAction(tool.kind, durationMs);
      if (Number.isFinite(result.linesRead) && metrics?.recordLinesRead) metrics.recordLinesRead(result.linesRead);

      // Anti-thrash nudge: on a run of consecutive successful writes to the
      // SAME path, tell the model to stop rewriting it and advance the plan.
      // Writes are always on the sequential (non-delegation) path, so mutating
      // this state here is race-free.
      let thrashNudge = '';
      if (!result.isError && (call.name === 'write_file' || call.name === 'edit_file') && path) {
        if (path === lastWritePath) sameWriteRun += 1;
        else { lastWritePath = path; sameWriteRun = 1; }
        const total = (writeTotals.get(path) || 0) + 1;
        writeTotals.set(path, total);
        // Nudge on a consecutive run OR an interleaved total (2× the threshold),
        // but only ONCE per file so the message doesn't spam every later write.
        const consecutiveHit = sameWriteRun >= maxSameFileWrites;
        const totalHit = total >= maxSameFileWrites * 2;
        if ((consecutiveHit || totalHit) && !nudgedPaths.has(path)) {
          nudgedPaths.add(path);
          const howMany = consecutiveHit ? `${sameWriteRun} veces seguidas` : `${total} veces en esta corrida`;
          thrashNudge = `\n[LOOP] Ya escribiste ${path} ${howMany}. DEJA de reescribir este archivo: si ya está bien, avanza al siguiente paso del plan; corrígelo solo si type_check/dev_server_check reportó un error concreto en él.`;
        }
      } else if (!result.isError && tool.kind !== 'file_read') {
        // A non-write, non-read action (e.g. a command) breaks the consecutive
        // run but NOT the per-file totals (interleaved rewrites still count).
        lastWritePath = null;
        sameWriteRun = 0;
      }

      return {
        message: toolResultContent(call.name, result.observation, outputSummary, thrashNudge),
        blocking: blockingPattern ? { pattern: blockingPattern, detail: result.observation || outputSummary } : null,
      };
    };

    const outcomes = [];
    const batches = toolScheduler.scheduleToolCalls(calls, {
      enabled: parallelTools,
      parallelSubagents,
    });
    for (const batch of batches) {
      const batchOutcomes = batch.length > 1
        ? await Promise.all(batch.map((call) => executeCall(call)))
        : [await executeCall(batch[0])];
      outcomes.push(...batchOutcomes);
      // A permission request pauses the run before later dependency batches.
      if (batchOutcomes.some((outcome) => outcome?.approval)) break;
    }

    for (const o of outcomes) messages.push({ role: 'user', content: o.message });
    const approval = outcomes.find((outcome) => outcome?.approval)?.approval;
    if (approval) {
      await eventStore.appendEvent(run.id, 'tool_permission_required', approval, { prisma });
      await persistContextSnapshot({
        run,
        eventStore,
        prisma,
        summary: contextSummary,
        messages,
        state: { verifyRounds, planExtensionsUsed, planTasks: latestPlanTasks },
      });
      return { status: 'waiting_approval', permission: approval };
    }
    const blocked = outcomes.find((o) => o.blocking);
    if (blocked) {
      await eventStore.appendEvent(run.id, 'action_required', toActionRequired(blocked.blocking.pattern, blocked.blocking.detail), { prisma }).catch(() => {});
      return { status: 'error', error: blocked.blocking.pattern.title };
    }
    await persistContextSnapshot({
      run,
      eventStore,
      prisma,
      summary: contextSummary,
      messages,
      state: { verifyRounds, planExtensionsUsed, planTasks: latestPlanTasks },
    });

    // ── Plan-aware budget extension: this was the last budgeted step and the
    // plan is still unfinished → extend (bounded) so the agent keeps working
    // instead of closing a half-built app. `maxSteps` is re-read by the for
    // condition, so bumping it here naturally continues the loop. The hard
    // run timeout (abort signal) still caps total wall time.
    if (step === maxSteps - 1 && !aborted && !signal?.aborted) {
      const pending = pendingPlanTasks(latestPlanTasks);
      if (pending.length > 0 && planExtensionsUsed < maxPlanExtensions) {
        planExtensionsUsed += 1;
        const extraSteps = Math.max(4, Math.ceil(baseMaxSteps / 2));
        maxSteps += extraSteps;
        await eventStore.appendEvent(
          run.id,
          'narrative_delta',
          { text: `El plan aún tiene ${pending.length} tarea(s) pendiente(s); sigo trabajando (extensión ${planExtensionsUsed}/${maxPlanExtensions}).` },
          { prisma },
        ).catch(() => {});
        messages.push({
          role: 'user',
          content: `[CONTINUACIÓN] Presupuesto de pasos extendido porque el plan sigue incompleto. Tareas pendientes: ${pending.slice(0, 8).join(' · ')}. Continúa con la siguiente tarea pendiente y mantén update_plan al día. Si en realidad ya está todo terminado, marca las tareas como completed con update_plan y deja de llamar herramientas.`,
        });
      }
    }
  }

  // Budget exhausted (or aborted by the hard timeout signal): close honestly,
  // not as an error — the work done so far is real.
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    {
      text: aborted
        ? 'Me detuve por el límite de tiempo de la corrida.'
        : (pendingPlanTasks(latestPlanTasks).length
          ? `Alcancé el límite de pasos con ${pendingPlanTasks(latestPlanTasks).length} tarea(s) del plan aún pendiente(s); cierro con lo construido hasta aquí. Escríbeme "continúa" para seguir donde quedé.`
          : 'Alcancé el límite de pasos de esta corrida; cierro con lo construido hasta aquí.'),
    },
    { prisma },
  ).catch(() => {});
  const stopHook = projectHooks.applyStopHooks(hookState?.hooks, {
    status: aborted ? 'timeout' : 'budget_exhausted',
    reason: aborted ? 'timeout' : 'step_budget',
    runId: run.id,
  });
  if (!stopHook.allowed) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `No cerré la corrida porque el hook Stop la bloqueó: ${stopHook.message}`,
    }, { prisma }).catch(() => {});
    return { status: 'error', error: `stop hook denied: ${stopHook.message}` };
  }
  const closed = await closeBuild({
    run,
    project,
    runner,
    eventStore,
    prisma,
    llmTurn,
    clock,
    env,
    metrics,
    sourcePrompt,
    webSearch,
    checkpointService: checkpointServiceForRun,
    sessionService: deps.sessionService,
    backgroundTaskService: deps.backgroundTaskService,
    backgroundWatchers,
    browserCheck: deps.browserCheck,
  });
  if (budgetTerminalError) {
    return { status: 'error', error: budgetTerminalError.message };
  }
  return terminalOutcomeAfterClose(closed, stopHook, 'proactive quality gate failed');
}

async function readRunnerFileResult(runner, projectId, path) {
  try {
    const out = await runner.readFile(projectId, path);
    return { ok: true, content: String(out?.content || '') };
  } catch {
    return { ok: false, content: '' };
  }
}

async function readRunnerFile(runner, projectId, path) {
  return (await readRunnerFileResult(runner, projectId, path)).content;
}

function packageLooksLikeNext(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Boolean(deps.next || /next\s+dev/i.test(String(pkg.scripts?.dev || '')));
  } catch {
    return false;
  }
}

async function hasExistingNextApplication({ runner, projectId, pkgText }) {
  if (!packageLooksLikeNext(pkgText)) return false;

  // Fast path for the conventional App/Pages router roots. Reading through the
  // runner also covers freshly imported files that have not been committed yet.
  const commonEntries = await Promise.all(
    COMMON_NEXT_ROUTE_ENTRIES.map((path) => readRunnerFile(runner, projectId, path)),
  );
  if (commonEntries.some((content) => content.trim())) return true;

  // Dynamic or nested-only routers (for example app/(site)/page.tsx or
  // pages/[slug].tsx) need a bounded file listing. Failure is fail-safe: once
  // package.json identifies Next, an unavailable inventory must never authorize
  // a destructive framework conversion.
  if (typeof runner?.exec !== 'function') return true;
  let listed;
  try {
    listed = await runner.exec(
      projectId,
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeoutMs: 10_000 },
    );
  } catch {
    return true;
  }
  if (!listed || (listed.exitCode != null && listed.exitCode !== 0)) return true;
  return String(listed.stdout || listed.output || '')
    .split(/\r?\n/)
    .some(isNextRouteEntryPath);
}

function packageLooksLikeVite(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Boolean(deps.vite || /vite/i.test(String(pkg.scripts?.dev || '')));
  } catch {
    return false;
  }
}

function inspectExistingBackendPackage(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const framework = deps.express ? 'express' : deps.fastify ? 'fastify' : deps.koa ? 'koa' : null;
    const preferredKeys = ['dev', 'dev:api', 'dev:server', 'server', 'start'];
    const orderedCommands = [
      ...preferredKeys.filter((key) => scripts[key]).map((key) => [key, String(scripts[key])]),
      ...Object.entries(scripts)
        .filter(([key]) => !preferredKeys.includes(key) && !/(?:seed|test|migrate)/i.test(key))
        .map(([key, command]) => [key, String(command)]),
    ];
    let entry = null;
    let entryScript = null;
    for (const [, command] of orderedCommands) {
      const match = command.match(/(?:^|[\s"'=])((?:\.\/)?(?:server|api|backend)\/[A-Za-z0-9_./-]+\.(?:[cm]?js|ts))(?:[\s"';&|]|$)/i);
      if (!match) continue;
      entry = match[1].replace(/^\.\//, '');
      entryScript = command;
      break;
    }
    const scriptText = Object.values(scripts).join('\n');
    const dev = String(scripts.dev || '');
    const previewReady = Boolean(
      framework
      && entry
      && packageLooksLikeVite(pkgText)
      && !packageLooksLikeNext(pkgText)
      && /(?:concurrently|npm-run-all|run-p)/i.test(dev)
      && /vite/i.test(scriptText),
    );
    return { pkg, framework, entry, entryScript, previewReady };
  } catch {
    return { pkg: null, framework: null, entry: null, entryScript: null, previewReady: false };
  }
}

function packageLooksFullStack(pkgText) {
  const backend = inspectExistingBackendPackage(pkgText);
  return Boolean(backend.framework || backend.entry);
}

function packageHasExpressStarterContract(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const dev = String(pkg.scripts?.dev || '');
    const scripts = Object.values(pkg.scripts || {}).join('\n');
    return packageLooksLikeVite(pkgText)
      && !packageLooksLikeNext(pkgText)
      && Boolean(deps.express)
      && Boolean(deps.concurrently)
      && /concurrently/i.test(dev)
      && /vite/i.test(scripts)
      && /server\/index\.[cm]?[jt]s/i.test(scripts);
  } catch {
    return false;
  }
}

function mergeExistingBackendPackage(currentText, starterText, backend) {
  let current;
  let starter;
  try {
    current = JSON.parse(currentText || '{}');
    starter = JSON.parse(starterText || '{}');
  } catch {
    return currentText || starterText;
  }
  const scripts = current.scripts && typeof current.scripts === 'object' ? { ...current.scripts } : {};
  const apiCommand = String(
    scripts['dev:api']
      || scripts['dev:server']
      || backend.entryScript
      || `node ${backend.entry}`,
  );
  if (!scripts['dev:api']) scripts['dev:api'] = apiCommand;
  if (!scripts['dev:web'] || /\bnext\b/i.test(String(scripts['dev:web']))) scripts['dev:web'] = 'vite';
  scripts.dev = 'concurrently -n api,web -c blue,green "npm run dev:api" "npm run dev:web"';
  for (const [name, command] of Object.entries(scripts)) {
    if (!['dev', 'dev:web', 'dev:api', 'dev:server'].includes(name) && /\bnext\b/i.test(String(command))) {
      delete scripts[name];
    }
  }
  const merged = {
    ...current,
    private: current.private ?? true,
    scripts,
    dependencies: { ...(starter.dependencies || {}), ...(current.dependencies || {}) },
    devDependencies: {
      ...(starter.devDependencies || {}),
      ...(current.devDependencies || {}),
      concurrently: current.devDependencies?.concurrently || current.dependencies?.concurrently || '^9.1.0',
    },
  };
  for (const collection of [merged.dependencies, merged.devDependencies]) {
    for (const name of Object.keys(collection)) {
      if (name === 'next' || name.startsWith('@next/')) delete collection[name];
    }
  }
  // Deliberately do not add or rewrite `type`: CommonJS, ESM and explicit
  // .cjs/.mjs entries remain exactly as authored by the backend.
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeFullStackPackage(currentText, starterText) {
  let current;
  let starter;
  try {
    current = JSON.parse(currentText || '{}');
    starter = JSON.parse(starterText || '{}');
  } catch {
    return starterText;
  }
  const currentScripts = current.scripts && typeof current.scripts === 'object' ? current.scripts : {};
  const merged = {
    ...starter,
    ...current,
    name: current.name || starter.name,
    private: true,
    type: 'module',
    scripts: { ...currentScripts, ...(starter.scripts || {}) },
    dependencies: { ...(current.dependencies || {}), ...(starter.dependencies || {}) },
    devDependencies: { ...(current.devDependencies || {}), ...(starter.devDependencies || {}) },
  };
  // A repaired APPS workspace must be pure Vite on the frontend. Preserve
  // unrelated libraries/scripts, but remove Next runtime packages and scripts.
  for (const collection of [merged.dependencies, merged.devDependencies]) {
    for (const name of Object.keys(collection)) {
      if (name === 'next' || name.startsWith('@next/')) delete collection[name];
    }
  }
  for (const [name, command] of Object.entries(merged.scripts)) {
    if (!Object.hasOwn(starter.scripts || {}, name) && /\bnext\b/i.test(String(command))) {
      delete merged.scripts[name];
    }
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

async function fullStackAppsRepairFiles({
  runner,
  projectId,
  projectName,
  pkgText,
  indexText,
  appText,
  viteConfigText,
  serverIndexText,
  serverDbText,
}) {
  const { fullStackStarterFiles } = require('./starter-files');
  const starter = fullStackStarterFiles({ projectName });
  const existing = new Map([
    ['package.json', pkgText],
    ['index.html', indexText],
    ['src/App.tsx', appText],
    ['vite.config.ts', viteConfigText],
    ['server/index.js', serverIndexText],
    ['server/db.js', serverDbText],
  ]);
  const unread = starter.filter((file) => !existing.has(file.path));
  const unreadContents = await Promise.all(
    unread.map((file) => readRunnerFile(runner, projectId, file.path)),
  );
  unread.forEach((file, index) => existing.set(file.path, unreadContents[index]));

  const starterPackage = starter.find((file) => file.path === 'package.json')?.content || '';
  const healthyPackage = packageHasExpressStarterContract(pkgText);
  const healthyProxy = packageLooksLikeVite(pkgText)
    && !packageLooksLikeNext(pkgText)
    && /\bproxy\b[\s\S]*\/api|apiBase[\s\S]*proxy/i.test(String(viteConfigText || ''));
  const healthyIndex = /<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.(?:tsx|jsx?)["']/i.test(String(indexText || ''));
  const customApp = String(appText || '').trim() && !isStarterIndex('', appText);

  const writes = [];
  for (const file of starter) {
    const current = String(existing.get(file.path) || '');
    if (file.path === 'package.json') {
      if (!healthyPackage) writes.push({ ...file, content: mergeFullStackPackage(pkgText, starterPackage) });
      continue;
    }
    if (file.path === 'vite.config.ts') {
      if (!healthyProxy) writes.push(file);
      continue;
    }
    if (file.path === 'index.html') {
      if (!healthyIndex) writes.push(file);
      continue;
    }
    if (file.path === 'src/App.tsx') {
      if (!customApp) writes.push(file);
      continue;
    }
    // Never overwrite a real API, schema, UI component or project memory.
    // fullStackStarterFiles fills only the missing layers of an existing app.
    if (!current.trim()) writes.push(file);
  }
  return writes;
}

async function existingBackendAppsRepairFiles({
  runner,
  projectId,
  projectName,
  pkgText,
  indexText,
  appText,
  viteConfigText,
  backend,
}) {
  const { starterFiles } = require('./starter-files');
  const starter = starterFiles({ projectName });
  const existing = new Map([
    ['package.json', pkgText],
    ['index.html', indexText],
    ['src/App.tsx', appText],
    ['vite.config.ts', viteConfigText],
  ]);
  const unread = starter.filter((file) => !existing.has(file.path));
  const unreadContents = await Promise.all(
    unread.map((file) => readRunnerFile(runner, projectId, file.path)),
  );
  unread.forEach((file, index) => existing.set(file.path, unreadContents[index]));

  const starterPackage = starter.find((file) => file.path === 'package.json')?.content || '';
  const healthyIndex = /<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.(?:tsx|jsx?)["']/i.test(String(indexText || ''));
  const customApp = String(appText || '').trim() && !isStarterIndex('', appText);
  const writes = [];
  for (const file of starter) {
    const current = String(existing.get(file.path) || '');
    if (file.path === 'package.json') {
      if (!backend.previewReady) {
        writes.push({ ...file, content: mergeExistingBackendPackage(pkgText, starterPackage, backend) });
      }
      continue;
    }
    if (file.path === 'vite.config.ts') {
      if (!current.trim()) writes.push(file);
      continue;
    }
    if (file.path === 'index.html') {
      if (!healthyIndex) writes.push(file);
      continue;
    }
    if (file.path === 'src/App.tsx') {
      if (!customApp) writes.push(file);
      continue;
    }
    if (!current.trim()) writes.push(file);
  }
  return writes;
}

function isStarterIndex(indexText, appText) {
  // The React starter's marker lives in src/App.tsx ("Workspace listo").
  return /Workspace listo|codex workspace ready/i.test(`${indexText}\n${appText}`);
}

async function ensureAppsVitePreviewable({ run, project, runner, eventStore, prisma }) {
  const sourcePrompt = await resolveRunSourcePrompt({ run, prisma });
  if (!isAppsPrompt(sourcePrompt) || explicitlyRequestsNext(sourcePrompt)) return { repaired: false };
  const projectId = project?.id || run.projectId;
  const packageRead = await readRunnerFileResult(runner, projectId, 'package.json');
  if (!packageRead.ok) {
    return { repaired: false, preservationReason: 'package_unavailable' };
  }
  const pkgText = packageRead.content;
  if (await hasExistingNextApplication({ runner, projectId, pkgText })) {
    return { repaired: false, preservedFramework: 'next' };
  }
  const detectedBackend = inspectExistingBackendPackage(pkgText);
  const paths = [...new Set([
    'index.html',
    'src/App.tsx',
    'vite.config.ts',
    'server/index.js',
    'server/app.js',
    'server/db.js',
    ...(detectedBackend.entry ? [detectedBackend.entry] : []),
  ])];
  const contents = await Promise.all(paths.map((path) => readRunnerFile(runner, projectId, path)));
  const filesByPath = new Map(paths.map((path, index) => [path, contents[index]]));
  const indexText = filesByPath.get('index.html') || '';
  const appText = filesByPath.get('src/App.tsx') || '';
  const viteConfigText = filesByPath.get('vite.config.ts') || '';
  const serverIndexText = filesByPath.get('server/index.js') || '';
  const serverAppText = filesByPath.get('server/app.js') || '';
  const serverDbText = filesByPath.get('server/db.js') || '';
  const inferredEntry = detectedBackend.entry
    || (serverAppText.trim() ? 'server/app.js' : serverIndexText.trim() ? 'server/index.js' : null);
  const backend = inferredEntry === detectedBackend.entry
    ? detectedBackend
    : { ...detectedBackend, entry: inferredEntry, entryScript: inferredEntry ? `node ${inferredEntry}` : null };
  const backendEntryText = backend.entry ? filesByPath.get(backend.entry) || '' : '';
  const backendFilesPresent = Boolean(backend.framework && backend.entry && backendEntryText.trim());
  // Preserve imported Express CommonJS runtimes even when their current `dev`
  // script starts only Vite. Sending them through the default Express starter
  // would force `type: module`, replace their entry with server/index.js, and
  // make the authored `require(...)` backend fail at runtime.
  const commonJsExpressBackend = backend.framework === 'express' && (
    backend.pkg?.type === 'commonjs'
    || /\.cjs$/i.test(String(backend.entry || ''))
    || (
      backend.pkg?.type !== 'module'
      && /\b(?:require\s*\(|module\.exports\b|exports\.)/.test(backendEntryText)
    )
  );
  const preserveExistingBackend = backendFilesPresent && (
    backend.previewReady
    || commonJsExpressBackend
    || ['koa', 'fastify'].includes(backend.framework)
  );
  const fullStack = appsHasFullStackContract({
    sourcePrompt,
    project,
    pkgText,
    serverIndexText,
    serverDbText,
    backendEntryText,
  });
  // A healthy workspace is React + Vite + TS: Vite package.json (not Next) and
  // index.html loading /src/main.tsx (or legacy /src/main.js). Anything else —
  // a Next hybrid, a non-Vite pkg, a stale entry, or the untouched starter — is
  // repaired. A valid existing backend is normalized in place without changing
  // its framework/module/entry contract; only a new or incomplete default
  // Express stack is filled from fullStackStarterFiles.
  const needsRepair =
    packageLooksLikeNext(pkgText) ||
    !packageLooksLikeVite(pkgText) ||
    !/<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.(?:tsx|jsx?)["']/i.test(indexText) ||
    isStarterIndex(indexText, appText) ||
    (fullStack && preserveExistingBackend && !backend.previewReady) ||
    (fullStack && !preserveExistingBackend && (
      !packageHasExpressStarterContract(pkgText)
      || !/\bproxy\b[\s\S]*\/api|apiBase[\s\S]*proxy/i.test(viteConfigText)
      || !String(serverIndexText).trim()
      || !String(serverDbText).trim()
    ));
  if (!needsRepair) return { repaired: false };

  const files = fullStack && preserveExistingBackend
    ? await existingBackendAppsRepairFiles({
      runner,
      projectId,
      projectName: project?.name || 'App generada',
      pkgText,
      indexText,
      appText,
      viteConfigText,
      backend,
    })
    : fullStack
      ? await fullStackAppsRepairFiles({
        runner,
        projectId,
        projectName: project?.name || 'App generada',
        pkgText,
        indexText,
        appText,
        viteConfigText,
        serverIndexText,
        serverDbText,
      })
      : appsFallbackFiles({ prompt: sourcePrompt, projectName: project?.name || 'App generada' });
  await runner.writeFiles(projectId, files);
  // Writing the Vite fallback isn't enough: the agent's Next scaffold (app/,
  // next.config.mjs, next-env.d.ts, .next, pages/) lingers alongside it, so the
  // workspace stays a broken Next+Vite hybrid the host-runner boots into an
  // error overlay. Purge the Next-only files so the workspace is PURE Vite.
  if (typeof runner.exec === 'function') {
    // The runner exec API only accepts argv arrays of allowlisted binaries
    // (no shell, no `rm`) — a plain `rm -rf …` string is rejected upstream and
    // the Next leftovers survive. `node -e` with fs.rmSync is allowlisted.
    const purgePaths = [
      'app', 'pages', 'src/app', 'src/pages',
      'next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.mts', 'next.config.cjs',
      'next-env.d.ts', '.next', '.next-env.d.ts', 'vite.config.js',
      // The SPA fallback always writes main.tsx. A repaired full-stack app may
      // intentionally retain a custom legacy main.js entry, so do not delete it.
      ...(!fullStack ? ['src/main.js'] : []),
    ];
    const purgeScript = `const fs=require('fs');for(const p of ${JSON.stringify(purgePaths)}){try{fs.rmSync(p,{recursive:true,force:true})}catch{}}`;
    await runner.exec(projectId, ['node', '-e', purgeScript], { timeoutMs: 15000 }).catch(() => {});
  }
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    {
      text: preserveExistingBackend && backend.previewReady
        ? `Reparé sólo las capas frontend de APPS y preservé intacto el backend ${backend.framework} (${backend.entry}), incluido su contrato de módulos y arranque.`
        : preserveExistingBackend
          ? `Conservé el backend ${backend.framework}, su tipo de módulos y su entry ${backend.entry}; normalicé únicamente los scripts web/API necesarios para el preview.`
        : fullStack
          ? 'Reparé el workspace APPS como full-stack: mantuve la API y la base SQLite existentes, restauré las capas faltantes de Express + Vite y conservé el arranque compuesto con concurrently.'
          : 'Normalicé el workspace de APPS a Vite (limpié el scaffold Next) para que el preview abra en /index.html.',
    },
    { prisma },
  ).catch(() => {});
  return { repaired: true, fullStack };
}

function gateEvidence(verification) {
  const labels = {
    typeCheck: 'type_check',
    smoke: 'smoke_tests',
    devServer: 'dev_server_check',
    browser: 'browser_check',
  };
  const parts = [];
  for (const [key, gate] of Object.entries(verification?.gates || {})) {
    if (!gate?.ran) {
      parts.push(`${labels[key] || key}: ${gate?.ok ? 'no aplicable' : 'sin evidencia'}`);
    } else {
      parts.push(`${labels[key] || key}: ${gate.ok ? 'ok' : 'falló'}`);
    }
  }
  return parts.join('; ') || 'sin evidencia de verificación';
}

/**
 * Fold the mandatory final runtime/browser probe into the project-gate result.
 * The repair loop is intentionally bounded; without this last admission check a
 * model could exhaust its repair rounds, pass TypeScript, and still checkpoint
 * a blank or non-booting app as `done`.
 */
function mergeFinalRuntimeGate(projectVerification, runtimeVerification) {
  const devServer = runtimeVerification?.devServer || { ran: false, ok: false };
  const browser = runtimeVerification?.browser || { ran: false, ok: false };
  const passed = Boolean(
    runtimeVerification?.ran === true
    && runtimeVerification?.ok === true
    && devServer.ran === true
    && devServer.ok === true
    && browser.ran === true
    && browser.ok === true,
  );
  const blockingGates = new Set(projectVerification?.blockingGates || []);
  if (!devServer.ran || !devServer.ok) blockingGates.add('dev_server_check');
  if (!browser.ran || !browser.ok) blockingGates.add('browser_check');
  const diagnostics = Array.isArray(projectVerification?.diagnostics)
    ? [...projectVerification.diagnostics]
    : [];
  if (!passed) {
    diagnostics.push({
      gate: runtimeVerification?.kind === 'browser' ? 'browser_check' : 'dev_server_check',
      message: String(runtimeVerification?.errors || 'La verificación final de runtime/navegador no produjo evidencia verde.').slice(0, 2000),
    });
  }
  return {
    ...(projectVerification || {}),
    ran: true,
    clean: projectVerification?.clean === true && passed,
    gates: {
      ...(projectVerification?.gates || {}),
      devServer,
      browser,
    },
    ...(passed ? {} : {
      blockingGates: [...blockingGates],
      diagnostics: diagnostics.slice(0, 50),
    }),
  };
}

async function workspaceDiffstat({ runner, projectId }) {
  const diffstat = { additions: 0, deletions: 0, filesChanged: 0 };
  if (typeof runner?.exec !== 'function') return diffstat;
  try {
    const [status, unstaged, staged] = await Promise.all([
      runner.exec(projectId, ['git', 'status', '--porcelain']),
      runner.exec(projectId, ['git', 'diff', '--shortstat', 'HEAD']),
      runner.exec(projectId, ['git', 'diff', '--cached', '--shortstat', 'HEAD']),
    ]);
    const parsedUnstaged = checkpointService.parseShortstat(unstaged?.stdout || '');
    const parsedStaged = checkpointService.parseShortstat(staged?.stdout || '');
    diffstat.additions = parsedUnstaged.additions + parsedStaged.additions;
    diffstat.deletions = parsedUnstaged.deletions + parsedStaged.deletions;
    diffstat.filesChanged = String(status?.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
  } catch { /* best-effort evidence */ }
  return diffstat;
}

async function workspaceFilePatch({ runner, projectId, path, maxChars = LIVE_FILE_PATCH_CAP }) {
  const normalized = require('./file-state').normalizeWorkspacePath(path);
  if (
    !normalized
    || BLOCKED_LIVE_PATCH_PATHS.some((pattern) => pattern.test(normalized))
    || typeof runner?.exec !== 'function'
  ) return null;
  let patch = '';
  try {
    const diff = await runner.exec(
      projectId,
      ['git', 'diff', '--no-ext-diff', '--unified=3', '--', normalized],
      { timeoutMs: 15_000 },
    );
    patch = String(diff?.stdout || '');
    if (!patch) {
      const untracked = await runner.exec(
        projectId,
        ['git', 'ls-files', '--others', '--exclude-standard', '--', normalized],
        { timeoutMs: 15_000 },
      );
      const isUntracked = String(untracked?.stdout || '')
        .split('\n')
        .map((value) => value.trim())
        .includes(normalized);
      if (isUntracked && typeof runner?.readFile === 'function') {
        const file = await runner.readFile(projectId, normalized);
        const content = String(file?.content ?? '');
        const lines = content.split('\n');
        patch = [
          `diff --git a/${normalized} b/${normalized}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${normalized}`,
          `@@ -0,0 +1,${lines.length} @@`,
          lines.map((line) => `+${line}`).join('\n'),
        ].join('\n');
      }
    }
  } catch {
    return null;
  }
  if (!patch) return null;
  patch = redactString(patch);
  if (!scanBuffer(patch, { maxFindings: 1 }).ok) return null;
  const cap = Math.max(1000, Number(maxChars) || LIVE_FILE_PATCH_CAP);
  const truncated = patch.length > cap;
  return {
    path: normalized,
    patch: truncated ? `${patch.slice(0, cap)}\n…[diff recortado]` : patch,
    truncated,
  };
}

function conciseTaskTitle(value) {
  const text = String(value || '')
    .replace(/\[SIRA_PROACTIVE_TASK\][\s\S]*?\[\/SIRA_PROACTIVE_TASK\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'Trabajo del agente').slice(0, 180);
}

function buildExecutiveSummary({
  outcome,
  proactiveMeta,
  sourcePrompt,
  checkpoint,
  diffstat,
  projectGateVerification,
  verification,
  branchFinalization,
  checkpointError,
}) {
  const passed = outcome === 'passed';
  const stats = {
    filesChanged: Number(diffstat?.filesChanged) || 0,
    additions: Number(diffstat?.additions) || 0,
    deletions: Number(diffstat?.deletions) || 0,
  };
  const department = String(proactiveMeta?.department || 'interactive');
  const title = conciseTaskTitle(proactiveMeta?.title || sourcePrompt);
  const result = passed
    ? 'Trabajo completado y cerrado con los controles de calidad disponibles.'
    : 'El trabajo no se promovió porque uno o más controles obligatorios fallaron.';
  const impact = `${stats.filesChanged} archivo(s) cambiado(s), ${stats.additions} adición(es) y ${stats.deletions} eliminación(es).`;
  const evidence = [];
  if (projectGateVerification) evidence.push(`Gates del proyecto: ${gateEvidence(projectGateVerification)}`);
  if (verification) evidence.push(`Verificación proactiva: ${gateEvidence(verification)}`);
  if (checkpoint?.commitSha) evidence.push(`Checkpoint Git: ${checkpoint.commitSha}`);
  if (branchFinalization?.pullRequest?.url) evidence.push(`Pull request: ${branchFinalization.pullRequest.url}`);
  if (!evidence.length) evidence.push('Ejecución registrada en el timeline durable del proyecto.');
  const risks = [];
  if (!passed) {
    const blocked = [
      ...(projectGateVerification?.blockingGates || []),
      ...(verification?.blockingGates || []),
    ].filter(Boolean);
    risks.push(blocked.length ? `Gates pendientes: ${blocked.join(', ')}.` : 'Quedó una validación obligatoria sin resolver.');
    if (checkpointError) risks.push(`Checkpoint pendiente: ${String(checkpointError).slice(0, 240)}`);
    if (branchFinalization && branchFinalization.ok !== true) {
      risks.push(`Integración Git pendiente: ${branchFinalization?.merge?.code || branchFinalization?.status || 'merge_failed'}.`);
    }
  }
  const nextActions = passed
    ? ['CEO Office puede continuar con el siguiente objetivo priorizado usando este resultado y el ledger.']
    : ['El debugger debe corregir la evidencia fallida y volver a ejecutar los gates antes de promover cambios.'];
  const riskAudio = risks.length ? ` Riesgo pendiente: ${risks[0]}` : '';
  return {
    status: passed ? 'passed' : 'failed',
    department,
    title,
    result,
    impact,
    risks,
    nextActions,
    evidence,
    audioText: `${result} ${impact}${riskAudio}`.slice(0, 1800),
    checkpointSha: checkpoint?.commitSha || null,
    diffstat: stats,
  };
}

async function runDebuggerRepair({
  run,
  projectId,
  runner,
  eventStore,
  prisma,
  llmTurn,
  env,
  metrics,
  webSearch,
  verification,
  round,
  clock,
}) {
  const tool = buildTools.getTool('run_subagent');
  if (!tool) return { isError: true, summary: 'debugger no disponible' };
  const actionId = `quality-debug-${round}`;
  const groupId = `quality-repair-${round}`;
  await eventStore.appendEvent(run.id, 'action_start', {
    actionId,
    kind: 'agent',
    command: `subagent debugger: reparar gate ${verification?.kind || 'quality'}`,
    groupId,
  }, { prisma }).catch(() => {});
  const t0 = clock().getTime();
  const result = await tool.execute({
    agent: 'debugger',
    task: [
      'Repara el workspace hasta que pueda superar sus gates deterministas.',
      `Gate que falló: ${verification?.kind || 'quality'}.`,
      `Evidencia real:\n${String(verification?.errors || 'sin detalle').slice(0, 6000)}`,
      'Inspecciona los archivos y aplica correcciones concretas. Ejecuta type_check y, cuando corresponda, smoke tests, dev_server_check y browser_check antes de terminar.',
    ].join('\n\n'),
    context: 'Este es un run PROACTIVO. No ocultes ni ignores errores y no elimines funcionalidad para hacer pasar el gate.',
  }, {
    runner,
    project: projectId,
    webSearch,
    env,
    llmTurn,
    tier: run?.tier || null,
    onUsage: (usage) => recordLlmUsageOnce(metrics, usage),
  });
  const durationMs = Math.max(0, clock().getTime() - t0);
  await eventStore.appendEvent(run.id, 'action_end', {
    actionId,
    status: result?.isError ? 'error' : 'done',
    outputSummary: buildTools.summarise(result?.summary || result?.observation || '', 1600),
    durationMs,
  }, { prisma }).catch(() => {});
  if (metrics?.recordAction) metrics.recordAction('agent', durationMs);
  return result;
}

function acceptanceEvidence(meta, verification) {
  const evidence = gateEvidence(verification);
  return (meta?.acceptanceCriteria || []).map((criterion) => ({
    criterion,
    passed: verification?.ok === true,
    evidence: verification?.ok
      ? `Gate técnico obligatorio superado: ${evidence}.`
      : `Bloqueado por ${verification?.kind || 'quality'}: ${String(verification?.errors || evidence).slice(0, 420)}`,
  }));
}

function terminalOutcomeAfterClose(closed, stopHook, fallbackError) {
  if (closed?.ok === false) {
    return {
      status: 'error',
      error: closed.error || fallbackError || 'quality gate failed',
      close: closed,
    };
  }
  const transformed = stopHook?.outcome || {};
  const status = ['done', 'error', 'cancelled'].includes(transformed.status)
    ? transformed.status
    : 'done';
  return status === 'error'
    ? {
      status,
      error: String(transformed.error || transformed.reason || 'stop hook transformed outcome').slice(0, 2000),
      close: closed,
    }
    : { status, close: closed };
}

function recordGateMetrics(verification) {
  for (const [gate, result] of Object.entries(verification?.gates || {})) {
    if (!result?.ran && result?.ok) continue;
    proactiveMetrics.recordQuality({ outcome: result?.ok ? 'passed' : 'failed', gate });
  }
}

/**
 * Build close (feature 07 + 08): create the git checkpoint for the changes this
 * run produced (no checkpoint when the tree is clean), then finalize metrics +
 * run_summary (feature 08 extends this). Best-effort — a checkpoint/metrics
 * failure must not turn a successful build into an error.
 */
async function closeBuild({
  run,
  project,
  runner,
  eventStore,
  prisma,
  llmTurn,
  clock,
  env,
  metrics,
  sourcePrompt,
  webSearch,
  checkpointService: checkpointServiceForClose = checkpointService,
  sessionService,
  backgroundTaskService,
  backgroundWatchers = null,
  browserCheck = null,
}) {
  await ensureAppsVitePreviewable({ run, project, runner, eventStore, prisma });
  const resolvedSourcePrompt = sourcePrompt != null
    ? sourcePrompt
    : await resolveRunSourcePrompt({ run, prisma });
  const proactiveMeta = progressLedger.taskMetaFromPrompt(resolvedSourcePrompt);
  // Stop every trusted background task before verification. A task that cannot
  // be authenticated/stopped blocks the close rather than racing the gate.
  const verifyRequired = String(env?.CODEX_AUTO_VERIFY ?? '1') !== '0';
  const projectId = project?.id || run.projectId;
  let projectGateVerification = null;
  if (verifyRequired) {
    const tasks = backgroundTaskService || require('./background-tasks').backgroundTaskService;
    let quiescence;
    try {
      quiescence = typeof tasks?.quiesce === 'function'
        ? await tasks.quiesce({ runner, project: projectId })
        : { ok: false, code: 'background_quiescence_unavailable' };
    } catch (error) {
      quiescence = { ok: false, code: 'background_quiescence_failed', error: String(error?.message || error) };
    }
    if (!quiescence?.ok) {
      projectGateVerification = {
        ran: true,
        clean: false,
        rounds: 0,
        fixes: 0,
        blockingGates: [quiescence?.code || 'background_tasks'],
      };
    } else {
      if (backgroundWatchers?.size) {
        await Promise.allSettled([...backgroundWatchers]);
      }
      try {
        const verifyLoop = require('./verify-loop');
        projectGateVerification = await verifyLoop.autoVerifyAndHeal({
          run,
          projectId,
          runner,
          eventStore,
          prisma,
          llmTurn,
          env,
          metrics,
          clock,
        });
      } catch (err) {
        projectGateVerification = {
          ran: true,
          clean: false,
          rounds: 0,
          fixes: 0,
          blockingGates: ['verification_exception'],
          diagnostics: [{ message: String(err?.message || err).slice(0, 1000) }],
        };
        if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] auto-verify failed:', err?.message || err);
      }
    }
  }

  let verification = null;
  if (proactiveMeta) {
    const maxRepairRounds = readPosInt(env?.CODEX_PROACTIVE_REPAIR_ROUNDS, 2);
    verification = await verifyWorkspace({
      runner,
      projectId,
      run,
      eventStore,
      prisma,
      metrics,
      clock,
      env,
      actionId: 'quality-1',
      groupId: 'quality-gate',
      strict: true,
      requireSmoke: proactiveMeta.qaCycle,
      browserCheck,
    });
    for (let round = 1; !verification.ok && round <= maxRepairRounds; round += 1) {
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: `El gate ${verification.kind || 'de calidad'} falló. El subagente debugger inicia la reparación ${round}/${maxRepairRounds}.`,
      }, { prisma }).catch(() => {});
      await runDebuggerRepair({
        run,
        projectId,
        runner,
        eventStore,
        prisma,
        llmTurn,
        env,
        metrics,
        webSearch,
        verification,
        round,
        clock,
      });
      verification = await verifyWorkspace({
        runner,
        projectId,
        run,
        eventStore,
        prisma,
        metrics,
        clock,
        env,
        actionId: `quality-${round + 1}`,
        groupId: 'quality-gate',
        strict: true,
        requireSmoke: proactiveMeta.qaCycle,
        browserCheck,
      });
    }
    recordGateMetrics(verification);
  }

  // Autonomous /code runs explicitly enable the dev-server verifier. Run one
  // final, strict runtime + browser admission check after every bounded healing
  // loop, including the proactive debugger. This is the authoritative close
  // gate: unavailable evidence, a Vite boot error, a blank page, or a browser
  // exception all block checkpointing.
  if (
    verifyRequired
    && String(env?.CODEX_VERIFY_DEV_SERVER ?? '0') === '1'
    && projectGateVerification?.clean === true
  ) {
    let finalRuntimeVerification;
    try {
      finalRuntimeVerification = await verifyDevServer({
        runner,
        projectId,
        run,
        eventStore,
        prisma,
        metrics,
        clock,
        env,
        actionId: 'quality-runtime-final',
        groupId: 'quality-runtime-final',
        strict: true,
        browserCheck,
      });
    } catch (error) {
      finalRuntimeVerification = {
        ran: true,
        ok: false,
        kind: 'infra',
        errors: String(error?.message || error).slice(0, 2000),
        devServer: { ran: false, ok: false },
        browser: { ran: false, ok: false },
      };
    }
    projectGateVerification = mergeFinalRuntimeGate(
      projectGateVerification,
      finalRuntimeVerification,
    );
  }

  let diffstat = await workspaceDiffstat({ runner, projectId });
  let checkpoint = null;
  let checkpointError = null;
  let branchFinalization = null;
  let projectGatesPassed = !verifyRequired || projectGateVerification?.clean === true;
  let verifiedTreeSha = null;
  const closeRunBranchesEnabled = productionFeatureEnabled(env, 'CODEX_RUN_BRANCHES');
  if (closeRunBranchesEnabled && projectGatesPassed && (!proactiveMeta || verification?.ok)) {
    try {
      verifiedTreeSha = await checkpointServiceForClose.captureWorkspaceTree({ runner, projectId });
    } catch (error) {
      projectGatesPassed = false;
      projectGateVerification = {
        ...(projectGateVerification || {}),
        ran: true,
        clean: false,
        blockingGates: ['git_tree_capture'],
        diagnostics: [{ message: String(error?.message || error).slice(0, 1000) }],
      };
    }
  }
  if (projectGatesPassed && (!proactiveMeta || verification?.ok)) {
    try {
      const checkpointDeps = {
        runner,
        eventStore,
        prisma,
        llmTurn,
        clock,
        env,
        sessionService,
        expectedTreeSha: verifiedTreeSha,
      };
      if (closeRunBranchesEnabled) {
        const repository = project?.brief?.kind === 'repo' ? project.brief.repository : null;
        if (repository?.url) {
          checkpoint = await checkpointServiceForClose.createCheckpoint({
            run,
            project,
            deps: checkpointDeps,
          });
          const pullRequest = await require('./self-hosting').publishSelfHostedPullRequest({
            runner,
            projectId,
            runId: run.id,
            repositoryUrl: repository.url,
            sourceBranch: repository.sourceBranch || 'main',
            title: `feat(codex): ${String(resolvedSourcePrompt || run.id).slice(0, 120)}`,
            env,
          });
          branchFinalization = { ...pullRequest, checkpoint };
        } else {
          branchFinalization = await checkpointServiceForClose.finalizeRunCheckpoint({
            run,
            project,
            verification: {
              ok: true,
              status: 'passed',
              treeSha: verifiedTreeSha,
            },
            deps: checkpointDeps,
          });
          checkpoint = branchFinalization?.checkpoint || null;
        }
      } else {
        checkpoint = await checkpointServiceForClose.createCheckpoint({
          run,
          project,
          deps: checkpointDeps,
        });
      }
    } catch (err) {
      checkpointError = String(err?.message || err).slice(0, 1000);
      if (closeRunBranchesEnabled) {
        branchFinalization = {
          ok: false,
          status: 'checkpoint_failed',
          merge: { code: 'checkpoint_failed', detail: String(err?.message || err).slice(0, 1000) },
        };
      }
      if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] checkpoint failed:', err?.message || err);
    }
  }

  const proactivePassed = !proactiveMeta || verification?.ok === true;
  const branchPassed = !branchFinalization || branchFinalization.ok === true;
  const checkpointPassed = !checkpointError;
  const finalOutcome = projectGatesPassed && proactivePassed && branchPassed && checkpointPassed ? 'passed' : 'failed';
  const learningEvidence = {
    project: projectGateVerification,
    proactive: verification,
    branch: branchFinalization
      ? {
        ok: branchFinalization.ok,
        status: branchFinalization.status || null,
        merge: branchFinalization.merge || null,
      }
      : null,
    checkpointError,
  };
  let learned = {
    learnings: progressLedger.deterministicLearnings({
      outcome: finalOutcome,
      checkpointSha: checkpoint?.commitSha || null,
      diffstat,
      verification: learningEvidence,
    }),
    usage: null,
  };
  const autoMemoryConfigured = env?.CODEX_AUTO_MEMORY;
  const autoMemoryEnabled = autoMemoryConfigured == null
    ? env?.NODE_ENV === 'production'
    : String(autoMemoryConfigured).trim() !== '0';
  if (autoMemoryEnabled) {
    learned = await progressLedger.generateAutoLearnings({
      llmTurn,
      task: proactiveMeta?.title || resolvedSourcePrompt,
      outcome: finalOutcome,
      checkpointSha: checkpoint?.commitSha || null,
      diffstat,
      verification: learningEvidence,
      env,
    });
    recordLlmUsageOnce(metrics, learned.usage);
  }

  // Metrics + run_summary (feature 08). Order: checkpoint → auto-memory →
  // metric → ledger → run_summary, then the processor emits run_status.
  let metric = null;
  if (metrics && typeof metrics.finalize === 'function') {
    try {
      const userPlan = await resolveUserPlan(run.userId, prisma);
      metric = await metrics.finalize({ diffstat, userPlan, prisma, eventStore, env, clock });
    } catch (err) {
      if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] metrics finalize failed:', err?.message || err);
    }
  }

  await progressLedger.appendLedgerEntry({
    prisma,
    project,
    entry: {
      department: proactiveMeta?.department || 'interactive',
      runId: run.id,
      ...(proactiveMeta?.missionId ? { missionId: proactiveMeta.missionId } : {}),
      outcome: finalOutcome,
      task: proactiveMeta?.title || String(resolvedSourcePrompt || '').slice(0, 600),
      checkpointSha: checkpoint?.commitSha || null,
      diffstat,
      costUsd: Number(metric?.costAppliedUsd ?? metric?.costUsd) || 0,
      acceptance: proactiveMeta ? acceptanceEvidence(proactiveMeta, verification) : [],
      learnings: learned.learnings,
      createdAt: clock().toISOString(),
    },
  }).catch((err) => {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] progress ledger append failed:', err?.message || err);
  });

  const executiveSummary = buildExecutiveSummary({
    outcome: finalOutcome,
    proactiveMeta,
    sourcePrompt: resolvedSourcePrompt,
    checkpoint,
    diffstat,
    projectGateVerification,
    verification,
    branchFinalization,
    checkpointError,
  });
  await eventStore.appendEvent(run.id, 'executive_summary', executiveSummary, { prisma }).catch((err) => {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] executive summary append failed:', err?.message || err);
  });
  await require('./mission-evidence-ledger').recordMissionCompletion({
    prisma,
    project,
    runId: run.id,
    missionId: proactiveMeta?.missionId || null,
    missionTitle: proactiveMeta?.title || conciseTaskTitle(resolvedSourcePrompt),
    department: proactiveMeta?.department || 'interactive',
    outcome: finalOutcome,
    executiveSummary,
    acceptance: proactiveMeta ? acceptanceEvidence(proactiveMeta, verification) : [],
    now: clock(),
  }).catch((err) => {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] mission evidence append failed:', err?.message || err);
  });

  if (proactiveMeta) {
    if (!proactivePassed || !projectGatesPassed) {
      await eventStore.appendEvent(run.id, 'narrative_delta', {
        text: `No cerré ni promoví este run: el gate obligatorio ${verification?.kind || 'de calidad'} sigue fallando después de la reparación.`,
      }, { prisma }).catch(() => {});
      return {
        ok: false,
        checkpoint: null,
        verification,
        projectGateVerification,
        error: projectGatesPassed
          ? `proactive quality gate failed (${verification?.kind || 'unknown'}): ${String(verification?.errors || 'sin evidencia').slice(0, 1200)}`
          : `project quality gates failed: ${String(projectGateVerification?.blockingGates || 'unknown').slice(0, 1200)}`,
      };
    }
  }
  if (!projectGatesPassed) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `No cerré ni creé un checkpoint: fallaron los gates obligatorios ${String(projectGateVerification?.blockingGates || 'de calidad')}.`,
    }, { prisma }).catch(() => {});
    return {
      ok: false,
      checkpoint: null,
      verification,
      projectGateVerification,
      error: `project quality gates failed: ${String(projectGateVerification?.blockingGates || 'unknown').slice(0, 1200)}`,
    };
  }
  if (checkpointError) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `No cerré la corrida porque el checkpoint Git falló: ${checkpointError}`,
    }, { prisma }).catch(() => {});
    return {
      ok: false,
      checkpoint: null,
      verification,
      projectGateVerification,
      error: `checkpoint failed: ${checkpointError}`,
    };
  }
  if (branchFinalization && branchFinalization.ok !== true) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `El checkpoint quedó en la rama del run, pero no se fusionó: ${branchFinalization?.merge?.code || branchFinalization?.status || 'merge_failed'}.`,
    }, { prisma }).catch(() => {});
    return {
      ok: false,
      checkpoint,
      verification,
      projectGateVerification,
      branchFinalization,
      error: `run branch merge failed: ${branchFinalization?.merge?.code || branchFinalization?.status || 'unknown'}`,
    };
  }
  if (branchFinalization?.pullRequest?.url) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `Pull request creado desde el checkpoint verde: ${branchFinalization.pullRequest.url}`,
    }, { prisma }).catch(() => {});
  }
  return {
    ok: true,
    checkpoint,
    verification,
    projectGateVerification,
    branchFinalization,
  };
}

/** Best-effort lookup of the user's plan for pricing (defaults to FREE). */
async function resolveUserPlan(userId, prisma) {
  if (!userId || !prisma || !prisma.user) return 'FREE';
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
    return u?.plan || 'FREE';
  } catch {
    return 'FREE';
  }
}

async function runAgentLoop({ run, project, signal, isCancelled, deps = {} } = {}) {
  const { eventStore } = deps;
  if (!eventStore) throw new Error('agent-loop: eventStore dep required');
  const baseLlmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));
  // Durable model controls ride along on every model step, including plan mode.
  // Build mode can still raise effort explicitly for repair rounds via `...a`.
  const llmTurn = (a = {}) => baseLlmTurn({
    tier: run?.tier || null,
    model: run?.model || null,
    effort: effortForStage({
      tier: run?.tier || null,
      reasoningEffort: run?.reasoningEffort || null,
      env: a.env || deps.env || process.env,
    }),
    ...a,
  });

  if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

  if (run.mode === 'plan') {
    const companySoul = deps.companySoul != null
      ? deps.companySoul
      : String((await require('./company-operating-profile')
        .loadCompanySoul({ prisma: deps.prisma, project })
        .catch(() => null))?.content || '');
    return planMode.runPlanMode({
      run,
      project,
      deps: { ...deps, llmTurn, companySoul },
    });
  }
  return runBuildLoop({ run, project, signal, isCancelled, deps: { ...deps, llmTurn } });
}

module.exports = {
  runAgentLoop,
  runBuildLoop,
  buildSystemPrompt,
  safeFileTree,
  safeProjectNotes,
  loadApprovedPlan,
  // Exported for white-box tests / reuse.
  ensureAppsVitePreviewable,
  appsFallbackFiles,
  packageLooksLikeNext,
  workspaceFilePatch,
  buildExecutiveSummary,
  isAppsPrompt,
  compactMessages,
  boundedArgsPreview,
  contextBudgetChars,
  effortForStage,
  createProtocolSafeTextStream,
  messageChars,
  boundedTail,
  messageContentText,
  toolResultContent,
  summaryInput,
  summariseContextWithLlm,
  loadLatestContextSnapshot,
  loadResolvedToolPermissions,
  persistContextSnapshot,
  verifyWorkspace,
  verifyDevServer,
  verifySmokeTests,
  closeBuild,
  gateEvidence,
  acceptanceEvidence,
};
