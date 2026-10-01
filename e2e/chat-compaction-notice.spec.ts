import { expect, test, type Route } from '@playwright/test'

// Real /agentes UI and SSE decoder; the model/DB are deterministic fixtures.
// No requests may reach production, and no real account is needed.
test.use({ locale: 'es-PE', serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 90_000 })

declare global {
  interface Window { finishCompactionFixture: (failed?: boolean) => void }
}

for (const failed of [false, true]) {
test(`the chat announces actual compaction, then shows the ${failed ? 'preserved-history failure' : 'completed result'}`, async ({ context, page, baseURL }, info) => {
  expect(['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname)).toBe(true)
  const chatId = 'compaction-qa'
  const timestamp = new Date().toISOString()
  const chat = { id: chatId, title: 'Continuidad del contexto', model: 'context-qa', messages: [], createdAt: timestamp, updatedAt: timestamp }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.addInitScript(() => {
    localStorage.setItem('auth-token', 'offline-context-fixture')
    localStorage.setItem('selectedModel', 'context-qa')
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const input = args[0]
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
      if (!url.pathname.endsWith('/ai/generate')) return originalFetch(...args)
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({ start(controller) {
        const emit = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
        emit({ type: 'start', at: Date.now() })
        emit({ type: 'stage', label: 'Compactando contexto…', tool: 'compact', phase: 'history', stageId: 'pipe:history:1', step: 'tool_call', status: 'running', detail: 'Conservando instrucciones, archivos y mensajes recientes' })
        // A generic reasoning row must not hide the actual compaction phase.
        emit({ type: 'reasoning_delta', reasoning: 'Organizando el contexto del informe.' })
        window.finishCompactionFixture = (failed = false) => {
          emit({ type: 'stage', label: failed ? 'No se pudo compactar; se conserva el historial' : 'Contexto compactado · 20 mensajes resumidos', tool: 'compact', phase: 'history', stageId: 'pipe:history:1', step: 'tool_result', status: failed ? 'error' : 'done', ok: !failed, elapsedMs: 1800 })
          emit({ content: 'Continúo con tu informe y las referencias conservadas.' })
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
  const json = (route: Route, body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (url.origin === new URL(baseURL!).origin && !url.pathname.startsWith('/api/')) return route.continue()
    const isFixtureApi = ['localhost', '127.0.0.1'].includes(url.hostname) || (url.origin === 'https://siragpt.com' && url.pathname.startsWith('/api/'))
    if (!isFixtureApi) return route.abort('blockedbyclient')
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '')
    if (path === '/auth/me') return json(route, { user: { id: 'context-owner', name: 'QA', email: 'qa@example.test', plan: 'PRO', isAdmin: false } })
    if (path.startsWith('/health')) return json(route, { status: 'healthy' })
    if (path === '/ai/models') return json(route, { models: [{ id: 'context-qa', name: 'context-qa', provider: 'QA', displayName: 'Sira QA', type: 'TEXT', isActive: true }] })
    if (path === '/payments/subscription') return json(route, { plan: 'PRO', status: 'active', monthlyLimit: 100000 })
    if (path === '/chats') return json(route, request.method() === 'POST' ? { chat } : { chats: [chat], pagination: { page: 1, total: 1, pages: 1 } })
    if (path === `/chats/${chatId}`) return json(route, { chat })
    if (path.endsWith('/messages') && request.method() === 'POST') return json(route, { message: { ...request.postDataJSON(), id: `message-${Date.now()}`, chatId, timestamp } })
    if (path === '/cowork/approvals') return json(route, { approvals: [] })
    if (path === '/users/me/notifications') return json(route, { items: [], unreadCount: 0 })
    return json(route, { ok: true, pending: null, activeTasks: [] })
  })
  await page.goto(`/agentes?id=${chatId}`, { waitUntil: 'domcontentloaded' })
  const textarea = page.locator('[data-testid=chat-composer-surface]:visible').last().locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 60_000 })
  await textarea.fill('¿Qué acuerdos hemos tomado hasta ahora?')
  await textarea.press('Enter')
  await expect.poll(() => page.evaluate(() => typeof window.finishCompactionFixture)).toBe('function')
  const notice = page.locator('[data-step-current="1"]').filter({ hasText: 'Compactando contexto' })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Compactando contexto…')
  await page.screenshot({ path: info.outputPath('compacting-context.png') })
  await page.evaluate(failed => window.finishCompactionFixture(failed), failed)
  await expect(page.getByText('Continúo con tu informe y las referencias conservadas.', { exact: true })).toBeVisible()
  await expect(notice).toHaveCount(0)
  const completed = page.locator('[data-thinking-collapsed="done"]').last()
  await completed.click()
  await expect(page.getByText(failed ? 'No se pudo compactar; se conserva el historial' : 'Contexto compactado · 20 mensajes resumidos', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
}
