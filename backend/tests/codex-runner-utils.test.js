'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
  commandRejectionReason,
  shouldIgnoreExportPath,
  buildRunnerEnv,
  isControlRequestAuthorized,
  controlTokenForEnv,
  projectIdentity,
  sandboxCommand,
} = require('../../scripts/code-runner-utils');
const {
  safeWriteFiles,
  safeReadFile,
  collectExportFiles,
  migrateOwnershipTree,
  sealWorkspaceRoot,
} = require('../../scripts/code-runner-fs-helper');

test('sanitizeProjectId accepts cuid-like ids and rejects everything else', () => {
  assert.equal(sanitizeProjectId('cmbx1y2z30000abcd1234efgh'), 'cmbx1y2z30000abcd1234efgh');
  assert.equal(sanitizeProjectId('proj_1-A'), 'proj_1-A');
  assert.equal(sanitizeProjectId('../etc'), null);
  assert.equal(sanitizeProjectId('a b'), null);
  assert.equal(sanitizeProjectId(''), null);
  assert.equal(sanitizeProjectId(null), null);
  assert.equal(sanitizeProjectId('x'.repeat(65)), null);
});

test('resolveProjectRelPath normalizes and blocks traversal/absolute paths', () => {
  assert.equal(resolveProjectRelPath('src/main.js'), 'src/main.js');
  assert.equal(resolveProjectRelPath('./a//b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('a\\b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('../secret'), null);
  assert.equal(resolveProjectRelPath('a/../../b'), null);
  assert.equal(resolveProjectRelPath('/etc/passwd'), null);
  assert.equal(resolveProjectRelPath('C:/windows'), null);
  assert.equal(resolveProjectRelPath(''), null);
});

test('isAllowedCommand allows git/bun/bunx/node and blocks the rest', () => {
  assert.equal(isAllowedCommand(['git', 'init']), true);
  assert.equal(isAllowedCommand(['bun', 'install']), true);
  assert.equal(isAllowedCommand(['rm', '-rf', '/']), false);
  assert.equal(isAllowedCommand(['sh', '-c', 'echo hi']), false);
  assert.equal(isAllowedCommand([]), false);
  assert.equal(isAllowedCommand('git init'), false);
  assert.equal(isAllowedCommand(['git', 42]), false);
});

test('isAllowedCommand blocks interactive scaffolds that should be written by tools', () => {
  assert.equal(isAllowedCommand(['bunx', 'create-next-app@latest', '.']), false);
  assert.equal(isAllowedCommand(['bunx', 'create-vite', '.']), false);
  assert.equal(isAllowedCommand(['bun', 'create', 'vite', '.']), false);
  assert.match(commandRejectionReason(['bunx', 'create-next-app@latest', '.']), /interactive_scaffold_disallowed/);
  assert.equal(commandRejectionReason(['bun', 'install']), null);
});

test('shouldIgnoreExportPath keeps source but skips generated/heavy dirs', () => {
  // Source files the user wants on disk → copied.
  assert.equal(shouldIgnoreExportPath('package.json'), false);
  assert.equal(shouldIgnoreExportPath('src/main.tsx'), false);
  assert.equal(shouldIgnoreExportPath('public/logo.svg'), false);
  assert.equal(shouldIgnoreExportPath('a/b/c.ts'), false);
  // Generated/heavy trees → never mirrored, at any depth, backslashes too.
  assert.equal(shouldIgnoreExportPath('node_modules/react/index.js'), true);
  assert.equal(shouldIgnoreExportPath('.git/HEAD'), true);
  assert.equal(shouldIgnoreExportPath('dist/bundle.js'), true);
  assert.equal(shouldIgnoreExportPath('.next/cache/x'), true);
  assert.equal(shouldIgnoreExportPath('src/node_modules/dep/x.js'), true);
  assert.equal(shouldIgnoreExportPath('build\\out.js'), true);
  // Empty/blank → ignored (nothing to copy).
  assert.equal(shouldIgnoreExportPath(''), true);
  assert.equal(shouldIgnoreExportPath(null), true);
});

test('buildRunnerEnv starts from an allowlist and never forwards secrets', () => {
  const out = buildRunnerEnv({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    CODE_RUNNER_CONTROL_TOKEN: 'control-secret',
    OPENAI_API_KEY: 'provider-secret',
    DATABASE_URL: 'postgres://control-plane',
    REDIS_URL: 'redis://control-plane',
  }, {
    HOME: '/runner-home/p1',
    PORT: 5173,
    CODE_RUNNER_CONTROL_TOKEN: 'still-no',
    SOME_PASSWORD: 'still-no',
    AWS_ACCESS_KEY_ID: 'still-no',
  });

  assert.deepEqual(out, {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/runner-home/p1',
    PORT: '5173',
  });
});

test('control auth keeps /health public, supports tokenless dev, and validates bearer tokens', () => {
  assert.equal(isControlRequestAuthorized({ pathname: '/health', token: 'secret' }), true);
  assert.equal(isControlRequestAuthorized({ pathname: '/status', token: '' }), true);
  assert.equal(isControlRequestAuthorized({ pathname: '/status', token: 'secret' }), false);
  assert.equal(isControlRequestAuthorized({ pathname: '/status', token: 'secret', authorization: 'Basic secret' }), false);
  assert.equal(isControlRequestAuthorized({ pathname: '/status', token: 'secret', authorization: 'Bearer wrong' }), false);
  assert.equal(isControlRequestAuthorized({ pathname: '/status', token: 'secret', authorization: 'Bearer secret' }), true);
});

test('control token configuration fails closed only in production', () => {
  assert.equal(controlTokenForEnv({ NODE_ENV: 'development' }), '');
  assert.equal(controlTokenForEnv({ NODE_ENV: 'production', CODE_RUNNER_CONTROL_TOKEN: ' token ' }), 'token');
  assert.throws(
    () => controlTokenForEnv({ NODE_ENV: 'production' }),
    /CODE_RUNNER_CONTROL_TOKEN is required/,
  );
});

test('projectIdentity is stable, project-specific, and never root', () => {
  const a1 = projectIdentity('project-a');
  const a2 = projectIdentity('project-a');
  const b = projectIdentity('project-b');
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  assert.ok(a1.uid > 0);
  assert.ok(a1.gid > 0);
  assert.deepEqual(projectIdentity('project-a', { uidBase: 20_000, uidSpan: 1, gidBase: 30_000, gidSpan: 1 }), {
    uid: 20_000,
    gid: 30_000,
  });
});

test('sandboxCommand applies setsid, prlimit, and a no-root setpriv identity without a shell', () => {
  const argv = sandboxCommand(['bun', 'install'], { uid: 20_001, gid: 30_001 }, {
    addressSpaceBytes: 123_456,
    maxProcesses: 12,
    maxOpenFiles: 34,
    maxFileBytes: 56_789,
    cpuSeconds: 90,
  });
  assert.deepEqual(argv, [
    'setsid',
    'prlimit',
    '--as=123456:123456',
    '--nproc=12:12',
    '--nofile=34:34',
    '--fsize=56789:56789',
    '--cpu=90:90',
    '--core=0:0',
    'setpriv',
    '--reuid=20001',
    '--regid=30001',
    '--clear-groups',
    '--no-new-privs',
    '--',
    'bun',
    'install',
  ]);
  assert.throws(() => sandboxCommand(['node', '-v'], { uid: 0, gid: 0 }), /non-root/);
  assert.throws(() => sandboxCommand('node -v', { uid: 20_001, gid: 20_001 }), /non-empty string array/);
});

test('filesystem helper rejects direct, dangling, and parent symlinks and never exports them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-runner-fs-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(project, 'safe.txt'), 'safe');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(project, 'leak.txt'));
  symlinkSync(join(root, 'would-be-created.txt'), join(project, 'dangling.txt'));
  symlinkSync(outside, join(project, 'outside-dir'));

  assert.throws(() => safeReadFile(project, 'leak.txt'), /unsafe_path/);
  assert.deepEqual(safeReadFile(project, 'safe.txt'), { path: 'safe.txt', content: 'safe' });

  const result = safeWriteFiles(project, [
    { path: 'safe.txt', content: 'updated' },
    { path: 'dangling.txt', content: 'must not escape' },
    { path: 'outside-dir/new.txt', content: 'must not escape' },
  ]);
  assert.equal(result.written, 1);
  assert.equal(readFileSync(join(project, 'safe.txt'), 'utf8'), 'updated');
  assert.equal(lstatSync(join(project, 'dangling.txt')).isSymbolicLink(), true);
  assert.equal(existsSync(join(root, 'would-be-created.txt')), false);
  assert.equal(existsSync(join(outside, 'new.txt')), false);

  const bundle = collectExportFiles(project);
  assert.deepEqual(bundle.files.map((file) => file.path), ['safe.txt']);
  assert.equal(Buffer.from(bundle.files[0].content, 'base64').toString('utf8'), 'updated');
});

