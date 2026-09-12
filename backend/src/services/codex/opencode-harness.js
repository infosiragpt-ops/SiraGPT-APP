'use strict';

/**
 * codex/opencode-harness — fusión del arnés de OpenCode en el backend Codex.
 *
 * PROVENIENCIA (MIT, con atribución — NO es copia literal):
 *   Upstream: https://github.com/sst/opencode (MIT License, © SST Inc.)
 *   Referencia vendoreada solo-lectura: `vendor/opencode/` (ver `vendor/opencode/LICENSE`).
 *   Referencia conceptual (contratos portados, sin Effect-TS):
 *     - packages/opencode/src/tool/registry.ts   → catálogo + filtrado por agente/permiso
 *     - packages/opencode/src/permission/index.ts → evaluate ask/allow/deny (findLast gana)
 *     - packages/opencode/src/tool/read.ts        → límites read (offset/limit, 50KB, anti-binario)
 *     - packages/opencode/src/tool/{write,edit,glob,grep,shell,task,todo,webfetch,websearch,skill,plan}.ts
 *   El código Effect (`Effect.gen`, Layers, `Context.Service`) NO se copió: no corre
 *   en este backend CommonJS sin nuevas dependencias. Se portaron los CONTRATOS
 *   (schemas, semántica de permisos, catálogo) sobre el runner/Codex existentes.
 *
 * Qué resuelve para la UI canónica `/agentes` (AGENTS.md §1, §18: cero diff visual):
 *   1. Programar 100% desde la web: el loop Codex ya ejecuta read/write/edit/
 *      exec vía runner; este módulo expone el catálogo estilo-OpenCode que
 *      `/agentes` consume vía `build-tools.js`. Sin controles nuevos.
 *   2. Clonar desde la web: `parsePublicGithubRepo` + `clonePublicRepo` clonan
 *      un repo github.com HTTPS en el workspace del runner (fetch --depth=1),
 *      sin allowlist de operador (el allowlist sigue en `self-hosting.js`
 *      para el flujo self-host). Con el OAuth del usuario (`accessToken`, en
 *      memoria, vía `-c http.<github>.extraheader`) alcanza sus repos
 *      PRIVADOS; el remote queda siempre limpio. Reutiliza `workspace.js`/
 *      `git-workflow.js`. NO clona en máquinas de usuario (AGENTS.md §6).
 *   3. Publicar en GitHub desde la web: `buildPublishPlan` valida el diff
 *      (paths sensibles, secretos, topes) y delega el push/PR real a
 *      `self-hosting.publishSelfHostedPullRequest` con token por-request
 *      (nunca global). Sin token → descriptor `compareUrl` para PR manual.
 *      PRs siempre a `production-main`, nunca push a `main` (AGENTS.md §21).
 */

const { isSafeBranchName, runBranchName, redactGitOutput } = require('./git-workflow');

const OPENCODE_PROVENANCE = Object.freeze({
  upstream: 'https://github.com/sst/opencode',
  license: 'MIT',
  vendorSnapshot: 'vendor/opencode',
  portedFrom: [
    'packages/opencode/src/tool/registry.ts',
    'packages/opencode/src/permission/index.ts',
    'packages/opencode/src/tool/read.ts',
    'packages/opencode/src/tool/write.ts',
    'packages/opencode/src/tool/edit.ts',
    'packages/opencode/src/tool/glob.ts',
    'packages/opencode/src/tool/grep.ts',
    'packages/opencode/src/tool/shell.ts',
    'packages/opencode/src/tool/task.ts',
    'packages/opencode/src/tool/todo.ts',
    'packages/opencode/src/tool/webfetch.ts',
    'packages/opencode/src/tool/websearch.ts',
    'packages/opencode/src/tool/skill.ts',
    'packages/opencode/src/tool/plan.ts',
  ],
  note: 'Contracts ported to CommonJS; no Effect-TS runtime copied.',
});

