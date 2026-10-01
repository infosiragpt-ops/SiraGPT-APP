'use strict';

const { normalize, detectCodingIntent, isSoftwareBuildRequest } = require('../agents/software-build-intent');
const { extractClaims } = require('../agents/completion-claim-verifier');
const { _internal: { sanitizeRelPath } } = require('../agents/project-workspace-tools');
const { ENTRYPOINTS } = require('./local-cli');

const CHANGE = /\b(?:crea(?:r|me)?|genera(?:r|me)?|construye|implementa|corrige|corregir|arregla|repara|edita|modifica|cambia|actualiza|anade|agrega|quita|elimina|refactoriza|optimiza|pon|ponle|conecta|integra|create|build|make|fix|edit|modify|change|update|add|remove|refactor)\b/;
const REVIEW = /\b(?:revisa|verifica|analiza|inspecciona|review|inspect|explain|explica)\b/;
const WEB = /\b(?:web|website|frontend|html|react|vite|next|tienda|ecommerce|carrito|pagina|app|aplicacion)\b/;
const PREVIEW = /\b(?:preview|vista previa|en local|navegador)\b/;
const TESTS = /\b(?:tests?|pruebas|pytest|vitest|jest|unittest)\b/;
const BUILD = /\b(?:compila|compilar|compilacion|build)\b/;
const TYPES = /\b(?:typecheck|tipos|tsc|typescript)\b/;
const PR = /\b(?:pr|pull request)\b/;
const PR_ACTION = /\b(?:abre|abrir|crea|crear|creame|publica|sube|open|create)\b/;

function failure(code, message, missingTools = []) {
  return { ok: false, code, message, missingTools, allowUnverifiedDraft: false,
    repairInstructions: message + ' Conserva el mismo proyecto. No declares éxito ni inventes evidencia; si no puedes comprobarlo, informa el bloqueo.' };
}

function taskContract(query) {
  const text = normalize(String(query || '').replace(/```[\s\S]*?```/g, ' '))
    .replace(/\bno (?:crees|hagas|construyas) (?:otro|un nuevo) proyecto\b/g, ' ');
  // File names and paths (app.js, src/app/config) are not requests to deliver
  // a web application. Keep actual surrounding words such as 'web' or 'app'.
  const webText = text.replace(/(?:[\w@.-]*[\\/])+[\w@.-]+(?::\d+){0,2}|\b[\w@-]+\.[a-z\d]+(?::\d+){0,2}\b/gi, ' ');
  const intent = detectCodingIntent(query, { hasWorkspace: true });
  const pr = PR.test(text) && PR_ACTION.test(text);
  const previewOnly = PREVIEW.test(text) && !CHANGE.test(text);
  const checksOnly = !CHANGE.test(text) && (TESTS.test(text) || BUILD.test(text) || /\b(?:ejecuta|run|comprueba)\b/.test(text));
  const changeText = text.replace(/\b(?:crea(?:r|me)?|create|build) (?:un |el |a |the )?(?:pr|pull request)\b/g, '').replace(/\b(?:run|ejecuta) (?:el |the )?build\b/g, '');
  const mutation = CHANGE.test(changeText) || isSoftwareBuildRequest(query)
    || (!previewOnly && !checksOnly && !REVIEW.test(text) && !pr && ['create', 'edit', 'followup'].includes(intent.kind));
  return { mutation, review: !mutation && !previewOnly && !checksOnly && !pr,
    preview: previewOnly || (mutation && WEB.test(webText)),
    tests: TESTS.test(text), build: BUILD.test(text) && !/^build (?:a|an|me)\b/.test(text),
    types: /\b(?:typecheck|tipos|tsc)\b/.test(text), pr };
}

function argsOf(action) {
  const args = typeof action.args === 'string' ? JSON.parse(action.args || '{}') : action.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_args');
  return args;
}

function positiveObservation(obs) { return obs && typeof obs === 'object' && obs.ok === true && !obs.error; }
function fullRead(action) {
  const obs = action.observation;
  return positiveObservation(obs) && typeof obs.content === 'string'
    && !obs.cached_result && obs.truncated === false && obs.offset === 0 && sanitizeRelPath(obs.path) === action.args.path;
}

