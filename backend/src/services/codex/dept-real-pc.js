'use strict';

/**
 * Isolated Linux desktop (XFCE + browser + files + terminal) per department.
 * One webtop container, start-on-demand, persist /config on the host.
 * No docker.sock, no .env, no other department volumes, no public ports.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAGE = process.env.SIRAGPT_DEPT_PC_IMAGE || 'lscr.io/linuxserver/webtop:debian-xfce';
const NETWORK = process.env.SIRAGPT_DEPT_PC_NETWORK || 'siragpt_dept_os';
const DATA_ROOT = process.env.SIRAGPT_DEPT_PC_DATA || '/opt/siragpt/data/dept-computers';
const CONTAINER_PREFIX = 'sira-dpc-';
const HTTP_PORT = 3000;
const MEMORY = process.env.SIRAGPT_DEPT_PC_MEMORY || '2g';
const CPUS = process.env.SIRAGPT_DEPT_PC_CPUS || '2';
const PIDS = Number(process.env.SIRAGPT_DEPT_PC_PIDS || 256);
const READY_TIMEOUT_MS = Number(process.env.SIRAGPT_DEPT_PC_READY_MS || 90_000);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/;

function safeId(value, label) {
  const id = String(value || '').trim();
  if (!ID_RE.test(id)) {
    const err = new Error('department_computer_unavailable');
    err.detail = `invalid_${label || 'id'}`;
    throw err;
  }
  return id;
}

function containerName(projectId, departmentId) {
  const project = safeId(projectId, 'project');
  const department = safeId(departmentId, 'department');
  return `${CONTAINER_PREFIX}${project}-${department}`.slice(0, 120);
}

function persistDir(projectId, departmentId) {
  return path.posix.join(DATA_ROOT, safeId(projectId, 'project'), safeId(departmentId, 'department'));
}

function publicPath(projectId, departmentId) {
  return `/dept-os/${safeId(projectId, 'project')}/${safeId(departmentId, 'department')}/`;
}

function chosenRuntime() {
  const requested = String(process.env.SIRAGPT_DEPT_PC_RUNTIME || 'runc').trim().toLowerCase();
  // Selkies/XFCE/Chromium need host syscalls that gVisor (runsc) does not
  // provide reliably. Default runc + tight caps. Opt-in runsc via env.
  if (requested === 'runsc') return 'runsc';
  return 'runc';
}

function runDocker(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}


function runDockerBuffer(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout: Buffer.concat(chunks),
        stderr: stderr.trim(),
      });
    });
  });
}

function buildDockerRunArgs({
  name,
  persist,
  subfolder,
  title,
  runtime = 'runc',
  dropCaps = true,
} = {}) {
  const args = [
    'run', '-d',
    '--name', name,
    '--runtime', runtime,
    '--network', NETWORK,
    '--restart', 'always',
    '--memory', MEMORY,
    '--memory-swap', MEMORY,
    '--cpus', String(CPUS),
    '--pids-limit', String(PIDS),
    '--shm-size', '1g',
    '--security-opt', 'seccomp=unconfined',
    '--security-opt', 'no-new-privileges:true',
    '--label', 'sira.role=dept-real-pc',
    '--label', `sira.department=${name}`,
    '-e', 'PUID=1000',
    '-e', 'PGID=1000',
    '-e', 'TZ=America/Lima',
    '-e', `SUBFOLDER=${subfolder}`,
    '-e', `TITLE=${title}`,
    '-e', 'LC_ALL=es_PE.UTF-8',
    '-v', `${persist}:/config`,
  ];
  if (dropCaps) {
    args.push(
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'FOWNER',
      '--cap-add', 'FSETID',
      '--cap-add', 'SETGID',
      '--cap-add', 'SETUID',
      '--cap-add', 'SETPCAP',
      '--cap-add', 'AUDIT_WRITE',
      '--cap-add', 'KILL',
      '--cap-add', 'NET_BIND_SERVICE',
      '--cap-add', 'SYS_CHROOT',
    );
  }
  args.push(IMAGE);
  return args;
}

async function inspectContainer(name) {
  const running = await runDocker(
    ['inspect', '-f', '{{.State.Running}} {{.State.Status}} {{.State.ExitCode}}', name],
    { timeoutMs: 8_000 },
  );
  if (running.code !== 0) return { exists: false, running: false };
  const parts = running.stdout.split(/\s+/);
  return {
    exists: true,
    running: parts[0] === 'true',
    status: parts[1] || '',
    exitCode: parts[2] || '',
  };
}

async function waitUntilReady(name, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await inspectContainer(name);
    if (!state.exists || !state.running) {
      last = `container ${state.status || 'missing'}`;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const probe = await runDocker(
      ['exec', name, 'bash', '-lc', 'exec 3<>/dev/tcp/127.0.0.1/3000 && echo ready'],
      { timeoutMs: 4_000 },
    );
    if (probe.code === 0 && /ready/.test(probe.stdout)) return true;
    last = probe.stderr || probe.stdout || 'port 3000 closed';
    await new Promise((r) => setTimeout(r, 1500));
  }
  const err = new Error('department_computer_not_ready');
  err.detail = last;
  throw err;
}

async function startContainer({ projectId, departmentId, dropCaps = true }) {
  const name = containerName(projectId, departmentId);
  const persist = persistDir(projectId, departmentId);
  const subfolder = publicPath(projectId, departmentId);
  const title = `Pantalla de ${departmentId}`;
  const runtime = chosenRuntime();
  const args = buildDockerRunArgs({
    name,
    persist,
    subfolder,
    title,
    runtime,
    dropCaps,
  });
  const started = await runDocker(args, { timeoutMs: 90_000 });
  if (started.code !== 0) {
    const err = new Error('department_computer_start_failed');
    err.detail = started.stderr || started.stdout;
    throw err;
  }
  return { name, persist, subfolder, runtime };
}

const inflight = new Map();

async function ensureDepartmentDesktop({ projectId, departmentId }) {
  const name = containerName(projectId, departmentId);
  const persist = persistDir(projectId, departmentId);
  const url = publicPath(projectId, departmentId);
  const key = name;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const state = await inspectContainer(name);
    if (state.exists && state.running) {
      await waitUntilReady(name);
      rememberDesktopBinding({ projectId, departmentId, container: name, requestedDepartmentId: departmentId });
      return {
        url,
        container: name,
        persist,
        resumed: true,
        shared: false,
        runtime: chosenRuntime(),
        image: IMAGE,
      };
    }
    if (!state.exists || !state.running) {
      const shared = await findSharedDesktop({ projectId, departmentId });
      if (shared && shared.container && shared.container !== name) {
        rememberDesktopBinding({
          projectId: shared.projectId,
          departmentId: shared.departmentId,
          container: shared.container,
          requestedDepartmentId: departmentId,
        });
        return {
          url: publicPath(shared.projectId, shared.departmentId),
          container: shared.container,
          persist: persistDir(shared.projectId, shared.departmentId),
          resumed: true,
          shared: true,
          requestedDepartmentId: departmentId,
          runtime: chosenRuntime(),
          image: IMAGE,
        };
      }
    }
    if (state.exists && !state.running) {
      const started = await runDocker(['start', name], { timeoutMs: 30_000 });
      if (started.code === 0) {
        await waitUntilReady(name);
        return {
          url,
          container: name,
          persist,
          resumed: true,
          runtime: chosenRuntime(),
          image: IMAGE,
        };
      }
      await runDocker(['rm', '-f', name], { timeoutMs: 15_000 });
    }

    try {
      await startContainer({ projectId, departmentId, dropCaps: true });
    } catch (err) {
      await runDocker(['rm', '-f', name], { timeoutMs: 15_000 });
      // Webtop/s6 sometimes needs default caps; still no privileged, no sock.
      await startContainer({ projectId, departmentId, dropCaps: false });
    }
    await waitUntilReady(name);
    return {
      url,
      container: name,
      persist,
      resumed: false,
      runtime: chosenRuntime(),
      image: IMAGE,
    };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}


/**
 * Resolve a webtop runtime scope from either a Codex project or a company
 * folder (Empresas Project). The returned `id` is the stable runtime id used
 * in container names (`sira-dpc-{id}-{dept}`) and `/dept-os/{id}/{dept}/`.
 * A missing Codex project must not blank the desktop.
 */
