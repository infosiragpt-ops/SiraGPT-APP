'use strict';

/**
 * codex/verify-loop — the Claude Code-style "verify → read the real errors →
 * fix → re-verify" pass that runs when the build loop finishes, BEFORE the
 * checkpoint (so the fixes land in it).
 *
 * Bounded and best-effort: at most CODEX_VERIFY_ROUNDS type-check rounds with
 * CODEX_VERIFY_FIX_STEPS model steps each; any internal failure degrades to a
 * no-op — a verification problem must never turn a successful build into an
 * error. Disable with CODEX_AUTO_VERIFY=0.
 */

const buildTools = require('./build-tools');

const DEFAULT_ROUNDS = 2;
const DEFAULT_FIX_STEPS = 4;
const FIX_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files'];

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function enabled(env = process.env) {
  return String(env.CODEX_AUTO_VERIFY ?? '1') !== '0';
}

async function fileExists(runner, projectId, path) {
  try {
    const out = await runner.readFile(projectId, path);
    return Boolean(out && typeof out.content === 'string' && out.content.trim());
  } catch {
    return false;
  }
}

/**
 * Deterministic tsconfig repair before type-checking. Models sometimes
 * overwrite the starter tsconfig adding `"types": ["react", "react-dom"]`
 * — redundant (React types auto-include via jsx + include:src) and fragile:
 * it fires TS2688 whenever @types resolution hiccups, which the fixer then
 * burns rounds on (cycle-14 CRM run). Strip exactly those entries; keep
 * anything else (e.g. "vite/client") untouched. Best-effort by contract.
 */
async function normalizeTsconfig(runner, projectId) {
  try {
    const read = await runner.readFile(projectId, 'tsconfig.json');
    const raw = typeof read?.content === 'string' ? read.content : '';
    if (!raw.trim()) return false;
    const cfg = JSON.parse(raw);
    const types = cfg?.compilerOptions?.types;
    if (!Array.isArray(types)) return false;
    const cleaned = types.filter((t) => !['react', 'react-dom'].includes(String(t)));
    if (cleaned.length === types.length) return false;
    if (cleaned.length) cfg.compilerOptions.types = cleaned;
    else delete cfg.compilerOptions.types;
    await runner.writeFiles(projectId, [{ path: 'tsconfig.json', content: `${JSON.stringify(cfg, null, 2)}\n` }]);
    return true;
  } catch {
    return false; // unparseable/custom tsconfig → leave it to the fixer
  }
}

async function runTypeCheck(runner, projectId) {
  const out = await runner.exec(projectId, ['bunx', 'tsc', '--noEmit', '--pretty', 'false'], { timeoutMs: 120000 });
  const diagnostics = [out.stdout, out.stderr].filter(Boolean).join('\n').trim();
  return { clean: out.exitCode === 0, diagnostics };
}

const FIXER_SYSTEM_PROMPT = [
  'Eres un reparador de errores de compilación TypeScript trabajando en un workspace React 18 + Vite 7 + TS.',
  'Recibes la salida REAL de `tsc --noEmit`. Corrige los errores editando los archivos con las herramientas; no expliques, actúa.',
  'PROHIBIDO añadir "types": ["react", "react-dom"] al tsconfig (causa TS2688; los tipos de React se auto-incluyen). Ante TS2688, ELIMINA esas entradas en vez de añadirlas.',
  'Reglas: arregla la causa raíz (imports rotos, tipos mal declarados, props faltantes), no silencies errores con `any`/`@ts-ignore` salvo último recurso.',
  'Cuando creas que está corregido, deja de llamar herramientas y di brevemente qué cambiaste.',
].join('\n');

/**
 * Verify the workspace compiles and, when it doesn't, run a bounded fix loop.
 * Emits narrative + action events on the run timeline. Returns
 * `{ ran, clean, rounds, fixes }` (ran=false when skipped).
 */
