import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const gate = require(path.join(process.cwd(), 'scripts/audit-backend-production.cjs'))
const { PATCHES } = require(path.join(process.cwd(), 'backend/scripts/image-size-security-patch.cjs'))
const { isTransientAuditError } = require(path.join(process.cwd(), 'scripts/lib/npm-audit-retry.cjs'))
const clone = (value: any) => structuredClone(value)
const advisory = (name = 'image-size', severity = 'high', url = gate.ALLOWED_URLS[0]) => ({
  source: 12345, name, dependency: name, severity, url, title: 'Synthetic advisory fixture',
})
function reportFor(entries: Record<string, any> = {}) {
  const counts: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(entries).length }
  for (const entry of Object.values(entries)) counts[entry.severity]++
  return { auditReportVersion: 2, vulnerabilities: entries, metadata: { vulnerabilities: counts, dependencies: { prod: 10, total: 10 } } }
}
function packageEntry(name: string, via: any[], severity = 'high') {
  return { name, via, severity, nodes: [`node_modules/${name}`] }
}
function imageReport() {
  return reportFor({
    'image-size': packageEntry('image-size', [advisory(), { ...advisory(), source: 67890, url: gate.ALLOWED_URLS[1] }]),
    pptxgenjs: packageEntry('pptxgenjs', ['image-size']),
  })
}
function patchEvidence() {
  return { package: 'image-size', version: '1.2.1', verified: true, patchedFiles: 0,
    advisories: gate.ALLOWED_URLS.map((url: string) => url.split('/').pop()),
    copies: [{ path: 'image-size', version: '1.2.1', files: PATCHES.map((patch: any) => ({ file: patch.file, sha256: patch.afterSha256 })) }] }
}
function invoke(report: any, { status = 1, patch = patchEvidence(), patchStatus = 0, patchError = undefined, exceptions = [], now = Date.now() }: any = {}) {
  const commands: any[] = []; const output: string[] = []
  const result = gate.runBackendAuditGate({ exceptions, now, print: (text: string) => output.push(text), run: (command: string, args: string[]) => {
    commands.push({ command, args })
    if (command === 'npm') return { status, stdout: JSON.stringify(report) }
    return { status: patchStatus, error: patchError, stdout: typeof patch === 'string' ? patch : JSON.stringify(patch) }
  } })
  return { result, commands, output }
}

// Time-boxed exception fixtures: the backend's zod 3 advisory and the packages
// npm lists only "via zod" (openai -> zod, @llamaindex/openai -> openai).
const ZOD_URL = 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5'
const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
function zodException(overrides: any = {}) {
  return { url: ZOD_URL, package: 'zod', nodes: ['node_modules/zod'], approvedBy: 'Owner',
    reason: 'No patched zod 3 release exists; the zod 4 migration lands before this expires.',
    createdOn: '2026-10-26', expiresOn: '2026-11-09', ...overrides }
}
function zodReport({ level = 'high', url = ZOD_URL, nodes = ['node_modules/zod'] }: any = {}) {
  return reportFor({
    zod: { ...packageEntry('zod', [advisory('zod', level, url)], level), nodes },
    openai: packageEntry('openai', ['zod'], level),
    '@llamaindex/openai': packageEntry('@llamaindex/openai', ['openai'], level),
  })
}
function runWithExceptions(report: any, exceptions: any[], now = NOW) {
  const output: string[] = []
  try {
    const result = gate.runBackendAuditGate({ exceptions, now, print: (text: string) => output.push(text),
      run: (command: string) => command === 'npm'
        ? { status: 1, stdout: JSON.stringify(report) }
        : { status: 0, stdout: JSON.stringify(patchEvidence()) } })
    return { result, output, error: null as any }
  } catch (error) { return { result: null as any, output, error: error as any } }
}

test('exact image advisories resolve through transitive strings only with verified installed hashes', () => {
  const report = imageReport(); const original = clone(report)
  const { result, commands, output } = invoke(report)
  assert.equal(result.ok, true); assert.equal(result.patchedAndVerified.length, 2)
  assert.deepEqual(result.affectedPackages.sort(), ['image-size', 'pptxgenjs'])
  assert.deepEqual(commands[0].args, ['--prefix', 'backend', 'audit', '--omit=dev', '--json'])
  assert.equal(commands[1].args[1], '--verify')
  assert.deepEqual(JSON.parse(output[0]), original)
  assert.deepEqual(report, original)
  assert.equal(result.rawCounts.high, 2); assert.match(output.join(''), /patched-and-verified/)
})