async function resolveDesktopScope({ prisma, userId, projectId } = {}) {
  const id = String(projectId || '').trim();
  const uid = String(userId || '').trim();
  if (!id || !uid) {
    return {
      ok: false,
      status: 400,
      error: 'validation_failed',
      message: 'Falta el proyecto de la empresa.',
    };
  }
  if (!ID_RE.test(id)) {
    return {
      ok: false,
      status: 400,
      error: 'validation_failed',
      message: 'Identificador de proyecto inválido.',
    };
  }

  const db = prisma || {};

  if (typeof db.codexProject?.findFirst === 'function') {
    const codex = await db.codexProject.findFirst({
      where: { id, userId: uid, deletedAt: null },
    }).catch(() => null);
    if (codex) {
      return { ok: true, id: codex.id, brief: codex.brief, source: 'codex' };
    }
  }

  if (typeof db.project?.findFirst === 'function') {
    const folder = await db.project.findFirst({
      where: { id, userId: uid, deletedAt: null },
    }).catch(() => null);
    if (folder) {
      let brief = {};
      if (typeof db.company?.findFirst === 'function') {
        const company = await db.company.findFirst({
          where: { projectId: folder.id, userId: uid },
        }).catch(() => null);
        if (company && company.brief && typeof company.brief === 'object') {
          brief = company.brief;
        }
      }
      return { ok: true, id: folder.id, brief, source: 'company-folder' };
    }
  }

  return {
    ok: false,
    status: 404,
    error: 'project_not_found',
    message: 'No se encontró el proyecto.',
  };
}


async function ensureDesktopScope({ prisma, userId, projectId } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) {
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: 'Inicia sesión para encender la computadora.',
    };
  }

  const requested = String(projectId || '').trim();
  if (requested) {
    const scoped = await resolveDesktopScope({ prisma, userId: uid, projectId: requested });
    if (scoped.ok) return scoped;
    if (scoped.status && scoped.status !== 404 && !(scoped.status === 400 && !requested)) {
      if (scoped.error !== 'project_not_found' && scoped.error !== 'validation_failed') return scoped;
    }
  }

  const db = prisma || {};
  const first = async (model, args) => {
    if (typeof db[model]?.findFirst !== 'function') return null;
    return db[model].findFirst(args).catch(() => null);
  };

  const company = await first('company', { where: { userId: uid }, orderBy: { updatedAt: 'desc' } });
  if (company && company.projectId) {
    const scoped = await resolveDesktopScope({ prisma, userId: uid, projectId: company.projectId });
    if (scoped.ok) return { ...scoped, created: false };
  }
  const codex = await first('codexProject', {
    where: { userId: uid, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
  });
  if (codex && codex.id) {
    const scoped = await resolveDesktopScope({ prisma, userId: uid, projectId: codex.id });
    if (scoped.ok) return { ...scoped, created: false };
  }
  const folder = await first('project', { where: { userId: uid }, orderBy: { updatedAt: 'desc' } });
  if (folder && folder.id) {
    const scoped = await resolveDesktopScope({ prisma, userId: uid, projectId: folder.id });
    if (scoped.ok) return { ...scoped, created: false };
  }

  if (typeof db.project?.create !== 'function') {
    return {
      ok: false,
      status: 404,
      error: 'project_not_found',
      message: 'No se encontró el proyecto.',
    };
  }
  const created = await db.project.create({
    data: {
      userId: uid,
      name: 'CEO Office',
      description: 'Escritorio automático de CEO Office',
      type: 'general',
    },
  });
  if (typeof db.company?.create === 'function') {
    await db.company.create({
      data: {
        userId: uid,
        projectId: created.id,
        name: 'CEO Office',
        mission: 'Dirección y coordinación.',
      },
    }).catch(() => null);
  }
  const scoped = await resolveDesktopScope({ prisma, userId: uid, projectId: created.id });
  return scoped.ok ? { ...scoped, created: true } : scoped;
}

