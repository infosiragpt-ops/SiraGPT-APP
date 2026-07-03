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
const buildTools = require('./build-tools');
const actionStoreDefault = require('./action-store');
const checkpointService = require('./checkpoint-service');
const runMetrics = require('./run-metrics');
const { classifyText, toActionRequired, benignAnnotation } = require('./error-patterns');

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOOLS_PER_TURN = 4;
const DEFAULT_CONTEXT_MAX_CHARS = 60_000;
const DEFAULT_MAX_VERIFY_ROUNDS = 2;
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

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isAppsPrompt(text) {
  return /MODO APPS TIPO CODEX/i.test(String(text || ''));
}

function explicitlyRequestsNext(text) {
  const source = String(text || '').split(/SOLICITUD DEL USUARIO:/i).pop() || '';
  return /\bnext(?:\.js|js)?\b/i.test(source);
}

function userRequestFromPrompt(text) {
  const source = String(text || '');
  const parts = source.split(/SOLICITUD DEL USUARIO:/i);
  return (parts.length > 1 ? parts.pop() : source).trim();
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
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      typescript: '^5.5.4',
      vite: '^7.0.0',
    },
  };
  const viteConfig = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n`;
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020', useDefineForClassFields: true, lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true,
      resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: 'react-jsx', strict: true,
    },
    include: ['src'],
  };
  const mainTsx = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n)\n`;
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

function buildSystemPrompt({ project, plan, fileTree, sourcePrompt }) {
  const appsMode = isAppsPrompt(sourcePrompt);
  const forceViteApps = appsMode && !explicitlyRequestsNext(sourcePrompt);
  const lines = [
    'Eres un agente de software senior trabajando dentro de un workspace aislado.',
    'Narras en PRIMERA PERSONA y en ESPAÑOL lo que vas haciendo, de forma breve y concreta.',
    'Construyes el proyecto usando las herramientas disponibles (no inventes resultados).',
    'Trabajas paso a paso: piensa, usa una herramienta, lee el resultado, continúa.',
    'El workspace ya viene provisionado con un starter REACT 18 + VITE 7 + TypeScript ejecutable: package.json (react, react-dom, @vitejs/plugin-react, typescript, vite), vite.config.ts, tsconfig.json, index.html (carga /src/main.tsx), src/main.tsx y src/App.tsx.',
    'NO inicialices frameworks ni ejecutes scaffolds interactivos (create-next-app/create-vite); construye componentes React (.tsx) editando/creando archivos en src/ con write_file/edit_file.',
    'Si necesitas estructura adicional, crea archivos concretos tú mismo. Usa run_command solo para verificar, instalar dependencias declaradas o revisar git.',
    'Antes de editar un archivo existente, léelo (read_file) y usa edit_file con el fragmento EXACTO; usa list_files/grep_search para orientarte en el workspace en vez de adivinar rutas.',
    'NO reescribas un archivo que ya escribiste salvo para corregir un error concreto (uno que viste en type_check o dev_server_check). Construye archivo por archivo siguiendo el plan; NO intentes hacerlo "todo de una vez" reescribiendo el mismo archivo una y otra vez. Cuando un archivo esté listo, avanza al siguiente paso del plan.',
    'Antes de dar por terminado, asegúrate de que el proyecto compila (el sistema ejecutará una verificación de tipos al final y te devolverá los errores si los hay).',
    'Nunca dependas de prompts interactivos de terminal; los comandos deben terminar solos.',
    'VERIFICA tu trabajo como lo haría un ingeniero: después de crear o editar código usa type_check para ver los errores reales de compilación y dev_server_check para confirmar que la app corre; corrige lo que salga antes de dar el trabajo por terminado.',
    'Para tareas grandes o especializadas delega con run_subagent: planner (plan de construcción), frontend_builder (UI React/TS), backend_engineer (APIs y capa de datos), db_architect (modelo de datos), qa_reviewer (revisión final), debugger (diagnóstico y fix de errores reales), enterprise_analyst (especificación de negocio). Si el proyecto define agentes custom en .sira/agents.json también puedes delegarles.',
    'Los subagentes son independientes: cuando dos tareas no dependen entre sí (p.ej. frontend_builder para la UI y db_architect para el modelo), emite VARIOS run_subagent en el MISMO turno y correrán en paralelo.',
    'Si el usuario pide software de EMPRESA (CRM, ERP, inventario, facturación, RRHH, punto de venta, gestión de clientes/proveedores/proyectos), delega PRIMERO en enterprise_analyst para convertir el pedido en módulos, entidades, roles y flujos; luego construye una app multi-módulo con navegación lateral, dashboard con KPIs y datos de ejemplo realistas del dominio.',
    `Proyecto: ${project?.name || 'Codex'}.`,
  ];
  if (forceViteApps) {
    lines.push('Este run viene de /apps. Stack OBLIGATORIO: React 18 + Vite 7 + TypeScript (el starter ya provisto). Construye componentes .tsx en src/; el entry es src/main.tsx que monta <App/> en #root.');
    lines.push('PROHIBIDO Next.js: NO crees next.config.mjs, app/, pages/ ni cambies package.json a "next dev". Mantén el package.json Vite (script dev="vite"). El resultado debe abrir en el preview de inmediato.');
  }
  if (plan) {
    lines.push('Plan aprobado por el usuario (síguelo):');
    lines.push(JSON.stringify(plan));
  }
  if (fileTree) {
    lines.push('Archivos actuales del workspace:');
    lines.push(fileTree);
  }
  lines.push('Cuando el proyecto esté listo, deja de llamar herramientas y resume lo construido.');
  return lines.join('\n');
}

