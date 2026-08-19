#!/usr/bin/env node
/**
 * siraGPT developer CLI — stdlib-only.
 *
 * Usage:
 *   node scripts/cli.js status
 *   node scripts/cli.js health [--base URL]
 *   node scripts/cli.js shadow-prompt <model> <prompt> [--base URL]
 *   node scripts/cli.js logs [--tail N] [--grep PATTERN] [--file PATH]
 *
 * No third-party deps — uses only Node stdlib.
 */

'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// ---------- tiny ANSI helpers ------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, str) => (useColor ? `\x1b[${code}m${str}\x1b[0m` : String(str));
const color = {
  bold: (s) => c(1, s),
  dim: (s) => c(2, s),
  red: (s) => c(31, s),
  green: (s) => c(32, s),
  yellow: (s) => c(33, s),
  blue: (s) => c(34, s),
  magenta: (s) => c(35, s),
  cyan: (s) => c(36, s),
  gray: (s) => c(90, s),
};

// ---------- arg parser -------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
}

// ---------- commands ---------------------------------------------------------
function cmdStatus() {
  console.log(color.bold('▌ git status'));
  const status = tryExec('git status --short --branch');
  console.log(typeof status === 'string' ? status || color.dim('(clean)') : color.red(status.error));

  console.log('\n' + color.bold('▌ recent commits'));
  const log = tryExec('git log --oneline --decorate -n 10');
  console.log(typeof log === 'string' ? log : color.red(log.error));

  console.log('\n' + color.bold('▌ last CI run (gh)'));
  const ghPath = tryExec('command -v gh');
  if (typeof ghPath === 'string' && ghPath) {
    const run = tryExec('gh run list --limit 1 --json status,conclusion,name,headBranch,createdAt');
    if (typeof run === 'string' && run) {
      try {
        const [r] = JSON.parse(run);
        if (r) {
          const concl = r.conclusion || r.status || 'unknown';
          const tag =
            concl === 'success'
              ? color.green(concl)
              : concl === 'failure'
              ? color.red(concl)
              : color.yellow(concl);
          console.log(`  ${tag}  ${r.name}  (${r.headBranch})  ${color.dim(r.createdAt)}`);
        } else {
          console.log(color.dim('  no runs'));
        }
      } catch {
        console.log(color.dim(run));
      }
    } else {
      console.log(color.dim('  gh installed but no data'));
    }
  } else {
    console.log(color.dim('  gh CLI not installed — skipping'));
  }

  console.log('\n' + color.bold('▌ latest migration'));
  const migDirs = [
    'backend/prisma/migrations',
    'prisma/migrations',
  ];
  let latest = null;
  for (const d of migDirs) {
    if (fs.existsSync(d)) {
      const entries = fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      if (entries.length) latest = path.join(d, entries[entries.length - 1]);
    }
  }
  console.log(latest ? '  ' + color.cyan(latest) : color.dim('  no migration directory found'));
}

async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: err.message } };
  } finally {
    clearTimeout(t);
  }
}

async function cmdHealth(args) {
  const base = args.flags.base || process.env.SIRAGPT_BASE_URL || 'http://localhost:5000';
  const url = `${base.replace(/\/+$/, '')}/api/admin/health/services`;
  console.log(color.bold(`GET ${url}`));
  const r = await fetchJson(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    console.log(color.red(`✗ HTTP ${r.status}`));
    console.log(JSON.stringify(r.body, null, 2));
    process.exit(1);
  }
  const services = r.body?.services ?? r.body ?? {};
  console.log(color.bold('\nServices:'));
  for (const [name, info] of Object.entries(services)) {
    const status =
      (info && typeof info === 'object' ? info.status || info.state : info) || 'unknown';
    const dot =
      status === 'ok' || status === 'healthy' || status === 'up'
        ? color.green('●')
        : status === 'degraded' || status === 'warn'
        ? color.yellow('●')
        : color.red('●');
    console.log(`  ${dot} ${name.padEnd(24)} ${color.dim(String(status))}`);
  }
}

async function cmdShadowPrompt(args) {
  const model = args._[0];
  const prompt = args._.slice(1).join(' ');
  if (!model || !prompt) {
    console.error('Usage: cli.js shadow-prompt <model> <prompt>');
    process.exit(2);
  }
  const base = args.flags.base || process.env.SIRAGPT_BASE_URL || 'http://localhost:5000';
  const token = args.flags.token || process.env.SIRAGPT_TOKEN;
  const url = `${base.replace(/\/+$/, '')}/api/ai/chat`;
  console.log(color.dim(`→ ${url} (model=${model}, shadow=true)`));
  const r = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Shadow-Request': '1',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      shadow: true,
      persist: false,
    }),
    timeoutMs: 60_000,
  });
  if (!r.ok) {
    console.log(color.red(`✗ HTTP ${r.status}`));
    console.log(JSON.stringify(r.body, null, 2));
    process.exit(1);
  }
  const out = r.body?.content ?? r.body?.message?.content ?? r.body;
  console.log(color.bold('\n--- response ---'));
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  if (r.body?.usage) {
    console.log(color.dim('\nusage: ' + JSON.stringify(r.body.usage)));
  }
}