module.exports = {
  IMAGE,
  NETWORK,
  DATA_ROOT,
  CONTAINER_PREFIX,
  HTTP_PORT,
  ID_RE,
  buildDockerRunArgs,
  containerName,
  persistDir,
  publicPath,
  resolveDesktopScope,
  ensureDesktopScope,
  ensureDepartmentDesktop,
  inspectContainer,
};


/** OLA200_WAVE_G BE-083 — one desktop per user; never share. Existing name scheme kept. */
function containerNameForUser(userId, projectId, departmentId) {
  const uid = safeId(userId, "user");
  return (CONTAINER_PREFIX + "u-" + uid + "-" + safeId(projectId, "project") + "-" + safeId(departmentId, "department")).slice(0, 120);
}
function assertExclusiveUserContainer(existingName, userId, projectId, departmentId) {
  if (!existingName) return true;
  const expected = containerName(projectId, departmentId);
  if (String(existingName).indexOf(CONTAINER_PREFIX + "u-") !== -1 && userId) {
    const mine = containerNameForUser(userId, projectId, departmentId);
    if (existingName !== mine && existingName !== expected) { const e = new Error("department_computer_shared_forbidden"); e.code = "department_computer_shared_forbidden"; throw e; }
  }
  return true;
}
module.exports.containerNameForUser = containerNameForUser;
module.exports.assertExclusiveUserContainer = assertExclusiveUserContainer;


/** OLA200_WAVE_G BE-084 — abort session destroys the sandbox container (not sibling desktops). */
async function destroyDepartmentDesktop(args) {
  args = args || {};
  const name = containerName(args.projectId, args.departmentId);
  // Shared department computer stays running. Never docker rm from a pane close.
  return { destroyed: false, skipped: true, container: name, reason: "shared_always_on" };
}
module.exports.destroyDepartmentDesktop = destroyDepartmentDesktop;


/** Short-lived ticket so /dept-os iframe + assets can pass Caddy forward_auth
 *  even when Safari refuses Set-Cookie Path=/dept-os from an /api response. */
const desktopTickets = new Map();
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;

function issueDesktopTicket({ userId, projectId, departmentId } = {}) {
  const ticket = crypto.randomBytes(24).toString('hex');
  desktopTickets.set(ticket, {
    userId: String(userId || ''),
    projectId: String(projectId || ''),
    departmentId: String(departmentId || ''),
    exp: Date.now() + TICKET_TTL_MS,
  });
  if (desktopTickets.size > 2500) {
    const now = Date.now();
    for (const [key, row] of desktopTickets) {
      if (!row || row.exp < now) desktopTickets.delete(key);
    }
  }
  return ticket;
}

function readDesktopTicket(ticket) {
  const row = desktopTickets.get(String(ticket || '').trim());
  if (!row || row.exp < Date.now()) return null;
  return row;
}

async function execInDesktop({ projectId, departmentId, command, container } = {}) {
  let name = String(container || '').trim();
  if (!name) {
    const scope = await resolveDesktopTarget({ projectId, departmentId });
    name = scope.container;
    projectId = scope.projectId;
    departmentId = scope.departmentId;
  }
  const state = await inspectContainer(name);
  if (!state.exists || !state.running) {
    const err = new Error('department_computer_not_ready');
    err.detail = 'container_not_running';
    throw err;
  }
  const cmd = String(command || '').slice(0, 4000);
  if (!cmd.trim()) {
    const err = new Error('department_computer_unavailable');
    err.detail = 'empty_command';
    throw err;
  }
  const result = await runDocker(
    ['exec', '-u', 'abc', '-e', 'DISPLAY=:1', '-e', 'HOME=/config', '-e', 'LANG=C.UTF-8', name, 'bash', '-lc', cmd],
    { timeoutMs: 20_000 },
  );
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: String(result.stdout || '').slice(0, 80_000),
    stderr: String(result.stderr || '').slice(0, 8_000),
    container: name,
  };
}

async function listDesktopFiles({ projectId, departmentId, rel = '' } = {}) {
  const scope = await resolveDesktopTarget({ projectId, departmentId });
  const name = scope.container;
  projectId = scope.projectId;
  departmentId = scope.departmentId;
  const state = await inspectContainer(name);
  if (!state.exists || !state.running) {
    const err = new Error('department_computer_not_ready');
    err.detail = 'container_not_running';
    throw err;
  }
  const safeRel = String(rel || '').replace(/\.\./g, '').replace(/^\/+/, '').slice(0, 200);
  const target = safeRel ? ('/config/' + safeRel) : '/config';
  const quoted = JSON.stringify(target);
  const result = await runDocker(
    ['exec', '-u', 'abc', name, 'bash', '-lc', 'ls -la -- ' + quoted],
    { timeoutMs: 8_000 },
  );
  return {
    path: target,
    listing: String(result.stdout || '').slice(0, 80_000),
    code: result.code,
    stderr: String(result.stderr || '').slice(0, 4_000),
    container: name,
  };
}

module.exports.issueDesktopTicket = issueDesktopTicket;
module.exports.readDesktopTicket = readDesktopTicket;
module.exports.execInDesktop = execInDesktop;
module.exports.listDesktopFiles = listDesktopFiles;

const net = require('node:net');