// ── Catálogo OpenCode → SiraGPT ─────────────────────────────────────────────
// status: native = ya existe 1:1 · adapted = existe con otro nombre/semántica
// cercana · missing = gap explícito (no se finge paridad).
const OPENCODE_TOOL_CATALOG = Object.freeze([
  { opencodeId: 'read', siraTool: 'read_file', status: 'native', notes: 'offset/limit, cap 50KB-equivalente vía summarise.' },
  { opencodeId: 'write', siraTool: 'write_file', status: 'native', notes: 'read-before-write enforced en file-state.' },
  { opencodeId: 'edit', siraTool: 'edit_file', status: 'native', notes: 'ladder exact→line-trimmed en edit-matching.js.' },
  { opencodeId: 'apply_patch', siraTool: 'edit_file', status: 'adapted', notes: 'OpenCode usa unified-diff; aquí find/replace exacto. Gap: parche multi-hunk.' },
  { opencodeId: 'glob', siraTool: 'glob', status: 'native', notes: 'safe-glob con pathspec git, respeta .gitignore.' },
  { opencodeId: 'grep', siraTool: 'grep_search', status: 'native', notes: 'git grep -In --untracked.' },
  { opencodeId: 'shell', siraTool: 'run_command', status: 'adapted', notes: 'Allowlist (git,bun,node,npm…) + background tasks; OpenCode shell es abierto.' },
  { opencodeId: 'task', siraTool: 'run_subagent', status: 'adapted', notes: 'Subagentes con contexto aislado (agent-sdk).' },
  { opencodeId: 'todowrite', siraTool: 'update_plan', status: 'adapted', notes: 'Checklist viva del plan aprobado.' },
  { opencodeId: 'todo', siraTool: 'update_plan', status: 'adapted', notes: 'Alias histórico de todowrite.' },
  { opencodeId: 'webfetch', siraTool: 'web_fetch', status: 'native', notes: 'SSRF guard + extracción con cap.' },
  { opencodeId: 'websearch', siraTool: 'web_search', status: 'native', notes: 'Brave→DuckDuckGo→Wikipedia→SearXNG.' },
  { opencodeId: 'skill', siraTool: 'use_skill', status: 'native', notes: 'Playbooks + .sira/skills/ del workspace.' },
  { opencodeId: 'plan_enter', siraTool: 'plan-mode', status: 'adapted', notes: 'mode plan del agent-loop (no muta).' },
  { opencodeId: 'plan_exit', siraTool: 'plan-mode', status: 'adapted', notes: 'Cierre plan → waiting_approval.' },
  { opencodeId: 'question', siraTool: null, status: 'missing', notes: 'OpenCode pregunta al usuario mid-run; aquí se usa needsClarification + permission_request.' },
  { opencodeId: 'lsp', siraTool: 'type_check', status: 'adapted', notes: 'tsc --noEmit vía runner en vez de LSP persistente.' },
]);

function catalogStatus() {
  const out = { native: 0, adapted: 0, missing: 0, total: OPENCODE_TOOL_CATALOG.length };
  for (const row of OPENCODE_TOOL_CATALOG) out[row.status] += 1;
  return out;
}

// ── Permisos estilo-OpenCode (port de permission/index.ts:evaluate) ─────────
// Regla: última coincidencia gana (findLast). Sin coincidencia → ask.
// permission/pattern soportan `*` (cualquier secuencia, incl. `/`).
function wildcardMatch(pattern, value) {
  const p = String(pattern ?? '');
  const v = String(value ?? '');
  if (p === '*') return true;
  // Escapa todo excepto `*`, que se vuelve `.*`. `?` se deja literal
  // (OpenCode usa `*` como comodín principal).
  const rx = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')}$`);
  return rx.test(v);
}

function evaluatePermission(permission, pattern, ...rulesets) {
  const flat = rulesets.flat().filter(Boolean);
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    const rule = flat[i];
    if (!rule || typeof rule !== 'object') continue;
    if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) {
      return rule;
    }
  }
  return { action: 'ask', permission, pattern: '*' };
}