async function autoVerifyAndHeal({ run, projectId, runner, eventStore, prisma, llmTurn, env = process.env, metrics, clock = () => new Date() }) {
  try {
    if (!enabled(env) || !runner || typeof runner.exec !== 'function' || !llmTurn) return { ran: false, clean: null, rounds: 0, fixes: 0 };
    // Only meaningful for TS projects with a manifest (the APPS starter always has both).
    if (!(await fileExists(runner, projectId, 'package.json')) || !(await fileExists(runner, projectId, 'tsconfig.json'))) {
      return { ran: false, clean: null, rounds: 0, fixes: 0 };
    }

    const maxRounds = readPosInt(env.CODEX_VERIFY_ROUNDS, DEFAULT_ROUNDS);
    const maxFixSteps = readPosInt(env.CODEX_VERIFY_FIX_STEPS, DEFAULT_FIX_STEPS);
    const say = (text) => eventStore.appendEvent(run.id, 'narrative_delta', { text }, { prisma }).catch(() => {});

    let actionCounter = 0;
    let groupCounter = 0;
    let fixes = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      const groupId = `vg${++groupCounter}`;
      const checkActionId = `v${++actionCounter}`;
      await normalizeTsconfig(runner, projectId); // every round — the fixer itself can re-add the bogus types
      await eventStore.appendEvent(run.id, 'action_start', { actionId: checkActionId, kind: 'terminal', command: 'bunx tsc --noEmit', groupId }, { prisma }).catch(() => {});
      const t0 = clock().getTime();
      let check;
      try {
        check = await runTypeCheck(runner, projectId);
      } catch (err) {
        await eventStore.appendEvent(run.id, 'action_end', { actionId: checkActionId, status: 'done', outputSummary: `type check no disponible: ${err.message}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
        return { ran: true, clean: null, rounds: round, fixes };
      }
      const durationMs = Math.max(0, clock().getTime() - t0);
      await eventStore.appendEvent(run.id, 'action_end', { actionId: checkActionId, status: check.clean ? 'done' : 'error', outputSummary: check.clean ? 'type check limpio' : buildTools.summarise(check.diagnostics, 1500), durationMs }, { prisma }).catch(() => {});
      if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);

      if (check.clean) {
        await say(round === 1 ? 'Verifiqué el proyecto con TypeScript: compila sin errores.' : 'Re-verifiqué el proyecto: los errores quedaron corregidos y compila limpio.');
        return { ran: true, clean: true, rounds: round, fixes };
      }
      if (round === maxRounds) {
        await say('El proyecto aún tiene errores de TypeScript tras la auto-reparación; dejo el detalle en la línea de tiempo.');
        return { ran: true, clean: false, rounds: round, fixes };
      }

      await say('La verificación encontró errores de TypeScript; los corrijo antes de cerrar.');

      // Bounded fix mini-loop with fresh, focused context.
      const registry = buildTools.toolRegistry(FIX_TOOLS);
      const messages = [
        { role: 'system', content: FIXER_SYSTEM_PROMPT },
        { role: 'user', content: `Salida de \`tsc --noEmit\`:\n${buildTools.summarise(check.diagnostics, 6000)}` },
      ];
      for (let step = 0; step < maxFixSteps; step += 1) {
        let turn;
        try {
          turn = await llmTurn({ messages, tools: registry, env });
        } catch {
          break; // provider hiccup — the next round's re-check reports honestly
        }
        if (turn?.usage && metrics?.recordLlmUsage) metrics.recordLlmUsage(turn.usage);
        if (turn?.text && turn.text.trim()) messages.push({ role: 'assistant', content: turn.text.trim() });

        const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls.slice(0, 4) : [];
        if (calls.length === 0) break;
        for (const call of calls) {
          const tool = FIX_TOOLS.includes(call.name) ? buildTools.getTool(call.name) : null;
          if (!tool) {
            messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] Error: herramienta no disponible en la fase de reparación.` });
            continue;
          }
          const actionId = `v${++actionCounter}`;
          await eventStore.appendEvent(run.id, 'action_start', { actionId, kind: tool.kind, command: tool.commandFor(call.args) || undefined, path: tool.pathFor(call.args) || undefined, groupId }, { prisma }).catch(() => {});
          const f0 = clock().getTime();
          const result = await tool.execute(call.args, { runner, project: projectId });
          const fMs = Math.max(0, clock().getTime() - f0);
          await eventStore.appendEvent(run.id, 'action_end', { actionId, status: result.isError ? 'error' : 'done', outputSummary: buildTools.summarise(result.summary || '', 800), durationMs: fMs }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction(tool.kind, fMs);
          if (!result.isError && tool.kind === 'file_write') fixes += 1;
          messages.push({ role: 'user', content: `[TOOL_RESULT ${call.name}] ${result.observation || result.summary || ''}` });
        }
      }
    }
    return { ran: true, clean: false, rounds: maxRounds, fixes };
  } catch (err) {
    if (env?.NODE_ENV !== 'test') console.warn('[codex verify-loop] skipped:', err?.message || err);
    return { ran: false, clean: null, rounds: 0, fixes: 0 };
  }
}

module.exports = { autoVerifyAndHeal, enabled, runTypeCheck, normalizeTsconfig, DEFAULT_ROUNDS, DEFAULT_FIX_STEPS, FIX_TOOLS, FIXER_SYSTEM_PROMPT };