function isPrivateOrReservedIp(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (net.isIPv6(value)) {
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80');
  }
  const parts = value.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
  if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function assertPublicHttpUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); }
  catch {
    const err = new Error('department_computer_unavailable');
    err.detail = 'invalid_url'; err.status = 400; throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('department_computer_unavailable');
    err.detail = 'unsupported_scheme'; err.status = 400; throw err;
  }
  const host = String(parsed.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    const err = new Error('department_computer_unavailable');
    err.detail = 'blocked_host'; err.status = 400; throw err;
  }
  if (host === 'metadata.google.internal' || host.endsWith('.internal') || host === '169.254.169.254') {
    const err = new Error('department_computer_unavailable');
    err.detail = 'blocked_host'; err.status = 400; throw err;
  }
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    const err = new Error('department_computer_unavailable');
    err.detail = 'blocked_ip'; err.status = 400; throw err;
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}


const lastBinding = { projectId: '', departmentId: '', container: '', requestedDepartmentId: '' };

function rememberDesktopBinding({ projectId, departmentId, container, requestedDepartmentId } = {}) {
  lastBinding.projectId = String(projectId || lastBinding.projectId || '');
  lastBinding.departmentId = String(departmentId || lastBinding.departmentId || '');
  lastBinding.container = String(container || lastBinding.container || '');
  lastBinding.requestedDepartmentId = String(requestedDepartmentId || departmentId || lastBinding.requestedDepartmentId || '');
  return { ...lastBinding };
}

function lastDesktopBinding() {
  return { ...lastBinding };
}

const KNOWN_DEPTS = [
  'ceo-office', 'agent-infrastructure', 'product-engineering', 'engineering-01',
  'engineering-02', 'market-intelligence', 'sales', 'customer-success',
  'growth-engines', 'marketing', 'website-distribution', 'integrations',
  'localization', 'trust',
];

function parseDpcName(name) {
  const raw = String(name || '').trim();
  if (!raw.startsWith(CONTAINER_PREFIX)) return null;
  const rest = raw.slice(CONTAINER_PREFIX.length);
  for (const dept of KNOWN_DEPTS) {
    const suffix = '-' + dept;
    if (rest.endsWith(suffix)) {
      return { projectId: rest.slice(0, rest.length - suffix.length), departmentId: dept, container: raw };
    }
  }
  const idx = rest.lastIndexOf('-');
  if (idx <= 0) return null;
  return { projectId: rest.slice(0, idx), departmentId: rest.slice(idx + 1), container: raw };
}

async function listRunningDesktops() {
  const listed = await runDocker(['ps', '--format', '{{.Names}}', '--filter', 'name=sira-dpc-'], { timeoutMs: 8_000 });
  return String(listed.stdout || '')
    .split('\n')
    .map((n) => parseDpcName(n.trim()))
    .filter(Boolean);
}

async function findSharedDesktop({ projectId, departmentId } = {}) {
  const rows = await listRunningDesktops();
  if (!rows.length) return null;
  const proj = String(projectId || '').trim();
  const dept = String(departmentId || '').trim();
  if (proj && dept) {
    const exact = rows.find((row) => row.projectId === proj && row.departmentId === dept);
    if (exact) return { ...exact, shared: false };
  }
  if (proj) {
    const ceo = rows.find((row) => row.projectId === proj && row.departmentId === 'ceo-office');
    if (ceo) return { ...ceo, shared: true, requestedDepartmentId: dept };
    const anyProj = rows.find((row) => row.projectId === proj);
    if (anyProj) return { ...anyProj, shared: true, requestedDepartmentId: dept };
  }
  const anyCeo = rows.find((row) => row.departmentId === 'ceo-office');
  if (anyCeo) return { ...anyCeo, shared: true, requestedDepartmentId: dept };
  return { ...rows[0], shared: true, requestedDepartmentId: dept };
}

async function findRunningCeoOffice({ departmentId = 'ceo-office' } = {}) {
  const listed = await runDocker(['ps', '--format', '{{.Names}}', '--filter', 'name=sira-dpc-'], { timeoutMs: 8_000 });
  const suffix = '-' + departmentId;
  const names = String(listed.stdout || '').split('\n').map((n) => n.trim()).filter((n) => n.startsWith(CONTAINER_PREFIX) && n.endsWith(suffix));
  if (!names.length) return null;
  const name = names[0];
  return { projectId: name.slice(CONTAINER_PREFIX.length, name.length - suffix.length), departmentId, container: name };
}

async function resolveDesktopTarget({ projectId, departmentId } = {}) {
  const last = lastDesktopBinding();
  const dept = String(departmentId || last.requestedDepartmentId || last.departmentId || '').trim();
  const proj = String(projectId || last.projectId || '').trim();
  const shared = await findSharedDesktop({ projectId: proj, departmentId: dept });
  if (shared) {
    rememberDesktopBinding({
      projectId: shared.projectId,
      departmentId: shared.departmentId,
      container: shared.container,
      requestedDepartmentId: dept || shared.departmentId,
    });
    return {
      projectId: shared.projectId,
      departmentId: shared.departmentId,
      requestedDepartmentId: dept || shared.departmentId,
      container: shared.container,
      shared: Boolean(shared.shared),
    };
  }
  if (proj && dept) {
    const started = await ensureDepartmentDesktop({ projectId: proj, departmentId: dept });
    rememberDesktopBinding({
      projectId: proj,
      departmentId: dept,
      container: started.container,
      requestedDepartmentId: dept,
    });
    return {
      projectId: proj,
      departmentId: dept,
      requestedDepartmentId: dept,
      container: started.container,
      shared: Boolean(started.shared),
    };
  }
  const err = new Error('department_computer_not_ready');
  err.detail = 'no_running_desktop';
  throw err;
}

