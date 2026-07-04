'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, toolRegistry, getTool, lineCount, parsePrismaSchema, normalisePlanTasks, normalisePackageSpecs } = require('../src/services/codex/build-tools');

function fakeRunner(overrides = {}) {
  return {
    exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    readFile: async () => ({ content: 'line1\nline2\nline3' }),
    writeFiles: async () => ({ ok: true, written: 1 }),
    ...overrides,
  };
}

test('toolRegistry projects name/description/parameters for every tool', () => {
  const reg = toolRegistry();
  assert.deepEqual(
    reg.map((t) => t.name).sort(),
    ['browser_check', 'dev_server_check', 'edit_file', 'grep_search', 'inspect_database', 'install_dependencies', 'list_files', 'read_file', 'repo_map', 'run_command', 'run_subagent', 'type_check', 'update_plan', 'use_skill', 'web_search', 'write_file'],
  );
  for (const t of reg) { assert.ok(t.description); assert.ok(t.parameters); }
});

test('run_command returns exit code; non-zero is a tool error (not a throw)', async () => {
  const ok = await TOOLS.run_command.execute({ cmd: ['git', 'status'] }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(ok.isError, false);
  assert.match(ok.observation, /exitCode=0/);

  const bad = await TOOLS.run_command.execute({ cmd: ['bun', 'run', 'x'] }, { runner: fakeRunner({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) }), project: 'p1' });
  assert.equal(bad.isError, true);
  assert.match(bad.summary, /exit 1/);
});

test('run_command rejects a non-array cmd', async () => {
  const r = await TOOLS.run_command.execute({ cmd: 'git status' }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, true);
});

test('read_file counts lines read', async () => {
  const r = await TOOLS.read_file.execute({ path: 'src/main.js' }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, false);
  assert.equal(r.linesRead, 3);
  assert.equal(TOOLS.read_file.pathFor({ path: 'src/main.js' }), 'src/main.js');
});

test('write_file writes content and reports bytes', async () => {
  let captured = null;
  const runner = fakeRunner({ writeFiles: async (p, files) => { captured = files; return { ok: true }; } });
  const r = await TOOLS.write_file.execute({ path: 'a.txt', content: 'hola' }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.deepEqual(captured, [{ path: 'a.txt', content: 'hola' }]);
  assert.match(r.summary, /4 bytes/);
});

test('edit_file replaces an exact match and errors when not found', async () => {
  let written = null;
  const runner = fakeRunner({ readFile: async () => ({ content: 'const x = 1;' }), writeFiles: async (p, f) => { written = f; return {}; } });
  const ok = await TOOLS.edit_file.execute({ path: 'a.js', find: 'x = 1', replace: 'x = 2' }, { runner, project: 'p1' });
  assert.equal(ok.isError, false);
  assert.equal(written[0].content, 'const x = 2;');

  const miss = await TOOLS.edit_file.execute({ path: 'a.js', find: 'nope', replace: 'y' }, { runner: fakeRunner({ readFile: async () => ({ content: 'const x = 1;' }) }), project: 'p1' });
  assert.equal(miss.isError, true);
  assert.match(miss.observation, /no existe/);
});

test('web_search returns titles/snippets and degrades without an adapter', async () => {
  const withAdapter = await TOOLS.web_search.execute({ query: 'vite docs' }, { webSearch: async () => [{ title: 'Vite', snippet: 'build tool' }] });
  assert.equal(withAdapter.isError, false);
  assert.match(withAdapter.observation, /Vite/);

  const noAdapter = await TOOLS.web_search.execute({ query: 'x' }, {});
  assert.equal(noAdapter.isError, true);
});

test('install_dependencies validates package specs and runs bun add safely', async () => {
  const calls = [];
  const runner = fakeRunner({
    readFile: async (_project, path) => {
      assert.equal(path, 'package.json');
      return { content: '{"dependencies":{"lucide-react":"latest"}}' };
    },
    exec: async (_project, cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: 'installed', stderr: '' };
    },
  });
  const r = await TOOLS.install_dependencies.execute({ packages: ['lucide-react', 'zod@^3.23.8'], dev: true }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.deepEqual(calls[0], ['bun', 'add', '-d', 'lucide-react', 'zod@^3.23.8']);
  assert.match(r.observation, /type_check/);
  assert.equal(TOOLS.install_dependencies.pathFor({}), 'package.json');
});

test('install_dependencies rejects unsafe package specs', async () => {
  assert.equal(normalisePackageSpecs(['lucide-react', '@vitejs/plugin-react']).length, 2);
  assert.equal(normalisePackageSpecs(['react && rm -rf /']), null);
  assert.equal(normalisePackageSpecs(['https://example.com/x.tgz']), null);
  assert.equal(normalisePackageSpecs(['--force']), null);
  const r = await TOOLS.install_dependencies.execute({ packages: ['react && rm -rf /'] }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, true);
});

test('getTool + lineCount helpers', () => {
  assert.equal(getTool('read_file').kind, 'file_read');
  assert.equal(getTool('nope'), null);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount(''), 0);
});

// ---------------------------------------------------------------------------
// update_plan (G1): TodoWrite parity — validates the shape and returns the
// normalised plan tasks the loop turns into a plan_updated event. Touches no
// filesystem.

