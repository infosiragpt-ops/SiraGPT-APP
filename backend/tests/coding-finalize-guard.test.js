'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodingFinalizeGuard } = require('../src/services/codex/coding-finalize-guard');
const identity = { userId: 'u', chatId: 'c', projectId: 'p' };
const ctx = { userId: 'u', chatId: 'c', codingWorkspace: { projectId: 'p' } };
const content = 'module.exports = 2;\n';
const action = (tool, args, observation) => ({ tool, args: JSON.stringify(args), observation });
const write = (path = 'app.js', value = content) => action('project_write', { path, content: value }, { ok: true, path, bytes: Buffer.byteLength(value) });
const read = (path = 'app.js', value = content) => action('project_read', { path }, { ok: true, path, offset: 0, limit: 200, totalLines: value.split('\n').length, truncated: false, content: value });
const exec = (cmd = ['node', '--test', 'app.test.js'], patch = {}) => action('project_exec', { cmd }, { ok: true, exitCode: 0, timedOut: false, stdout: '# tests 4\n# pass 4\n# fail 0\n', stderr: '', truncated: false, ...patch });
const preview = (patch = {}) => action('project_preview_status', {}, { ok: true, project: { id: 'p' }, status: { running: true, ready: true }, previewUrl: 'https://siragpt.com/api/codex/projects/p/preview/token/app/', ...patch });
const proof = () => [write(), exec(), read(), preview()];
function check(actions, query = 'Crea una web de bicicletas y ejecuta las pruebas', answer = 'La vista previa está lista. Las pruebas pasaron.', context = ctx) {
  return createCodingFinalizeGuard({ userQuery: query, ...identity })({ answer, steps: actions.map(item => ({ actions: [item] })), ctx: context });
}
function blocked(result, code) { assert.equal(result.ok, false); assert.equal(result.allowUnverifiedDraft, false); if (code) assert.equal(result.code, code); }