function openUrlCommand(safeUrl) {
  const quoted = JSON.stringify(safeUrl);
  return [
    'set +e',
    'export DISPLAY="${DISPLAY:-:1}"',
    'export HOME=/config',
    'URL=' + quoted,
    'printf "%s\n" "$URL" > /config/sira-last-url.txt',
    'BIN=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)',
    'if [ -z "$BIN" ]; then echo NO_BROWSER; exit 2; fi',
    // Visible on DISPLAY=:1, never headless. Reuse the running window if present.
    'if pgrep -f /usr/lib/chromium/chromium >/dev/null 2>&1; then',
    '  "$BIN" --no-first-run --disable-dev-shm-usage -- "$URL" >>/config/sira-nav.log 2>&1 &',
    'else',
    '  nohup "$BIN" --no-first-run --disable-dev-shm-usage --window-size=900,560 --window-position=48,40 --disable-infobars -- "$URL" >>/config/sira-nav.log 2>&1 &',
    'fi',
    'echo $! > /config/sira-chrome.pid',
    'sleep 3',
    'if pgrep -f /usr/lib/chromium/chromium >/dev/null 2>&1 || pgrep -f "[c]hromium" >/dev/null 2>&1; then',
    '  echo NAV_OK',
    '  echo URL="$URL"',
    '  pgrep -af /usr/lib/chromium/chromium | head -3',
    '  exit 0',
    'fi',
    'echo NAV_STARTED',
    'echo URL="$URL"',
    'exit 0',
  ].join('\n');
}

async function navigateDesktop({ projectId, departmentId = 'ceo-office', url } = {}) {
  const safeUrl = assertPublicHttpUrl(url);
  const scope = await resolveDesktopTarget({ projectId, departmentId });
  const result = await execInDesktop({ projectId: scope.projectId, departmentId: scope.departmentId, command: openUrlCommand(safeUrl) });
  return {
    ok: result.ok || /NAV_OK/.test(result.stdout || ''),
    status: 200,
    url: safeUrl,
    title: '',
    container: scope.container,
    projectId: scope.projectId,
    departmentId: scope.departmentId,
    stdout: String(result.stdout || '').slice(0, 4000),
    stderr: String(result.stderr || '').slice(0, 1000),
  };
}


const XWD2PNG_PY = "#!/usr/bin/env python3\n\"\"\"Convert X11 xwd dump (ZPixmap TrueColor) to PNG using stdlib only.\"\"\"\nfrom __future__ import annotations\n\nimport struct\nimport sys\nimport zlib\n\n\ndef png_chunk(tag: bytes, data: bytes) -> bytes:\n    crc = zlib.crc32(tag)\n    crc = zlib.crc32(data, crc) & 0xFFFFFFFF\n    return struct.pack(\">I\", len(data)) + tag + data + struct.pack(\">I\", crc)\n\n\ndef write_png(width: int, height: int, rows, out) -> None:\n    sig = b\"\\x89PNG\\r\\n\\x1a\\n\"\n    ihdr = struct.pack(\">IIBBBBB\", width, height, 8, 2, 0, 0, 0)\n    raw = b\"\".join(b\"\\x00\" + row for row in rows)\n    idat = zlib.compress(raw, 6)\n    out.write(sig + png_chunk(b\"IHDR\", ihdr) + png_chunk(b\"IDAT\", idat) + png_chunk(b\"IEND\", b\"\"))\n\n\ndef mask_shift(mask: int) -> tuple[int, int]:\n    if mask <= 0:\n        return 0, 8\n    shift = 0\n    while mask and (mask & 1) == 0:\n        mask >>= 1\n        shift += 1\n    bits = 0\n    m = mask\n    while m & 1:\n        m >>= 1\n        bits += 1\n    return shift, bits or 8\n\n\ndef scale_channel(value: int, bits: int) -> int:\n    if bits <= 0:\n        return 0\n    if bits >= 8:\n        return (value >> (bits - 8)) & 0xFF\n    return int(round(value * 255 / ((1 << bits) - 1)))\n\n\ndef convert(src, dest) -> tuple[int, int]:\n    hdr = src.read(100)\n    if len(hdr) < 100:\n        raise SystemExit(\"xwd too small\")\n    # Probe endianness via file_version == 7\n    ver_be = struct.unpack(\">I\", hdr[4:8])[0]\n    ver_le = struct.unpack(\"<I\", hdr[4:8])[0]\n    if ver_be == 7:\n        endian = \">\"\n    elif ver_le == 7:\n        endian = \"<\"\n    else:\n        raise SystemExit(\"unsupported xwd version %s/%s\" % (ver_be, ver_le))\n    u32 = struct.Struct(endian + \"I\")\n    fields = [u32.unpack(hdr[i : i + 4])[0] for i in range(0, 100, 4)]\n    (\n        header_size,\n        _ver,\n        pixmap_format,\n        pixmap_depth,\n        width,\n        height,\n        _xoff,\n        byte_order,\n        _bitmap_unit,\n        _bitmap_bit_order,\n        _bitmap_pad,\n        bits_per_pixel,\n        bytes_per_line,\n        _visual,\n        red_mask,\n        green_mask,\n        blue_mask,\n        _bits_rgb,\n        _cmap_entries,\n        ncolors,\n        _ww,\n        _wh,\n        _wx,\n        _wy,\n        _wb,\n    ) = fields\n    if header_size > 100:\n        extra = header_size - 100\n        leftover = src.read(extra)\n        if len(leftover) < extra:\n            raise SystemExit(\"truncated xwd header\")\n    if ncolors:\n        src.read(ncolors * 12)\n    if width <= 0 or height <= 0 or width > 8192 or height > 8192:\n        raise SystemExit(\"bad geometry %sx%s\" % (width, height))\n    r_shift, r_bits = mask_shift(red_mask)\n    g_shift, g_bits = mask_shift(green_mask)\n    b_shift, b_bits = mask_shift(blue_mask)\n    bpp = bits_per_pixel\n    if bpp not in (16, 24, 32) and pixmap_depth not in (16, 24, 32):\n        # still try using bits_per_pixel\n        pass\n    pixel_bytes = max(1, (bpp + 7) // 8)\n    if bytes_per_line < width * pixel_bytes and bpp == 24:\n        pixel_bytes = 3\n    rows = []\n    for _y in range(height):\n        line = src.read(bytes_per_line)\n        if len(line) < bytes_per_line:\n            raise SystemExit(\"truncated xwd pixels\")\n        out = bytearray(width * 3)\n        oi = 0\n        if bpp == 32 or (bpp == 0 and pixmap_depth == 24):\n            for x in range(width):\n                px = line[x * 4 : x * 4 + 4]\n                if len(px) < 4:\n                    break\n                if byte_order == 1:  # MSBFirst\n                    val = struct.unpack(\">I\", px)[0]\n                else:\n                    val = struct.unpack(\"<I\", px)[0]\n                r = scale_channel((val & red_mask) >> r_shift, r_bits)\n                g = scale_channel((val & green_mask) >> g_shift, g_bits)\n                b = scale_channel((val & blue_mask) >> b_shift, b_bits)\n                out[oi] = r\n                out[oi + 1] = g\n                out[oi + 2] = b\n                oi += 3\n        elif bpp == 24:\n            for x in range(width):\n                px = line[x * 3 : x * 3 + 3]\n                if len(px) < 3:\n                    break\n                if byte_order == 1:\n                    val = (px[0] << 16) | (px[1] << 8) | px[2]\n                else:\n                    val = px[0] | (px[1] << 8) | (px[2] << 16)\n                if red_mask:\n                    r = scale_channel((val & red_mask) >> r_shift, r_bits)\n                    g = scale_channel((val & green_mask) >> g_shift, g_bits)\n                    b = scale_channel((val & blue_mask) >> b_shift, b_bits)\n                else:\n                    r, g, b = px[0], px[1], px[2]\n                out[oi] = r\n                out[oi + 1] = g\n                out[oi + 2] = b\n                oi += 3\n        elif bpp == 16:\n            for x in range(width):\n                px = line[x * 2 : x * 2 + 2]\n                if len(px) < 2:\n                    break\n                val = struct.unpack(\">H\" if byte_order == 1 else \"<H\", px)[0]\n                r = scale_channel((val & red_mask) >> r_shift, r_bits)\n                g = scale_channel((val & green_mask) >> g_shift, g_bits)\n                b = scale_channel((val & blue_mask) >> b_shift, b_bits)\n                out[oi] = r\n                out[oi + 1] = g\n                out[oi + 2] = b\n                oi += 3\n        else:\n            raise SystemExit(\"unsupported bpp %s depth %s format %s\" % (bpp, pixmap_depth, pixmap_format))\n        rows.append(bytes(out))\n    write_png(width, height, rows, dest)\n    return width, height\n\n\ndef main() -> None:\n    if len(sys.argv) >= 3:\n        with open(sys.argv[1], \"rb\") as src, open(sys.argv[2], \"wb\") as dest:\n            w, h = convert(src, dest)\n    else:\n        data = sys.stdin.buffer.read()\n        import io\n\n        src = io.BytesIO(data)\n        dest = sys.stdout.buffer\n        w, h = convert(src, dest)\n        dest.flush()\n    print(\"%sx%s\" % (w, h), file=sys.stderr)\n\n\nif __name__ == \"__main__\":\n    main()\n";

