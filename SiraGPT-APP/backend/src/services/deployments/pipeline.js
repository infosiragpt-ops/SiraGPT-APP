'use strict';

/**
 * deployments/pipeline — pure, deterministic helpers behind the Deployments
 * module. No DB, no clock, no randomness: same inputs ⇒ same bytes, so the
 * unit tests stay offline and stable. The route/service layer stamps real
 * timestamps (via Prisma defaults) and persistence; everything domain-shaped
 * (labels, the publish pipeline, short hashes, DNS records, the synthetic
 * security scan) lives here.
 *
 * Mirrors Replit's Deployments UX (see docs research): 5-phase publish
 * pipeline, immutable versions identified by a short hash, custom-domain
 * A+TXT records, machine tiers. Provider connectors live beside this module
 * so the UI can target real infrastructure without putting secrets in code.
 */

const DEPLOYMENT_TYPES = ['autoscale', 'reserved_vm', 'static', 'scheduled', 'hostinger_vps', 'aws'];
const VISIBILITIES = ['public', 'workspace', 'private', 'password'];
const GEOGRAPHIES = ['na', 'eu', 'sa', 'asia', 'au'];
const STATUSES = ['building', 'running', 'failed', 'paused', 'suspended', 'shut_down'];

const DEPLOYMENT_TYPE_LABELS = {
  autoscale: 'Autoscale',
  reserved_vm: 'Reserved VM',
  static: 'Static',
  scheduled: 'Scheduled',
  hostinger_vps: 'Hostinger VPS',
  aws: 'AWS',
};

const GEOGRAPHY_LABELS = {
  na: 'North America',
  eu: 'Europe (EU)',
  sa: 'South America',
  asia: 'Asia',
  au: 'Australia',
};

// Reserved VM ladder (Replit-style display tiers / monthly USD).
const RESERVED_TIERS = {
  '0.5vcpu_2gb': { label: 'Shared 0.5 vCPU / 2 GiB RAM', cpu: 0.5, memoryMb: 2048, monthlyUsd: 20 },
  '1vcpu_4gb': { label: 'Dedicated 1 vCPU / 4 GiB RAM', cpu: 1, memoryMb: 4096, monthlyUsd: 40 },
  '2vcpu_8gb': { label: 'Dedicated 2 vCPU / 8 GiB RAM', cpu: 2, memoryMb: 8192, monthlyUsd: 80 },
  '4vcpu_16gb': { label: 'Dedicated 4 vCPU / 16 GiB RAM', cpu: 4, memoryMb: 16384, monthlyUsd: 160 },
};

// The 5 publish phases Replit runs on every publish.
const PUBLISH_PHASES = ['provision', 'security_scan', 'build', 'bundle', 'promote'];

const PHASE_LABELS = {
  provision: 'Provision',
  security_scan: 'Security scan',
  build: 'Build',
  bundle: 'Bundle',
  promote: 'Promote',
};

/** FNV-1a 32-bit — deterministic, dependency-free string hash. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 8-char build hash from a deployment id + sequence (mirrors `39864864`). */
function generateShortHash(deploymentId, seq = 0) {
  const a = fnv1a(`${deploymentId}:${seq}`);
  const b = fnv1a(`${seq}:${deploymentId}:salt`);
  // Mix BOTH hashes into the 8-hex output. The previous
  // `(aHex8 + bHex8).slice(0, 8)` kept only aHex8 — the salt hash `b` was dead
  // and added no distribution. XOR folds b's entropy back in within 8 hex chars.
  return ((a ^ b) >>> 0).toString(16).padStart(8, '0');
}

/** URL-safe subdomain from a name, with a short deterministic suffix so two
 *  deployments named the same don't collide. */
function slugifySubdomain(name, deploymentId = '') {
  const base = String(name || 'app')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app';
  const suffix = deploymentId ? fnv1a(deploymentId).toString(36).slice(0, 4) : '';
  return suffix ? `${base}-${suffix}` : base;
}

function defaultDomain(subdomain) {
  return `https://${subdomain}.replit.app`;
}

/** Resolve machine label + resources for a deployment type/tier. */
function machineSpec(deploymentType, machineTier) {
  if (deploymentType === 'reserved_vm') {
    const tier = RESERVED_TIERS[machineTier] || RESERVED_TIERS['1vcpu_4gb'];
    return { label: `Reserved VM (${tier.label})`, cpu: tier.cpu, memoryMb: tier.memoryMb, monthlyUsd: tier.monthlyUsd };
  }
  if (deploymentType === 'static') {
    return { label: 'Static (CDN)', cpu: null, memoryMb: null, monthlyUsd: 0 };
  }
  if (deploymentType === 'scheduled') {
    return { label: 'Scheduled job', cpu: 1, memoryMb: 1024, monthlyUsd: null };
  }
  if (deploymentType === 'hostinger_vps') {
    return { label: 'Hostinger VPS', cpu: null, memoryMb: null, monthlyUsd: null };
  }
  if (deploymentType === 'aws') {
    return { label: 'AWS target', cpu: null, memoryMb: null, monthlyUsd: null };
  }
  return { label: 'Autoscale', cpu: 1, memoryMb: 2048, monthlyUsd: null };
}