/**
 * In-place transcript compaction (Claude Code-style "microcompact"): when the
 * transcript exceeds the char budget, old `[TOOL_RESULT]` bodies — the bulk of
 * the growth — are truncated. System prompt, the task prompt and the last
 * COMPACT_KEEP_TAIL messages stay verbatim. Returns how many were compacted.
 */
function compactMessages(messages, { maxChars = DEFAULT_CONTEXT_MAX_CHARS } = {}) {
  const total = messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
  if (total <= maxChars) return 0;
  let compacted = 0;
  const lastKeep = Math.max(2, messages.length - COMPACT_KEEP_TAIL);
  for (let i = 2; i < lastKeep; i += 1) {
    const m = messages[i];
    const content = typeof m?.content === 'string' ? m.content : '';
    if (m?.role === 'user' && content.startsWith('[TOOL_RESULT') && content.length > COMPACT_TOOL_RESULT_CAP + 60) {
      messages[i] = { ...m, content: `${content.slice(0, COMPACT_TOOL_RESULT_CAP)}\n…[resultado antiguo recortado; vuelve a leer el archivo si lo necesitas]` };
      compacted += 1;
    }
  }
  return compacted;
}

/**
 * Post-build verification (the missing "fifth leg" vs Claude Code): install
 * deps and typecheck the workspace, feeding failures back to the model for a
 * bounded number of repair rounds. Only runs when the workspace has a real
 * tsconfig.json — deterministic no-op otherwise (keeps scripted tests inert).
 * Emits action events so the timeline shows the verification like any tool.
 */