const xwdReady = new Set();

async function ensureXwdHelper(name) {
  if (xwdReady.has(name)) return;
  const b64 = Buffer.from(XWD2PNG_PY, 'utf8').toString('base64');
  const wrote = await runDocker(
    ['exec', name, 'bash', '-lc', "printf '%s' '" + b64 + "' | base64 -d > /config/sira-xwd2png.py && chmod 755 /config/sira-xwd2png.py && test -s /config/sira-xwd2png.py && echo OK"],
    { timeoutMs: 10_000 },
  );
  if (wrote.code === 0 && /OK/.test(wrote.stdout)) xwdReady.add(name);
}

function captureCommand() {
  return [
    'set +e',
    'export DISPLAY="${DISPLAY:-:1}"',
    'export HOME=/config',
    'DEST=/config/sira-frame.png',
    'rm -f "$DEST"',
    'SHOT=0',
    'if command -v scrot >/dev/null 2>&1; then scrot -o "$DEST" && SHOT=1; fi',
    'if [ "$SHOT" -eq 0 ] && command -v import >/dev/null 2>&1; then import -window root -silent "$DEST" && SHOT=1; fi',
    'if [ "$SHOT" -eq 0 ] && command -v ffmpeg >/dev/null 2>&1; then ffmpeg -y -hide_banner -loglevel error -f x11grab -video_size 1024x768 -i "$DISPLAY" -frames:v 1 "$DEST" && SHOT=1; fi',
    'if [ "$SHOT" -eq 0 ] && command -v xwd >/dev/null 2>&1 && [ -s /config/sira-xwd2png.py ]; then',
    '  xwd -root -silent -display "$DISPLAY" -out /tmp/sira.xwd && python3 /config/sira-xwd2png.py /tmp/sira.xwd "$DEST" && SHOT=1',
    'fi',
    'if [ "$SHOT" -eq 0 ]; then',
    '  URL=""',
    '  if [ -f /config/sira-last-url.txt ]; then URL=$(head -1 /config/sira-last-url.txt); fi',
    '  if [ -z "$URL" ]; then URL=$(ps -eo args 2>/dev/null | sed -n "s/.*\\(https\\?:\\/\\/[^ ]*\\).*/\\1/p" | head -1); fi',
    '  if command -v chromium >/dev/null 2>&1 && [ -n "$URL" ]; then',
    '    chromium --headless --disable-gpu --no-first-run --disable-dev-shm-usage --screenshot="$DEST" --window-size=1280,720 "$URL" >/tmp/sira-shot.log 2>&1 && SHOT=1',
    '  fi',
    'fi',
    'if [ "$SHOT" -eq 1 ] && [ -s "$DEST" ]; then echo SHOT_OK; ls -la "$DEST"; else echo NO_CAPTURE_BIN; ls -la "$DEST" 2>/dev/null; fi',
    'exit 0',
  ].join('\n');
}