/** Deterministic per-deployment public IP (UI only — the A record value). */
function pseudoIpFor(deploymentId) {
  const h = fnv1a(deploymentId);
  const a = 34 + (h % 20); // 34-53, AWS/GCP-ish ranges, purely cosmetic
  const b = (h >> 8) & 0xff;
  const c = (h >> 16) & 0xff;
  const d = ((h >> 24) & 0xff) || 7;
  return `${a}.${b}.${c}.${d}`;
}

/** A + TXT records a user must add to verify a custom domain (Replit parity:
 *  A record per-deployment IP + permanent replit-verify TXT for SSL renewal). */
function dnsRecordsFor(hostname, deploymentId) {
  const ip = pseudoIpFor(deploymentId);
  const token = fnv1a(`${hostname}:${deploymentId}`).toString(16).padStart(8, '0');
  return [
    { type: 'A', name: hostname, value: ip, ttl: 3600 },
    { type: 'TXT', name: hostname, value: `replit-verify=${token}`, ttl: 3600 },
  ];
}

function normalizePublishPhase(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PUBLISH_PHASES.includes(normalized) ? normalized : null;
}

function blockingSecurityFindings(findings) {
  return findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high');
}

/** Synthetic security scan (Semgrep/dependency-style). Deterministic from a
 *  seed so the same version always reports the same findings. */
function securityScanReport(seed) {
  const h = fnv1a(`scan:${seed}`);
  const CANDIDATES = [
    { severity: 'medium', category: 'dependency', title: 'Outdated dependency with a known advisory' },
    { severity: 'low', category: 'secret_exposure', title: 'Possible token in a committed .env example' },
    { severity: 'high', category: 'xss', title: 'Unescaped user input rendered in HTML' },
    { severity: 'low', category: 'csrf', title: 'State-changing route without CSRF token' },
  ];
  const count = h % 3; // 0..2 findings
  const findings = [];
  for (let i = 0; i < count; i += 1) findings.push(CANDIDATES[(h + i) % CANDIDATES.length]);
  const blocking = blockingSecurityFindings(findings);
  return {
    status: blocking.length > 0 ? 'failed' : 'passed',
    scannedAt: null, // route stamps this
    findings,
    summary:
      findings.length === 0
        ? 'No issues found.'
        : blocking.length > 0
          ? `${blocking.length} blocking security issue(s) found.`
          : `${findings.length} issue(s) found.`,
  };
}

/**
 * Run the 5-phase publish pipeline for a version. Pure: returns the phase
 * results + accumulated runtime log lines + the final status. `hasFiles`
 * lets the caller fail a publish with no workspace files (parity with the
 * old mock). The route persists the outcome and streams the phases over SSE.
 */
function failedResult({ shortHash, phases, logs, securityScan, subdomain, phase, message }) {
  phases.push({ name: phase, status: 'failed', logs: [message] });
  logs.push(`[${phase}] failed: ${message}`);
  return {
    shortHash,
    phases,
    logs,
    finalStatus: 'failed',
    promoted: false,
    securityScan,
    subdomain,
    failedPhase: phase,
    failureMessage: message,
  };
}