async function verifyWorkspace({ runner, projectId, run, eventStore, prisma, metrics, clock, env = process.env, actionId, groupId }) {
  if (String(env.CODEX_VERIFY_DISABLED || '') === '1') return { ran: false, ok: true };
  if (typeof runner?.exec !== 'function' || typeof runner?.readFile !== 'function') return { ran: false, ok: true };

  let tsconfig = '';
  try {
    const out = await runner.readFile(projectId, 'tsconfig.json');
    tsconfig = String(out?.content || '');
  } catch { /* no tsconfig → nothing to verify */ }
  if (!tsconfig.trim()) return { ran: false, ok: true };
  // Only verify REAL TypeScript projects: the tsconfig must parse (JSONC
  // comments tolerated). Garbage/placeholder content → deterministic no-op.
  try {
    JSON.parse(tsconfig.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return { ran: false, ok: true };
  }

  await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: 'verificación: bun install + tsc --noEmit', groupId }, { prisma }).catch(() => {});
  const t0 = clock().getTime();
  let ok = false;
  let errors = '';
  try {
    const install = await runner.exec(projectId, ['bun', 'install'], { timeoutMs: 120_000 });
    if (install.exitCode !== 0) {
      errors = `bun install exit ${install.exitCode}\n${String(install.stderr || install.stdout || '').slice(0, 4000)}`;
    } else {
      const tsc = await runner.exec(projectId, ['bunx', 'tsc', '--noEmit', '--pretty', 'false'], { timeoutMs: 120_000 });
      if (tsc.exitCode === 0) ok = true;
      else errors = String([tsc.stdout, tsc.stderr].filter(Boolean).join('\n')).slice(0, 4000) || `tsc exit ${tsc.exitCode}`;
    }
  } catch (err) {
    // Runner/env failure (not a code failure) → skip verification honestly.
    await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `verificación no disponible: ${err.message}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
    return { ran: false, ok: true };
  }
  const durationMs = Math.max(0, clock().getTime() - t0);
  await eventStore.appendEvent(run.id, 'action_end', { actionId, status: ok ? 'done' : 'error', outputSummary: ok ? 'compila sin errores de tipos' : errors, durationMs }, { prisma }).catch(() => {});
  if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);
  return { ran: true, ok, errors };
}

/** Best-effort tracked-file listing for context. Never throws. */
async function safeFileTree(runner, projectId) {
  try {
    const out = await runner.exec(projectId, ['git', 'ls-files']);
    if (out && out.exitCode === 0 && out.stdout) return String(out.stdout).slice(0, 4000);
  } catch { /* ignore */ }
  return '';
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
  const llmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));
  const runner = deps.runner || require('./runner-client').createRunnerClient();
  const actionStore = deps.actionStore || actionStoreDefault;
  const webSearch = deps.webSearch || defaultWebSearch;
  const projectId = project?.id || run.projectId;

  const maxSteps = readPosInt(env.CODEX_MAX_STEPS, DEFAULT_MAX_STEPS);
  const maxToolsPerTurn = readPosInt(env.CODEX_MAX_TOOLS_PER_TURN, DEFAULT_MAX_TOOLS_PER_TURN);
  const contextMaxChars = readPosInt(env.CODEX_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS);
  const maxVerifyRounds = readPosInt(env.CODEX_MAX_VERIFY_ROUNDS, DEFAULT_MAX_VERIFY_ROUNDS);
  const maxSameFileWrites = readPosInt(env.CODEX_MAX_SAME_FILE_WRITES, DEFAULT_MAX_SAME_FILE_WRITES);
  const registry = buildTools.toolRegistry();

  const plan = deps.plan || (await loadApprovedPlan({ run, eventStore, prisma }));
  const sourcePrompt = deps.sourcePrompt != null ? deps.sourcePrompt : await resolveRunSourcePrompt({ run, prisma });
  const fileTree = deps.fileTree != null ? deps.fileTree : await safeFileTree(runner, projectId);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ project, plan, fileTree, sourcePrompt }) },
    { role: 'user', content: sourcePrompt || 'Construye el proyecto según el plan aprobado.' },
  ];

  let actionCounter = 0;
  let groupCounter = 0;
  let aborted = false;
  let verifyRounds = 0;
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

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { aborted = true; break; }
    if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

    compactMessages(messages, { maxChars: contextMaxChars });

    let turn;
    try {
      turn = await llmTurn({ messages, tools: registry, signal, env, tier: run?.tier || null });
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
    if (turn?.usage && metrics?.recordLlmUsage) metrics.recordLlmUsage(turn.usage);

    // Reasoning block (native or prompted).
    if (turn?.reasoning && (turn.reasoning.text || turn.reasoning.label)) {
      const blockId = `r${step}`;
      const r = turn.reasoning;
      await eventStore.appendEvent(run.id, 'reasoning_start', { blockId, label: r.label || 'Razonando' }, { prisma });
      if (r.text) await eventStore.appendEvent(run.id, 'reasoning_delta', { blockId, text: String(r.text) }, { prisma });
      await eventStore.appendEvent(run.id, 'reasoning_end', { blockId, durationMs: Number(r.durationMs) || 0 }, { prisma });
    }

    // Narrative.
    if (turn?.text && turn.text.trim()) {
      await eventStore.appendEvent(run.id, 'narrative_delta', { text: turn.text.trim() }, { prisma });
      messages.push({ role: 'assistant', content: turn.text.trim() });
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
        });
        if (v.ran && !v.ok) {
          verifyRounds += 1;
          messages.push({ role: 'user', content: `[VERIFICACIÓN] El proyecto NO compila. Errores de tsc:\n${v.errors}\nCorrige estos errores (read_file + edit_file) y cuando termines deja de llamar herramientas.` });
          continue;
        }
      }
      await closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics });
      return { status: 'done' };
    }
    if (allCalls.length > calls.length) {
      // Honest budget: tell the model what was dropped instead of letting it
      // believe those actions ran (they never did).
      const dropped = allCalls.slice(calls.length).map((c) => c.name).join(', ');
      messages.push({ role: 'user', content: `[BUDGET] Se omitieron ${allCalls.length - calls.length} tool calls de este turno por el límite de ${maxToolsPerTurn} por turno (${dropped}). Reintenta esas acciones en el siguiente turno.` });
    }

    const groupId = `g${++groupCounter}`;

    const executeCall = async (call) => {
      const tool = buildTools.getTool(call.name);
      const actionId = `a${++actionCounter}`;
      if (!tool) {
        await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: String(call.name), groupId }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `herramienta desconocida: ${call.name}`, durationMs: 0 }, { prisma });
        // Honest counting (feature 08, spec req. 4): actionsCount = actions with
        // an action_end of ANY status. This unknown-tool path emits an action_end,
        // so it must be counted too — otherwise the "Work done" number undercounts.
        if (metrics?.recordAction) metrics.recordAction('terminal', 0);
        return { message: `[TOOL_RESULT ${call.name}] Error: herramienta desconocida.`, blocking: null };
      }

      const command = tool.commandFor(call.args);
      const path = tool.pathFor(call.args);
      await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: tool.kind, command: command || undefined, path: path || undefined, groupId }, { prisma });

      const t0 = clock().getTime();
      const result = await tool.execute(call.args, {
        runner,
        project: projectId,
        webSearch,
        env,
        signal,
        llmTurn,
        // The run tier (composer Power selector) must reach subagents too, so a
        // delegation runs on the SAME engine as the main loop (Claude for paid
        // tiers) instead of silently dropping to the free Cerebras path.
        tier: run?.tier || null,
        onUsage: (u) => { if (u && metrics?.recordLlmUsage) metrics.recordLlmUsage(u); },
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
        message: `[TOOL_RESULT ${call.name}] ${result.observation || outputSummary || ''}${thrashNudge}`,
        blocking: blockingPattern ? { pattern: blockingPattern, detail: result.observation || outputSummary } : null,
      };
    };

    // Claude Code-style parallel delegation: a turn made ONLY of run_subagent
    // calls runs them concurrently (independent specialists; writes are
    // per-file via the runner). Mixed turns stay sequential to preserve
    // read-after-write ordering between tools.
    const allDelegations = calls.length > 1 && calls.every((c) => c.name === 'run_subagent');
    const outcomes = [];
    if (allDelegations) {
      outcomes.push(...await Promise.all(calls.map((call) => executeCall(call))));
    } else {
      for (const call of calls) outcomes.push(await executeCall(call));
    }

    for (const o of outcomes) messages.push({ role: 'user', content: o.message });
    const blocked = outcomes.find((o) => o.blocking);
    if (blocked) {
      await eventStore.appendEvent(run.id, 'action_required', toActionRequired(blocked.blocking.pattern, blocked.blocking.detail), { prisma }).catch(() => {});
      return { status: 'error', error: blocked.blocking.pattern.title };
    }
  }

  // Budget exhausted (or aborted by the hard timeout signal): close honestly,
  // not as an error — the work done so far is real.
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    { text: aborted ? 'Me detuve por el límite de tiempo de la corrida.' : 'Alcancé el límite de pasos de esta corrida; cierro con lo construido hasta aquí.' },
    { prisma },
  ).catch(() => {});
  await closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics });
  return { status: 'done' };
}

async function readRunnerFile(runner, projectId, path) {
  try {
    const out = await runner.readFile(projectId, path);
    return String(out?.content || '');
  } catch {
    return '';
  }
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

function packageLooksLikeVite(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Boolean(deps.vite || /vite/i.test(String(pkg.scripts?.dev || '')));
  } catch {
    return false;
  }
}

function isStarterIndex(indexText, appText) {
  // The React starter's marker lives in src/App.tsx ("Workspace listo").
  return /Workspace listo|codex workspace ready/i.test(`${indexText}\n${appText}`);
}

async function ensureAppsVitePreviewable({ run, project, runner, eventStore, prisma }) {
  const sourcePrompt = await resolveRunSourcePrompt({ run, prisma });
  if (!isAppsPrompt(sourcePrompt) || explicitlyRequestsNext(sourcePrompt)) return { repaired: false };
  const projectId = project?.id || run.projectId;
  const [pkgText, indexText, appText] = await Promise.all([
    readRunnerFile(runner, projectId, 'package.json'),
    readRunnerFile(runner, projectId, 'index.html'),
    readRunnerFile(runner, projectId, 'src/App.tsx'),
  ]);
  // A healthy workspace is React + Vite + TS: Vite package.json (not Next) and
  // index.html loading /src/main.tsx (or legacy /src/main.js). Anything else —
  // a Next hybrid, a non-Vite pkg, a stale entry, or the untouched starter — is
  // repaired to the deterministic React+Vite+TS fallback.
  const needsRepair =
    packageLooksLikeNext(pkgText) ||
    !packageLooksLikeVite(pkgText) ||
    !/<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.(?:tsx|jsx?)["']/i.test(indexText) ||
    isStarterIndex(indexText, appText);
  if (!needsRepair) return { repaired: false };

  const files = appsFallbackFiles({ prompt: sourcePrompt, projectName: project?.name || 'App generada' });
  await runner.writeFiles(projectId, files);
  // Writing the Vite fallback isn't enough: the agent's Next scaffold (app/,
  // next.config.mjs, next-env.d.ts, .next, pages/) lingers alongside it, so the
  // workspace stays a broken Next+Vite hybrid the host-runner boots into an
  // error overlay. Purge the Next-only files so the workspace is PURE Vite.
  if (typeof runner.exec === 'function') {
    // The runner exec API only accepts argv arrays of allowlisted binaries
    // (no shell, no `rm`) — a plain `rm -rf …` string is rejected upstream and
    // the Next leftovers survive. `node -e` with fs.rmSync is allowlisted.
    const purgePaths = ['app', 'pages', 'src/app', 'next.config.mjs', 'next.config.js', 'next-env.d.ts', '.next', '.next-env.d.ts', 'vite.config.js', 'src/main.js'];
    const purgeScript = `const fs=require('fs');for(const p of ${JSON.stringify(purgePaths)}){try{fs.rmSync(p,{recursive:true,force:true})}catch{}}`;
    await runner.exec(projectId, ['node', '-e', purgeScript], { timeoutMs: 15000 }).catch(() => {});
  }
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    { text: 'Normalicé el workspace de APPS a Vite (limpié el scaffold Next) para que el preview abra en /index.html.' },
    { prisma },
  ).catch(() => {});
  return { repaired: true };
}

/**
 * Build close (feature 07 + 08): create the git checkpoint for the changes this
 * run produced (no checkpoint when the tree is clean), then finalize metrics +
 * run_summary (feature 08 extends this). Best-effort — a checkpoint/metrics
 * failure must not turn a successful build into an error.
 */
async function closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics }) {
  await ensureAppsVitePreviewable({ run, project, runner, eventStore, prisma });
  // Claude Code-style close: verify the workspace actually compiles and run a
  // bounded self-heal pass BEFORE the checkpoint so the fixes land in it.
  // Best-effort by contract (verify-loop never throws).
  try {
    const verifyLoop = require('./verify-loop');
    await verifyLoop.autoVerifyAndHeal({ run, projectId: project?.id || run.projectId, runner, eventStore, prisma, llmTurn, env, metrics, clock });
  } catch (err) {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] auto-verify failed:', err?.message || err);
  }
  let checkpoint = null;
  try {
    checkpoint = await checkpointService.createCheckpoint({ run, project, deps: { runner, eventStore, prisma, llmTurn, clock, env } });
  } catch (err) {
    if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] checkpoint failed:', err?.message || err);
  }

  // Metrics + run_summary (feature 08). Order: checkpoint → diffstat → metric →
  // run_summary, then the processor emits the terminal run_status. Best-effort —
  // a metrics failure must not turn a successful build into an error.
  if (metrics && typeof metrics.finalize === 'function') {
    try {
      let diffstat = { additions: 0, deletions: 0 };
      if (checkpoint) {
        const d = await checkpointService.getCheckpointDiff({ checkpointId: checkpoint.id, userId: run.userId, deps: { runner, prisma } });
        if (d && !d.error) diffstat = { additions: d.additions, deletions: d.deletions };
      }
      const userPlan = await resolveUserPlan(run.userId, prisma);
      await metrics.finalize({ diffstat, userPlan, prisma, eventStore, env, clock });
    } catch (err) {
      if (env?.NODE_ENV !== 'test') console.warn('[codex agent-loop] metrics finalize failed:', err?.message || err);
    }
  }
  return { checkpoint };
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
  // The run tier (composer Power selector) rides along on every model step so
  // llm-turn can pick the engine (Claude for paid tiers, Cerebras for Eco).
  const llmTurn = (a) => baseLlmTurn({ tier: run?.tier || null, ...a });

  if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

  if (run.mode === 'plan') {
    return planMode.runPlanMode({ run, project, deps: { ...deps, llmTurn } });
  }
  return runBuildLoop({ run, project, signal, isCancelled, deps: { ...deps, llmTurn } });
}

module.exports = {
  runAgentLoop,
  runBuildLoop,
  buildSystemPrompt,
  safeFileTree,
  loadApprovedPlan,
  // Exported for white-box tests / reuse.
  ensureAppsVitePreviewable,
  appsFallbackFiles,
  packageLooksLikeNext,
  isAppsPrompt,
  compactMessages,
  verifyWorkspace,
};
