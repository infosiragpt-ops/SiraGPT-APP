'use strict';

/**
 * codex/verify-loop — the Claude Code-style "verify → read the real errors →
 * fix → re-verify" pass that runs when the build loop finishes, BEFORE the
 * checkpoint (so the fixes land in it).
 *
 * Bounded and best-effort: at most CODEX_VERIFY_ROUNDS verification rounds
 * with CODEX_VERIFY_FIX_STEPS model steps each. TypeScript is always checked;
 * project tests/lint become fail-closed gates only when a matching package
 * script or config exists. Disable the whole pass with CODEX_AUTO_VERIFY=0.
 */

const buildTools = require('./build-tools');
const { localCliCommand } = require('./local-cli');

const DEFAULT_ROUNDS = 2;
const DEFAULT_FIX_STEPS = 4;
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
const MAX_GATE_TIMEOUT_MS = 300_000;
const MAX_STRUCTURED_DIAGNOSTICS = 50;
const FIX_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'install_dependencies'];
const TEST_CONFIG_PATHS = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'jest.config.ts',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs',
];
const LINT_CONFIG_PATHS = [
  'eslint.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

function readPosInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readTimeoutMs(raw, fallback = DEFAULT_GATE_TIMEOUT_MS) {
  return Math.min(MAX_GATE_TIMEOUT_MS, readPosInt(raw, fallback));
}

function enabled(env = process.env) {
  return String(env.CODEX_AUTO_VERIFY ?? '1') !== '0';
}

function gateEnabled(env, name) {
  if (String(env.CODEX_VERIFY_PROJECT_GATES ?? '1') === '0') return false;
  return String(env[name] ?? '1') !== '0';
}

async function readFileContent(runner, projectId, path) {
  try {
    const out = await runner.readFile(projectId, path);
    return typeof out?.content === 'string' ? out.content : null;
  } catch {
    return null;
  }
}

async function fileExists(runner, projectId, path) {
  const content = await readFileContent(runner, projectId, path);
  return Boolean(content && content.trim());
}

async function firstExistingFile(runner, projectId, paths) {
  for (const path of paths) {
    if (await fileExists(runner, projectId, path)) return path;
  }
  return null;
}

function parsePackageJson(raw) {
  try {
    const parsed = JSON.parse(raw || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function usableScript(scripts, name) {
  const value = typeof scripts?.[name] === 'string' ? scripts[name].trim() : '';
  if (!value) return null;
  if (name === 'test' && /no test specified|no tests? configured/i.test(value)) return null;
  return { name, value };
}

function firstUsableScript(scripts, names) {
  for (const name of names) {
    const script = usableScript(scripts, name);
    if (script) return script;
  }
  return null;
}

/**
 * Detect opt-in project gates without guessing. A dependency by itself does
 * not make a gate mandatory: the workspace must expose a script or config.
 */
async function detectProjectGates(runner, projectId, env = process.env) {
  const pkg = parsePackageJson(await readFileContent(runner, projectId, 'package.json'));
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

  const testScript = firstUsableScript(scripts, ['test', 'test:run', 'test:unit']);
  const lintScript = firstUsableScript(scripts, ['lint', 'lint:check']);
  const testConfig = gateEnabled(env, 'CODEX_VERIFY_TESTS')
    ? await firstExistingFile(runner, projectId, TEST_CONFIG_PATHS)
    : null;
  const lintConfig = gateEnabled(env, 'CODEX_VERIFY_LINT')
    ? await firstExistingFile(runner, projectId, LINT_CONFIG_PATHS)
    : null;

  const testsEnabled = gateEnabled(env, 'CODEX_VERIFY_TESTS');
  const lintEnabled = gateEnabled(env, 'CODEX_VERIFY_LINT');
  const usesVitest = Boolean(
    testConfig?.startsWith('vitest.')
    || pkg.vitest
    || /\bvitest\b/i.test(testScript?.value || ''),
  );

  return {
    tests: {
      name: 'tests',
      applies: testsEnabled && Boolean(testScript || testConfig || pkg.vitest || pkg.jest),
      reason: testsEnabled ? (testScript ? `script:${testScript.name}` : testConfig || (pkg.vitest ? 'package:vitest' : pkg.jest ? 'package:jest' : 'not_configured')) : 'disabled',
      command: usesVitest
        ? localCliCommand('vitest', 'run', '--reporter=json')
        : testScript
          ? ['npm', 'run', testScript.name]
          : pkg.jest || testConfig?.startsWith('jest.')
            ? localCliCommand('jest', '--runInBand', '--json')
            : null,
      timeoutMs: readTimeoutMs(env.CODEX_VERIFY_TEST_TIMEOUT_MS || env.CODEX_VERIFY_GATE_TIMEOUT_MS),
    },
    lint: {
      name: 'lint',
      applies: lintEnabled && Boolean(lintScript || lintConfig || pkg.eslintConfig),
      reason: lintEnabled ? (lintScript ? `script:${lintScript.name}` : lintConfig || (pkg.eslintConfig ? 'package:eslintConfig' : 'not_configured')) : 'disabled',
      command: lintScript
        ? ['npm', 'run', lintScript.name]
        : lintConfig || pkg.eslintConfig
          ? localCliCommand('eslint', '.', '--format', 'json')
          : null,
      timeoutMs: readTimeoutMs(env.CODEX_VERIFY_LINT_TIMEOUT_MS || env.CODEX_VERIFY_GATE_TIMEOUT_MS),
    },
  };
}

function jsonFromOutput(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function diagnostic({ gate, file = null, line = null, column = null, severity = 'error', code, message }) {
  return {
    gate,
    file,
    line: line != null && Number.isFinite(Number(line)) ? Number(line) : null,
    column: column != null && Number.isFinite(Number(column)) ? Number(column) : null,
    severity,
    code: code || `${String(gate).toUpperCase()}_FAILED`,
    message: String(message || 'Gate failed').trim().slice(0, 2000),
  };
}

function parseVitestDiagnostics(json) {
  if (!json || !Array.isArray(json.testResults)) return [];
  const found = [];
  for (const suite of json.testResults) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      if (!['failed', 'failure'].includes(String(assertion.status).toLowerCase())) continue;
      const title = [...(assertion.ancestorTitles || []), assertion.title].filter(Boolean).join(' > ');
      const failures = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter(Boolean) : [];
      found.push(diagnostic({
        gate: 'tests',
        file: suite.name || null,
        line: assertion.location?.line,
        column: assertion.location?.column,
        code: 'TEST_FAILURE',
        message: [title, ...failures].filter(Boolean).join('\n') || suite.message || 'Test failed',
      }));
      if (found.length >= MAX_STRUCTURED_DIAGNOSTICS) return found;
    }
    if (assertions.length === 0 && String(suite.status).toLowerCase() === 'failed') {
      found.push(diagnostic({
        gate: 'tests',
        file: suite.name || null,
        code: 'TEST_SUITE_FAILURE',
        message: suite.message || 'Test suite failed',
      }));
    }
    if (found.length >= MAX_STRUCTURED_DIAGNOSTICS) return found;
  }
  return found;
}

function parseEslintDiagnostics(json) {
  if (!Array.isArray(json)) return [];
  const found = [];
  for (const result of json) {
    for (const entry of Array.isArray(result?.messages) ? result.messages : []) {
      if (Number(entry.severity || 0) < 1) continue;
      found.push(diagnostic({
        gate: 'lint',
        file: result.filePath || null,
        line: entry.line,
        column: entry.column,
        severity: Number(entry.severity) >= 2 ? 'error' : 'warning',
        code: entry.ruleId || 'ESLINT',
        message: entry.message,
      }));
      if (found.length >= MAX_STRUCTURED_DIAGNOSTICS) return found;
    }
  }
  return found;
}

function genericDiagnostics(gate, output, exitCode) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const likelyErrors = lines.filter((line) => /error|failed|failure|✖|×/i.test(line));
  const selected = (likelyErrors.length ? likelyErrors : lines).slice(0, MAX_STRUCTURED_DIAGNOSTICS);
  if (selected.length === 0) {
    selected.push(`${gate} exited with code ${exitCode ?? 'unknown'} without diagnostics`);
  }
  return selected.map((message) => diagnostic({
    gate,
    code: `${gate.toUpperCase()}_COMMAND_FAILED`,
    message,
  }));
}

function parseGateDiagnostics(gate, output, exitCode) {
  const json = jsonFromOutput(output);
  const structured = gate === 'tests'
    ? parseVitestDiagnostics(json)
    : parseEslintDiagnostics(json);
  return structured.length ? structured : genericDiagnostics(gate, output, exitCode);
}

async function runProjectGate(runner, projectId, gate) {
  if (!gate?.applies || !Array.isArray(gate.command) || gate.command.length === 0) {
    return { ...gate, ran: false, clean: null, exitCode: null, diagnostics: [], outputSummary: '' };
  }
  try {
    const out = await runner.exec(projectId, gate.command, { timeoutMs: gate.timeoutMs });
    const output = [out?.stdout, out?.stderr].filter(Boolean).join('\n').trim();
    const clean = out?.exitCode === 0;
    return {
      ...gate,
      ran: true,
      clean,
      exitCode: Number.isFinite(Number(out?.exitCode)) ? Number(out.exitCode) : null,
      diagnostics: clean ? [] : parseGateDiagnostics(gate.name, output, out?.exitCode),
      outputSummary: buildTools.summarise(output, 6000),
    };
  } catch (err) {
    return {
      ...gate,
      ran: true,
      clean: false,
      exitCode: null,
      diagnostics: [diagnostic({
        gate: gate.name,
        code: `${gate.name.toUpperCase()}_RUNNER_ERROR`,
        message: err?.message || 'Runner unavailable',
      })],
      outputSummary: buildTools.summarise(err?.message || 'Runner unavailable', 6000),
    };
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

async function runTypeCheck(runner, projectId, env = process.env) {
  // Ensure deps exist before every check. The local TypeScript entrypoint is
  // intentional: bunx runs package CLIs with Bun and fails under the runner's
  // high, project-scoped Linux UIDs. With a lockfile install is a <1s no-op.
  const installTimeoutMs = readTimeoutMs(env.CODEX_VERIFY_INSTALL_TIMEOUT_MS || env.CODEX_VERIFY_GATE_TIMEOUT_MS);
  const typecheckTimeoutMs = readTimeoutMs(env.CODEX_VERIFY_TYPECHECK_TIMEOUT_MS || env.CODEX_VERIFY_GATE_TIMEOUT_MS);
  try {
    await runner.exec(projectId, ['bun', 'install'], { timeoutMs: installTimeoutMs });
  } catch { /* install trouble surfaces through tsc's own output */ }
  const out = await runner.exec(
    projectId,
    localCliCommand('tsc', '--noEmit', '--pretty', 'false'),
    { timeoutMs: typecheckTimeoutMs },
  );
  const diagnostics = [out.stdout, out.stderr].filter(Boolean).join('\n').trim();
  if (out.exitCode !== 0 && /\b(?:spawn(?:Sync)?\s+)?(?:bun|node)\s+ENOENT\b|command not found:\s*(?:bun|node)\b/i.test(diagnostics)) {
    return { clean: null, unavailable: true, diagnostics };
  }
  return { clean: out.exitCode === 0, diagnostics };
}

const FIXER_SYSTEM_PROMPT = [
  'Eres un reparador de gates de calidad trabajando en un workspace React 18 + Vite 7 + TS.',
  'Recibes diagnósticos REALES y estructurados de TypeScript, tests y/o lint. Corrige los errores editando los archivos con las herramientas; no expliques, actúa.',
  'PROHIBIDO añadir "types": ["react", "react-dom"] al tsconfig (causa TS2688; los tipos de React se auto-incluyen). Ante TS2688, ELIMINA esas entradas en vez de añadirlas.',
  'Reglas: arregla la causa raíz (imports rotos, tipos, comportamiento, tests o reglas lint), no borres tests ni silencies errores con `any`/`@ts-ignore` salvo último recurso.',
  'Si el error es "Cannot find module" por una dependencia npm faltante, usa install_dependencies con el nombre exacto del paquete y vuelve a verificar.',
  'Cuando creas que está corregido, deja de llamar herramientas y di brevemente qué cambiaste.',
].join('\n');

/**
 * Preserve the legacy return shape for workspaces without project gates. When
 * tests/lint apply, expose enough structured evidence for the caller/timeline.
 */
function verificationResult({ clean, rounds, fixes, gates }) {
  const base = { ran: true, clean, rounds, fixes };
  const projectGatesApply = Boolean(gates?.tests?.applies || gates?.lint?.applies);
  if (!projectGatesApply) return base;

  const publicGates = {};
  for (const [name, gate] of Object.entries(gates || {})) {
    if (!gate) continue;
    const { rawDiagnostics: _rawDiagnostics, ...safeGate } = gate;
    publicGates[name] = safeGate;
  }
  const failed = Object.values(publicGates).filter((gate) => gate?.applies && gate?.clean === false);
  return {
    ...base,
    gates: publicGates,
    diagnostics: failed.flatMap((gate) => gate.diagnostics || []).slice(0, MAX_STRUCTURED_DIAGNOSTICS),
    blockingGates: failed.map((gate) => gate.name),
  };
}

function skippedGate(gate) {
  return { ...gate, ran: false, clean: null, exitCode: null, diagnostics: [], outputSummary: '' };
}

function failedGatePayload(gates) {
  return Object.values(gates)
    .filter((gate) => gate?.applies && gate?.clean === false)
    .map((gate) => ({
      gate: gate.name,
      command: gate.command,
      exitCode: gate.exitCode,
      diagnostics: gate.diagnostics,
      outputSummary: gate.outputSummary,
    }));
}

/**
 * Verify the workspace compiles, passes configured project gates and, when it
 * doesn't, run a bounded fix loop. Emits narrative + action events on the run
 * timeline. Returns `{ ran, clean, rounds, fixes }` plus `gates`,
 * `diagnostics`, and `blockingGates` when tests/lint apply.
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
    const projectGateDefinitions = await detectProjectGates(runner, projectId, env);
    const configuredProjectGateNames = Object.values(projectGateDefinitions)
      .filter((gate) => gate.applies)
      .map((gate) => gate.name);
    const say = (text) => eventStore.appendEvent(run.id, 'narrative_delta', { text }, { prisma }).catch(() => {});

    let actionCounter = 0;
    let groupCounter = 0;
    let fixes = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      const groupId = `vg${++groupCounter}`;
      const checkActionId = `v${++actionCounter}`;
      await normalizeTsconfig(runner, projectId); // every round — the fixer itself can re-add the bogus types
      await eventStore.appendEvent(run.id, 'action_start', { actionId: checkActionId, kind: 'terminal', command: 'node node_modules/typescript/bin/tsc --noEmit', groupId }, { prisma }).catch(() => {});
      const t0 = clock().getTime();
      let check;
      try {
        const typecheck = await runTypeCheck(runner, projectId, env);
        if (typecheck.unavailable) {
          await eventStore.appendEvent(run.id, 'action_end', {
            actionId: checkActionId,
            status: 'done',
            outputSummary: `type check no disponible: ${buildTools.summarise(typecheck.diagnostics, 1200)}`,
            durationMs: Math.max(0, clock().getTime() - t0),
          }, { prisma }).catch(() => {});
          return { ran: true, clean: null, rounds: round, fixes };
        }
        check = {
          name: 'typecheck',
          applies: true,
          ran: true,
          clean: typecheck.clean,
          command: localCliCommand('tsc', '--noEmit', '--pretty', 'false'),
          timeoutMs: readTimeoutMs(env.CODEX_VERIFY_TYPECHECK_TIMEOUT_MS || env.CODEX_VERIFY_GATE_TIMEOUT_MS),
          exitCode: typecheck.clean ? 0 : 1,
          diagnostics: typecheck.clean ? [] : genericDiagnostics('typecheck', typecheck.diagnostics, 1),
          outputSummary: buildTools.summarise(typecheck.diagnostics, 6000),
          rawDiagnostics: typecheck.diagnostics,
        };
      } catch (err) {
        await eventStore.appendEvent(run.id, 'action_end', { actionId: checkActionId, status: 'done', outputSummary: `type check no disponible: ${err.message}`, durationMs: Math.max(0, clock().getTime() - t0) }, { prisma }).catch(() => {});
        return { ran: true, clean: null, rounds: round, fixes };
      }
      const durationMs = Math.max(0, clock().getTime() - t0);
      await eventStore.appendEvent(run.id, 'action_end', { actionId: checkActionId, status: check.clean ? 'done' : 'error', outputSummary: check.clean ? 'type check limpio' : buildTools.summarise(check.rawDiagnostics, 1500), durationMs }, { prisma }).catch(() => {});
      if (metrics?.recordAction) metrics.recordAction('terminal', durationMs);

      const gates = {
        typecheck: check,
        tests: skippedGate(projectGateDefinitions.tests),
        lint: skippedGate(projectGateDefinitions.lint),
      };

      if (check.clean) {
        for (const gateName of ['tests', 'lint']) {
          const gate = projectGateDefinitions[gateName];
          if (!gate.applies) continue;
          const gateActionId = `v${++actionCounter}`;
          await eventStore.appendEvent(run.id, 'action_start', {
            actionId: gateActionId,
            kind: 'terminal',
            command: gate.command.join(' '),
            groupId,
          }, { prisma }).catch(() => {});
          const gateT0 = clock().getTime();
          const result = await runProjectGate(runner, projectId, gate);
          const gateDurationMs = Math.max(0, clock().getTime() - gateT0);
          gates[gateName] = result;
          await eventStore.appendEvent(run.id, 'action_end', {
            actionId: gateActionId,
            status: result.clean ? 'done' : 'error',
            outputSummary: result.clean ? `${gateName} limpio` : buildTools.summarise(result.outputSummary || result.diagnostics?.map((item) => item.message).join('\n'), 1500),
            durationMs: gateDurationMs,
          }, { prisma }).catch(() => {});
          if (metrics?.recordAction) metrics.recordAction('terminal', gateDurationMs);
        }
      }

      const failures = failedGatePayload(gates);
      if (failures.length === 0) {
        const gateLabel = configuredProjectGateNames.length
          ? `TypeScript y ${configuredProjectGateNames.join(' + ')}`
          : 'TypeScript';
        await say(round === 1
          ? `Verifiqué el proyecto con ${gateLabel}: todos los gates aplicables pasaron.`
          : `Re-verifiqué el proyecto: los errores quedaron corregidos y ${gateLabel} pasa limpio.`);
        return verificationResult({ clean: true, rounds: round, fixes, gates });
      }

      if (round === maxRounds) {
        const names = failures.map((failure) => failure.gate).join(', ');
        await say(`El proyecto aún tiene errores en los gates ${names} tras la auto-reparación; dejo diagnósticos estructurados en la línea de tiempo.`);
        return verificationResult({ clean: false, rounds: round, fixes, gates });
      }

      await say(`La verificación encontró errores en ${failures.map((failure) => failure.gate).join(', ')}; los corrijo antes de cerrar.`);

      // Bounded fix mini-loop with fresh, focused context.
      const registry = buildTools.toolRegistry(FIX_TOOLS);
      const messages = [
        { role: 'system', content: FIXER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Gates fallidos (JSON estructurado):\n${buildTools.summarise(JSON.stringify(failures, null, 2), 9000)}`,
        },
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

module.exports = {
  autoVerifyAndHeal,
  enabled,
  runTypeCheck,
  normalizeTsconfig,
  detectProjectGates,
  runProjectGate,
  parseGateDiagnostics,
  DEFAULT_ROUNDS,
  DEFAULT_FIX_STEPS,
  DEFAULT_GATE_TIMEOUT_MS,
  FIX_TOOLS,
  FIXER_SYSTEM_PROMPT,
};
