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
  const escapedTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const pkg = {
    name: 'siragpt-apps-vite-preview',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {},
    devDependencies: { vite: '^7.0.0' },
  };
  const indexHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedTitle} · SiraGPT Apps</title>
    <style>
      :root { color-scheme: light; --accent: #ff0000; --ink: #111113; --muted: #666a73; --line: #e9e9ec; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #f7f7f8; }
      .shell { min-height: 100vh; background: radial-gradient(circle at top left, rgba(255,0,0,.08), transparent 30%), #fff; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 18px clamp(20px, 5vw, 72px); border-bottom: 1px solid var(--line); background: rgba(255,255,255,.86); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 3; }
      .brand { display: inline-flex; align-items: center; gap: .7rem; font-weight: 800; letter-spacing: 0; }
      .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px; background: var(--accent); color: white; font-weight: 900; }
      nav { display: flex; gap: 1rem; color: var(--muted); font-size: .92rem; }
      main { padding: clamp(38px, 7vw, 88px) clamp(20px, 5vw, 72px); }
      .hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(280px, .95fr); gap: clamp(28px, 5vw, 72px); align-items: center; max-width: 1180px; margin: 0 auto; }
      .eyebrow { display: inline-flex; align-items: center; gap: .45rem; border: 1px solid rgba(255,0,0,.22); color: var(--accent); border-radius: 999px; padding: 7px 11px; font-size: .78rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; background: rgba(255,0,0,.04); }
      h1 { margin: 18px 0 14px; font-size: clamp(2.4rem, 6vw, 5.4rem); line-height: .94; letter-spacing: 0; max-width: 760px; }
      p { color: var(--muted); font-size: clamp(1rem, 2vw, 1.22rem); line-height: 1.65; margin: 0; max-width: 650px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
      .btn { appearance: none; border: 1px solid var(--line); border-radius: 8px; padding: 13px 18px; font-weight: 800; background: white; color: var(--ink); text-decoration: none; }
      .btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; box-shadow: 0 16px 38px rgba(255,0,0,.22); }
      .panel { border: 1px solid var(--line); border-radius: 8px; background: #111113; color: white; padding: 22px; box-shadow: 0 22px 80px rgba(17,17,19,.18); }
      .panel-top { display: flex; align-items: center; justify-content: space-between; color: #b7bac2; font-size: .85rem; margin-bottom: 18px; }
      .metric { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 18px; }
      .metric div { border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 14px; }
      .metric strong { display: block; font-size: 1.35rem; color: white; }
      .cars { max-width: 1180px; margin: clamp(46px, 8vw, 88px) auto 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
      .card { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: white; }
      .photo { height: 170px; background: linear-gradient(135deg, #1d1d22, #4c4d55); position: relative; }
      .photo:after { content: ""; position: absolute; left: 11%; right: 11%; bottom: 26%; height: 34%; border-radius: 999px 999px 12px 12px; background: var(--accent); box-shadow: 0 18px 32px rgba(0,0,0,.22); }
      .card-body { padding: 18px; }
      .card h2 { margin: 0 0 8px; font-size: 1.08rem; }
      .price { color: var(--accent); font-weight: 900; margin-top: 12px; }
      footer { max-width: 1180px; margin: 56px auto 0; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: .9rem; }
      @media (max-width: 820px) {
        nav { display: none; }
        .hero, .cars { grid-template-columns: 1fr; }
        .metric { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand"><span class="mark">S</span><span>${escapedTitle}</span></div>
        <nav><a>Inicio</a><a>Catalogo</a><a>Contacto</a></nav>
      </header>
      <main>
        <section class="hero">
          <div>
            <span class="eyebrow">SiraGPT Apps · Preview listo</span>
            <h1>${escapedTitle}</h1>
            <p>Una experiencia web minimalista, rapida y enfocada en conversion. Catalogo claro, propuesta directa y contacto visible desde el primer vistazo.</p>
            <div class="actions">
              <a class="btn primary" href="#contacto">Contactar ahora</a>
              <a class="btn" href="#catalogo">Ver catalogo</a>
            </div>
          </div>
          <aside class="panel" aria-label="Resumen">
            <div class="panel-top"><span>Preview en vivo</span><span>Vite</span></div>
            <p style="color:#d7d9de">Este proyecto fue generado desde el chat de APPS y esta listo para iterar con nuevas instrucciones.</p>
            <div class="metric">
              <div><strong>3</strong><span>Opciones destacadas</span></div>
              <div><strong>24h</strong><span>Respuesta comercial</span></div>
              <div><strong>#FF0000</strong><span>Acento visual</span></div>
            </div>
          </aside>
        </section>
        <section id="catalogo" class="cars">
          <article class="card"><div class="photo"></div><div class="card-body"><h2>Sedan Ejecutivo</h2><p>Confort, seguridad y eficiencia para uso diario.</p><div class="price">Desde $18,900</div></div></article>
          <article class="card"><div class="photo"></div><div class="card-body"><h2>SUV Familiar</h2><p>Espacio, tecnologia y potencia para cada ruta.</p><div class="price">Desde $27,500</div></div></article>
          <article class="card"><div class="photo"></div><div class="card-body"><h2>Deportivo Premium</h2><p>Diseno agresivo y respuesta inmediata al volante.</p><div class="price">Desde $42,000</div></div></article>
        </section>
        <footer id="contacto">Contacto comercial: ventas@siragpt.com · Respuesta rapida por WhatsApp.</footer>
      </main>
    </div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;
  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.js', content: 'document.querySelectorAll("a[href^=\\"#\\"]").forEach((link) => link.addEventListener("click", (event) => { const target = document.querySelector(link.getAttribute("href")); if (target) { event.preventDefault(); target.scrollIntoView({ behavior: "smooth", block: "start" }); } }));\n' },
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
    'El workspace ya viene provisionado con un starter Vite mínimo: package.json, index.html y src/main.js.',
    'Para landings, demos o apps simples, NO inicialices frameworks ni ejecutes scaffolds interactivos como create-next-app/create-vite; sobrescribe los archivos existentes con write_file/edit_file.',
    'Si necesitas estructura adicional, crea archivos concretos tú mismo. Usa run_command solo para verificar, instalar dependencias declaradas o revisar git.',
    'Nunca dependas de prompts interactivos de terminal; los comandos deben terminar solos.',
    `Proyecto: ${project?.name || 'Codex'}.`,
  ];
  if (forceViteApps) {
    lines.push('Este run viene de /apps. Stack obligatorio para esta solicitud: Vite SPA usando index.html + src/main.js. Ignora cualquier plan que mencione Next.js, TypeScript o Tailwind si el usuario no lo pidió explícitamente.');
    lines.push('No cambies package.json a Next.js. El resultado debe abrir en el preview como /index.html y verse de inmediato.');
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
  const fileTree = deps.fileTree != null ? deps.fileTree : await safeFileTree(runner, projectId);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ project, plan, fileTree, sourcePrompt: run.prompt }) },
    { role: 'user', content: run.prompt || 'Construye el proyecto según el plan aprobado.' },
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

function isStarterIndex(indexText, mainText) {
  return /Workspace listo|codex workspace ready/i.test(`${indexText}\n${mainText}`);
}

async function ensureAppsVitePreviewable({ run, project, runner, eventStore, prisma }) {
  if (!isAppsPrompt(run?.prompt) || explicitlyRequestsNext(run?.prompt)) return { repaired: false };
  const projectId = project?.id || run.projectId;
  const [pkgText, indexText, mainText] = await Promise.all([
    readRunnerFile(runner, projectId, 'package.json'),
    readRunnerFile(runner, projectId, 'index.html'),
    readRunnerFile(runner, projectId, 'src/main.js'),
  ]);
  const needsRepair =
    packageLooksLikeNext(pkgText) ||
    !packageLooksLikeVite(pkgText) ||
    !/<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.js["']/i.test(indexText) ||
    isStarterIndex(indexText, mainText);
  if (!needsRepair) return { repaired: false };

  const files = appsFallbackFiles({ prompt: run.prompt, projectName: project?.name || 'App generada' });
  await runner.writeFiles(projectId, files);
  await eventStore.appendEvent(
    run.id,
    'narrative_delta',
    { text: 'Normalicé el workspace de APPS a Vite para que el preview abra en /index.html sin depender de scaffolds incompletos.' },
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

module.exports = { runAgentLoop, runBuildLoop, buildSystemPrompt, safeFileTree, loadApprovedPlan };