// Recognize actual executable entrypoints, not an echoed command or a shell
// wrapper which can mask failures with `|| true`. Output still needs proof.
function commandKind(cmd) {
  if (!Array.isArray(cmd) || !cmd.length || cmd.some(part => typeof part !== 'string')) return null;
  if (cmd.some(part => /^(?:--help|-h|--version|-v|--showConfig|--listFilesOnly|--init|--all|--clean)$/.test(part))) return null;
  let name = cmd[0].split('/').pop();
  let parts = cmd.slice(1);
  if (name === 'node' && Object.values(ENTRYPOINTS).includes(parts[0])) {
    name = Object.keys(ENTRYPOINTS).find(key => ENTRYPOINTS[key] === parts[0]); parts = parts.slice(1);
  } else if (['npx', 'bunx'].includes(name)) { name = parts[0]; parts = parts.slice(1); }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const script = parts[0] === 'run' ? parts[1] : parts[0];
    if (/^test(?::|$)/.test(script || '')) return 'tests';
    if (/^build(?::|$)/.test(script || '')) return 'build';
    if (/^(?:typecheck|check:types|tsc)$/.test(script || '')) return 'types';
    if (/^lint(?::|$)/.test(script || '')) return 'lint';
    return null;
  }
  if (name === 'node' && parts.includes('--test')) return 'tests';
  if (name === 'node' && (parts.includes('--check') || parts.includes('-c')) && parts.some(part => /\.[cm]?js$/.test(part))) return 'syntax';
  if (name === 'tsc') return 'types';
  if (['jest', 'vitest', 'pytest'].includes(name) || (name === 'playwright' && parts[0] === 'test')) return 'tests';
  if (/^python(?:3(?:\.\d+)?)?$/.test(name) && parts[0] === '-m' && ['pytest', 'unittest'].includes(parts[1])) return 'tests';
  if (['go', 'cargo', 'dotnet', 'swift'].includes(name) && parts[0] === 'test') return 'tests';
  if (['go', 'cargo', 'dotnet', 'swift', 'vite', 'next'].includes(name) && parts[0] === 'build') return 'build';
  if (name === 'eslint') return 'lint';
  return null;
}

function checkScope(cmd) {
  // Keep explicit test targets/name filters distinct. A passing unrelated
  // suite cannot erase an earlier failed one; reporter-only changes can.
  const scope = [];
  for (let i = 1; i < cmd.length; i++) {
    const part = cmd[i];
    if (/^--(?:test-)?reporter=/.test(part)) continue;
    if (/^--(?:test-)?reporter$/.test(part)) { i += 1; continue; }
    if (['--test', 'test', 'run', 'jest', 'vitest', 'pytest'].includes(part) || Object.values(ENTRYPOINTS).includes(part)) continue;
    scope.push(part);
  }
  return `${commandKind(cmd)}:${JSON.stringify(scope)}`;
}

