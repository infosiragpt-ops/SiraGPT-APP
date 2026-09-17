'use strict';

/**
 * codex/github-checks — the `github_checks` build tool: read-only CI/check
 * status for the project's GitHub repository, through the USER's connected
 * GitHub account (OAuth stored by /api/github/connect), never a server token.
 *
 * Closes the "PR as output" loop the Claude Code way: after `publish` opens
 * the PR, the agent can ask GitHub whether the checks passed and, for failed
 * GitHub Actions jobs, which steps failed — then fix and push again instead
 * of declaring victory blind.
 *
 * Pure function of (args, ctx). `ctx.githubApi` is injectable for tests; the
 * default is services/github/github-api.service (lazy-required).
 */

const MAX_CHECKS = 50;
const MAX_FAILED_JOB_LOOKUPS = 5;
const MAX_SUMMARY_CHARS = 400;
const MAX_STEPS_PER_JOB = 8;

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** owner/repo from `owner/repo`, an https github.com URL, or a `.git` clone URL. */
function parseRepository(input) {
  const raw = clean(input);
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== 'github.com') return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

/** Repository for this tool call: explicit arg, else the project brief. */
function resolveRepository(args, ctx) {
  const explicit = parseRepository(args?.repository);
  if (explicit) return explicit;
  const brief = ctx?.projectRecord?.brief;
  const repository = brief && typeof brief === 'object' ? brief.repository : null;
  if (!repository || typeof repository !== 'object') return null;
  return parseRepository(repository.fullName) || parseRepository(repository.webUrl) || parseRepository(repository.url);
}

function defaultRef(ctx) {
  const runId = clean(ctx?.run?.id);
  return runId ? `run/${runId}` : '';
}