test('update_plan validates the shape and returns normalised planTasks', async () => {
  const r = await TOOLS.update_plan.execute({
    tasks: [
      { id: 't1', title: 'Estructura', status: 'completed' },
      { id: 't2', title: 'Estilos', status: 'in_progress' },
      { id: 't3', title: 'Deploy', status: 'pending' },
    ],
  }, {});
  assert.equal(r.isError, false);
  assert.deepEqual(r.planTasks, [
    { id: 't1', title: 'Estructura', status: 'completed' },
    { id: 't2', title: 'Estilos', status: 'in_progress' },
    { id: 't3', title: 'Deploy', status: 'pending' },
  ]);
  assert.match(r.summary, /1\/3 completadas/);
  assert.equal(TOOLS.update_plan.kind, 'terminal');
  assert.equal(TOOLS.update_plan.commandFor(), 'update plan');
});

test('update_plan derives a missing title from the id but requires id + a known status', async () => {
  const ok = await TOOLS.update_plan.execute({ tasks: [{ id: 't1', status: 'pending' }] }, {});
  assert.equal(ok.isError, false);
  assert.equal(ok.planTasks[0].title, 't1');

  const badStatus = await TOOLS.update_plan.execute({ tasks: [{ id: 't1', title: 'x', status: 'doing' }] }, {});
  assert.equal(badStatus.isError, true);

  const noId = await TOOLS.update_plan.execute({ tasks: [{ title: 'x', status: 'pending' }] }, {});
  assert.equal(noId.isError, true);

  const notArray = await TOOLS.update_plan.execute({ tasks: 'nope' }, {});
  assert.equal(notArray.isError, true);

  const empty = await TOOLS.update_plan.execute({ tasks: [] }, {});
  assert.equal(empty.isError, true);
});

test('normalisePlanTasks returns null on unrecoverable shapes', () => {
  assert.equal(normalisePlanTasks(null), null);
  assert.equal(normalisePlanTasks([{ id: '', status: 'pending' }]), null);
  assert.equal(normalisePlanTasks([{ id: 't1', status: 'nope' }]), null);
  assert.deepEqual(normalisePlanTasks([{ id: 't1', status: 'completed' }]), [{ id: 't1', title: 't1', status: 'completed' }]);
});

const PRISMA_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
enum Role { USER ADMIN }
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())
}
model Post {
  id       String @id @default(cuid())
  title    String
  authorId String
}
`;

test('parsePrismaSchema extracts provider, models with fields, and enums', () => {
  const s = parsePrismaSchema(PRISMA_SCHEMA);
  assert.equal(s.provider, 'postgresql');
  assert.deepEqual(s.models.map((m) => m.name), ['User', 'Post']);
  assert.equal(s.models[0].fields.length, 5);
  assert.equal(s.models[0].fields[1].name, 'email');
  assert.match(s.models[0].fields[1].attrs, /@unique/);
  assert.deepEqual(s.enums, [{ name: 'Role', values: ['USER ADMIN'] }]);
});

test('inspect_database summarises the Prisma schema (no live connection)', async () => {
  const runner = fakeRunner({ readFile: async (_p, path) => { assert.equal(path, 'prisma/schema.prisma'); return { content: PRISMA_SCHEMA }; } });
  const r = await TOOLS.inspect_database.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.equal(r.models, 2);
  assert.match(r.observation, /Provider: postgresql/);
  assert.match(r.observation, /User \(5 campos\)/);
  assert.equal(TOOLS.inspect_database.kind, 'database');
  assert.equal(TOOLS.inspect_database.pathFor({}), 'prisma/schema.prisma');
});

test('inspect_database treats a missing schema as informational, not an error', async () => {
  const runner = fakeRunner({ readFile: async () => { throw new Error('ENOENT'); } });
  const r = await TOOLS.inspect_database.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.match(r.observation, /no tiene base de datos|no se encontró/i);
});

test('inspect_database honours an explicit path', async () => {
  let seen = null;
  const runner = fakeRunner({ readFile: async (_p, path) => { seen = path; return { content: PRISMA_SCHEMA }; } });
  await TOOLS.inspect_database.execute({ path: 'db/schema.prisma' }, { runner, project: 'p1' });
  assert.equal(seen, 'db/schema.prisma');
});

// ---------------------------------------------------------------------------
// dev_server_check: slot hygiene (audit G5) — the tool must stop a dev server
// it started only for the check, but must NOT stop a pre-existing one (the
// user's live preview).

test('dev_server_check stops the dev server it started (no pre-existing preview)', async () => {
  const calls = { start: 0, stop: 0, stoppedProject: null };
  const runner = fakeRunner({
    devStatus: async () => ({ running: false }),
    startDev: async () => { calls.start += 1; return { ok: true }; },
    stopDev: async (p) => { calls.stop += 1; calls.stoppedProject = p; return { ok: true }; },
  });
  // Second devStatus (after start) reports ready so the wait loop breaks fast.
  let n = 0;
  runner.devStatus = async () => { n += 1; return n === 1 ? { running: false } : { running: true, project: 'p1', ready: true, tail: ['ready'] }; };
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.equal(calls.start, 1, 'arrancó el server');
  assert.equal(calls.stop, 1, 'lo paró al terminar (sin fuga de slot)');
  assert.equal(calls.stoppedProject, 'p1');
});

test('dev_server_check does NOT stop a pre-existing dev server (user preview)', async () => {
  const calls = { start: 0, stop: 0 };
  const runner = fakeRunner({
    devStatus: async () => ({ running: true, project: 'p1', ready: true, tail: ['ready'] }),
    startDev: async () => { calls.start += 1; return { ok: true }; },
    stopDev: async () => { calls.stop += 1; return { ok: true }; },
  });
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.equal(calls.start, 0, 'no rearranca el preview del usuario');
  assert.equal(calls.stop, 0, 'NO para el preview del usuario');
});