function testSummary(output) {
  if (/(?:^|\n)\s*[#ℹ]?\s*(?:fail|failed|failures)\s*[:=]?\s*[1-9]\d*\b|\b[1-9]\d* (?:fail(?:ed)?|errors?)\b|(?:^|\n)\s*not ok \d/i.test(output)) return false;
  try {
    const json = JSON.parse(output.trim());
    if (json.success === true && Number(json.numPassedTests) > 0 && json.numFailedTests === 0
      && json.numFailedTestSuites === 0) return true;
  } catch (_) { /* human-readable runner reports below */ }
  // Bun's native runner reports "4 pass / 0 fail" and a completed run.
  // Require both counters and the run summary; a banner is not test proof.
  const bunPass = /^\s*(\d+) pass\s*$/im.exec(output);
  const bunFail = /^\s*(\d+) fail\s*$/im.exec(output);
  if (bunPass || bunFail) return Boolean(bunPass && bunFail && Number(bunPass[1]) > 0
    && Number(bunFail[1]) === 0 && /\bRan [1-9]\d* tests? across [1-9]\d* files?\./i.test(output));
  const fail = /(?:^|\n)\s*[#ℹ]?\s*(?:fail|failed|failures)\s*[:=]?\s*(\d+)\b/im.exec(output);
  const pass = /(?:^|\n)\s*[#ℹ]?\s*pass\s*[:=]?\s*(\d+)\b/im.exec(output);
  if (pass && fail) return Number(pass[1]) > 0 && Number(fail[1]) === 0;
  // Jest/Vitest/pytest/Playwright print positive counts, never merely "passed".
  return /\b[1-9]\d* passed\b/i.test(output) && !/\b[1-9]\d* (?:failed|errors?)\b|\bFAIL(?:ED)?\b|not ok \d|no tests?(?: were)? (?:found|ran)/i.test(output);
}

function checkedExecution(action, actions) {
  let cmd = action.args.cmd;
  // `bun test` invokes Bun's test runner directly; `bun run test` is a package script.
  const nativeBunTest = cmd?.[0] === 'bun' && cmd[1] === 'test';
  if (!nativeBunTest && ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd?.[0])) {
    // A script name or echoed banner proves nothing. Resolve the exact script
    // from a fresh package.json observation/write before allowing its result.
    const previous = actions.filter(item => item.index < action.index);
    const snapshot = previous.filter(item => item.args.path === 'package.json' && (fullRead(item)
      || (item.tool === 'project_write' && positiveObservation(item.observation) && typeof item.args.content === 'string'))).at(-1);
    if (!snapshot || previous.some(item => item.index > snapshot.index && item.tool === 'project_exec')) return false;
    try {
      const pkg = JSON.parse(snapshot.tool === 'project_read' ? snapshot.observation.content : snapshot.args.content);
      const script = pkg.scripts?.[cmd[1] === 'run' ? cmd[2] : cmd[1]];
      if (typeof script !== 'string' || /[;&|`$<>]/.test(script)) return false;
      const resolved = script.trim().split(/\s+/);
      if (!commandKind(resolved) || commandKind(resolved) !== commandKind(cmd)) return false;
      cmd = resolved;
    } catch (_) { return false; }
  }
  const obs = action.observation;
  if (!positiveObservation(obs) || obs.exitCode !== 0 || obs.timedOut === true || obs.truncated === true) return false;
  const output = [obs.stdout, obs.stderr].filter(value => typeof value === 'string').join('\n');
  const kind = commandKind(cmd);
  if (kind === 'tests') return testSummary(output);
  // Silent success is valid for the actual compiler/syntax checker, but not
  // an arbitrary package script called "typecheck" or an empty tool result.
  if (kind === 'types' || kind === 'syntax') {
    const direct = cmd[0].split('/').pop() === 'tsc' || cmd.includes(ENTRYPOINTS.tsc)
      || (['npx', 'bunx'].includes(cmd[0]) && cmd[1] === 'tsc') || kind === 'syntax';
    return direct;
  }
  if (kind === 'build') return /built in|compiled successfully|build (?:succeeded|successful)|finished .*(?:target|profile)|✓.*built/i.test(output)
    && !/compilation failed|build failed|error TS\d+/i.test(output);
  if (kind === 'lint') return output.trim() === '[]' || /0 errors?\b/i.test(output);
  return false;
}

/** Pure completion contract for the server-authorized, project-scoped tool
 * lane. This verifies recorded work, not arbitrary functional correctness or
 * preservation of application data. It never sends another model request. */
function createCodingFinalizeGuard({ userQuery, projectId, userId, chatId }) {
  const contract = taskContract(userQuery);
  return ({ answer, steps, ctx, onCheckStart }) => {
    if (ctx?.signal?.aborted) return failure('E_CANCELLED', 'La comprobación del proyecto fue cancelada.');
    onCheckStart?.();
    if (!projectId || !userId || !chatId || ctx?.codingWorkspace?.projectId !== projectId
      || ctx?.userId !== userId || ctx?.chatId !== chatId) return failure('E_CODING_SCOPE', 'No se pudo comprobar la identidad del proyecto de este chat.');
    if (!String(answer || '').trim()) return failure('E_CODING_ANSWER', 'Describe el resultado comprobado antes de finalizar.');
    let actions;
    try {
      if (!Array.isArray(steps)) throw new Error('invalid_steps');
      actions = [];
      for (const step of steps) {
        if (!Array.isArray(step?.actions)) throw new Error('invalid_actions');
        for (const action of step.actions) {
          if (!action || typeof action.tool !== 'string') throw new Error('invalid_action');
          if (!action.tool.startsWith('project_')) continue;
          const args = argsOf(action);
          const obs = action.observation;
          if (!obs || typeof obs !== 'object' || Array.isArray(obs)) throw new Error('missing_observation');
          const identities = [args.projectId, obs.projectId, obs.project?.id, obs.status?.projectId].filter(id => id != null);
          if (identities.some(id => String(id) !== String(projectId))) return failure('E_CODING_SCOPE', 'La evidencia incluye otro proyecto. Vuelve a comprobar el proyecto de este chat.');
          actions.push({ ...action, args, index: actions.length });
        }
      }
    } catch (_) { return failure('E_CODING_EVIDENCE', 'Faltan resultados estructurados de las herramientas del proyecto.'); }
    if (!actions.length) return failure('E_CODING_EVIDENCE', 'Inspecciona los archivos reales del proyecto antes de finalizar.', ['project_read']);
    const writes = new Map();
    const failed = new Map();
    let lastWrite = -1, lastExec = -1, exploratoryFailure = -1, preview = null, pullRequest = null;
    const reads = [], checks = [];
    for (const action of actions) {
      const { tool, args, observation: obs, index } = action;
      if (tool === 'project_write') {
        lastWrite = index;
        const path = sanitizeRelPath(args.path);
        const valid = path && positiveObservation(obs) && obs.path === path && typeof args.content === 'string'
          && obs.bytes === Buffer.byteLength(args.content, 'utf8');
        if (!valid) { failed.set(`write:${path || ''}`, 'Una escritura no está confirmada. Repite y verifica el archivo.'); continue; }
        failed.delete(`write:${path}`); writes.set(path, action); lastWrite = index;
      }
      if (tool === 'project_read' && fullRead(action)) reads.push(action);
      if (tool === 'project_exec') {
        lastExec = index;
        const cmd = args.cmd;
        const kind = commandKind(cmd);
        const key = `check:${Array.isArray(cmd) ? checkScope(cmd) : kind}`;
        const executable = ['node', 'npm', 'bun', 'bunx', 'npx'].includes(cmd?.[0]) ? cmd[0] : 'el comprobador';
        // Only the tool's explicit pre-spawn rejection is recoverable across
        // commands. It never clears a prior actual failure of the same check.
        const rejectedBeforeExecution = obs.ok === false && obs.code === 'command_rejected'
          && obs.executionStarted === false && !obs.error
          && !['exitCode', 'stdout', 'stderr', 'timedOut', 'truncated', 'durationMs'].some(key => Object.hasOwn(obs, key));
        if (rejectedBeforeExecution) {
          exploratoryFailure = index;
        } else if (!Array.isArray(cmd) || !positiveObservation(obs) || obs.exitCode !== 0 || obs.timedOut === true || obs.truncated === true) {
          if (kind) failed.set(key, `La comprobación ${kind} con ${executable} falló o quedó incompleta. Corrige y vuelve a comprobar ese mismo tipo de validación.`);
          else exploratoryFailure = index;
        } else if (kind) {
          if (checkedExecution(action, actions)) { failed.delete(key); checks.push(action); }
          else failed.set(key, `El comando ${kind} con ${executable} no confirmó una comprobación válida. Usa un reporte real de pruebas con casos ejecutados o el compilador directo. Para un script npm/pnpm/yarn/bun, relee package.json completo inmediatamente antes del script; no basta su nombre ni un banner. Si el script encadena comandos, ejecuta cada comprobador directamente y revisa sus resultados.`);
        }
      }
      if (['project_preview_start', 'project_preview_status', 'project_preview_stop'].includes(tool)) preview = action;
      if (tool === 'project_open_pull_request') pullRequest = action;
    }
    if (failed.size) return failure('E_CODING_CHECK_FAILED', [...failed.values()][0], ['project_exec']);
    const text = normalize(answer);
    const claims = extractClaims(answer);
    const wroteClaim = claims.some(claim => ['file_created', 'doc_edited'].includes(claim.kind));
    if (contract.mutation || wroteClaim) {
      if (!writes.size) return failure('E_CODING_WRITE_REQUIRED', 'Guarda los cambios solicitados con project_write y comprueba el archivo real.', ['project_write']);
      const unverified = [...writes.entries()].filter(([path, written]) => !reads.some(read => read.index > Math.max(written.index, lastExec)
        && read.observation.path === path && read.observation.content === written.args.content)).map(([path]) => path);
      if (unverified.length) return failure('E_CODING_READBACK_REQUIRED', `Después de los comandos, relee completos y comprueba estos archivos: ${unverified.slice(0, 10).join(', ')}. No basta un prefijo ni el diff contra la rama base.`, ['project_read']);
    } else if (contract.review && !reads.some(read => read.observation.content.trim())) {
      return failure('E_CODING_READ_REQUIRED', 'Lee el contenido completo de al menos un archivo relevante; listar nombres no comprueba el código.', ['project_read']);
    }
    const fresh = checks.filter(check => check.index > lastWrite);
    if ((contract.mutation || wroteClaim || exploratoryFailure >= 0) && !fresh.some(check => check.index > exploratoryFailure)) {
      return failure('E_CODING_CHECK_REQUIRED', 'Ejecuta una comprobación real posterior a los cambios y a cualquier comando fallido. Una vista previa no sustituye los tests ni el compilador.', ['project_exec']);
    }
    const testClaim = /\b(?:pasaron|paso|passed|ejecute|executed|ran|correctas|superadas)\b.{0,70}\b(?:tests?|pruebas?)\b|\b(?:tests?|pruebas?)\b.{0,40}\b(?:pasaron|paso|passed|correctas|superadas)\b/.test(text);
    const required = [];
    if (contract.tests || testClaim) required.push('tests');
    if (contract.build || /\b(?:compilado|compilada|compiled|build exitoso|build correcto)\b/.test(text)) required.push('build');
    if (contract.types || (TYPES.test(text) && /\b(?:sin errores|paso|correcto|passed)\b/.test(text))) required.push('types');
    for (const kind of required) {
      if (!fresh.some(check => commandKind(check.args.cmd) === kind)) {
        return failure('E_CODING_CHECK_REQUIRED', `Falta una comprobación ${kind} satisfactoria posterior a la última escritura. Ejecuta el comando pertinente y revisa su resultado real.`, ['project_exec']);
      }
    }
    if (claims.some(claim => claim.kind === 'code_executed') && !fresh.length) return failure('E_CODING_CHECK_REQUIRED', 'La respuesta afirma comprobaciones sin una ejecución verificada posterior a los cambios.', ['project_exec']);
    const previewClaim = /\b(?:vista previa|preview)\b.{0,60}\b(?:list[oa]|disponible|ready|funcionando)\b/.test(text);
    if (contract.preview || previewClaim) {
      const obs = preview?.observation;
      if (!preview || preview.tool === 'project_preview_stop' || preview.index < Math.max(lastWrite, lastExec)
        || !positiveObservation(obs) || obs.project?.id !== projectId || obs.status?.ready !== true || obs.status?.running !== true
        || obs.status?.error || typeof obs.previewUrl !== 'string' || !obs.previewUrl.trim()) {
        return failure('E_CODING_PREVIEW_REQUIRED', 'Consulta la vista previa del mismo proyecto después de los cambios y comandos. Debe estar ejecutándose y lista.', ['project_preview_status']);
      }
    }
    const prClaim = /\b(?:abri|creado|creada|cree|opened|created)\b.{0,70}\b(?:pr|pull request)\b/.test(text) || /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.test(answer);
    if (contract.pr || prClaim) {
      const obs = pullRequest?.observation;
      if (!pullRequest || !positiveObservation(obs) || obs.project?.id !== projectId || !obs.commitSha || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(obs.prUrl || '')
        || pullRequest.index < Math.max(lastWrite, lastExec)) return failure('E_CODING_PR_REQUIRED', 'Falta el resultado confirmado del PR del mismo proyecto. No inventes una URL ni lo des por publicado.', ['project_open_pull_request']);
      const urls = String(answer).match(/https?:\/\/github\.com\/[^\s/)]+\/[^\s/]+\/pull\/\d+/g) || [];
      if (urls.some(url => url !== obs.prUrl)) return failure('E_CODING_PR_REQUIRED', 'Comparte únicamente la URL del PR confirmada por la herramienta.');
    }
    const affirmative = text.replace(/\b(?:no|not|never|sin)\s+(?:(?:he|se ha|haber|ha sido|have|been)\s+)?(?:desplegue|desplegado|desplegada|publique|publicado|publicada|deployed|published|merged|fusione|fusionado)\b/g, '');
    const deploy = /\b(?:desplegue|desplegado|desplegada|deployed|merged|fusione|fusionado)\b/.test(affirmative)
      || affirmative.split(/[.!?;\n]+/).some(clause => /\b(?:publique|publicado|publicada|published)\b/.test(clause)
        && !(pullRequest && positiveObservation(pullRequest.observation) && PR.test(clause)
          && !/\b(?:produccion|production|tambien|also)\b/.test(clause)));
    if (deploy) return failure('E_CODING_DEPLOY_UNVERIFIED', 'Las herramientas de este chat verifican archivos, pruebas, vista previa y PR; no acreditan un despliegue ni una fusión en producción.');
    return { ok: true };
  };
}

module.exports = { createCodingFinalizeGuard, taskContract, commandKind, testSummary };