test('numeric source IDs may change but exact URL, package and severity may not', () => {
  const changedId = imageReport(); changedId.vulnerabilities['image-size'].via[0].source = 7654321
  assert.equal(invoke(changedId).result.ok, true)
  for (const url of ['https://github.com/advisories/GHSA-w3rx-r6r6-pgpr#fake', 'https://evil.test/GHSA-w3rx-r6r6-pgpr', 'https://github.com/advisories/GHSA-new-unknown']) {
    const report = imageReport(); report.vulnerabilities['image-size'].via[0].url = url
    assert.throws(() => invoke(report), /Unpatched high/)
  }
  assert.throws(() => invoke(reportFor({ other: packageEntry('other', [advisory('other')]) })), /Unpatched high/)
})

test('unknown high and critical findings block even alongside correctly patched images', () => {
  for (const level of ['high', 'critical']) {
    const report = imageReport(); const entries = { ...report.vulnerabilities, unknown: packageEntry('unknown', [advisory('unknown', level)], level) }
    assert.throws(() => invoke(reportFor(entries)), /Unpatched high\/critical/)
  }
  const criticalImage = reportFor({ 'image-size': packageEntry('image-size', [advisory('image-size', 'critical')], 'critical') })
  assert.throws(() => invoke(criticalImage), /Unpatched high\/critical/)
})

test('unknown or cyclic transitive chains and misleading severity cannot hide findings', () => {
  assert.throws(() => invoke(reportFor({ wrapper: packageEntry('wrapper', ['absent']) })), /Unresolved transitive/)
  assert.throws(() => invoke(reportFor({ one: packageEntry('one', ['two']), two: packageEntry('two', ['one']) })), /Cyclic/)
  assert.throws(() => invoke(reportFor({ hidden: packageEntry('hidden', [advisory('hidden')], 'low') })), /severity does not match/)
})

test('missing, malformed and inconsistent reports fail closed, including empty objects', () => {
  for (const report of [{}, null, [], { auditReportVersion: 2 }, { ...imageReport(), error: { code: 'ENETUNREACH' } },
    { ...imageReport(), vulnerabilities: {} }, { ...imageReport(), metadata: {} }]) assert.throws(() => invoke(report))
  const missing = imageReport(); delete (missing.metadata.vulnerabilities as any).high
  assert.throws(() => invoke(missing), /Invalid raw/)
  const badCount = imageReport(); badCount.metadata.vulnerabilities.total = 99
  assert.throws(() => invoke(badCount), /Inconsistent raw/)
  const badDependencies = imageReport(); (badDependencies.metadata.dependencies as any).prod = '10'
  assert.throws(() => invoke(badDependencies), /dependency metadata/)
  const unknownCount = reportFor(); unknownCount.metadata.vulnerabilities.severe = 1
  assert.throws(() => invoke(unknownCount, { status: 0 }), /Unknown raw/)
})

test('a genuine zero report passes without inventing installation evidence', () => {
  const { result, commands } = invoke(reportFor(), { status: 0 })
  assert.equal(result.rawCounts.total, 0); assert.deepEqual(result.patchedAndVerified, []); assert.equal(commands.length, 1)
  assert.throws(() => invoke(reportFor()), /failed without reporting findings/)
})

test('low and moderate reports remain visible and their schemas are validated', () => {
  for (const level of ['low', 'moderate']) {
    const report = reportFor({ lowpkg: packageEntry('lowpkg', [advisory('lowpkg', level)], level) })
    const { result, output, commands } = invoke(report)
    assert.equal(result.rawCounts[level], 1); assert.equal(commands.length, 1); assert.deepEqual(JSON.parse(output[0]), report)
    report.vulnerabilities.lowpkg.via[0].source = 'invalid'
    assert.throws(() => invoke(report), /advisory identity/)
  }
})

test('npm non-JSON, missing output, network failure, signal or unsupported exit cannot pass', () => {
  for (const result of [
    { status: 2, stdout: JSON.stringify(imageReport()) }, { status: null, stdout: JSON.stringify(imageReport()) },
    { status: 0, stdout: '{}' }, { status: 1, stdout: 'not JSON' }, { status: 1, stdout: '' },
    { status: 1, stdout: JSON.stringify(imageReport()), error: new Error('network') },
    { status: 1, stdout: JSON.stringify(imageReport()), signal: 'SIGTERM' },
  ]) assert.throws(() => gate.runBackendAuditGate({ run: () => result, print: () => {} }))
})

