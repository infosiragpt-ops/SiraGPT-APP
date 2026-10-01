import { expect, test } from '@playwright/test'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createRequire, Module } from 'node:module'
import path from 'node:path'

const backendRequire = createRequire(path.join(process.cwd(), 'backend/package.json'))

function mockBackendModule(modulePath: string, exports: unknown): () => void {
  const resolved = backendRequire.resolve(modulePath)
  const original = backendRequire.cache[resolved]
  const replacement = new Module(resolved)
  replacement.filename = resolved
  replacement.loaded = true
  replacement.exports = exports
  backendRequire.cache[resolved] = replacement
  return () => {
    if (original) backendRequire.cache[resolved] = original
    else delete backendRequire.cache[resolved]
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('opaque sandbox renders real proxied ES modules and completes a JSON API preflight', async ({ page }, testInfo) => {
  const envKeys = ['CODEX_AGENT_V2', 'CODEX_PREVIEW_TOKEN_SECRET', 'CODE_RUNNER_PREVIEW_TOKEN_SECRET', 'CODE_RUNNER_DEV_INTERNAL_URL', 'CORS_ORIGINS'] as const
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  process.env.CODEX_AGENT_V2 = '1'
  process.env.CODEX_PREVIEW_TOKEN_SECRET = 'browser-preview-fixture-signing-secret-at-least-32-bytes'
  delete process.env.CODE_RUNNER_PREVIEW_TOKEN_SECRET

  const databaseAccesses: string[] = []
  const restoreDatabase = mockBackendModule('./src/config/database', new Proxy({}, {
    get(_target, property) {
      databaseAccesses.push(String(property))
      throw new Error(`Preview fixture must not access the database: ${String(property)}`)
    },
  }))
  const express = backendRequire('express')
  const cors = backendRequire('cors')
  const { createCredentialedCorsOptions } = backendRequire('./src/middleware/cors-policy')
  const { isOpaqueCodexPreviewRequest, previewTokenFor } = backendRequire('./src/services/code/preview-proxy')
  const token = previewTokenFor({ projectId: 'browser-project', userId: 'browser-user' })
  const base = `/api/codex/projects/browser-project/preview/${token}/app/`
  const requests: Array<{ path: string; method: string; origin?: string; headers: IncomingHttpHeaders; body: string }> = []
  const preflights: Array<{ origin?: string; method?: string; headers?: string }> = []
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))

  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const resource = String(request.url || '').replace(base, '')
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ path: resource, method: request.method || '', origin: request.headers.origin, headers: request.headers, body })
      response.setHeader('Access-Control-Allow-Origin', 'https://untrusted.example')
      response.setHeader('Access-Control-Allow-Credentials', 'true')
      response.setHeader('Set-Cookie', 'untrusted_preview=unsafe')
      if (!resource) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html><head><title>Opaque project preview</title></head><body><h1 id="render">Loading</h1><p id="api"></p><script type="module" src="${base}src/main.js"></script></body></html>`)
      } else if (resource === 'src/main.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(`import { title } from './dependency.js';
document.getElementById('render').textContent = title;
try { parent.document.body; document.body.dataset.isolated = 'false'; } catch { document.body.dataset.isolated = 'true'; }
const result = await fetch(new URL('api/products', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bici roja', stock: 2 }) });
if (!result.ok) throw new Error('Preview API failed: ' + result.status);
const product = await result.json();
document.getElementById('api').textContent = product.name + ' · stock ' + product.stock;
document.body.dataset.ready = 'true';`)
      } else if (resource === 'src/dependency.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end('export const title = "Proyecto renderizado con módulos ES";')
      } else if (resource === 'api/products' && request.method === 'POST') {
        response.setHeader('Content-Type', 'application/json')
        try { response.end(JSON.stringify(JSON.parse(body))) }
        catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'json_body_missing' })) }
      } else {
        response.statusCode = 404
        response.end('Unknown fixture resource')
      }
    })
  })
  const upstreamOrigin = await listen(upstream)
  process.env.CODE_RUNNER_DEV_INTERNAL_URL = upstreamOrigin
  const restoreRunner = mockBackendModule('./src/services/codex/runner-client', {
    createRunnerClient: () => ({ devStatus: async () => ({ running: true, ready: true, project: 'browser-project', port: Number(new URL(upstreamOrigin).port) }) }),
    runnerDevUrl: () => upstreamOrigin,
    codexExportHostPath: () => '',
    RunnerError: class RunnerError extends Error {},
  })
  const routerPath = backendRequire.resolve('./src/routes/codex')
  const previousRouter = backendRequire.cache[routerPath]
  delete backendRequire.cache[routerPath]
  const router = backendRequire('./src/routes/codex')
  const app = express()
  const credentialedCors = cors(createCredentialedCorsOptions(['http://localhost:3000']))
  app.use((request: any, response: any, next: any) => {
    if (request.method === 'OPTIONS') preflights.push({ origin: request.headers.origin, method: request.headers['access-control-request-method'], headers: request.headers['access-control-request-headers'] })
    return isOpaqueCodexPreviewRequest(request) ? next() : credentialedCors(request, response, next)
  })
  app.use(express.json())
  app.get('/fixture', (_request: any, response: any) => response.type('html').send(`<!doctype html><html><body><h1>SiraGPT preview fixture</h1><iframe title="Proyecto aislado" sandbox="allow-scripts allow-forms" src="${base}" style="width:700px;height:400px"></iframe></body></html>`))
  app.use('/api/codex', router)
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status || 500).json({ error: error.code || error.message }))
  const proxy = createServer(app)
  const proxyOrigin = await listen(proxy)
  process.env.CORS_ORIGINS = proxyOrigin
  try {
    await page.goto(`${proxyOrigin}/fixture`)
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('#render')).toHaveText('Proyecto renderizado con módulos ES')
    await expect(frame.locator('#api')).toHaveText('Bici roja · stock 2')
    await expect(frame.locator('body')).toHaveAttribute('data-isolated', 'true')
    await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('iframe')).not.toHaveAttribute('sandbox', /allow-same-origin/)
    expect(await page.locator('iframe').evaluate((element) => (element as HTMLIFrameElement).contentDocument)).toBeNull()
    expect(requests.filter((entry) => entry.path.endsWith('.js')).map((entry) => entry.origin)).toEqual(['null', 'null'])
    const apiCall = requests.find((entry) => entry.path === 'api/products')
    expect(apiCall?.method).toBe('POST')
    expect(apiCall?.origin).toBe('null')
    expect(JSON.parse(apiCall?.body || '{}')).toEqual({ name: 'Bici roja', stock: 2 })
    expect(preflights).toEqual([{ origin: 'null', method: 'POST', headers: 'content-type' }])
    expect(requests.some((entry) => entry.headers.cookie || entry.headers.authorization)).toBe(false)
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'untrusted_preview')).toBe(false)
    expect(browserErrors).toEqual([])
    expect(databaseAccesses).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('opaque-preview-render-and-api.png') })
  } finally {
    await close(proxy)
    await close(upstream)
    restoreRunner()
    restoreDatabase()
    if (previousRouter) backendRequire.cache[routerPath] = previousRouter
    else delete backendRequire.cache[routerPath]
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
})
