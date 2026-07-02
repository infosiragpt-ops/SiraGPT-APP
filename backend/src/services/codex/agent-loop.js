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
    'Nunca dependas de prompts interactivos de terminal; los comandos deben terminar solos.',
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

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { aborted = true; break; }
    if (typeof isCancelled === 'function' && (await isCancelled())) return { status: 'cancelled' };

    let turn;
    try {
      turn = await llmTurn({ messages, tools: registry, signal, env });
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

    const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls.slice(0, maxToolsPerTurn) : [];
    if (calls.length === 0) {
      // Model produced no tool call → it's done.
      await closeBuild({ run, project, runner, eventStore, prisma, llmTurn, clock, env, metrics });
      return { status: 'done' };
    }

    const groupId = `g${++groupCounter}`;
    for (const call of calls) {
      const tool = buildTools.getTool(call.name);
      const actionId = `a${++actionCounter}`;
      if (!tool) {
        await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: 'terminal', command: String(call.name), groupId }, { prisma });
        await eventStore.appendEvent(run.id, 'action_end', { actionId, status: 'error', outputSummary: `herramienta desconocida: ${call.name}`, durationMs: 0 }, { prisma });
        // Honest counting (feature 08, spec req. 4): actionsCount = actions with
        // an action_end of ANY status. This unknown-tool path emits an action_end,
        // so it must be counted too — otherwise the "Work done" number undercounts.
        if (metrics?.recordAction) metrics.recordAction('terminal', 0);
        messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] Error: herramienta desconocida.` });
        continue;
      }

      const command = tool.commandFor(call.args);
      const path = tool.pathFor(call.args);
      await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: tool.kind, command: command || undefined, path: path || undefined, groupId }, { prisma });

      const t0 = clock().getTime();
      const result = await tool.execute(call.args, { runner, project: projectId, webSearch });
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

      messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] ${result.observation || outputSummary || ''}` });

      if (blockingPattern) {
        await eventStore.appendEvent(run.id, 'action_required', toActionRequired(blockingPattern, result.observation || outputSummary), { prisma }).catch(() => {});
        return { status: 'error', error: blockingPattern.title };
      }
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
    await runner.exec(
      projectId,
      'rm -rf app pages src/app next.config.mjs next.config.js next-env.d.ts .next .next-env.d.ts vite.config.js src/main.js',
      { timeoutMs: 15000 },
    ).catch(() => {});
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
  const llmTurn = deps.llmTurn || ((a) => require('./llm-turn').defaultLlmTurn(a));

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
};