test('owned app with real files, successful tests, complete readback and ready preview completes', () => { assert.equal(check(proof()).ok, true); });
test('short and long prose both require the same coding proof', () => {
  for (const answer of ['Listo.', 'La aplicación está lista. '.repeat(40)]) {
    blocked(check([], undefined, answer)); assert.equal(check(proof(), undefined, answer).ok, true);
  }
});
test('all 51 execution actions are checked, including an early unresolved failure', () => {
  const actions = [...Array.from({ length: 51 }, () => exec()), ...proof()];
  assert.equal(check(actions).ok, true);
  actions[0] = exec(['npx', 'vite', 'build'], { ok: false, exitCode: 1 });
  blocked(check(actions), 'E_CODING_CHECK_FAILED');
});
test('requires authoritative user/chat/project and rejects conflicting evidence identities', () => {
  for (const context of [{}, { ...ctx, userId: 'foreign' }, { ...ctx, chatId: 'foreign' }, { ...ctx, codingWorkspace: { projectId: 'foreign' } }]) blocked(check(proof(), undefined, undefined, context), 'E_CODING_SCOPE');
  for (const patch of [{ projectId: 'foreign' }, { project: { id: 'foreign' } }, { status: { projectId: 'foreign' } }]) { const actions = proof(); Object.assign(actions[0].observation, patch); blocked(check(actions), 'E_CODING_SCOPE'); }
});
test('review requires actual complete file content, not file names or empty ok', () => {
  assert.equal(check([read()], 'Revisa mi código', 'El archivo exporta el valor 2.').ok, true);
  for (const evidence of [action('project_list', {}, { ok: true, files: ['app.js'] }), action('project_read', { path: 'app.js' }, { ok: true })]) blocked(check([evidence], 'Revisa mi código', 'Revisado.'), 'E_CODING_READ_REQUIRED');
});
test('mixed review and correction requires writes while a pure test run does not', () => {
  blocked(check([read(), exec()], 'Revisa y corrige el error del código', 'Revisado.'), 'E_CODING_WRITE_REQUIRED');
  assert.equal(check([exec()], 'Ejecuta las pruebas del proyecto', 'Las pruebas pasaron.').ok, true);
});
test('mutation always requires a fresh execution check, even without a test claim', () => { blocked(check([write(), read(), preview()], 'Crea una web de bicicletas', 'Lista.'), 'E_CODING_CHECK_REQUIRED'); });
test('readback must follow all commands and match every final write exactly', () => {
  for (const actions of [
    [read(), write(), exec(), preview()], [write(), read(), exec(), preview()],
    [write(), exec(), read('app.js', 'wrong'), preview()],
    [write(), write('other.js'), exec(), read(), preview()],
    [write(), exec(), read(), write('app.js', 'changed'), preview()],
  ]) blocked(check(actions), 'E_CODING_READBACK_REQUIRED');
  for (const patch of [{ truncated: true }, { offset: 1 }, { cached_result: 'old' }]) { const actions = proof(); Object.assign(actions[2].observation, patch); blocked(check(actions), 'E_CODING_READBACK_REQUIRED'); }
});
test('an attempted failed write after good proof invalidates completion until a confirmed rewrite and fresh checks', () => {
  const bad = write(); bad.observation = { ok: false, code: 'runner_unreachable' };
  blocked(check([...proof(), bad]), 'E_CODING_CHECK_FAILED');
  assert.equal(check([...proof(), bad, ...proof()]).ok, true);
});
test('write byte count and path are verified', () => {
  for (const patch of [{ bytes: 1 }, { path: 'other.js' }, { ok: true, bytes: undefined }]) { const actions = proof(); Object.assign(actions[0].observation, patch); blocked(check(actions), 'E_CODING_CHECK_FAILED'); }
});
test('test failures require a later passing test run, not a successful build', () => {
  const bad = exec(undefined, { exitCode: 1, ok: false, stdout: '# pass 3\n# fail 1' });
  blocked(check([write(), bad, exec(['npx', 'vite', 'build'], { stdout: '✓ built in 1s' }), read(), preview()]), 'E_CODING_CHECK_FAILED');
  assert.equal(check([write(), bad, exec(['node', '--test', '--test-reporter=tap', 'app.test.js']), read(), preview()]).ok, true);
});
test('passing an unrelated suite cannot erase a failed test target', () => {
  blocked(check([write(), exec(['node', '--test', 'failing.test.js'], { ok: false, exitCode: 1 }), exec(['node', '--test', 'unrelated.test.js']), read(), preview()]), 'E_CODING_CHECK_FAILED');
});
test('exploratory errors can recover through later real checks and complete readback', () => {
  const invalid = exec(['curl', 'localhost'], { ok: false, exitCode: null, code: 'invalid_command' });
  assert.equal(check([invalid, ...proof()]).ok, true);
  blocked(check([...proof(), invalid, read(), preview()]), 'E_CODING_CHECK_REQUIRED');
});
test('empty, zero-test, failed, timed-out and truncated test reports never prove success', () => {
  for (const patch of [{ stdout: '' }, { stdout: '# tests 0\n# pass 0\n# fail 0' }, { stdout: '# pass 4\n# fail 1' }, { stdout: '# pass 4\n# fail 0\nnot ok 5 - broken\n# fail 1' }, { stdout: 'passed' }, { timedOut: true }, { truncated: true }, { exitCode: null }, { ok: undefined }]) blocked(check([write(), exec(undefined, patch), read(), preview()]));
});
test('echo and unused assertion imports cannot stand in for a test suite', () => {
  for (const cmd of [['echo', '4 passed'], ['node', '-e', "const assert=require('node:assert'); console.log('ok')"]]) blocked(check([write(), exec(cmd), read(), preview()]), 'E_CODING_CHECK_REQUIRED');
});
test('compiler silent success counts, but help/version/config-only invocations and fake banners do not', () => {
  const query = 'Verifica los tipos TypeScript';
  assert.equal(check([exec(['npx', 'tsc', '--noEmit'], { stdout: '' }), read()], query, 'Tipos sin errores.').ok, true);
  for (const cmd of [['tsc', '--version'], ['tsc', '--showConfig'], ['tsc', '--listFilesOnly'], ['tsc', '--help'], ['tsc', '--init'], ['tsc', '--all'], ['tsc', '--build', '--clean'], ['npm', 'run', 'typecheck']]) blocked(check([exec(cmd, { stdout: 'fake tsc banner' }), read()], query, 'Tipos sin errores.'));
});
test('package scripts must resolve from fresh package.json to a real checker', () => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
  assert.equal(check([read('package.json', pkg), exec(['npm', 'test'])], 'Ejecuta tests', 'Pruebas pasaron.').ok, true);
  for (const script of ['echo "4 passed"', 'node --test || true']) blocked(check([read('package.json', JSON.stringify({ scripts: { test: script } })), exec(['npm', 'test'], { stdout: '4 passed' })], 'Ejecuta tests', 'Pruebas pasaron.'));
});
test('typecheck does not prove a requested build', () => { blocked(check([write(), exec(['npx', 'tsc', '--noEmit'], { stdout: '' }), read(), preview()], 'Crea la web y ejecuta el build', 'Lista.'), 'E_CODING_CHECK_REQUIRED'); });
test('preview must belong to this project, be ready, and remain running after all writes and commands', () => {
  for (const patch of [{ project: undefined }, { status: { ready: false, running: true } }, { status: { ready: true, running: false } }, { previewUrl: null }]) blocked(check([write(), exec(), read(), preview(patch)]), 'E_CODING_PREVIEW_REQUIRED');
  blocked(check([...proof(), action('project_preview_stop', {}, { ok: true, project: { id: 'p' }, stopped: true })]), 'E_CODING_PREVIEW_REQUIRED');
  blocked(check([preview(), write(), exec(), read()]), 'E_CODING_PREVIEW_REQUIRED');
});
test('an existing confirmed PR can be delivered without inventing another write or deploy', () => {
  const pr = action('project_open_pull_request', { approved: true }, { ok: true, project: { id: 'p' }, commitSha: 'abc123', prUrl: 'https://github.com/org/repo/pull/1' });
  assert.equal(check([pr], 'Crea un PR', 'He publicado el PR https://github.com/org/repo/pull/1').ok, true);
  blocked(check([pr], 'Crea un PR', 'He creado el PR https://github.com/org/repo/pull/2'), 'E_CODING_PR_REQUIRED');
  blocked(check([pr], 'Crea un PR', 'He publicado el PR https://github.com/org/repo/pull/1. También he publicado la app en producción.'), 'E_CODING_DEPLOY_UNVERIFIED');
  blocked(check([read()], 'Abre un PR', 'PR creado.'), 'E_CODING_PR_REQUIRED');
});
test('production/deployment claims need evidence that this tool lane cannot provide', () => {
  for (const answer of ['Desplegué la aplicación.', 'Las pruebas no fallaron y desplegué la aplicación.']) blocked(check(proof(), undefined, answer), 'E_CODING_DEPLOY_UNVERIFIED');
  assert.equal(check(proof(), undefined, 'La vista previa está lista. No he desplegado a producción.').ok, true);
});
test('Stop, missing proof and malformed records fail closed and cannot salvage prose', () => {
  const guard = createCodingFinalizeGuard({ userQuery: 'Crea una web', ...identity });
  for (const steps of [null, [{ actions: null }], [{ actions: [null] }]]) blocked(guard({ answer: 'Listo.', steps, ctx }), 'E_CODING_EVIDENCE');
  const controller = new AbortController(); controller.abort(); blocked(check(proof(), undefined, undefined, { ...ctx, signal: controller.signal }), 'E_CANCELLED');
});