function findLogFile(explicit) {
  if (explicit) return explicit;
  const candidates = [
    'logs/backend.log',
    'logs/app.log',
    'backend/logs/app.log',
    'tmp/backend.log',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function cmdLogs(args) {
  const tail = Number(args.flags.tail ?? 100);
  const grep = args.flags.grep ? new RegExp(String(args.flags.grep), 'i') : null;
  const file = findLogFile(args.flags.file);

  if (!file) {
    // Fall back to PM2 if available (production layout)
    const pm2 = tryExec('command -v pm2');
    if (typeof pm2 === 'string' && pm2) {
      console.log(color.dim('No log file found — falling back to `pm2 logs`'));
      const out = spawnSync('pm2', ['logs', '--lines', String(tail), '--nostream'], {
        stdio: 'inherit',
      });
      process.exit(out.status ?? 0);
    }
    console.error(color.red('No log file found. Pass --file <path>.'));
    process.exit(1);
  }

  console.log(color.dim(`tailing ${file} (last ${tail} lines${grep ? `, grep ${grep}` : ''})`));
  const data = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const slice = data.slice(-tail);
  for (const line of slice) {
    if (!line) continue;
    if (grep && !grep.test(line)) continue;
    let out = line;
    if (/\b(error|fatal|critical)\b/i.test(line)) out = color.red(line);
    else if (/\bwarn(ing)?\b/i.test(line)) out = color.yellow(line);
    else if (/\binfo\b/i.test(line)) out = color.blue(line);
    else if (/\bdebug\b/i.test(line)) out = color.dim(line);
    console.log(out);
  }
}

// ─── admin-only commands (cycle 45) ──────────────────────────────────────────
function adminBase(args) {
  return args.flags.base || process.env.SIRAGPT_BASE_URL || 'http://localhost:5000';
}

function adminToken() {
  const t = process.env.SIRAGPT_ADMIN_TOKEN;
  if (!t) {
    console.error(color.red('Missing SIRAGPT_ADMIN_TOKEN env var (required for admin commands).'));
    process.exit(2);
  }
  return t;
}

function adminHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${adminToken()}`,
    ...extra,
  };
}

function exitNonOk(r) {
  if (!r.ok) {
    console.log(color.red(`✗ HTTP ${r.status}`));
    console.log(JSON.stringify(r.body, null, 2));
    process.exit(1);
  }
}

async function cmdAudit(args) {
  const userId = args._[0];
  if (!userId) {
    console.error('Usage: cli.js audit <userId> [--limit N] [--action A] [--from D] [--to D]');
    process.exit(2);
  }
  const base = adminBase(args);
  const params = new URLSearchParams({ userId });
  if (args.flags.limit) params.set('limit', String(args.flags.limit));
  if (args.flags.action) params.set('action', String(args.flags.action));
  if (args.flags.from) params.set('from', String(args.flags.from));
  if (args.flags.to) params.set('to', String(args.flags.to));
  const url = `${base.replace(/\/+$/, '')}/api/admin/audit-logs?${params.toString()}`;
  console.log(color.dim(`→ GET ${url}`));
  const r = await fetchJson(url, { headers: adminHeaders() });
  exitNonOk(r);
  const items = r.body?.items || [];
  console.log(color.bold(`\n${items.length} entries (total ${r.body?.total ?? '?'}):`));
  for (const row of items) {
    const when = row.createdAt ? color.dim(new Date(row.createdAt).toISOString()) : '';
    const who = color.cyan(row.actorName || row.actorId || '?');
    const act = color.yellow(row.action);
    const res = row.resourceType ? color.magenta(`${row.resourceType}${row.resourceId ? `:${row.resourceId}` : ''}`) : '';
    console.log(`  ${when}  ${who}  ${act}  ${res}`);
  }
}

async function cmdFailoverStatus(args) {
  const base = adminBase(args);
  // Try a few likely endpoints; surface first one that responds.
  const candidates = [
    '/api/admin/failover/status',
    '/api/admin/failover-events',
    '/api/admin/providers/failover',
  ];
  for (const path of candidates) {
    const url = `${base.replace(/\/+$/, '')}${path}`;
    const r = await fetchJson(url, { headers: adminHeaders() });
    if (r.ok) {
      console.log(color.bold(`GET ${url}`));
      console.log(JSON.stringify(r.body, null, 2));
      return;
    }
    if (r.status !== 404 && r.status !== 0) {
      console.log(color.bold(`GET ${url}`));
      exitNonOk(r);
      return;
    }
  }
  console.log(color.yellow('No failover endpoint responded (tried admin/failover/{status,events} and providers/failover).'));
  process.exit(1);
}

async function cmdRefund(args) {
  const userId = args._[0];
  const amount = Number(args._[1]);
  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    console.error('Usage: cli.js refund <userId> <positiveAmount>');
    console.error('  Note: amount is the *positive* number of credits to refund; we call grant-credits with a negative reason tag.');
    process.exit(2);
  }
  const base = adminBase(args);
  // grant-credits route expects positive credits; we attach a `reason: refund` marker.
  const url = `${base.replace(/\/+$/, '')}/api/admin/users/${encodeURIComponent(userId)}/grant-credits`;
  console.log(color.dim(`→ POST ${url} credits=${-amount} (refund)`));
  const r = await fetchJson(url, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ credits: amount, reason: `refund_via_cli:${process.env.USER || 'unknown'}`, refund: true }),
  });
  exitNonOk(r);
  console.log(color.green('✓ refund recorded'));
  console.log(JSON.stringify(r.body, null, 2));
}

async function cmdQueueRetry(args) {
  const name = args._[0];
  if (!name) {
    console.error('Usage: cli.js queue-retry <queueName>');
    process.exit(2);
  }
  const base = adminBase(args);
  const url = `${base.replace(/\/+$/, '')}/api/admin/queues/${encodeURIComponent(name)}/retry-failed`;
  console.log(color.dim(`→ POST ${url}`));
  const r = await fetchJson(url, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  exitNonOk(r);
  console.log(color.green(`✓ retried ${r.body?.retried ?? '?'} / ${r.body?.totalFailed ?? '?'} failed jobs`));
}

async function cmdScrubNow(args) {
  const userId = args._[0];
  if (!userId) {
    console.error('Usage: cli.js scrub-now <userId>');
    process.exit(2);
  }
  const base = adminBase(args);
  // Try a known/likely scrub endpoint; harmless if 404 — we just report.
  const candidates = [
    `/api/admin/users/${encodeURIComponent(userId)}/scrub`,
    `/api/admin/scrub/${encodeURIComponent(userId)}`,
  ];
  for (const path of candidates) {
    const url = `${base.replace(/\/+$/, '')}${path}`;
    const r = await fetchJson(url, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    if (r.ok) {
      console.log(color.green(`✓ scrub triggered (${url})`));
      console.log(JSON.stringify(r.body, null, 2));
      return;
    }
    if (r.status !== 404 && r.status !== 0) {
      console.log(color.bold(`POST ${url}`));
      exitNonOk(r);
      return;
    }
  }
  console.log(color.yellow('No scrub endpoint accepted the request — wire `/api/admin/users/:id/scrub` to enable this command.'));
  process.exit(1);
}

function printHelp() {
  console.log(`siraGPT dev CLI

Commands:
  status                          git + CI + migration snapshot
  health [--base URL]             call /api/admin/health/services
  shadow-prompt <model> <prompt>  test prompt against /api/ai/chat (shadow, not saved)
                                  [--base URL] [--token TOKEN]
  logs [--tail N] [--grep RX] [--file PATH]
                                  tail recent backend logs (falls back to pm2)

Admin (require SIRAGPT_ADMIN_TOKEN env var):
  audit <userId> [--limit N] [--action A] [--from D] [--to D]
                                  print recent audit-log entries for a user
  failover-status                 print current provider failover events
  refund <userId> <amount>        refund credits (grant-credits with refund flag)
  queue-retry <queueName>         retry all failed jobs in queue
  scrub-now <userId>              manually trigger PII scrub for one user

Environment:
  SIRAGPT_BASE_URL          default base URL (else http://localhost:5000)
  SIRAGPT_TOKEN             bearer token for shadow-prompt
  SIRAGPT_ADMIN_TOKEN       bearer token (super-admin) for the admin commands
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'health':
      return cmdHealth(args);
    case 'shadow-prompt':
      return cmdShadowPrompt(args);
    case 'logs':
      return cmdLogs(args);
    case 'audit':
      return cmdAudit(args);
    case 'failover-status':
      return cmdFailoverStatus(args);
    case 'refund':
      return cmdRefund(args);
    case 'queue-retry':
      return cmdQueueRetry(args);
    case 'scrub-now':
      return cmdScrubNow(args);
    default:
      console.error(color.red(`Unknown command: ${cmd}`));
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(color.red('Fatal:'), err.stack || err.message);
  process.exit(1);
});