test('missing, failed or malformed patch verification never grants the exception', () => {
  for (const options of [{ patchStatus: 1 }, { patchStatus: null }, { patchError: new Error('ENOENT') }, { patch: '' },
    { patch: '{}' }, { patch: 'not JSON' }, { patch: { ...patchEvidence(), verified: false } },
    { patch: { ...patchEvidence(), copies: [] } }, { patch: { ...patchEvidence(), patchedFiles: 2 } }])
    assert.throws(() => invoke(imageReport(), options))
})

test('version drift, unexpected advisories, missing copies and altered hashes block', () => {
  for (const mutate of [
    (patch: any) => { patch.version = '2.0.2' }, (patch: any) => { patch.copies[0].version = '2.0.2' },
    (patch: any) => { patch.package = 'pptxgenjs' },
    (patch: any) => { patch.advisories[0] = 'GHSA-unknown' }, (patch: any) => { patch.copies[0].files[0].sha256 = '0'.repeat(64) },
    (patch: any) => { patch.copies[0].files.pop() }, (patch: any) => { patch.copies[0].path = '../image-size' },
  ]) { const patch = patchEvidence(); mutate(patch); assert.throws(() => invoke(imageReport(), { patch })) }
  const report = imageReport(); report.vulnerabilities['image-size'].nodes.push('node_modules/nested/node_modules/image-size')
  assert.throws(() => invoke(report), /Not every audited/)
})

test('audit installation paths must refer to the named package, without traversal or an empty component', () => {
  for (const node of ['node_modules/', 'node_modules/other', 'node_modules/../image-size', 'node_modules//image-size', 'node_modules/one\\image-size']) {
    const report = imageReport(); report.vulnerabilities['image-size'].nodes = [node]
    assert.throws(() => invoke(report), /installation paths/)
  }
})


test('npm low metavulnerability over moderate leaves retains raw findings without relaxing the high boundary', () => {
  const report = reportFor({
    dompurify: packageEntry('dompurify', [advisory('dompurify', 'moderate', 'https://github.com/advisories/GHSA-cmwh-pvxp-8882')], 'moderate'),
    'monaco-editor': packageEntry('monaco-editor', ['dompurify'], 'low'),
  })
  const original = clone(report)
  assert.equal(invoke(report).result.ok, true)
  assert.deepEqual(report, original)
  for (const level of ['high', 'critical']) {
    const hidden = reportFor({ leaf: packageEntry('leaf', [advisory('leaf', level)], level), parent: packageEntry('parent', ['leaf'], 'low') })
    assert.throws(() => invoke(hidden), /severity does not match/)
  }
  assert.throws(() => invoke(reportFor({ direct: packageEntry('direct', [advisory('direct', 'moderate')], 'low') })), /severity does not match/)
})

test('an approved, unexpired exception covers its exact advisory, named copies and the packages that only reach it', () => {
  const report = zodReport(); const original = clone(report)
  const classified = gate.classifyAuditReport(report, { exceptions: [zodException()], now: NOW })
  assert.deepEqual(classified.blocked, [])
  assert.deepEqual(classified.excepted.map((item: any) => item.package).sort(), ['@llamaindex/openai', 'openai', 'zod'])
  assert.ok(classified.excepted.every((item: any) => item.advisoryPackage === 'zod' && item.url === ZOD_URL && item.expiresOn === '2026-11-09'))
  const { result, output, error } = runWithExceptions(report, [zodException()])
  assert.equal(error, null); assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(output[0]), original, 'the raw npm report is still printed first, untouched')
  assert.match(output.join(''), /::warning title=Backend audit exception::zod \S+ is NOT fixed; excepted until 2026-11-09/)
  assert.match(output.join(''), /passed with 1 time-boxed exception/)
  // The image-size patch attestation still runs alongside an exception.
  const mixed = runWithExceptions(reportFor({ ...imageReport().vulnerabilities, ...zodReport().vulnerabilities }), [zodException()])
  assert.equal(mixed.error, null); assert.equal(mixed.result.patchedAndVerified.length, 2)
})