// Port de permission.visibleTools: oculta tools cuyo ruleset dice deny+`*`.
// edits (edit/write/apply_patch) comparten el permiso `edit` como en OpenCode.
function hiddenTools(toolIds, ruleset = []) {
  const edits = new Set(['edit', 'write', 'apply_patch']);
  const reads = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
  const hidden = new Set();
  for (const tool of toolIds) {
    const permission = edits.has(tool) ? 'edit' : reads.has(tool) ? 'read' : tool;
    const rule = (Array.isArray(ruleset) ? ruleset : []).findLast
      ? ruleset.findLast((r) => wildcardMatch(r.permission, permission))
      : [...ruleset].reverse().find((r) => wildcardMatch(r.permission, permission));
    if (rule && rule.pattern === '*' && rule.action === 'deny') hidden.add(tool);
  }
  return hidden;
}

function visibleTools(toolsRecord, ruleset = []) {
  const hidden = hiddenTools(Object.keys(toolsRecord || {}), ruleset);
  return Object.fromEntries(Object.entries(toolsRecord || {}).filter(([name]) => !hidden.has(name)));
}

// ── Clone público desde la web (sin allowlist de operador) ──────────────────
// A diferencia de `self-hosting.validateRepositoryUrl` (allowlist cerrada para
// self-host), aquí se acepta CUALQUIER repo público github.com HTTPS sin
// credenciales: es el equivalente servidor del `git clone` local. El clon
// ocurre en el workspace CloudAgent, nunca en máquinas de usuario.
const GITHUB_HOST = 'github.com';
const REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

function parsePublicGithubRepo(input) {
  const raw = String(input || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error('repository URL is invalid');
    err.code = 'invalid_repository_url';
    throw err;
  }
  if (url.protocol !== 'https:') {
    const err = new Error('repository URL must use HTTPS');
    err.code = 'repository_protocol_not_allowed';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error('repository URL must not contain credentials');
    err.code = 'repository_credentials_forbidden';
    throw err;
  }
  if (url.search || url.hash || (url.port && url.port !== '443')) {
    const err = new Error('repository URL must not contain query, fragment, or a custom port');
    err.code = 'invalid_repository_url';
    throw err;
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST) {
    const err = new Error('only github.com repositories can be cloned from the web');
    err.code = 'repository_host_unsupported';
    throw err;
  }
  const segments = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length !== 2 || segments.some((s) => !REPO_SEGMENT_RE.test(s))) {
    const err = new Error('repository URL must identify owner/repository');
    err.code = 'invalid_repository_path';
    throw err;
  }
  const [owner, repo] = segments;
  return {
    host: GITHUB_HOST,
    owner,
    repo,
    cloneUrl: `https://${GITHUB_HOST}/${owner}/${repo}.git`,
    webUrl: `https://${GITHUB_HOST}/${owner}/${repo}`,
    slug: `${owner}/${repo}`.toLowerCase(),
  };
}

/**
 * Credencial de un solo uso para `git fetch` sobre github.com: cabecera
 * Authorization inyectada con `-c http.<url>.extraheader=…` (el patrón de
 * actions/checkout). Va SOLO en los argumentos de ese fetch: el remote queda
 * limpio, nunca se escribe en .git/config ni en disco.
 */
function githubAuthConfigArgs(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://${GITHUB_HOST}/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** Strip a transient credential (and its base64 form) from any git output. */
function scrubCredential(text, accessToken) {
  let out = String(text || '');
  const token = String(accessToken || '').trim();
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    out = out.split(token).join('[REDACTED]').split(basic).join('[REDACTED]');
  }
  return redactGitOutput(out);
}

async function execGitOrThrow(runner, projectId, args, opts = {}) {
  const { accessToken = null, ...execOpts } = opts || {};
  const out = await runner.exec(projectId, ['git', ...args], execOpts);
  if (out?.exitCode === 0) return out;
  const err = new Error('repository bootstrap failed');
  err.code = 'git_operation_failed';
  err.details = {
    operation: args.find((a) => typeof a === 'string' && !a.startsWith('-') && !/=/.test(a)) || args[0],
    exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : 1,
    detail: scrubCredential(out?.stderr || out?.stdout, accessToken),
  };
  throw err;
}

