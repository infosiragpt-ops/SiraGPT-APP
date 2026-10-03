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

test('phase diagnostics emit only the thirteen fixed phase constants', () => {
  const phases = ['home_open', 'home_empty', 'home_create_tab', 'home_focus', 'home_focus_style',
    'home_navigate', 'home_viewport', 'home_no_chat', 'home_same_session', 'home_url_owner',
    'home_storage_owner', 'fixture_requests', 'frontend_exceptions'];
  for (const phase of phases) {
    const output = failureAnnotation({ ...caseInput(), annotations: [{ type: 'sira_safe_ui_phase', description: phase }] }, resultInput());
    assert.equal(output, '::error title=Critical UI case failed,file=' + knownFile + ',line=27::spec=' + knownFile + '; status=failed; line=27; retry=0; phase=' + phase + '\n');
    assertClosed(output);
  }
  const annotations = [
    { type: 'sira_safe_ui_phase', description: 'home_open' },
    { type: 'evidence', description: sensitive.join(' | ') },
    { type: 'sira_safe_ui_phase', description: 'home_focus_style' },
  ];
  const output = failureAnnotation({ ...caseInput(), annotations }, resultInput());
  assert.match(output, /; phase=home_focus_style\n$/);
  assertClosed(output);
});

test('arbitrary phase values, annotation types and object coercions never reach output', () => {
  const expected = failureAnnotation(caseInput(), resultInput());
  for (const payload of [...sensitive, 'HOME_OPEN', 'home_open\n', 'home_open,phase=home_empty', 'x'.repeat(100_000),
    null, undefined, 1, { toString() { throw new Error(secretMarker); } }]) {
    const annotations = [{ type: 'sira_safe_ui_phase', description: payload }, { type: payload, description: 'home_open' }];
    const output = failureAnnotation({ ...caseInput(), annotations }, resultInput());
    assert.equal(output, expected);
    assertClosed(output);
  }
});

test('phase arrays and entries use only own data descriptors without invoking getters', () => {
  let reads = 0;
  const poison = { get() { reads += 1; throw new Error(secretMarker); } };
  const inputGetter = Object.defineProperty(caseInput(), 'annotations', poison);
  const arrayGetter = [];
  Object.defineProperty(arrayGetter, '0', poison);
  const typeGetter = Object.defineProperty({ description: 'home_open' }, 'type', poison);
  const descriptionGetter = Object.defineProperty({ type: 'sira_safe_ui_phase' }, 'description', poison);
  const inheritedIndex = Array(1);
  Object.setPrototypeOf(inheritedIndex, { 0: { type: 'sira_safe_ui_phase', description: 'home_open' } });
  const inheritedEntries = [
    Object.create({ type: 'sira_safe_ui_phase', description: 'home_open' }),
    Object.assign(Object.create({ description: 'home_open' }), { type: 'sira_safe_ui_phase' }),
    Object.assign(Object.create({ type: 'sira_safe_ui_phase' }), { description: 'home_open' }),
  ];
  const inheritedInput = Object.assign(Object.create({ annotations: [{ type: 'sira_safe_ui_phase', description: 'home_open' }] }), caseInput());
  for (const input of [inputGetter, inheritedInput, ...[arrayGetter, [typeGetter], [descriptionGetter], inheritedIndex, inheritedEntries].map((annotations) => ({ ...caseInput(), annotations }))]) {
    assert.equal(failureAnnotation(input, resultInput()), failureAnnotation(caseInput(), resultInput()));
  }
  assert.equal(reads, 0);
});

test('phase arrays are bounded and reject oversized, array-like and revoked proxy values', () => {
  let indexReads = 0;
  const oversized = Array(65);
  Object.defineProperty(oversized, '0', { get() { indexReads += 1; throw new Error(secretMarker); } });
  const large = Array(10_000_000);
  const revocable = Proxy.revocable([], {});
  revocable.revoke();
  const brokenDescriptors = new Proxy([], { getOwnPropertyDescriptor() { throw new Error(secretMarker); } });
  const brokenItem = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secretMarker); } });
  for (const annotations of [oversized, large, { 0: { type: 'sira_safe_ui_phase', description: 'home_open' }, length: 1 },
    'home_open', null, undefined, revocable.proxy, brokenDescriptors, [brokenItem]]) {
    const output = failureAnnotation({ ...caseInput(), annotations }, resultInput());
    assert.equal(output, failureAnnotation(caseInput(), resultInput()));
    assertClosed(output);
  }
  assert.equal(indexReads, 0);
  const bounded = Array(64);
  bounded[63] = { type: 'sira_safe_ui_phase', description: 'home_viewport' };
  assert.match(failureAnnotation({ ...caseInput(), annotations: bounded }, resultInput()), /; phase=home_viewport\n$/);
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

test('real Playwright reports the last explicit closed phase without leaking other annotations', () => {
  const result = runPlaywright(`const {test}=require(${JSON.stringify(require.resolve('@playwright/test'))});\ntest(${JSON.stringify(secretMarker)},()=>{test.info().annotations.push({type:'sira_safe_ui_phase',description:'home_open'});test.info().annotations.push({type:'evidence',description:${JSON.stringify(sensitive.join(' | '))}});test.info().annotations.splice(0,1);test.info().annotations.push({type:'sira_safe_ui_phase',description:'home_focus_style'});throw new Error(${JSON.stringify(secretMarker)})});\n`);
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.includes(secretMarker), false);
  assert.equal(result.stdout, '::error title=Critical UI case failed,file=e2e/chat.spec.ts,line=2::spec=e2e/chat.spec.ts; status=failed; line=2; retry=0; phase=home_focus_style\n');
  assertClosed(result.stdout);
});

test('real Playwright omits arbitrary phase content instead of echoing or coercing it', () => {
  const result = runPlaywright(`const {test}=require(${JSON.stringify(require.resolve('@playwright/test'))});\ntest(${JSON.stringify(secretMarker)},()=>{test.info().annotations.push({type:'sira_safe_ui_phase',description:${JSON.stringify(sensitive.join(' | '))}});throw new Error(${JSON.stringify(secretMarker)})});\n`);
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.includes(secretMarker), false);
  assert.equal(result.stdout, '::error title=Critical UI case failed,file=e2e/chat.spec.ts,line=2::spec=e2e/chat.spec.ts; status=failed; line=2; retry=0\n');
  assertClosed(result.stdout);
});
