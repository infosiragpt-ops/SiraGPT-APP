'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const reporterPath = path.resolve(__dirname, '../e2e/critical-ui-safe-reporter.cjs');
const Reporter = require(reporterPath);
const { failureAnnotation } = Reporter;
const knownFile = 'e2e/chat-integrated-browser.spec.ts';
const secretMarker = 'PRIVATE_FIXTURE_DO_NOT_EMIT';
const sensitive = [
  'Bearer ' + secretMarker,
  'Cookie: session=' + secretMarker,
  'sk-' + secretMarker,
  'https://private.example.test/?token=' + secretMarker,
  '/private/people/' + secretMarker + '/secrets.txt',
  '\r\n::error title=' + secretMarker + '::injected',
  '\u001b[31m' + secretMarker,
];
const caseInput = (file = knownFile, line = 27) => ({ location: { file, line } });
const resultInput = (status = 'failed', retry = 0) => ({ status, retry });
function assertClosed(output) {
  assert.equal(output.includes(secretMarker), false);
  assert.equal(output.includes('\r'), false);
  assert.equal(output.includes('\u001b'), false);
  for (const line of output.trimEnd().split('\n')) {
    assert.match(line, /^::error title=Critical UI (?:case|runner) failed(?:,file=e2e\/[a-z-]+\.spec\.ts(?:,line=\d{1,7})?)?::[^\r\n]*$/);
  }
}

test('emits only the allowlisted file, bounded line, closed status and retry', () => {
  const output = failureAnnotation(caseInput('/home/runner/work/private-root/' + knownFile), resultInput('timedOut', 2));
  assert.equal(output, '::error title=Critical UI case failed,file=e2e/chat-integrated-browser.spec.ts,line=27::spec=e2e/chat-integrated-browser.spec.ts; status=timedOut; line=27; retry=2\n');
  assertClosed(output);
});

test('supports all thirteen fixed critical specs without echoing workspace prefixes', () => {
  const names = ['chat-github-connect', 'chat-browser-live-progress', 'chat-code-workspace', 'codex-preview-cors', 'chat-integrated-browser', 'chat', 'chat-upload', 'document-task-error-recovery', 'chat-composer-stable-size', 'document-artifact-consistency', 'voice-reference-layout', 'chat-media-preview-players', 'chat-computer-login-handoff'];
  for (const name of names) {
    const expected = 'e2e/' + name + '.spec.ts';
    const output = failureAnnotation(caseInput('/' + secretMarker + '/' + expected), resultInput());
    assert.match(output, new RegExp('file=' + expected.replace(/[.]/g, '\\.')));
    assertClosed(output);
  }
  assert.match(failureAnnotation(caseInput('C:\\private\\' + secretMarker + '\\e2e\\chat.spec.ts'), resultInput()), /file=e2e\/chat\.spec\.ts/);
});

test('does not inspect titles, errors, messages, stacks, URLs, attachments or arbitrary result fields', () => {
  const input = caseInput();
  const result = resultInput();
  const poisoned = ['title', 'titlePath', 'error', 'errors', 'message', 'stack', 'attachments', 'url', 'stdout', 'stderr', 'cookies', 'annotations'];
  for (const target of [input, input.location, result]) {
    for (const field of poisoned) Object.defineProperty(target, field, { get() { throw new Error(secretMarker); } });
  }
  const output = failureAnnotation(input, result);
  assertClosed(output);
  assert.match(output, /status=failed; line=27; retry=0/);
});

test('untrusted metadata cannot create commands or escape the closed annotation', () => {
  for (const payload of sensitive) {
    const output = failureAnnotation({ location: { file: payload, line: payload }, title: payload }, {
      status: payload, retry: payload, error: { message: payload, stack: payload }, attachments: [{ path: payload }],
    });
    assert.equal(output, '::error title=Critical UI case failed::spec=unknown; status=unknown\n');
    assertClosed(output);
  }
});

test('rejects unknown, URL, traversal, control-character and oversized filenames', () => {
  const files = [
    '/private/' + secretMarker + '/unknown.spec.ts',
    'chat.spec.ts', 'e2e/not-allowlisted.spec.ts',
    'https://private.example/' + knownFile,
    'file:///private/' + knownFile,
    '/root/../' + knownFile,
    '/root/./' + knownFile,
    '/root\n' + knownFile,
    '/root\u007f/' + knownFile,
    '/' + 'x'.repeat(4097) + '/' + knownFile,
    knownFile + '?token=' + secretMarker,
    knownFile + ',title=' + secretMarker,
    { toString() { throw new Error(secretMarker); } },
    null, undefined,
  ];
  for (const file of files) {
    const output = failureAnnotation({ location: { file, line: 27 } }, resultInput());
    assert.equal(output, '::error title=Critical UI case failed::spec=unknown; status=failed; retry=0\n');
    assertClosed(output);
  }
});