function truncate(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function iconFor(status, conclusion) {
  if (status !== 'completed') return '⏳';
  if (conclusion === 'success') return '✅';
  if (conclusion === 'skipped' || conclusion === 'neutral') return '⏭';
  if (conclusion === 'cancelled') return '⛔';
  return '❌';
}

function isFailure(check) {
  return check.status === 'completed' && !['success', 'skipped', 'neutral'].includes(String(check.conclusion || ''));
}

function notConnectedObservation() {
  return {
    isError: false,
    summary: 'GitHub no conectado',
    observation: 'No puedo leer el CI: la cuenta de GitHub del usuario no está conectada (o su token ya no sirve). Pídele que conecte GitHub en Ajustes → Apps y vuelve a intentarlo; mientras tanto, entrega el enlace del PR para que revise los checks a mano.',
  };
}

async function failedStepsFor(octokit, repo, check) {
  const isActions = String(check?.app?.slug || '').toLowerCase() === 'github-actions';
  if (!isActions || !Number.isInteger(check?.id)) return [];
  try {
    const job = await octokit.rest.actions.getJobForWorkflowRun({ ...repo, job_id: check.id });
    const steps = Array.isArray(job?.data?.steps) ? job.data.steps : [];
    return steps
      .filter((s) => s && s.status === 'completed' && !['success', 'skipped'].includes(String(s.conclusion || '')))
      .slice(0, MAX_STEPS_PER_JOB)
      .map((s) => `${s.name} (${s.conclusion})`);
  } catch {
    return [];
  }
}

/**
 * Tool body. Returns the standard `{ isError, summary, observation }` shape
 * plus a structured `checks` array for callers that want it.
 */
async function githubChecksTool(args = {}, ctx = {}) {
  const repo = resolveRepository(args, ctx);
  if (!repo) {
    return {
      isError: true,
      summary: 'sin repositorio',
      observation: 'Error: este proyecto no está ligado a un repositorio de GitHub y no se indicó `repository` (owner/repo). Publica primero el PR o pasa el repositorio explícitamente.',
    };
  }
  const userId = clean(ctx.userId);
  if (!userId) return notConnectedObservation();

  // eslint-disable-next-line global-require
  const api = ctx.githubApi || require('../github/github-api.service');
  let octokit;
  try {
    ({ octokit } = await api.octokitForUser(userId));
  } catch (err) {
    const code = String(err?.code || '');
    if (code === 'github_not_connected' || code === 'github_token_invalid' || Number(err?.status) === 409) {
      return notConnectedObservation();
    }
    return { isError: true, summary: `github no disponible: ${err.message}`, observation: `No pude autenticar con GitHub: ${err.message}` };
  }

  const repoParams = { owner: repo.owner, repo: repo.repo };
  let ref = clean(args.ref);
  let pull = null;
  try {
    const prNumber = Number(args.pr);
    if (Number.isInteger(prNumber) && prNumber > 0) {
      const res = await octokit.rest.pulls.get({ ...repoParams, pull_number: prNumber });
      pull = res?.data || null;
      if (!ref) ref = clean(pull?.head?.sha) || clean(pull?.head?.ref);
    }
    if (!ref) ref = defaultRef(ctx);
    if (!ref) {
      return { isError: true, summary: 'ref requerido', observation: 'Error: indica `ref` (rama o SHA) o `pr`; este run no tiene rama propia que consultar.' };
    }

    const listed = await octokit.rest.checks.listForRef({ ...repoParams, ref, per_page: MAX_CHECKS });
    const runs = Array.isArray(listed?.data?.check_runs) ? listed.data.check_runs : [];
    const checks = runs.map((c) => ({
      id: c.id,
      name: String(c.name || 'check'),
      app: c.app?.slug || null,
      status: String(c.status || 'queued'),
      conclusion: c.conclusion || null,
      url: c.html_url || null,
      title: truncate(c.output?.title || '', 160),
      summary: truncate(c.output?.summary || '', MAX_SUMMARY_CHARS),
      failedSteps: [],
    }));

    const failed = checks.filter(isFailure).slice(0, MAX_FAILED_JOB_LOOKUPS);
    for (const check of failed) {
      // eslint-disable-next-line no-await-in-loop
      check.failedSteps = await failedStepsFor(octokit, repoParams, runs.find((r) => r.id === check.id));
    }

    const counts = {
      total: checks.length,
      success: checks.filter((c) => c.status === 'completed' && c.conclusion === 'success').length,
      failed: checks.filter(isFailure).length,
      pending: checks.filter((c) => c.status !== 'completed').length,
      skipped: checks.filter((c) => c.status === 'completed' && ['skipped', 'neutral'].includes(String(c.conclusion || ''))).length,
    };
    const verdict = counts.total === 0
      ? 'sin checks'
      : counts.failed > 0 ? 'fallando' : counts.pending > 0 ? 'en curso' : 'verde';

    const lines = [];
    lines.push(`CI de ${repo.fullName} @ ${ref}${pull ? ` (PR #${pull.number}${pull.mergeable_state ? `, merge: ${pull.mergeable_state}` : ''})` : ''}: ${verdict} — ${counts.success} ok, ${counts.failed} fallo(s), ${counts.pending} pendiente(s), ${counts.skipped} omitido(s) de ${counts.total}.`);
    if (counts.total === 0) {
      lines.push('GitHub no reporta checks para esa ref todavía: o el CI no se disparó, o la rama aún no fue publicada. Vuelve a consultar en un momento o revisa que el PR exista.');
    }
    for (const c of checks) {
      const state = c.status === 'completed' ? (c.conclusion || 'sin conclusión') : c.status;
      let line = `${iconFor(c.status, c.conclusion)} ${c.name} — ${state}${c.url ? ` — ${c.url}` : ''}`;
      if (isFailure(c)) {
        if (c.failedSteps.length) line += `\n    pasos fallidos: ${c.failedSteps.join('; ')}`;
        if (c.title || c.summary) line += `\n    ${[c.title, c.summary].filter(Boolean).join(' · ')}`;
      }
      lines.push(line);
    }
    if (counts.failed > 0) {
      lines.push('Siguiente paso: abre el enlace del check fallido para leer el log, corrige la causa en el workspace y vuelve a publicar; luego consulta github_checks otra vez.');
    }
    const observation = lines.join('\n');
    return {
      isError: false,
      summary: `CI ${verdict}: ${counts.success}/${counts.total} ok, ${counts.failed} fallo(s), ${counts.pending} pendiente(s)`,
      observation,
      checks,
      counts,
      ref,
      repository: repo.fullName,
      pullRequest: pull ? { number: pull.number, state: pull.state, mergeableState: pull.mergeable_state || null, url: pull.html_url || null } : null,
    };
  } catch (err) {
    const status = Number(err?.status);
    if (status === 404) {
      return {
        isError: true,
        summary: 'ref o PR no encontrado',
        observation: `GitHub no encontró ${pull ? `el PR #${args.pr}` : `la ref "${ref}"`} en ${repo.fullName}. Comprueba que la rama fue publicada (push) o que el número de PR es correcto.`,
      };
    }
    if (status === 403 || status === 401) {
      return {
        isError: true,
        summary: 'sin permiso en GitHub',
        observation: `GitHub rechazó la consulta (${status}) sobre ${repo.fullName}: la cuenta conectada no tiene acceso a ese repositorio o el token expiró. Pide al usuario reconectar GitHub.`,
      };
    }
    return { isError: true, summary: `github_checks falló: ${err?.message || err}`, observation: `No pude consultar el CI: ${err?.message || err}` };
  }
}

module.exports = {
  githubChecksTool,
  parseRepository,
  resolveRepository,
  defaultRef,
  isFailure,
  MAX_CHECKS,
  MAX_FAILED_JOB_LOOKUPS,
};