test('the exception blocks again by itself at expiry and never covers critical, other advisories, packages or new copies', () => {
  const lastMoment = Date.parse('2026-11-09T23:59:59.999Z')
  assert.deepEqual(gate.classifyAuditReport(zodReport(), { exceptions: [zodException()], now: lastMoment }).blocked, [])
  const expired = runWithExceptions(zodReport(), [zodException()], lastMoment + 1)
  assert.match(String(expired.error?.message), /Unpatched high\/critical backend advisories/)
  assert.match(expired.output.join(''), /exception EXPIRED on 2026-11-09/)
  const cases: Array<[any, any]> = [
    [zodReport({ level: 'critical' }), zodException()],
    [zodReport({ url: 'https://github.com/advisories/GHSA-2222-3333-4444' }), zodException()],
    [zodReport(), zodException({ package: 'openai', nodes: ['node_modules/openai'] })],
    [zodReport({ nodes: ['node_modules/zod', 'node_modules/new-dep/node_modules/zod'] }), zodException()],
  ]
  for (const [report, exception] of cases) {
    const { blocked } = gate.classifyAuditReport(report, { exceptions: [exception], now: NOW })
    assert.equal(blocked.length, 3, JSON.stringify(blocked))
  }
  const unused = runWithExceptions(imageReport(), [zodException()])
  assert.equal(unused.error, null)
  assert.match(unused.output.join(''), /exception no longer needed .* remove it: zod/)
})

test('malformed, over-long, future-dated or unscoped exceptions fail closed instead of being ignored', () => {
  assert.equal(gate.MAX_EXCEPTION_DAYS, 14)
  for (const bad of [
    null, [], {},
    zodException({ url: `${ZOD_URL}#fragment` }), zodException({ url: 'https://evil.test/advisories/GHSA-mrhx-c7xc-m3w5' }),
    zodException({ package: '../zod' }),
    zodException({ nodes: [] }), zodException({ nodes: undefined }), zodException({ nodes: ['node_modules/zodiac'] }),
    zodException({ nodes: ['node_modules/../zod'] }), zodException({ nodes: ['node_modules/zod', 'node_modules/zod'] }),
    zodException({ approvedBy: '' }), zodException({ reason: 'because' }), zodException({ reason: undefined }),
    zodException({ expiresOn: '2026-11-10' }), // 15 days
    zodException({ expiresOn: '2026-10-26' }), // 0 days
    zodException({ expiresOn: '2026-10-20' }), // ends before it starts
    zodException({ createdOn: '2026-02-30', expiresOn: '2026-03-05' }), // not a calendar date
    zodException({ expiresOn: 'soon' }),
    zodException({ createdOn: '2026-12-01', expiresOn: '2026-12-10' }), // starts in the future: would stretch the window
  ]) {
    assert.throws(() => gate.validateException(bad, { now: NOW }), /exception/i, JSON.stringify(bad))
    assert.throws(() => gate.classifyAuditReport(zodReport(), { exceptions: [bad], now: NOW }), /exception/i)
    const viaGate = runWithExceptions(zodReport(), [bad])
    assert.equal(viaGate.result, null)
    assert.match(String(viaGate.error?.message), /exception/i)
  }
  assert.throws(() => gate.classifyAuditReport(zodReport(), { exceptions: 'zod', now: NOW }), /exceptions/i)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-exceptions-'))
  const broken = path.join(dir, 'broken.json'); writeFileSync(broken, '{ not json')
  assert.throws(() => gate.loadExceptions(broken, { now: NOW }),
    (error: any) => /not valid JSON/.test(error.message) && !isTransientAuditError(error), 'a broken policy file is not retried as an npm transport failure')
  const duplicate = path.join(dir, 'duplicate.json'); writeFileSync(duplicate, JSON.stringify({ exceptions: [zodException(), zodException()] }))
  assert.throws(() => gate.loadExceptions(duplicate, { now: NOW }), /Duplicate/)
  const shapeless = path.join(dir, 'shapeless.json'); writeFileSync(shapeless, JSON.stringify([zodException()]))
  assert.throws(() => gate.loadExceptions(shapeless, { now: NOW }), /exceptions file/)
  assert.deepEqual(gate.loadExceptions(path.join(dir, 'absent.json'), { now: NOW }), [])
})

test('the root gate never inherits backend exceptions; the recorded file stays valid and bounded', () => {
  // scripts/audit-production-allowlist.js calls classifyAuditReport(report) with no options.
  assert.equal(gate.classifyAuditReport(zodReport()).blocked.length, 3)
  for (const e of gate.loadExceptions()) {
    assert.ok((Date.parse(e.expiresOn) - Date.parse(e.createdOn)) / DAY_MS <= 14, `${e.package} lasts at most 14 days`)
    assert.ok(e.nodes.every((node: string) => node === `node_modules/${e.package}` || node.endsWith(`/node_modules/${e.package}`)))
    assert.ok(e.reason.length >= 20 && e.approvedBy.length >= 2)
  }
})