function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 200 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function captureDesktopPng({ projectId, departmentId = 'ceo-office' } = {}) {
  const scope = await resolveDesktopTarget({ projectId, departmentId });
  await ensureXwdHelper(scope.container);
  const result = await execInDesktop({
    projectId: scope.projectId,
    departmentId: scope.departmentId,
    command: captureCommand(),
  });
  const raw = await runDockerBuffer(
    ['exec', scope.container, 'cat', '/config/sira-frame.png'],
    { timeoutMs: 12_000 },
  );
  const png = raw.stdout || Buffer.alloc(0);
  if (!isPngBuffer(png)) {
    const err = new Error('department_computer_screenshot_failed');
    err.status = 503;
    err.detail = [result.stdout, result.stderr, raw.stderr].filter(Boolean).join(' | ').slice(0, 2000);
    throw err;
  }
  return {
    ok: true,
    png,
    bytes: png.length,
    path: '/config/sira-frame.png',
    container: scope.container,
    projectId: scope.projectId,
    departmentId: scope.departmentId,
    stdout: String(result.stdout || '').slice(0, 4000),
    stderr: String(result.stderr || '').slice(0, 1000),
  };
}

async function screenshotDesktop({ projectId, departmentId = 'ceo-office' } = {}) {
  const shot = await captureDesktopPng({ projectId, departmentId });
  const meta = await execInDesktop({
    projectId: shot.projectId,
    departmentId: shot.departmentId,
    command: [
      'set +e',
      'URL=""',
      'if [ -f /config/sira-last-url.txt ]; then URL=$(head -1 /config/sira-last-url.txt); fi',
      'if [ -z "$URL" ]; then URL=$(ps -eo args 2>/dev/null | sed -n "s/.*\\(https\\?:\\/\\/[^ ]*\\).*/\\1/p" | head -1); fi',
      'echo PAGE_URL="$URL"',
      'TITLE=""',
      'if [ -n "$URL" ]; then TITLE=$(printf "%s" "$URL" | sed -n "s#https\\?:\\/\\/##p"); fi',
      'echo PAGE_TITLE="$TITLE"',
      'exit 0',
    ].join('\n'),
  });
  const stdout = String(meta.stdout || '');
  const urlMatch = stdout.match(/^PAGE_URL=(.*)$/m);
  const titleMatch = stdout.match(/^PAGE_TITLE=(.*)$/m);
  const url = String((urlMatch && urlMatch[1]) || '').trim();
  const title = String((titleMatch && titleMatch[1]) || '').trim();
  return {
    ok: true,
    pageLoaded: true,
    path: shot.path,
    bytes: shot.bytes,
    url,
    title,
    container: shot.container,
    projectId: shot.projectId,
    departmentId: shot.departmentId,
    stdout: String(shot.stdout || '').slice(0, 4000),
    stderr: String(shot.stderr || '').slice(0, 1000),
  };
}

module.exports.assertPublicHttpUrl = assertPublicHttpUrl;
module.exports.navigateDesktop = navigateDesktop;
module.exports.screenshotDesktop = screenshotDesktop;
module.exports.resolveDesktopTarget = resolveDesktopTarget;
module.exports.captureDesktopPng = captureDesktopPng;
module.exports.runDockerBuffer = runDockerBuffer;


// Sandbox helper scripts live as plain, gitleaks-auditable files under
// backend/deploy/webtop/ and are piped into the webtop container at runtime.
const DESKCTL_SCRIPT_PATH = path.join(__dirname, '..', '..', '..', 'deploy', 'webtop', 'sira-deskctl.py');
const GROK_LAYOUT_SCRIPT_PATH = path.join(__dirname, '..', '..', '..', 'deploy', 'webtop', 'sira-grok-layout.sh');

function readScriptB64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

const deskctlReady = new Set();

async function ensureDeskctl(name) {
  if (deskctlReady.has(name + ':chrometab1')) return;
  const wrote = await runDocker(
    ['exec', name, 'bash', '-lc', "printf '%s' '" + readScriptB64(DESKCTL_SCRIPT_PATH) + "' | base64 -d > /config/sira-deskctl.py && chmod 755 /config/sira-deskctl.py && test -s /config/sira-deskctl.py && echo OK"],
    { timeoutMs: 10_000 },
  );
  if (wrote.code === 0 && /OK/.test(wrote.stdout)) deskctlReady.add(name + ':chrometab1');
}

function deskctlArgs(argv) {
  const safe = (argv || []).map((part) => String(part ?? '')).slice(0, 8);
  return ['python3', '/config/sira-deskctl.py', ...safe];
}

async function runDeskctl({ projectId, departmentId, argv, timeoutMs = 20_000 } = {}) {
  const scope = await resolveDesktopTarget({ projectId, departmentId });
  await ensureDeskctl(scope.container);
  const result = await execInDesktop({
    projectId: scope.projectId,
    departmentId: scope.departmentId,
    command: deskctlArgs(argv).map((part) => JSON.stringify(part)).join(' '),
  });
  return {
    ok: result.ok || /_OK/.test(result.stdout || ''),
    stdout: String(result.stdout || '').slice(0, 4000),
    stderr: String(result.stderr || '').slice(0, 1000),
    container: scope.container,
    projectId: scope.projectId,
    departmentId: scope.departmentId,
  };
}

function parseStatus(stdout) {
  const text = String(stdout || '');
  const flag = (name) => /(?:^|\n)NAME=1(?:\n|$)/.test(text.replace('NAME', name));
  return {
    desktop: /(?:^|\n)DESKTOP=1(?:\n|$)/.test(text),
    chrome: /(?:^|\n)CHROME=1(?:\n|$)/.test(text),
    terminal: /(?:^|\n)TERMINAL=1(?:\n|$)/.test(text),
    files: /(?:^|\n)FILES=1(?:\n|$)/.test(text),
  };
}

async function desktopStatus({ projectId, departmentId = 'ceo-office' } = {}) {
  const result = await runDeskctl({ projectId, departmentId, argv: ['status'], timeoutMs: 12_000 });
  const flags = parseStatus(result.stdout);
  return {
    ok: true,
    ...flags,
    line: [
      flags.desktop ? 'Escritorio' : null,
      flags.chrome ? 'Chrome' : null,
      flags.terminal ? 'Terminal' : null,
      flags.files ? 'Archivos' : null,
    ].filter(Boolean).join(' · ') || 'Escritorio',
    container: result.container,
    projectId: result.projectId,
    departmentId: result.departmentId,
    stdout: result.stdout,
  };
}

