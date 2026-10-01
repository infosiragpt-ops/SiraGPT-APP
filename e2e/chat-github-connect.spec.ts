import { expect, test, type Page, type Route } from '@playwright/test'

// Runs the actual /agentes frontend in Chromium. Only the HTTP APIs and the
// external OAuth provider are simulated: this is not a real GitHub login.
test.describe.configure({ timeout: 120_000 })
test.use({ viewport: { width: 1440, height: 900 } })

const chatId = 'github-chat'
const handoffId = '18a3ccf1-600a-4f36-a799-4a6b4c1e6f90'
const user = { id: 'github-owner', name: 'Valeria', email: 'qa@example.test', plan: 'PRO', isAdmin: true }
const chat = { id: chatId, title: 'Aplicación GitHub', model: 'grok-4.6', messages: [], createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' }
const otherChat = { ...chat, id: 'github-other-chat', title: 'Otra conversación' }
const project = { id: 'github-project', name: 'Aplicación GitHub', status: 'ready', chatId, workspacePath: null, previewUrl: null, error: null }

type Receipt = 'pending' | 'success' | 'error'
async function setup(page: Page, options: { blocked?: boolean; connected?: boolean; duplicate?: boolean; coop?: boolean; plainChat?: boolean; fresh?: boolean } = {}) {
  const generated: Record<string, unknown>[] = []
  const connects: URL[] = []
  const receipts: URL[] = []
  const errors: string[] = []
  const requests: string[] = []
  let connected = Boolean(options.connected)
  let receipt: Receipt = 'pending'
  let verify = true
  let identity = { ...user }
  let currentHandoff = handoffId
  let providerOrigin = ''
  let createdChat = !options.fresh
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ blocked }) => {
    if (window.self !== window.top) return
    localStorage.setItem('auth-token', 'github-qa-session')
    localStorage.setItem('selectedModel', 'grok-4.6')
    if (blocked) {
      const actualOpen = window.open.bind(window)
      ;(window as unknown as { restorePopupOpening: () => void }).restorePopupOpening = () => { window.open = actualOpen }
      window.open = () => null
    }
  }, { blocked: Boolean(options.blocked) })
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, '')
    requests.push(`${request.method()} ${path}`)
    if (path === '/auth/me') return json(route, { user: identity })
    if (path === '/health') return json(route, { status: 'healthy' })
    if (path === '/users/me/notifications') return json(route, { items: [], unreadCount: 0 })
    if (path === '/cowork/approvals') return json(route, { approvals: [] })
    if (path === '/ai/models') return json(route, { models: [{ id: 'qa-model', name: 'grok-4.6', displayName: 'Grok 4.6', provider: 'xAI', type: 'TEXT', isActive: true }] })
    if (path === '/payments/subscription') return json(route, { plan: 'PRO', status: 'active', apiUsage: 0, monthlyLimit: 100000 })
    if (path === '/chats') {
      if (request.method() === 'POST') { createdChat = true; return json(route, { chat }) }
      return json(route, { chats: createdChat ? [chat, otherChat] : [], pagination: { page: 1, total: createdChat ? 2 : 0, pages: 1 } })
    }
    if (path === `/chats/${chatId}`) return json(route, { chat })
    if (path === `/chats/${otherChat.id}`) return json(route, { chat: otherChat })
    if (path.endsWith('/messages') && request.method() === 'POST') return json(route, { message: { ...request.postDataJSON(), id: `message-${Date.now()}`, chatId, timestamp: new Date().toISOString() } })
    if (path === '/codex/health') return json(route, { ok: true, enabled: true })
    if (path === '/codex/access') return json(route, { ok: true, enabled: true, canRun: true })
    if (path === '/codex/projects') return json(route, { projects: options.plainChat ? [] : [project] })
    if (path === `/codex/projects/by-chat/${chatId}`) return json(route, { project: options.plainChat ? null : project, chatId })
    if (path.startsWith('/codex/projects/by-chat/')) return json(route, { project: null, chatId: otherChat.id })
    if (path === '/files/upload') return json(route, { files: [{ id: 'qa-draft-file', name: 'borrador-qa.txt', originalName: 'borrador-qa.txt', mimeType: 'text/plain', type: 'text/plain', success: true, processingStage: 'ready', status: 'ready', size: 20, url: null }], failed: [], batchId: 'qa-upload-batch' })
    if (path === '/files/qa-draft-file/processing-status') return json(route, { fileId: 'qa-draft-file', stage: 'ready', error: null, stageAt: '2026-09-30T21:00:00Z', isTerminal: true })
    if (path === '/github/status') return json(route, { configured: true, connected, verified: connected && verify, connectionVersion: connected ? '2026-09-30T21:00:00Z' : null, login: connected ? 'qa-github-account' : undefined })
    if (path === '/github/connect/status') {
      receipts.push(url)
      return json(route, { chatId, handoffId: currentHandoff, status: receipt, ...(receipt === 'success' ? { connectionVersion: '2026-09-30T21:00:00Z' } : {}), ...(receipt === 'error' ? { error: 'denied' } : {}) })
    }
    if (path === '/github/connect') {
      connects.push(url)
      if (connects.length > 1) return json(route, { code: 'github_handoff_reused', error: 'Esta solicitud ya se inició.' }, 409)
      currentHandoff = url.searchParams.get('handoffId') || handoffId
      providerOrigin = url.origin
      return json(route, { url: `https://github.com/login/oauth/authorize?state=qa-${currentHandoff}&client_id=qa`, chatId, handoffId: currentHandoff })
    }
    if (path === '/github/callback') {
      const payload = { type: 'github_oauth_result', service: 'github', status: receipt === 'error' ? 'error' : 'success', chatId, handoffId: currentHandoff, ...(receipt === 'error' ? { error: 'denied' } : {}) }
      return route.fulfill({ contentType: 'text/html', headers: { 'Cross-Origin-Opener-Policy': 'unsafe-none' }, body: `<!doctype html><title>Conexión de GitHub</title><p>Autorización de prueba completada</p><script>window.opener?.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(new URL(page.url()).origin)});window.opener?.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(new URL(page.url()).origin)})</script>` })
    }
    if (path === '/ai/generate') {
      generated.push(request.postDataJSON())
      const needConnection = generated.length === 1 && !options.connected
      const frame = `data: ${JSON.stringify({ type: 'github_connection_required', chatId, handoffId })}\n\n`
      return route.fulfill({ contentType: 'text/event-stream', body: `${needConnection ? frame + (options.duplicate ? frame : '') : ''}data: ${JSON.stringify({ content: needConnection ? 'Conecta GitHub para continuar.' : 'La conexión se verificó y continué en el mismo proyecto.' })}\n\ndata: [DONE]\n\n` })
    }
    return json(route, {})
  }
  await page.context().route('**/api/**', handle)
  await page.context().route('http://localhost:5000/**', handle)
  await page.context().route('https://github.com/login/oauth/authorize?**', route => route.fulfill({
    contentType: 'text/html',
    headers: options.coop ? { 'Cross-Origin-Opener-Policy': 'same-origin' } : {},
    body: '<!doctype html><title>GitHub OAuth QA</title><h1>Autorizar acceso de prueba</h1><p>Proveedor externo simulado. No ingreses credenciales.</p>',
  }))
  await page.goto(options.fresh ? '/agentes' : `/agentes?id=${chatId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-testid=chat-composer-surface]:visible').last()).toBeVisible({ timeout: 90_000 })
  if (!options.plainChat) await expect(page.getByTestId('chat-code-button')).toBeVisible()
  const send = async () => {
    const textarea = page.locator('[data-testid=chat-composer-surface]:visible').last().locator('textarea')
    await textarea.fill(options.plainChat ? 'abre GitHub para iniciar sesión' : 'Conecta GitHub y continúa con este proyecto')
    await textarea.press('Enter')
    await expect.poll(() => generated.length).toBe(1)
  }
  return {
    generated, connects, receipts, errors, requests, send,
    setConnected(value: boolean) { connected = value },
    setReceipt(value: Receipt) { receipt = value },
    setVerified(value: boolean) { verify = value },
    setUser(value: typeof user) { identity = value },
    async callback(popup: Page) { await popup.goto(`${providerOrigin}/api/github/callback?code=qa&state=qa`, { waitUntil: 'domcontentloaded' }) },
  }
}

async function startPopup(page: Page, state: Awaited<ReturnType<typeof setup>>) {
  const opened = page.context().waitForEvent('page')
  await state.send()
  const popup = await opened
  await expect(popup).toHaveURL(/github\.com\/login\/oauth\/authorize/)
  return popup
}

test('opens GitHub from the chat and resumes once only after receipt and verified account', async ({ page }, info) => {
  const state = await setup(page, { duplicate: true })
  const popup = await startPopup(page, state)
  await expect(page.getByText('Te abrí GitHub. Inicia sesión y autoriza; retomaré este chat al comprobar la conexión.', { exact: true })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath('github-chat-handoff.png'), animations: 'disabled' })
  expect(state.connects).toHaveLength(1)
  expect(state.connects[0].searchParams.get('chatId')).toBe(chatId)
  expect(state.connects[0].searchParams.get('handoffId')).toBe(handoffId)
  expect(state.connects[0].searchParams.get('popup')).toBe('1')
  state.setConnected(true)
  await expect.poll(() => state.receipts.length).toBeGreaterThan(0)
  expect(state.generated).toHaveLength(1)
  state.setReceipt('success')
  state.setVerified(false)
  await state.callback(popup)
  await expect.poll(() => state.receipts.length).toBeGreaterThan(1)
  expect(state.generated).toHaveLength(1)
  state.setVerified(true)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1]).toMatchObject({ chatId, model: 'grok-4.6', codingWorkspace: true })
  await page.waitForTimeout(800)
  expect(state.generated).toHaveLength(2)
  expect(state.errors).toEqual([])
})

test('a blocked popup can be reopened by one click without losing the chat', async ({ page }) => {
  const state = await setup(page, { blocked: true })
  await state.send()
  await expect(page.getByRole('button', { name: 'Abrir GitHub', exact: true })).toBeVisible()
  expect(state.generated).toHaveLength(1)
  expect(page.context().pages()).toHaveLength(1)
  await page.evaluate(() => (window as unknown as { restorePopupOpening: () => void }).restorePopupOpening())
  const opened = page.context().waitForEvent('page')
  await page.getByRole('button', { name: 'Abrir GitHub', exact: true }).click()
  const popup = await opened
  await expect(popup).toHaveURL(/github\.com\/login\/oauth\/authorize/)
  state.setReceipt('success')
  state.setConnected(true)
  await state.callback(popup)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1].chatId).toBe(chatId)
})

test('denied authorization never resumes even when an unrelated connection exists', async ({ page }) => {
  const state = await setup(page)
  const popup = await startPopup(page, state)
  state.setConnected(true)
  state.setReceipt('error')
  await state.callback(popup)
  await expect(page.getByText(/conexión con GitHub no se completó/)).toBeVisible()
  await page.waitForTimeout(3500)
  expect(state.generated).toHaveLength(1)
})

test('an OAuth provider that severs opener is recovered through the exact server receipt', async ({ page }) => {
  const state = await setup(page, { coop: true })
  const popup = await startPopup(page, state)
  expect(await popup.evaluate(() => window.opener === null)).toBe(true)
  await expect.poll(() => state.receipts.length).toBeGreaterThan(0)
  expect(state.generated).toHaveLength(1)
  state.setReceipt('success')
  state.setConnected(true)
  await state.callback(popup)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1].chatId).toBe(chatId)
})

test('callbacks with a foreign origin, source or handoff cannot resume the task', async ({ page }) => {
  const state = await setup(page)
  const popup = await startPopup(page, state)
  state.setConnected(true)
  const payload = { type: 'github_oauth_result', service: 'github', status: 'success', chatId, handoffId }
  // A real foreign-origin popup sends the correct IDs; receiver must reject it.
  await popup.evaluate(({ payload, origin }) => window.opener?.postMessage(payload, origin), { payload, origin: new URL(page.url()).origin })
  // The top-level window sends from the right origin, but is not the popup.
  await page.evaluate(payload => window.postMessage(payload, location.origin), payload)
  await popup.goto(`${new URL(page.url()).origin}/api/github/callback?code=qa&state=qa`)
  await popup.evaluate(({ payload, origin }) => window.opener?.postMessage({ ...payload, handoffId: '794b66ab-790b-454c-9bb3-f2d0a5433288' }, origin), { payload, origin: new URL(page.url()).origin })
  await expect.poll(() => state.receipts.length).toBeGreaterThan(0)
  expect(state.generated).toHaveLength(1)
  // All three invalid notifications leave the real flow usable.
  state.setReceipt('success')
  await state.callback(popup)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
})

test('another visible chat never receives the pending GitHub continuation', async ({ page }) => {
  const state = await setup(page)
  const popup = await startPopup(page, state)
  await page.getByText(otherChat.title, { exact: true }).first().click()
  await expect(page.getByRole('button', { name: `Cambiar el nombre del chat: ${otherChat.title}`, exact: true })).toBeVisible()
  state.setReceipt('success')
  state.setConnected(true)
  await state.callback(popup)
  await expect.poll(() => state.receipts.length).toBeGreaterThan(0)
  expect(state.generated).toHaveLength(1)
  await page.getByText(chat.title, { exact: true }).first().click()
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1].chatId).toBe(chatId)
})

test('reload restores only the same owner pending IDs and never stores provider credentials', async ({ page }) => {
  const state = await setup(page)
  await startPopup(page, state)
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(JSON.stringify(storage)).not.toMatch(/access_token|refresh_token|client_secret|password|qa-18a3ccf1/)
  const handoffStorage = storage.session[`siragpt:github-handoff:${user.id}`]
  expect(handoffStorage).toContain(handoffId)
  state.setUser({ ...user, id: 'other-owner' })
  state.setReceipt('success')
  state.setConnected(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-testid=chat-composer-surface]:visible').last()).toBeVisible()
  await page.waitForTimeout(3500)
  expect(state.generated).toHaveLength(1)
})

test('an already connected account does not leave a blank authorization tab after the answer', async ({ page }) => {
  const state = await setup(page, { connected: true })
  const opened = page.context().waitForEvent('page')
  await state.send()
  const reservation = await opened
  await expect.poll(() => reservation.isClosed(), { timeout: 5_000 }).toBe(true)
  expect(page.context().pages()).toHaveLength(1)
  expect(state.connects).toHaveLength(0)
  expect(state.generated).toHaveLength(1)
})

test('the pending connection can be cancelled after the answer without a later automatic continuation', async ({ page }) => {
  const state = await setup(page)
  const popup = await startPopup(page, state)
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect.poll(() => popup.isClosed()).toBe(true)
  state.setConnected(true)
  state.setReceipt('success')
  await page.waitForTimeout(3500)
  expect(state.generated).toHaveLength(1)
  expect(await page.evaluate(owner => sessionStorage.getItem(`siragpt:github-handoff:${owner}`), user.id)).toBe('[]')
})

test('same-owner reload resumes the waiting chat once and a second reload never replays it', async ({ page }) => {
  const state = await setup(page)
  await startPopup(page, state)
  state.setConnected(true)
  state.setReceipt('success')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1]).toMatchObject({ chatId, model: 'grok-4.6', codingWorkspace: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-testid=chat-composer-surface]:visible').last()).toBeVisible()
  await page.waitForTimeout(3500)
  expect(state.generated).toHaveLength(2)
})

for (const fresh of [false, true]) test(`a ${fresh ? 'new' : 'existing'} plain chat opens GitHub without creating a coding workspace or another agent lane`, async ({ page }) => {
  const state = await setup(page, { plainChat: true, fresh })
  const popup = await startPopup(page, state)
  expect(state.generated[0]).toMatchObject({ chatId, prompt: 'abre GitHub para iniciar sesión', model: 'grok-4.6' })
  expect(state.generated[0].codingWorkspace).not.toBe(true)
  state.setReceipt('success')
  state.setConnected(true)
  await state.callback(popup)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  expect(state.generated[1]).toMatchObject({ chatId, model: 'grok-4.6' })
  expect(state.generated[1].codingWorkspace).not.toBe(true)
  expect(state.requests.some(request => /POST \/(?:codex\/projects|agent-task|agent\/task)/.test(request))).toBe(false)
  await expect(page.getByTestId('chat-code-button')).toHaveCount(0)
})

test('automatic continuation preserves the unsent draft and uploaded attachment', async ({ page }) => {
  const state = await setup(page)
  const popup = await startPopup(page, state)
  const composer = page.locator('[data-testid=chat-composer-surface]:visible').last()
  const textarea = composer.locator('textarea')
  const draft = 'Este borrador queda pendiente para mi siguiente mensaje.'
  await textarea.fill(draft)
  await composer.getByRole('button', { name: 'Adjuntar archivos y herramientas', exact: true }).click()
  await page.locator('input[data-accepts-any-format="true"]').first().setInputFiles({
    name: 'borrador-qa.txt', mimeType: 'text/plain', buffer: Buffer.from('Documento QA local.\n'),
  })
  const attachment = composer.getByRole('button', { name: 'Quitar borrador-qa.txt', exact: true })
  await expect(attachment).toHaveCount(1)
  state.setReceipt('success')
  state.setConnected(true)
  await state.callback(popup)
  await expect.poll(() => state.generated.length, { timeout: 15_000 }).toBe(2)
  await expect(textarea).toHaveValue(draft)
  await expect(attachment).toHaveCount(1)
  expect(state.generated[1].prompt).not.toContain(draft)
  expect(JSON.stringify(state.generated[1])).not.toContain('qa-draft-file')
})