test('legacy ownership migration fails before chowning a multiply-linked inode', (t) => {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    t.skip('POSIX ownership test');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'codex-runner-hardlink-'));
  const project = join(root, 'legacy-project');
  const peer = join(root, 'other-project-secret');
  mkdirSync(project, { mode: 0o700 });
  writeFileSync(peer, 'secret');
  linkSync(peer, join(project, 'hidden-peer'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => migrateOwnershipTree(project, { uid: process.getuid(), gid: process.getgid() }),
    /unsafe_hardlink/,
  );
});

test('legacy workspace root is sealed while project traversal remains possible', (t) => {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    t.skip('POSIX ownership test');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'codex-runner-seal-'));
  mkdirSync(join(root, 'projects'), { mode: 0o777 });
  mkdirSync(join(root, 'legacy-app'), { mode: 0o755 });
  writeFileSync(join(root, 'package.json'), '{}', { mode: 0o644 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  sealWorkspaceRoot(root, 'projects', { uid: process.getuid(), gid: process.getgid() });
  const mode = (path) => statSync(path).mode & 0o777;
  assert.equal(mode(root), 0o711);
  assert.equal(mode(join(root, 'projects')), 0o711);
  assert.equal(mode(join(root, 'legacy-app')), 0o700);
  assert.equal(mode(join(root, 'package.json')), 0o600);
});