/**
 * Clona un repo github.com en el workspace del runner (fetch --depth=1).
 * Equivalente servidor del `git clone` + `switch -c run/<id>` local.
 * Con `accessToken` (OAuth del usuario, en memoria) el fetch va autenticado y
 * alcanza repos privados; sin token, solo repos públicos. En ambos casos el
 * remote `origin` queda con la URL limpia (sin credenciales).
 */
async function clonePublicRepo({
  runner,
  projectId,
  repoUrl,
  branch = 'main',
  runId = null,
  fetchTimeoutMs = 120_000,
  accessToken = null,
} = {}) {
  if (!runner || typeof runner.initWorkspace !== 'function' || typeof runner.exec !== 'function') {
    throw new TypeError('runner.initWorkspace and runner.exec are required');
  }
  if (!projectId) throw new Error('projectId is required');
  const repository = parsePublicGithubRepo(repoUrl);
  const baseBranch = String(branch || 'main').trim();
  if (!isSafeBranchName(baseBranch) || baseBranch.startsWith('run/')) {
    const err = new Error('source branch is invalid');
    err.code = 'invalid_source_branch';
    throw err;
  }
  let workBranch = null;
  if (runId != null) {
    workBranch = runBranchName(runId);
    if (!workBranch) {
      const err = new Error('run id is invalid');
      err.code = 'invalid_run_id';
      throw err;
    }
  }

  await runner.initWorkspace(projectId);
  const remote = await runner.exec(projectId, ['git', 'remote', 'get-url', 'origin']);
  if (remote?.exitCode === 0) {
    await execGitOrThrow(runner, projectId, ['remote', 'set-url', 'origin', repository.cloneUrl]);
  } else {
    await execGitOrThrow(runner, projectId, ['remote', 'add', 'origin', repository.cloneUrl]);
  }
  await execGitOrThrow(
    runner,
    projectId,
    [...githubAuthConfigArgs(accessToken), 'fetch', '--depth=1', 'origin', `refs/heads/${baseBranch}`],
    { timeoutMs: Math.max(10_000, Number(fetchTimeoutMs) || 120_000), accessToken },
  );
  await execGitOrThrow(runner, projectId, ['checkout', '-B', baseBranch, 'FETCH_HEAD']);
  if (workBranch) {
    await execGitOrThrow(runner, projectId, ['switch', '-c', workBranch, baseBranch]);
  }
  const head = await execGitOrThrow(runner, projectId, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    status: 'ready',
    repository,
    sourceBranch: baseBranch,
    workBranch,
    authenticated: Boolean(String(accessToken || '').trim()),
    commitSha: String(head.stdout || '').trim(),
    workspacePath: `projects/${projectId}`,
  };
}

// ── Plan de publicación GitHub desde la web ─────────────────────────────────
// Valida el diff antes de delegar a self-hosting.publishSelfHostedPullRequest.
// Puro excepto el `runner.readFile` para medir contenidos. Merge siempre vía
// PR a `production-main`; nunca push directo (AGENTS.md §21).
const MAX_PR_FILES = 240;
const MAX_PR_FILE_BYTES = 1_500_000;
const BLOCKED_PR_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.sira\/(?:sessions|tasks)(?:\/|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];

function isBlockedPublishPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  if (/(^|\/)\.env\.example$/i.test(normalized)) return false;
  return BLOCKED_PR_PATHS.some((re) => re.test(normalized));
}

function buildCompareUrl({ repository, baseBranch, workBranch }) {
  const base = encodeURIComponent(baseBranch);
  const head = encodeURIComponent(workBranch);
  return `${repository.webUrl}/compare/${base}...${head}?expand=1`;
}

/**
 * Arma el plan de publicación. Si hay `githubToken` se puede llamar a
 * `publishSelfHostedPullRequest` con `env: { ...env, CODEX_SELF_HOST_GITHUB_TOKEN: token }`;
 * sin token devuelve el `compareUrl` para abrir el PR a mano (flujo manual).
 */