function runPublishPipeline({ deployment, seq = 0, hasFiles = true, failPhase = null }) {
  const shortHash = generateShortHash(deployment.id, seq);
  const spec = machineSpec(deployment.deploymentType, deployment.machineTier);
  const subdomain = deployment.subdomain || slugifySubdomain(deployment.name, deployment.id);
  const scan = securityScanReport(`${deployment.id}:${seq}`);
  const forcedFailurePhase = normalizePublishPhase(failPhase);

  const phases = [];
  const logs = [];
  const push = (line) => logs.push(line);

  // provision
  if (forcedFailurePhase === 'provision') {
    return failedResult({
      shortHash,
      phases,
      logs,
      securityScan: scan,
      subdomain,
      phase: 'provision',
      message: 'Provisioning failed before compute resources were ready',
    });
  }
  phases.push({ name: 'provision', status: 'done', logs: [`Provisioning ${spec.label}`] });
  push(`[provision] ${spec.label} in ${GEOGRAPHY_LABELS[deployment.geography] || deployment.geography}`);

  // security_scan
  const scanOk = scan.status === 'passed';
  phases.push({
    name: 'security_scan',
    status: scanOk ? 'done' : 'failed',
    logs: [scan.summary],
  });
  push(`[security] ${scan.summary}`);
  if (!scanOk) {
    return {
      shortHash,
      phases,
      logs,
      finalStatus: 'failed',
      promoted: false,
      securityScan: scan,
      subdomain,
      failedPhase: 'security_scan',
      failureMessage: scan.summary,
    };
  }
  if (forcedFailurePhase === 'security_scan') {
    phases.pop();
    return failedResult({
      shortHash,
      phases,
      logs,
      securityScan: scan,
      subdomain,
      phase: 'security_scan',
      message: 'Security scan failed by policy',
    });
  }

  // build
  if (!hasFiles) {
    phases.push({ name: 'build', status: 'failed', logs: ['Build failed: no workspace files found'] });
    push('[build] failed: no workspace files found');
    return {
      shortHash,
      phases,
      logs,
      finalStatus: 'failed',
      promoted: false,
      securityScan: scan,
      subdomain,
      failedPhase: 'build',
      failureMessage: 'Build failed: no workspace files found',
    };
  }
  if (forcedFailurePhase === 'build') {
    return failedResult({
      shortHash,
      phases,
      logs,
      securityScan: scan,
      subdomain,
      phase: 'build',
      message: 'Build command exited with a non-zero status',
    });
  }
  phases.push({ name: 'build', status: 'done', logs: [deployment.buildCommand || 'npm run build', 'Compiled successfully'] });
  push(`[build] ${deployment.buildCommand || 'npm run build'}`);
  push('[build] compiled successfully');

  // bundle
  if (forcedFailurePhase === 'bundle') {
    return failedResult({
      shortHash,
      phases,
      logs,
      securityScan: scan,
      subdomain,
      phase: 'bundle',
      message: 'Bundle upload failed before the release artifact was stored',
    });
  }
  phases.push({ name: 'bundle', status: 'done', logs: ['Bundled image', 'Uploaded snapshot'] });
  push('[bundle] snapshot uploaded');

  // promote (gated by a health check at "/")
  if (forcedFailurePhase === 'promote') {
    return failedResult({
      shortHash,
      phases,
      logs,
      securityScan: scan,
      subdomain,
      phase: 'promote',
      message: 'Health check failed, so the release was not promoted',
    });
  }
  phases.push({ name: 'promote', status: 'done', logs: [`Health check 200 on /`, `Serving ${defaultDomain(subdomain)}`] });
  push(`[promote] health check passed`);
  push(`[promote] serving ${defaultDomain(subdomain)}`);

  // Realistic runtime log lines so the Logs tab looks populated (mirrors a real
  // deployment boot + a few served requests). Deterministic.
  push(`[run] ${deployment.runCommand || 'npm run start'}`);
  push(`[system] container started`);
  push(`server listening on :${deployment.externalPort || 80}`);
  push(`[system] connected to production database`);
  push(`GET / 200 12ms`);
  push(`GET /health 200 3ms`);
  push(`GET /api/status 200 8ms`);

  return { shortHash, phases, logs, finalStatus: 'running', promoted: true, securityScan: scan, subdomain };
}

/**
 * Classify a stored log line into a structured entry for the Logs table
 * (Time / Deployment / Source / Log). `[system]`/`[provision]`/`[bundle]`/
 * `[promote]` lines are System; everything else is User. Lines that look like
 * an error/failure get level "error" (rendered red, matched by "Errors only").
 */
function parseLogEntries(buildLog, baseMs = 0) {
  const lines = String(buildLog || '').split('\n').filter((l) => l.length > 0);
  return lines.map((message, i) => {
    const system = /^\[(system|provision|bundle|promote)\]/.test(message);
    const error = /\b(error|failed|fail|exception|refused|timeout)\b/i.test(message);
    return {
      ts: new Date(baseMs + i * 1000).toISOString(),
      source: system ? 'System' : 'User',
      level: error ? 'error' : 'info',
      message,
    };
  });
}

module.exports = {
  DEPLOYMENT_TYPES,
  VISIBILITIES,
  GEOGRAPHIES,
  STATUSES,
  DEPLOYMENT_TYPE_LABELS,
  GEOGRAPHY_LABELS,
  RESERVED_TIERS,
  PUBLISH_PHASES,
  PHASE_LABELS,
  fnv1a,
  generateShortHash,
  slugifySubdomain,
  defaultDomain,
  machineSpec,
  pseudoIpFor,
  dnsRecordsFor,
  securityScanReport,
  runPublishPipeline,
  parseLogEntries,
};
