import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

const gate = require(path.join(process.cwd(), 'scripts/audit-backend-production.cjs'))
const { PATCHES } = require(path.join(process.cwd(), 'backend/scripts/image-size-security-patch.cjs'))
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
function invoke(report: any, { status = 1, patch = patchEvidence(), patchStatus = 0, patchError = undefined }: any = {}) {
  const commands: any[] = []; const output: string[] = []
  const result = gate.runBackendAuditGate({ print: (text: string) => output.push(text), run: (command: string, args: string[]) => {
    commands.push({ command, args })
    if (command === 'npm') return { status, stdout: JSON.stringify(report) }
    return { status: patchStatus, error: patchError, stdout: typeof patch === 'string' ? patch : JSON.stringify(patch) }
  } })
  return { result, commands, output }
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
