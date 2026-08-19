'use strict';

/**
 * codex-test-utils — shared doubles for the Codex Agent V2 integration tests
 * (feature 15): a small in-memory Prisma fake covering every codex_* model +
 * user, and a runner-client backed by REAL git in a tmpdir (so the git sequence
 * is validated end-to-end, not mocked).
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

function matches(row, where) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    if (v && typeof v === 'object' && 'gt' in v) return row[k] > v.gt;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // relation filter e.g. project: { userId } — resolved by the caller's seed
      return true;
    }
    return row[k] === v;
  });
}

function makeTable() {
  const rows = [];
  let n = 0;
  const api = {
    rows,
    async create({ data }) { const row = { id: data.id || `id_${++n}`, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
    async findUnique({ where }) { return rows.find((r) => matches(r, where)) ? { ...rows.find((r) => matches(r, where)) } : null; },
    async findFirst({ where = {}, orderBy }) {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy) out = sortBy(out, orderBy);
      return out[0] ? { ...out[0] } : null;
    },
    async findMany({ where = {}, orderBy, take }) {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy) out = sortBy(out, orderBy);
      if (take) out = out.slice(0, take);
      return out.map((r) => ({ ...r }));
    },
    async update({ where, data }) { const r = rows.find((x) => matches(x, where)); Object.assign(r, data, { updatedAt: new Date() }); return { ...r }; },
    async updateMany({ where, data }) { const ms = rows.filter((x) => matches(x, where)); ms.forEach((r) => Object.assign(r, data)); return { count: ms.length }; },
    async upsert({ where, create, update }) {
      const r = rows.find((x) => matches(x, where));
      if (r) { Object.assign(r, update); return { ...r }; }
      return api.create({ data: { ...create } });
    },
    async count({ where = {} }) { return rows.filter((r) => matches(r, where)).length; },
    async aggregate({ where = {}, _max }) {
      const mine = rows.filter((r) => matches(r, where));
      const out = { _max: {} };
      if (_max) for (const k of Object.keys(_max)) out._max[k] = mine.length ? Math.max(...mine.map((r) => r[k] ?? 0)) : null;
      return out;
    },
  };
  return api;
}

function sortBy(rows, orderBy) {
  const [field, dir] = Object.entries(orderBy)[0];
  return rows.slice().sort((a, b) => {
    const av = a[field] instanceof Date ? a[field].getTime() : a[field];
    const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
    return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
}

/** In-memory Prisma fake covering the models the codex pipeline touches. */
function makeFakePrisma({ user } = {}) {
  const db = {
    codexProject: makeTable(),
    codexRun: makeTable(),
    codexEvent: makeTable(),
    codexAction: makeTable(),
    codexCheckpoint: makeTable(),
    codexRunMetric: makeTable(),
    user: makeTable(),
  };
  if (user) db.user.rows.push({ id: user.id, plan: user.plan || 'FREE' });
  // checkpoint-service uses a relation filter { project: { userId } }; resolve it
  // by patching findFirst to honour the project-owner check against seeded projects.
  const origCpFindFirst = db.codexCheckpoint.findFirst;
  db.codexCheckpoint.findFirst = async ({ where = {} }) => {
    const { project, ...rest } = where;
    const cp = await origCpFindFirst({ where: rest });
    if (!cp) return null;
    if (project && project.userId) {
      const proj = db.codexProject.rows.find((p) => p.id === cp.projectId);
      if (!proj || proj.userId !== project.userId) return null;
    }
    return cp;
  };
  return db;
}

/** Runner-client implemented against REAL git in a tmpdir. */
function makeGitRunner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
  const dirFor = (project) => path.join(root, 'projects', project);
  let devRunning = false;
  return {
    root,
    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
    runner: {
      initWorkspace: async (project) => {
        const dir = dirFor(project);
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 'codex@siragpt.local'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 'Codex Agent'], { cwd: dir });
        execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
        return { ok: true, dir: `projects/${project}` };
      },
      writeFiles: async (project, files) => {
        for (const f of files) {
          const full = path.join(dirFor(project), f.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, f.content);
        }
        return { ok: true, written: files.length };
      },
      readFile: async (project, p) => ({ content: fs.readFileSync(path.join(dirFor(project), p), 'utf8') }),
      exec: async (project, cmd) => {
        try {
          const stdout = execFileSync(cmd[0], cmd.slice(1), { cwd: dirFor(project), encoding: 'utf8' });
          return { exitCode: 0, stdout, stderr: '' };
        } catch (err) {
          return { exitCode: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || String(err.message) };
        }
      },
      startDev: async () => { devRunning = true; return { ok: true, port: 5173 }; },
      devStatus: async () => ({ running: devRunning, ready: devRunning }),
      stopDev: async () => { devRunning = false; return { ok: true }; },
    },
  };
}

module.exports = { makeFakePrisma, makeGitRunner, gitAvailable };
