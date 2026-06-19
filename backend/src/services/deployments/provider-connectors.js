'use strict';

const DEFAULT_GODADDY_BASE_URL = 'https://api.godaddy.com';

const COMMON_PUBLIC_SUFFIXES = new Set([
  'com.ar', 'com.au', 'com.br', 'com.co', 'com.mx', 'com.pe', 'co.uk', 'co.jp',
]);

const PROVIDERS = {
  hostinger_vps: {
    id: 'hostinger_vps',
    label: 'Hostinger VPS',
    category: 'compute',
    mode: 'ssh',
    description: 'Deploys to a Hostinger VPS over SSH and can optionally read Hostinger API metadata.',
    requiredEnv: ['HOSTINGER_VPS_HOST', 'HOSTINGER_VPS_USER', 'HOSTINGER_VPS_SSH_PRIVATE_KEY'],
    optionalEnv: ['HOSTINGER_VPS_PORT', 'HOSTINGER_VPS_APP_PATH', 'HOSTINGER_API_TOKEN', 'HOSTINGER_VPS_ID', 'HOSTINGER_VPS_IPV4'],
    capabilities: ['ssh_deploy', 'reverse_proxy', 'runtime_logs', 'custom_domain'],
    docsUrl: 'https://www.hostinger.com/support/5723772-how-to-connect-to-your-vps-via-ssh-at-hostinger/',
  },
  aws: {
    id: 'aws',
    label: 'AWS',
    category: 'compute',
    mode: 'aws_credentials',
    description: 'Connects a deployment target to AWS credentials, region and an App Runner/ECS target.',
    requiredEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    optionalEnv: ['AWS_SESSION_TOKEN', 'AWS_DEPLOY_TARGET', 'AWS_ACCOUNT_ID'],
    capabilities: ['container_deploy', 'health_checks', 'runtime_logs', 'custom_domain'],
    docsUrl: 'https://docs.aws.amazon.com/sdkref/latest/guide/environment-variables.html',
  },
  godaddy_dns: {
    id: 'godaddy_dns',
    label: 'GoDaddy DNS',
    category: 'domain',
    mode: 'godaddy_api',
    description: 'Creates or replaces the DNS records required for a custom domain in GoDaddy.',
    requiredEnv: ['GODADDY_API_KEY', 'GODADDY_API_SECRET'],
    optionalEnv: ['GODADDY_API_BASE_URL'],
    capabilities: ['dns_records', 'domain_verification'],
    docsUrl: 'https://developer.godaddy.com/doc/endpoint/domains',
  },
};

function envValue(env, key) {
  const value = env && env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function envRows(keys, env) {
  return keys.map((key) => ({ key, configured: Boolean(envValue(env, key)) }));
}

function providerDefinition(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    const err = new Error('unsupported provider');
    err.code = 'unsupported_provider';
    throw err;
  }
  return provider;
}

function providerReadiness(providerId, env = process.env) {
  const provider = providerDefinition(providerId);
  const missingRequired = provider.requiredEnv.filter((key) => !envValue(env, key));
  return {
    ...provider,
    configured: missingRequired.length === 0,
    missingRequired,
    requiredEnv: envRows(provider.requiredEnv, env),
    optionalEnv: envRows(provider.optionalEnv, env),
  };
}

function listProviders(env = process.env) {
  return Object.keys(PROVIDERS).map((providerId) => providerReadiness(providerId, env));
}

function normalizeHostname(hostname) {
  const clean = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
    const err = new Error('invalid hostname');
    err.code = 'invalid_hostname';
    throw err;
  }
  return clean;
}

function splitGoDaddyHostname(hostname) {
  const clean = normalizeHostname(hostname);
  const parts = clean.split('.').filter(Boolean);
  if (parts.length < 2) {
    const err = new Error('invalid hostname');
    err.code = 'invalid_hostname';
    throw err;
  }
  const publicSuffix = parts.slice(-2).join('.');
  const rootSize = COMMON_PUBLIC_SUFFIXES.has(publicSuffix) && parts.length >= 3 ? 3 : 2;
  const rootDomain = parts.slice(-rootSize).join('.');
  const recordName = parts.length === rootSize ? '@' : parts.slice(0, -rootSize).join('.');
  return { hostname: clean, rootDomain, recordName };
}

function godaddyRecordName(recordName, rootDomain) {
  const clean = normalizeHostname(recordName);
  if (clean === rootDomain) return '@';
  const suffix = `.${rootDomain}`;
  return clean.endsWith(suffix) ? clean.slice(0, -suffix.length) || '@' : clean;
}