async function buildPublishPlan({
  runner,
  projectId,
  repoUrl,
  sourceBranch = 'main',
  runId,
  title = null,
  body = null,
  hasGithubToken = false,
} = {}) {
  const repository = parsePublicGithubRepo(repoUrl);
  const baseBranch = String(sourceBranch || 'main').trim();
  if (!isSafeBranchName(baseBranch) || baseBranch.startsWith('run/')) {
    const err = new Error('source branch is invalid');
    err.code = 'invalid_source_branch';
    throw err;
  }
  const workBranch = runBranchName(runId);
  if (!workBranch) {
    const err = new Error('run id is invalid');
    err.code = 'invalid_run_id';
    throw err;
  }
  if (!runner || typeof runner.exec !== 'function') {
    throw new TypeError('runner.exec is required');
  }

  const changedOut = await runner.exec(projectId, ['git', 'diff', '--name-only', '-z', '--diff-filter=ACMRT', `${baseBranch}...${workBranch}`]);
  const deletedOut = await runner.exec(projectId, ['git', 'diff', '--name-only', '-z', '--diff-filter=D', `${baseBranch}...${workBranch}`]);
  const changed = String(changedOut?.stdout || '').split('\0').map((s) => s.trim()).filter(Boolean);
  const deleted = String(deletedOut?.stdout || '').split('\0').map((s) => s.trim()).filter(Boolean);
  if (changed.length + deleted.length > MAX_PR_FILES) {
    const err = new Error(`pull request exceeds ${MAX_PR_FILES} files`);
    err.code = 'pull_request_too_large';
    throw err;
  }
  const blocked = [...changed, ...deleted].filter(isBlockedPublishPath);
  if (blocked.length) {
    const err = new Error(`sensitive path cannot be published: ${blocked[0]}`);
    err.code = 'pull_request_sensitive_path';
    err.details = { blocked };
    throw err;
  }
  // Medición best-effort del tamaño (el secret-scan profundo vive en self-hosting).
  let bytes = 0;
  if (typeof runner.readFile === 'function') {
    for (const path of changed.slice(0, MAX_PR_FILES)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const read = await runner.readFile(projectId, path);
        const size = Buffer.byteLength(String(read?.content ?? ''), 'utf8');
        if (size > MAX_PR_FILE_BYTES) {
          const err = new Error(`${path} exceeds ${MAX_PR_FILE_BYTES} bytes`);
          err.code = 'pull_request_file_too_large';
          throw err;
        }
        bytes += size;
      } catch (err) {
        if (err?.code && String(err.code).startsWith('pull_request_')) throw err;
        // readFile falló (borrado entre diff y read): se ignora, el push lo dirime.
      }
    }
  }
  const safeTitle = String(title || `feat(codex): mejoras desde la web ${runId}`)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    || `feat(codex): mejoras desde la web ${runId}`;
  const safeBody = String(body || 'Cambios preparados por SiraGPT Codex desde la web. Requiere revisión y checks verdes.')
    .replace(/\u0000/g, '').trim().slice(0, 60_000);
  const compareUrl = buildCompareUrl({ repository, baseBranch, workBranch });
  if (!changed.length && !deleted.length) {
    return { ok: true, status: 'no_changes', branch: workBranch, compareUrl, files: 0, deleted: 0 };
  }
  return {
    ok: true,
    status: hasGithubToken ? 'ready_to_publish' : 'manual_pr',
    branch: workBranch,
    base: baseBranch,
    repository: repository.webUrl,
    compareUrl,
    title: safeTitle,
    body: safeBody,
    files: changed.length,
    deleted: deleted.length,
    bytes,
    mergePolicy: 'pull_request_only',
  };
}

module.exports = {
  OPENCODE_PROVENANCE,
  OPENCODE_TOOL_CATALOG,
  catalogStatus,
  wildcardMatch,
  evaluatePermission,
  hiddenTools,
  visibleTools,
  parsePublicGithubRepo,
  clonePublicRepo,
  githubAuthConfigArgs,
  scrubCredential,
  buildPublishPlan,
  buildCompareUrl,
  isBlockedPublishPath,
  MAX_PR_FILES,
  MAX_PR_FILE_BYTES,
};
