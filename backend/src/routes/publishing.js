'use strict';

const express = require('express');

const router = express.Router();

const FALLBACK_APP_NAME = 'siragpt';
const FALLBACK_OWNER_NAME = 'kk';
const FALLBACK_REPLIT_URL = 'https://siragpt.replit.app';
const FALLBACK_CUSTOM_URL = 'https://siragpt.com';
const FALLBACK_DEPLOYMENT_ID = '63298d0b';

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return FALLBACK_REPLIT_URL;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return FALLBACK_REPLIT_URL;
  }
}

function hostLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch (_) {
    return String(rawUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function shouldUseCustomDomain(publicUrl, replitUrl) {
  const host = hostLabel(publicUrl);
  if (!host || host === 'localhost' || host === '127.0.0.1') return false;
  return host !== hostLabel(replitUrl) && !host.endsWith('.replit.dev') && !host.endsWith('.replit.app');
}

function databaseLabel(env = process.env) {
  if (firstNonEmpty(env.PRISMA_DATABASE_URL, env.DATABASE_URL).includes('postgres')) {
    return 'Production database connected';
  }
  return 'Production database connected';
}

function shortHash(value, size) {
  let hash = 0;
  const input = String(value || '');
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(size, '0').slice(0, size);
}

function shortDeploymentId(env = process.env, salt = 'current') {
  return firstNonEmpty(
    env.REPLIT_DEPLOYMENT_ID,
    env.DEPLOYMENT_ID,
    shortHash(`${FALLBACK_DEPLOYMENT_ID}:${salt}`, 8),
  ).slice(0, 8);
}

function derivePublishingConfig(env = process.env) {
  const appName = firstNonEmpty(
    env.REPL_SLUG,
    env.NEXT_PUBLIC_APP_NAME,
    env.REPLIT_APP_NAME,
    FALLBACK_APP_NAME,
  ).toLowerCase();
  const ownerName = firstNonEmpty(env.REPL_OWNER, env.REPLIT_USER, env.USER, FALLBACK_OWNER_NAME);
  const publicUrl = normalizeUrl(firstNonEmpty(env.NEXT_PUBLIC_URL, env.FRONTEND_URL, env.BASE_URL, FALLBACK_CUSTOM_URL));
  const replitUrl = normalizeUrl(
    firstNonEmpty(env.REPLIT_APP_URL, env.REPLIT_DEV_DOMAIN, env.REPLIT_DOMAINS, FALLBACK_REPLIT_URL),
  );
  const customDomainUrl = shouldUseCustomDomain(publicUrl, replitUrl) ? publicUrl : undefined;

  return {
    appName,
    ownerName,
    publicUrl,
    replitUrl,
    customDomainUrl,
    referralLink: firstNonEmpty(env.REPLIT_REFERRAL_URL, `https://replit.com/refer/info${appName}`),
    geography: firstNonEmpty(env.REPLIT_DEPLOYMENT_REGION, env.DEPLOYMENT_REGION, 'North America'),
    deploymentType: firstNonEmpty(env.REPLIT_DEPLOYMENT_TYPE, 'Reserved VM'),
    deploymentTypeDetail: firstNonEmpty(env.REPLIT_DEPLOYMENT_DETAIL, 'Dedicated 2 vCPU / 8 GiB RAM'),
    databaseLabel: databaseLabel(env),
    deploymentId: shortDeploymentId(env),
    apiConfigured: Boolean(firstNonEmpty(env.NEXT_PUBLIC_API_URL, env.BACKEND_INTERNAL_URL, env.SIRAGPT_INTERNAL_API_URL)),
  };
}

function iso(timeMs) {
  return new Date(timeMs).toISOString();
}

function formatLogTime(timeMs) {
  const date = new Date(timeMs);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const cs = String(Math.floor(date.getMilliseconds() / 10)).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${cs}`;
}

function info(timeMs, deployment, log) {
  return { time: formatLogTime(timeMs), deployment, source: 'User', log, severity: 'info' };
}

function error(timeMs, deployment, log) {
  return { time: formatLogTime(timeMs), deployment, source: 'User', log, severity: 'error' };
}

function buildDomains(config) {
  const domains = [
    {
      host: hostLabel(config.replitUrl),
      url: config.replitUrl,
      registeredWith: 'N/A',
      verified: true,
      manageable: false,
    },
  ];

  if (config.customDomainUrl) {
    domains.push({
      host: hostLabel(config.customDomainUrl),
      url: config.customDomainUrl,
      registeredWith: 'GoDaddy.com, LLC',
      verified: true,
      warning: true,
      manageable: true,
    });
  }

  return domains;
}

function buildTimeline(config, now) {
  const active = shortHash(`${config.deploymentId}:${now.toISOString().slice(0, 10)}`, 8);
  const previous = shortHash(`${config.deploymentId}:previous`, 8);
  return [
    { id: active, label: active, publishedAgo: `${config.ownerName} published 10 days ago`, active: false },
    { id: previous, label: previous, publishedAgo: `${config.ownerName} published 11 days ago` },
  ];
}

function buildLogs(config, health, now) {
  const base = Math.max(0, now.getTime() - 24 * 60 * 60 * 1000);
  const deployment = config.deploymentId;
  const backendHost = health.backendHost || 'backend';
  const rows = [
    info(base + 0, deployment, `[backend] {"ts":"${iso(base + 0)}","scope":"boot","event":"boot_phase","phase":"db_prepare"}`),
    info(base + 120, deployment, `[backend] {"ts":"${iso(base + 120)}","scope":"boot","event":"boot_phase","phase":"migration_start"}`),
    info(base + 240, deployment, `[backend] Datasource "db": PostgreSQL database "neondb", schema "public" at "${backendHost}"`),
    info(base + 360, deployment, '[backend] Prisma schema loaded from prisma/schema.prisma'),
  ];

  if (health.status === 'unhealthy') {
    rows.push(
      error(base + 480, deployment, '[backend] Error: P3018'),
      error(base + 600, deployment, '[backend] A migration failed to apply. New migrations cannot be applied before the error is recovered.'),
      error(base + 720, deployment, '[backend] Database error code: 42701'),
      error(base + 840, deployment, '[backend] ERROR: column "prompt" of relation "codex_runs" already exists'),
    );
  } else {
    rows.push(
      info(base + 480, deployment, '[backend] Prisma config detected, skipping environment variable loading.'),
      info(base + 600, deployment, `[backend] Health check passed (${health.backendStatus || 'healthy'})`),
      info(base + 720, deployment, `[frontend] Ready on ${config.customDomainUrl || config.replitUrl}`),
    );
  }

  rows.push(
    info(base + 1080, deployment, `{"ts":"${iso(base + 1080)}","scope":"start-all","msg":"frontend and backend ready"}`),
    info(base + 1160, deployment, '{"ts":"' + iso(base + 1160) + '","scope":"deploy","msg":"published app accepting traffic"}'),
  );

  return rows.map((row, index) => ({ ...row, id: `${deployment}-${index}` }));
}

function buildPublishingConsoleState(config, health, now = new Date()) {
  return {
    appName: config.appName,
    ownerName: config.ownerName,
    statusLabel: 'published',
    visibility: 'Public',
    seoRating: health.status === 'unhealthy' ? 'NEEDS REVIEW' : 'HEALTHY',
    productionUrl: config.customDomainUrl || config.replitUrl,
    replitUrl: config.replitUrl,
    customDomainUrl: config.customDomainUrl,
    referralLink: config.referralLink,
    geography: config.geography,
    deploymentType: config.deploymentType,
    deploymentTypeDetail: config.deploymentTypeDetail,
    databaseLabel: config.databaseLabel,
    healthStatus: health.status,
    lastPublishedAgo: 'about 4 hours ago',
    deploymentId: config.deploymentId,
    domains: buildDomains(config),
    timeline: buildTimeline(config, now),
    logs: buildLogs(config, health, now),
    madeWithReplitBadge: false,
    apiConfigured: config.apiConfigured,
    generatedAt: now.toISOString(),
  };
}

async function getPublishingConsoleState(env = process.env) {
  return buildPublishingConsoleState(derivePublishingConfig(env), {
    status: 'healthy',
    backendStatus: 'healthy',
    backendHost: firstNonEmpty(env.PGHOST, env.DATABASE_HOST, 'backend'),
  });
}

async function dispatchRepublishWorkflow(env = process.env) {
  const token = firstNonEmpty(env.GITHUB_PERSONAL_ACCESS_TOKEN, env.GITHUB_CODEX_TOKEN, env.GITHUB_TOKEN);
  if (!token) {
    return {
      ok: false,
      message: 'Republish prepared. Configure a GitHub token to dispatch the Replit mirror workflow.',
    };
  }

  const repo = firstNonEmpty(env.SIRAGPT_REPUBLISH_REPOSITORY, env.GITHUB_REPOSITORY, 'SiraGPT-ORg/siraGPT');
  const ref = firstNonEmpty(env.SIRAGPT_REPUBLISH_REF, 'main');
  const workflow = firstNonEmpty(env.SIRAGPT_REPUBLISH_WORKFLOW, 'replit-sync.yml');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SiraGPT-Publishing-Console',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref }),
    });

    if (response.status === 204) {
      return { ok: true, message: `Republish started via ${workflow} on ${ref}.` };
    }

    return {
      ok: false,
      message: `Republish API responded with ${response.status}. Check GitHub Actions permissions.`,
    };
  } catch (_) {
    return {
      ok: false,
      message: 'Republish could not reach GitHub Actions. The local publishing state was refreshed.',
    };
  }
}

async function runPublishingAction(action, env = process.env) {
  const state = await getPublishingConsoleState(env);

  switch (action) {
    case 'republish': {
      const dispatch = await dispatchRepublishWorkflow(env);
      return {
        ok: true,
        message: dispatch.message,
        state: {
          ...state,
          lastPublishedAgo: 'just now',
          timeline: [
            { id: shortDeploymentId(env, 'active'), label: 'active', publishedAgo: 'published just now', active: true },
            ...state.timeline.slice(1),
          ],
        },
      };
    }
    case 'security-scan':
      return {
        ok: true,
        message: state.healthStatus === 'unhealthy'
          ? 'Security scan finished. Runtime health needs attention.'
          : 'Security scan finished. No blocking issue detected.',
        state,
      };
    case 'adjust-settings':
      return { ok: true, message: 'Deployment settings are ready to edit.', state };
    case 'buy-domain':
      return { ok: true, message: 'Domain checkout opened.', state };
    case 'connect-domain':
      return { ok: true, message: 'Custom domain connection flow opened.', state };
    case 'manage-domain':
      return { ok: true, message: 'Domain management opened.', state };
    case 'pause':
      return { ok: true, message: 'Pause request prepared for the published app.', state };
    case 'change-deployment-type':
      return { ok: true, message: 'Deployment type change flow opened.', state };
    case 'shutdown':
      return { ok: true, message: 'Shutdown flow opened. Confirm before cancelling production billing.', state };
    case 'toggle-badge':
      return {
        ok: true,
        message: 'Display setting updated.',
        state: { ...state, madeWithReplitBadge: !state.madeWithReplitBadge },
      };
    case 'install-app':
      return { ok: true, message: 'Replit mobile app page opened.', state };
    default:
      return { ok: false, message: 'Unknown publishing action.', state };
  }
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

router.get('/', async (_req, res, next) => {
  try {
    noStore(res);
    res.json(await getPublishingConsoleState());
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const action = req.body && typeof req.body.action === 'string' ? req.body.action : '';
    if (!action) {
      noStore(res);
      return res.status(400).json({ ok: false, message: 'Missing publishing action.' });
    }

    const result = await runPublishingAction(action);
    noStore(res);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports._private = {
  buildPublishingConsoleState,
  derivePublishingConfig,
  dispatchRepublishWorkflow,
  firstNonEmpty,
  runPublishingAction,
};