function buildConnectionPlan({ providerId, deployment, hostname = null, dnsRecords = [], env = process.env }) {
  const readiness = providerReadiness(providerId, env);
  const port = Number(deployment?.externalPort) || 3000;
  if (providerId === 'hostinger_vps') {
    const host = envValue(env, 'HOSTINGER_VPS_HOST');
    const user = envValue(env, 'HOSTINGER_VPS_USER') || 'root';
    const sshPort = envValue(env, 'HOSTINGER_VPS_PORT') || '22';
    const appPath = envValue(env, 'HOSTINGER_VPS_APP_PATH') || `/opt/siragpt/apps/${deployment?.subdomain || deployment?.id || 'app'}`;
    const publicIp = envValue(env, 'HOSTINGER_VPS_IPV4') || host || null;
    return {
      provider: readiness,
      ready: readiness.configured,
      target: { host: host || null, user, sshPort, appPath, publicIp, appPort: port },
      steps: [
        'Build the app locally or in CI.',
        `Sync the release to ${user}@${host || 'HOSTINGER_VPS_HOST'}:${appPath}.`,
        `Run the app on localhost:${port} and attach the reverse proxy.`,
        'Point the domain A record to the VPS public IPv4 address.',
      ],
    };
  }
  if (providerId === 'aws') {
    const region = envValue(env, 'AWS_REGION') || null;
    const target = envValue(env, 'AWS_DEPLOY_TARGET') || 'apprunner';
    return {
      provider: readiness,
      ready: readiness.configured,
      target: { region, deployTarget: target, accountIdConfigured: Boolean(envValue(env, 'AWS_ACCOUNT_ID')) },
      steps: [
        'Build a container or static bundle in CI.',
        `Publish the artifact to AWS ${target}.`,
        'Run health checks before marking the deployment as live.',
        'Use the Domains tab to connect the public hostname.',
      ],
    };
  }
  if (providerId === 'godaddy_dns') {
    const split = hostname ? splitGoDaddyHostname(hostname) : null;
    return {
      provider: readiness,
      ready: readiness.configured,
      target: split ? { rootDomain: split.rootDomain, recordName: split.recordName } : null,
      dnsRecords,
      steps: [
        'Create or replace the required A/TXT records through the GoDaddy Domains API.',
        'Keep TLS in provisioning until DNS propagation is visible.',
      ],
    };
  }
  return { provider: readiness, ready: readiness.configured, target: null, steps: [] };
}

async function applyGoDaddyDnsRecords({ hostname, records, env = process.env, fetchImpl = globalThis.fetch }) {
  const readiness = providerReadiness('godaddy_dns', env);
  const split = splitGoDaddyHostname(hostname);
  if (!readiness.configured) {
    return {
      applied: false,
      providerId: 'godaddy_dns',
      reason: 'missing_env',
      missingRequired: readiness.missingRequired,
      rootDomain: split.rootDomain,
      recordName: split.recordName,
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      applied: false,
      providerId: 'godaddy_dns',
      reason: 'fetch_unavailable',
      missingRequired: [],
      rootDomain: split.rootDomain,
      recordName: split.recordName,
    };
  }

  const baseUrl = (envValue(env, 'GODADDY_API_BASE_URL') || DEFAULT_GODADDY_BASE_URL).replace(/\/+$/, '');
  const auth = `sso-key ${envValue(env, 'GODADDY_API_KEY')}:${envValue(env, 'GODADDY_API_SECRET')}`;
  const attemptedRecords = [];
  for (const record of records || []) {
    if (!record || !['A', 'TXT', 'CNAME'].includes(record.type)) continue;
    const name = godaddyRecordName(record.name || hostname, split.rootDomain);
    const type = String(record.type).toUpperCase();
    const ttl = Number(record.ttl) || 3600;
    const value = String(record.value || '').trim();
    if (!value) continue;
    const url = `${baseUrl}/v1/domains/${encodeURIComponent(split.rootDomain)}/records/${encodeURIComponent(type)}/${encodeURIComponent(name)}`;
    const body = JSON.stringify([{ data: value, ttl }]);
    attemptedRecords.push({ type, name, value, ttl, url });
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      body,
    });
    if (!response || response.ok !== true) {
      const status = response && response.status ? response.status : 0;
      const text = response && typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      return {
        applied: false,
        providerId: 'godaddy_dns',
        reason: 'provider_error',
        status,
        message: String(text || '').slice(0, 300),
        rootDomain: split.rootDomain,
        recordName: split.recordName,
        attemptedRecords,
      };
    }
  }
  return {
    applied: attemptedRecords.length > 0,
    providerId: 'godaddy_dns',
    reason: attemptedRecords.length > 0 ? null : 'no_records',
    rootDomain: split.rootDomain,
    recordName: split.recordName,
    attemptedRecords,
  };
}

module.exports = {
  PROVIDERS,
  providerReadiness,
  listProviders,
  normalizeHostname,
  splitGoDaddyHostname,
  buildConnectionPlan,
  applyGoDaddyDnsRecords,
};