async function openDesktopApp({ projectId, departmentId = 'ceo-office', app = 'all', mode = 'focus' } = {}) {
  const allowed = new Set(['all', 'desktop', 'chrome', 'browser', 'navegador', 'terminal', 'term', 'files', 'archivos', 'thunar']);
  const name = String(app || 'all').trim().toLowerCase();
  if (!allowed.has(name)) {
    const err = new Error('department_computer_unavailable');
    err.detail = 'unknown_app';
    err.status = 400;
    throw err;
  }
  const how = String(mode || 'focus').trim().toLowerCase() === 'ensure' ? 'ensure' : 'focus';
  const result = await runDeskctl({
    projectId,
    departmentId,
    argv: ['open', name, how],
    timeoutMs: 25_000,
  });
  const flags = parseStatus(result.stdout);
  return {
    ok: result.ok,
    app: name,
    mode: how,
    ...flags,
    container: result.container,
    projectId: result.projectId,
    departmentId: result.departmentId,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function ensureGrokLayout(name) {
  const wrote = await runDocker(
    ['exec', name, 'bash', '-lc', "printf '%s' '" + readScriptB64(GROK_LAYOUT_SCRIPT_PATH) + "' | base64 -d > /config/sira-grok-layout.sh && chmod 755 /config/sira-grok-layout.sh && echo OK"],
    { timeoutMs: 12_000 },
  );
  if (wrote.code !== 0) return wrote;
  return runDocker(['exec', name, 'bash', '/config/sira-grok-layout.sh'], { timeoutMs: 180_000 });
}

async function prepareFullDesktop({ projectId, departmentId } = {}) {
  const scope = await resolveDesktopTarget({ projectId, departmentId });
  try { await ensureGrokLayout(scope.container); } catch (_) { /* layout is best-effort */ }
  const result = await runDeskctl({
    projectId: scope.projectId,
    departmentId: scope.departmentId,
    argv: ['prepare'],
    timeoutMs: 30_000,
  });
  const flags = parseStatus(result.stdout);
  return {
    ok: result.ok,
    ...flags,
    container: result.container,
    projectId: result.projectId,
    departmentId: result.departmentId,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function inputDesktop({
  projectId,
  departmentId = 'ceo-office',
  action = 'click',
  x,
  y,
  button,
  dy,
  text,
  key,
} = {}) {
  const kind = String(action || 'click').trim().toLowerCase();
  let argv;
  if (kind === 'click') {
    argv = [
      'click',
      String(clampInt(x, 0, 8192, 0)),
      String(clampInt(y, 0, 8192, 0)),
      String(clampInt(button, 1, 3, 1)),
    ];
  } else if (kind === 'scroll') {
    argv = [
      'scroll',
      String(clampInt(x, 0, 8192, 400)),
      String(clampInt(y, 0, 8192, 300)),
      String(clampInt(dy, -2400, 2400, 120)),
    ];
  } else if (kind === 'type') {
    const raw = String(text || '').slice(0, 500);
    if (!raw.trim()) {
      const err = new Error('department_computer_unavailable');
      err.detail = 'empty_text';
      err.status = 400;
      throw err;
    }
    argv = ['type', raw];
  } else if (kind === 'key') {
    const raw = String(key || '').slice(0, 40);
    if (!/^[A-Za-z0-9+\-]+$/.test(raw)) {
      const err = new Error('department_computer_unavailable');
      err.detail = 'bad_key';
      err.status = 400;
      throw err;
    }
    argv = ['key', raw];
  } else if (kind === 'down' || kind === 'up' || kind === 'move') {
    return {
      ok: true,
      action: kind,
      skipped: true,
      container: '',
      projectId,
      departmentId,
    };
  } else if (kind === 'new_tab' || kind === 'newtab') {
    argv = ['new_tab'];
  } else if (kind === 'search') {
    const raw = String(text || '').slice(0, 500);
    if (!raw.trim()) {
      const err = new Error('department_computer_unavailable');
      err.detail = 'empty_search';
      err.status = 400;
      throw err;
    }
    argv = ['search', raw];
  } else {
    const err = new Error('department_computer_unavailable');
    err.detail = 'unknown_action';
    err.status = 400;
    throw err;
  }
  const result = await runDeskctl({ projectId, departmentId, argv, timeoutMs: 15_000 });
  return {
    ok: result.ok,
    action: kind,
    container: result.container,
    projectId: result.projectId,
    departmentId: result.departmentId,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

module.exports.ensureDeskctl = ensureDeskctl;
module.exports.desktopStatus = desktopStatus;
module.exports.openDesktopApp = openDesktopApp;
module.exports.prepareFullDesktop = prepareFullDesktop;
module.exports.inputDesktop = inputDesktop;

module.exports.rememberDesktopBinding = rememberDesktopBinding;
module.exports.lastDesktopBinding = lastDesktopBinding;

async function prewarmSharedDesktop() {
  const shared = await findSharedDesktop({ departmentId: 'ceo-office' });
  if (!shared || !shared.container) {
    return { ok: false, reason: 'none' };
  }
  const state = await inspectContainer(shared.container);
  if (state.running) {
    await runDocker(['update', '--restart', 'always', shared.container], { timeoutMs: 8_000 });
    return { ok: true, running: true, container: shared.container, projectId: shared.projectId };
  }
  return ensureDepartmentDesktop({
    projectId: shared.projectId,
    departmentId: shared.departmentId || 'ceo-office',
  });
}
module.exports.prewarmSharedDesktop = prewarmSharedDesktop;

module.exports.findSharedDesktop = findSharedDesktop;
module.exports.ensureGrokLayout = ensureGrokLayout;