test('accepts only bounded numeric integers, never string coercions or invalid values', () => {
  for (const value of [-1, 1.25, NaN, Infinity, -Infinity, '27', null, undefined, 1n, { valueOf() { throw new Error(secretMarker); } }]) {
    const output = failureAnnotation({ location: { file: knownFile, line: value } }, { status: 'failed', retry: value });
    assert.equal(output, '::error title=Critical UI case failed,file=' + knownFile + '::spec=' + knownFile + '; status=failed\n');
  }
  for (const line of [0, 1_000_001]) assert.equal(failureAnnotation(caseInput(knownFile, line), resultInput()).includes(',line='), false);
  for (const retry of [101, Number.MAX_SAFE_INTEGER]) assert.equal(failureAnnotation(caseInput(), resultInput('failed', retry)).includes('retry='), false);
  assert.match(failureAnnotation(caseInput(knownFile, 1_000_000), resultInput('failed', 100)), /line=1000000; retry=100\n$/);
});

test('status is a closed enum; passing and skipped cases are silent', () => {
  assert.equal(failureAnnotation(caseInput(), resultInput('passed')), null);
  assert.equal(failureAnnotation(caseInput(), resultInput('skipped')), null);
  for (const status of ['failed', 'timedOut', 'interrupted']) {
    assert.match(failureAnnotation(caseInput(), resultInput(status)), new RegExp('status=' + status + ';'));
  }
  for (const status of ['FAILED', 'timeout', 'toString', null, {}, undefined]) {
    assert.match(failureAnnotation(caseInput(), { status, retry: 0 }), /status=unknown;/);
  }
});

test('getters, inherited metadata and throwing proxies fail closed without evaluation', () => {
  const poison = { get() { throw new Error(secretMarker); } };
  const input = Object.defineProperty({}, 'location', poison);
  const result = Object.defineProperty({}, 'status', poison);
  assert.equal(failureAnnotation(input, result), '::error title=Critical UI case failed::spec=unknown; status=unknown\n');
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secretMarker); } });
  assert.equal(failureAnnotation(proxy, proxy), '::error title=Critical UI case failed::spec=unknown; status=unknown\n');
  assert.equal(failureAnnotation(Object.create(caseInput()), Object.create(resultInput())), '::error title=Critical UI case failed::spec=unknown; status=unknown\n');
});

test('runner errors emit one fixed command and do not inspect the error', () => {
  const script = `const Reporter=require(${JSON.stringify(reporterPath)});const error=new Proxy({}, {get(){throw Error(${JSON.stringify(secretMarker)})}});new Reporter().onError(error);`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '::error title=Critical UI runner failed::Critical UI runner failed; details omitted.\n');
  assertClosed(result.stdout);
});

function runPlaywright(source) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-safe-reporter-'));
  try {
    const specDir = path.join(fixture, 'e2e');
    fs.mkdirSync(specDir);
    fs.writeFileSync(path.join(specDir, 'chat.spec.ts'), source);
    const configPath = path.join(fixture, 'playwright.config.cjs');
    fs.writeFileSync(configPath, 'module.exports=' + JSON.stringify({ testDir: specDir, workers: 1, retries: 0, reporter: [[reporterPath]], outputDir: path.join(fixture, 'results') }) + ';');
    return spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config=' + configPath], { encoding: 'utf8', timeout: 30_000 });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test('real Playwright loads the CJS reporter and emits only safe failure metadata', () => {
  const result = runPlaywright(`const {test}=require(${JSON.stringify(require.resolve('@playwright/test'))});\ntest(${JSON.stringify(secretMarker)},()=>{throw new Error(${JSON.stringify(sensitive.join(' | '))})});\n`);
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.includes(secretMarker), false);
  assert.equal(result.stdout, '::error title=Critical UI case failed,file=e2e/chat.spec.ts,line=2::spec=e2e/chat.spec.ts; status=failed; line=2; retry=0\n');
  assertClosed(result.stdout);
});

test('real Playwright runner errors never publish thrown messages or source context', () => {
  const result = runPlaywright(`throw new Error(${JSON.stringify(sensitive.join(' | '))});\n`);
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.includes(secretMarker), false);
  const lines = result.stdout.trimEnd().split('\n');
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((line) => line === '::error title=Critical UI runner failed::Critical UI runner failed; details omitted.'));
  assertClosed(result.stdout);
});
