'use strict';

/**
 * github-actions-tool
 *
 * Small, dependency-free GitHub Actions monitor for the agentic chat loop.
 * It gives the coding agent a first-class way to verify "CI green" after a
 * push without relying on ad-hoc page scraping.
 */

const https = require('https');

const SAFE_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;
const SAFE_SHA_RE = /^[a-f0-9]{7,40}$/i;

function parseRepository(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let owner = '';
  let repo = '';

  const short = /^([A-Za-z0-9-]{1,40})\/([A-Za-z0-9_.-]{1,100})(?:\.git)?$/i.exec(raw);
  if (short) {
    owner = short[1];
    repo = short[2];
  } else {
    try {
      const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(withProtocol);
      if (url.hostname.replace(/^www\./i, '').toLowerCase() !== 'github.com') return null;
      const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      owner = parts[0] || '';
      repo = (parts[1] || '').replace(/\.git$/i, '');
    } catch {
      return null;
    }
  }

  if (!SAFE_OWNER_RE.test(owner) || !SAFE_REPO_RE.test(repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function normalizeBranch(value) {
  const branch = String(value || 'main').trim() || 'main';
  if (!SAFE_BRANCH_RE.test(branch) || branch.includes('..') || branch.includes('@{') || branch.includes('//')) {
    return null;
  }
  return branch;
}

function normalizeSha(value) {
  const sha = String(value || '').trim();
  if (!sha) return '';
  return SAFE_SHA_RE.test(sha) ? sha : null;
}

function githubToken() {
  return process.env.SIRAGPT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function fetchJson(url, { token = githubToken(), timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'siraGPT-agentic-actions-monitor',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const err = new Error(parsed?.message || `GitHub API error ${res.statusCode}`);
        err.statusCode = res.statusCode;
        err.body = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('GitHub API timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeRun(run, parsed, branch) {
  if (!run) {
    return {
      ok: true,
      found: false,
      green: false,
      repository: parsed.fullName,
      branch,
      status: 'missing',
      conclusion: null,
      message: `No se encontraron ejecuciones de GitHub Actions para ${parsed.fullName}@${branch}.`,
    };
  }

  const status = run.status || 'unknown';
  const conclusion = run.conclusion || null;
  const green = status === 'completed' && conclusion === 'success';
  const failed = status === 'completed' && conclusion && conclusion !== 'success';
  const htmlUrl = run.html_url || `https://github.com/${parsed.fullName}/actions`;

  return {
    ok: true,
    found: true,
    green,
    failed,
    repository: parsed.fullName,
    branch,
    runId: run.id || null,
    name: run.name || run.display_title || null,
    status,
    conclusion,
    event: run.event || null,
    headSha: run.head_sha || null,
    htmlUrl,
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    message: green
      ? `CI verde en ${parsed.fullName}@${branch}.`
      : failed
        ? `CI terminó con conclusión "${conclusion}" en ${parsed.fullName}@${branch}.`
        : `CI en estado "${status}" para ${parsed.fullName}@${branch}.`,
  };
}

async function checkGithubActions(args = {}, ctx = {}) {
  const parsed = parseRepository(args.repository || args.repo || args.url);
  if (!parsed) {
    return {
      ok: false,
      error: 'Repositorio inválido. Usa owner/repo o https://github.com/owner/repo.',
    };
  }

  const branch = normalizeBranch(args.branch);
  if (!branch) return { ok: false, error: 'Rama inválida para consultar GitHub Actions.' };

  const commitSha = normalizeSha(args.commitSha || args.sha || args.headSha);
  if (commitSha === null) return { ok: false, error: 'SHA inválido para consultar GitHub Actions.' };

  const perPage = Math.min(30, Math.max(1, Number(args.perPage || 10) || 10));
  const url = new URL(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/runs`);
  url.searchParams.set('branch', branch);
  url.searchParams.set('per_page', String(perPage));

  ctx.onEvent?.({ type: 'tool_call', tool: 'check_ci_status', preview: `${parsed.fullName}@${branch}` });

  try {
    const data = await (ctx.fetchJson || fetchJson)(url.toString(), {});
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    const workflowName = String(args.workflowName || '').trim().toLowerCase();
    const selected = runs.find((run) => {
      if (commitSha && String(run.head_sha || '').toLowerCase() !== commitSha.toLowerCase()) return false;
      if (workflowName && String(run.name || '').trim().toLowerCase() !== workflowName) return false;
      return true;
    });
    const summary = summarizeRun(selected || null, parsed, branch);
    summary.totalRunsScanned = runs.length;
    ctx.onEvent?.({ type: 'tool_output', tool: 'check_ci_status', ok: summary.ok, preview: summary.message });
    return summary;
  } catch (err) {
    const message = err?.statusCode === 404
      ? 'No se pudo acceder al repositorio o no existe GitHub Actions para ese repo.'
      : (err?.message || 'Error consultando GitHub Actions.');
    ctx.onEvent?.({ type: 'tool_output', tool: 'check_ci_status', ok: false, preview: message });
    return { ok: false, error: message, repository: parsed.fullName, branch };
  }
}

async function monitorGithubActions(args = {}, ctx = {}) {
  const timeoutSeconds = Math.min(900, Math.max(10, Number(args.timeoutSeconds || 300) || 300));
  const intervalSeconds = Math.min(60, Math.max(1, Number(args.intervalSeconds || 15) || 15));
  const started = Date.now();
  let attempts = 0;
  let last = null;

  ctx.onEvent?.({ type: 'tool_call', tool: 'monitor_ci', preview: `timeout ${timeoutSeconds}s` });

  while ((Date.now() - started) / 1000 < timeoutSeconds) {
    attempts += 1;
    last = await checkGithubActions(args, ctx);
    if (!last.ok || last.green || last.failed) {
      return {
        ...last,
        attempts,
        elapsedMs: Date.now() - started,
        timedOut: false,
      };
    }
    ctx.onEvent?.({ type: 'stage', label: `CI pendiente (${last.status})`, pct: Math.min(95, 20 + attempts * 10) });
    await (ctx.sleep || sleep)(intervalSeconds * 1000);
  }

  return {
    ...(last || {}),
    ok: Boolean(last?.ok),
    green: false,
    attempts,
    elapsedMs: Date.now() - started,
    timedOut: true,
    message: last?.message || 'Tiempo agotado esperando GitHub Actions.',
  };
}

const checkCiStatusTool = {
  name: 'check_ci_status',
  description: 'Check the latest GitHub Actions run for a repository branch or commit. Use after pushing code to verify whether CI is green.',
  parameters: {
    type: 'object',
    properties: {
      repository: { type: 'string', description: 'GitHub repository as owner/repo or https://github.com/owner/repo.' },
      branch: { type: 'string', description: 'Branch to inspect. Defaults to main.' },
      commitSha: { type: 'string', description: 'Optional commit SHA to match exactly.' },
      workflowName: { type: 'string', description: 'Optional workflow name to match.' },
    },
    required: ['repository'],
    additionalProperties: false,
  },
  execute: checkGithubActions,
};

const monitorCiTool = {
  name: 'monitor_ci',
  description: 'Poll GitHub Actions until a repository branch or commit turns green, fails, or times out. Use when the user asks to wait for CI green status.',
  parameters: {
    type: 'object',
    properties: {
      repository: { type: 'string', description: 'GitHub repository as owner/repo or https://github.com/owner/repo.' },
      branch: { type: 'string', description: 'Branch to inspect. Defaults to main.' },
      commitSha: { type: 'string', description: 'Optional commit SHA to match exactly.' },
      workflowName: { type: 'string', description: 'Optional workflow name to match.' },
      timeoutSeconds: { type: 'integer', minimum: 10, maximum: 900, description: 'Maximum wait time. Default 300.' },
      intervalSeconds: { type: 'integer', minimum: 1, maximum: 60, description: 'Polling interval. Default 15.' },
    },
    required: ['repository'],
    additionalProperties: false,
  },
  execute: monitorGithubActions,
};

module.exports = {
  checkGithubActions,
  monitorGithubActions,
  checkCiStatusTool,
  monitorCiTool,
  _internal: {
    fetchJson,
    normalizeBranch,
    normalizeSha,
    parseRepository,
    summarizeRun,
  },
};
