import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'

const { verifyRelease } = require(path.join(process.cwd(), 'scripts/verify-lenovo-release.cjs'))
const sha = 'a'.repeat(40)
const readiness = () => ({ status: 'healthy', checks: ['database', 'redis', 'migrations'].map(name => ({ name, status: 'healthy', critical: true })) })
const mock = (version: unknown = { commit: sha }, ready: unknown = readiness(), status = 200) => ({
  fetchImpl: async (url: string, options: RequestInit) => {
    assert.ok(url.startsWith('https://siragpt.com/api/'))
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    return new Response(JSON.stringify(url.endsWith('/version') ? version : ready), { status })
  },
})

test('release verification requires the exact live commit and all critical checks', async () => {
  assert.deepEqual(await verifyRelease(sha, mock()), { commit: sha, status: 'healthy' })
})
test('release verification rejects SHA injection, abbreviated and missing targets before network', async () => {
  for (const invalid of [undefined, 'main', 'a'.repeat(8), `${sha};id`, 'A'.repeat(40)]) {
    await assert.rejects(verifyRelease(invalid, { fetchImpl: () => assert.fail('must not request') }), /commit SHA/)
  }
})
test('release verification never accepts another release', async () => {
  await assert.rejects(verifyRelease(sha, mock({ commit: 'b'.repeat(40) })), /does not match/)
})
test('release verification rejects missing and degraded readiness', async () => {
  for (const bad of [{ status: 'healthy' }, { ...readiness(), status: 'degraded' }, { status: 'healthy', checks: [] }]) {
    await assert.rejects(verifyRelease(sha, mock({ commit: sha }, bad)), /not healthy/)
  }
})
test('release verification rejects hidden critical failure even if summary says healthy', async () => {
  const ready = readiness()
  ready.checks.push({ name: 'rbac_bootstrap', status: 'unhealthy', critical: true })
  await assert.rejects(verifyRelease(sha, mock({ commit: sha }, ready)), /critical readiness/)
})
test('release verification rejects duplicate check names and HTTP errors', async () => {
  const ready = readiness()
  ready.checks.push({ ...ready.checks[0] })
  await assert.rejects(verifyRelease(sha, mock({ commit: sha }, ready)), /database/)
  await assert.rejects(verifyRelease(sha, mock(undefined, undefined, 503)), /HTTP 503/)
})
test('release verification does not swallow network or JSON failures', async () => {
  await assert.rejects(verifyRelease(sha, { fetchImpl: async () => { throw new Error('network unavailable') } }), /network unavailable/)
  await assert.rejects(verifyRelease(sha, { fetchImpl: async () => new Response('not JSON') }))
})
test('production workflow is explicit read-only verification, without legacy deploy triggers or secrets', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /node scripts\/verify-lenovo-release\.cjs/)
  assert.match(workflow, /git merge-base --is-ancestor/)
  assert.match(workflow, /\.event == "push" and \.conclusion == "success"/)
  assert.doesNotMatch(workflow, /workflow_run:|\n  push:|VPS_|appleboy|git reset|docker compose|contents: write/)
})
