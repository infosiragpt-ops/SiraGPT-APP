import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

test.describe.configure({ timeout: 120_000 })
test.use({ viewport: { width: 1440, height: 900 } })

// UI flows use a stateful API double. The backend suite separately runs the
// real ReAct loop, project tools and a real Node test against on-disk files.
async function setup(page: Page, opts: { bound?: boolean; access?: boolean; fresh?: boolean; menu?: boolean; twoProjects?: boolean } = {}) {
  const chat = { id: 'code-chat', title: 'Mi aplicación', model: 'grok-4.6', messages: [], createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' }
  const otherChat = { ...chat, id: 'other-chat', title: 'Otra aplicación' }
  const user = { id: 'code-user', name: 'Valeria', email: 'qa@example.com', plan: 'PRO', isAdmin: true }
  const project = { id: 'code-project', name: 'Mi aplicación', status: 'ready', chatId: chat.id, workspacePath: null, previewUrl: null, error: null }
  const otherProject = { ...project, id: 'other-project', chatId: otherChat.id, name: otherChat.title }
  const revisionOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
  const files: Record<string, string> = { 'app.js': 'module.exports = 1;\n' }
  const otherFiles: Record<string, string> = { 'app.js': 'module.exports = 9;\n' }
  const generated: any[] = [], requests: string[] = [], errors: string[] = []
  let bound = opts.bound !== false, createdChat = !opts.fresh
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'coding-test')
    localStorage.setItem('selectedModel', 'grok-4.6')
  })
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.replace(/^\/api/, '')
    requests.push(`${req.method()} ${p}`)
    const workspaceFiles = p.includes('/other-project/') ? otherFiles : files
    let body: unknown = {}, status = 200
    if (p === '/auth/me') body = { user }
    else if (p === '/health') body = { status: 'healthy' }
    else if (p === '/users/me/notifications') body = { items: [], unreadCount: 0 }
    else if (p === '/cowork/approvals') body = { approvals: [] }
    else if (p === '/ai/models') body = { models: [{ id: 'grok-test', name: 'grok-4.6', displayName: 'Grok 4.6', provider: 'xAI', type: 'TEXT', isActive: true }] }
    else if (p === '/payments/subscription') body = { plan: 'PRO', status: 'active', apiUsage: 0, monthlyLimit: 100000 }
    else if (p === '/chats') { if (req.method() === 'POST') { createdChat = true; body = { chat } } else { const chats = createdChat ? (opts.twoProjects ? [chat, otherChat] : [chat]) : []; body = { chats, pagination: { page: 1, total: chats.length, pages: 1 } } } }
    else if (p === `/chats/${chat.id}`) body = { chat }
    else if (opts.twoProjects && p === `/chats/${otherChat.id}`) body = { chat: otherChat }
    else if (p.endsWith('/messages') && req.method() === 'POST') body = { message: { ...req.postDataJSON(), id: `msg-${requests.length}`, chatId: chat.id, timestamp: new Date().toISOString() } }
    else if (p === '/codex/health') body = { ok: true, enabled: true }
    else if (p === '/codex/access') body = { ok: true, enabled: true, canRun: opts.access !== false }
    else if (p === '/codex/projects') body = { projects: bound ? (opts.twoProjects ? [project, otherProject] : [project]) : [] }
    else if (p === `/codex/projects/by-chat/${chat.id}`) {
      if (req.method() === 'POST') bound = true
      body = { project: bound ? project : null, chatId: chat.id }
    }
    else if (opts.twoProjects && p === `/codex/projects/by-chat/${otherChat.id}`) body = { project: otherProject, chatId: otherChat.id }
    else if (p === '/codex/projects/code-project/files' || (opts.twoProjects && p === '/codex/projects/other-project/files')) {
      if (req.method() === 'POST') { for (const f of req.postDataJSON().files) workspaceFiles[f.path] = f.content; body = { ok: true, written: req.postDataJSON().files.length } }
      else body = { files: Object.keys(workspaceFiles) }
    }
    else if (p === '/codex/projects/code-project/file' || (opts.twoProjects && p === '/codex/projects/other-project/file')) {
      if (req.method() === 'PUT') {
        const input = req.postDataJSON(), prior = workspaceFiles[input.path]
        const actualRevision = prior === undefined ? null : revisionOf(prior)
        if (input.expectedRevision !== actualRevision) {
          status = 409; body = { error: 'file_conflict' }
        } else {
          workspaceFiles[input.path] = input.content
          body = { ok: true, path: input.path, revision: revisionOf(input.content), sizeBytes: Buffer.byteLength(input.content), written: 1, truncated: false, readOnly: false }
        }
      } else {
        const path = url.searchParams.get('path')!, content = workspaceFiles[path]
        body = { ok: true, path, content, revision: revisionOf(content), sizeBytes: Buffer.byteLength(content), truncated: false, readOnly: false }
      }
    }
    else if (p === '/codex/projects/code-project/exec') body = { ok: false, exitCode: 1, stdout: '', stderr: 'Prueba fallida: esperado 2' }
    else if (p === '/codex/projects/code-project/preview/start') body = { devUrl: '/qa-code-preview', previewUrl: '/qa-code-preview' }
    else if (p === '/codex/projects/code-project/preview/status') body = { running: true, previewUrl: '/qa-code-preview' }
    else if (p === '/ai/generate') {
      generated.push(req.postDataJSON()); files['app.js'] = 'module.exports = 2;\n'
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"Actualicé app.js y comprobé el resultado."}\n\ndata: [DONE]\n\n' })
    }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route('**/qa-code-preview', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Mi aplicación</h1>' }))
  const menu = opts.menu !== false
  await page.goto(opts.fresh ? `/agentes${menu ? '' : '?code=1'}` : `/agentes?id=code-chat${menu ? '' : '&code=1'}`, { waitUntil: 'domcontentloaded' })
  if (menu) {
    const composer = page.locator('[data-testid=chat-composer-surface]:visible').last()
    await expect(composer).toBeVisible({ timeout: 90_000 })
    const tools = composer.getByRole('button', { name: 'Adjuntar archivos y herramientas', exact: true })
    // Next's development badge occupies the mobile plus-button coordinates.
    // Use the same accessible button through real keyboard activation there.
    if ((page.viewportSize()?.width ?? 1440) < 768) await tools.press('Enter')
    else await tools.click()
    await expect(page.getByTestId('composer-open-code')).toBeVisible()
    if (opts.fresh || test.info().title.startsWith('opens beside')) {
      await page.screenshot({ path: test.info().outputPath('coding-menu.png') })
    }
    await page.getByTestId('composer-open-code').click()
  }
  if (opts.access === false) {
    await expect(page.getByTestId('chat-coding-panel-status')).toContainText('Solicita acceso al administrador', { timeout: 90_000 })
  } else {
    // Wait for the requested surface, not the composer briefly painted before
    // the query-string effect opens the full-screen workspace on mobile.
    await expect(page.getByTestId('agentes-coding-ide')).toBeVisible({ timeout: 90_000 })
  }
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await expect(page.getByTestId('chat-composer-surface')).toBeHidden()
  } else {
    await expect(page.locator('[data-testid=chat-composer-surface]:visible').last()).toBeVisible({ timeout: 90_000 })
  }
  return { files, otherFiles, generated, requests, errors }
}

async function openFile(page: Page) {
  await page.getByRole('button', { name: 'app.js', exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 })
}

async function replaceEditor(page: Page, text: string) {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
}

test('opens beside the chat, edits real Monaco, saves and reopens the same persisted project', async ({ page }, info) => {
  const state = await setup(page)
  const panel = page.getByTestId('agentes-coding-ide')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('agentes-coding-new-session')).toHaveCount(0)
  await openFile(page)
  await replaceEditor(page, 'module.exports = 7;\n')
  await page.getByTestId('agentes-coding-save').click()
  await expect.poll(() => state.files['app.js']).toBe('module.exports = 7;\n')
  await expect(page.getByTestId('agentes-coding-save')).toBeDisabled()
  expect(state.requests).toContain('PUT /codex/projects/code-project/file')
  const composer = page.locator('[data-testid=chat-composer-surface]:visible').last()
  expect((await composer.boundingBox())!.x + (await composer.boundingBox())!.width).toBeLessThanOrEqual((await panel.boundingBox())!.x)
  await page.screenshot({ path: info.outputPath('coding-desktop.png') })
  await page.getByTestId('agentes-coding-ide-collapse').click()
  await expect(panel).toBeHidden()
  await page.goto('/agentes?id=code-chat&code=1', { waitUntil: 'domcontentloaded' })
  await openFile(page)
  await expect(page.locator('.monaco-editor').first()).toContainText('7')
  expect(state.requests.some(r => r.includes('/agentes-coding/sessions'))).toBe(false)
  expect(state.errors).toEqual([])
})

test('terminal uses the project and displays a failed exit instead of reporting success', async ({ page }) => {
  const state = await setup(page)
  await page.getByTestId('agentes-coding-pane-terminal').click()
  await page.getByTestId('agentes-coding-terminal-input').fill('npm test')
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click()
  await expect(page.getByTestId('agentes-coding-terminal-output')).toContainText('Código de salida: 1')
  expect(state.requests).toContain('POST /codex/projects/code-project/exec')
  expect(state.errors).toEqual([])
})

test('short chat follow-up targets the same project and preserves selected model; editor refreshes its result', async ({ page }) => {
  const state = await setup(page)
  await openFile(page)
  const composer = page.locator('[data-testid=chat-composer-surface]:visible').last().locator('textarea')
  await composer.fill('Cambia el valor a 2')
  await composer.press('Enter')
  await expect.poll(() => state.generated.length).toBe(1)
  expect(state.generated[0]).toMatchObject({ chatId: 'code-chat', codingWorkspace: true, model: 'grok-4.6' })
  expect(state.generated[0].disableAgentic).not.toBe(true)
  await page.getByTestId('agentes-coding-refresh-files').click()
  await expect(page.locator('.monaco-editor').first()).toContainText('2')
  expect(state.requests.some(r => r.includes('/generate-webdev') || r.includes('/agent-task'))).toBe(false)
  expect(state.errors).toEqual([])
})

test('fresh mobile chat can create its bound project and return to the composer', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await setup(page, { fresh: true, bound: false })
  await page.getByTestId('agentes-coding-project-name').fill('Mi app móvil')
  await page.getByTestId('agentes-coding-new-project').click()
  await expect(page.getByRole('button', { name: 'app.js', exact: true })).toBeVisible()
  await expect(page.getByTestId('agentes-coding-project-select')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('coding-mobile.png') })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
  await page.getByTestId('agentes-coding-ide-collapse').click()
  await expect(page.locator('[data-testid=chat-composer-surface]:visible').last()).toBeVisible()
  const composer = page.locator('[data-testid=chat-composer-surface]:visible').last().locator('textarea')
  await composer.fill('Cambia el valor a 2')
  await composer.press('Enter')
  await expect.poll(() => state.generated.length).toBe(1)
  expect(state.generated[0].codingWorkspace).toBe(true)
  expect(state.requests).toContain('POST /chats')
  expect(state.requests).toContain('POST /codex/projects/by-chat/code-chat')
  expect(state.errors).toEqual([])
})

test('account without coding access cannot create or execute a project', async ({ page }) => {
  const state = await setup(page, { access: false })
  await expect(page.getByTestId('chat-coding-panel-status')).toContainText('Solicita acceso al administrador')
  await expect(page.getByTestId('agentes-coding-ide')).toHaveCount(0)
  expect(state.requests.some(r => r.startsWith('POST /codex/'))).toBe(false)
})

test('preview opens inside the coding panel without leaving the chat', async ({ page }) => {
  await setup(page)
  await page.getByTestId('agentes-coding-pane-preview').click()
  await page.getByTestId('agentes-preview-start').click()
  await expect(page.getByTestId('agentes-preview-iframe')).toBeVisible()
  await expect(page.frameLocator('[data-testid=agentes-preview-iframe]').getByRole('heading')).toHaveText('Mi aplicación')
  expect(new URL(page.url()).pathname).toBe('/agentes')
})


test('save conflict preserves the unsaved editor and the remote file', async ({ page }) => {
  const state = await setup(page)
  await openFile(page)
  await replaceEditor(page, 'module.exports = 7;\n')
  state.files['app.js'] = 'module.exports = 9;\n'
  await page.getByTestId('agentes-coding-save').click()
  await expect(page.getByTestId('agentes-coding-ide').getByRole('alert').filter({ hasText: 'El archivo cambió en el proyecto' })).toContainText('El archivo cambió en el proyecto')
  await expect(page.locator('.monaco-editor').first()).toContainText('7')
  expect(state.files['app.js']).toBe('module.exports = 9;\n')
  expect(state.requests).toContain('PUT /codex/projects/code-project/file')
  expect(state.errors).toEqual([])
})

test('reload restores the draft with its original revision and rejects remote changes', async ({ page }) => {
  const state = await setup(page)
  await openFile(page)
  await replaceEditor(page, 'module.exports = 7;\n')
  state.files['app.js'] = 'module.exports = 9;\n'
  page.on('dialog', dialog => void dialog.accept())
  await page.goto('/agentes?id=code-chat&code=1', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('agentes-coding-ide')).toBeVisible({ timeout: 90_000 })
  await openFile(page)
  await expect(page.getByTestId('agentes-coding-ide').getByRole('alert').filter({ hasText: 'Recuperé tu borrador' })).toContainText('Recuperé tu borrador')
  await expect(page.locator('.monaco-editor').first()).toContainText('7')
  await page.getByTestId('agentes-coding-save').click()
  await expect(page.getByTestId('agentes-coding-ide').getByRole('alert').filter({ hasText: 'El archivo cambió en el proyecto' })).toContainText('El archivo cambió en el proyecto')
  expect(state.files['app.js']).toBe('module.exports = 9;\n')
  expect(state.errors).toEqual([])
})

test('the existing code link stays compatible', async ({ page }) => {
  await setup(page, { menu: false })
  await openFile(page)
  await expect(page.locator('.monaco-editor').first()).toContainText('1')
  expect(new URL(page.url()).pathname).toBe('/agentes')
})


test('switching projects never reuses a discarded draft from a cached Monaco model', async ({ page }) => {
  const state = await setup(page, { twoProjects: true })
  state.files['b.js'] = 'module.exports = "archivo b";\n'
  await page.getByTestId('agentes-coding-refresh-files').click()
  await openFile(page)
  await replaceEditor(page, 'module.exports = 7;\n')
  page.on('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'b.js', exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toContainText('archivo b')
  await page.getByText('Otra aplicación', { exact: true }).click()
  await expect(page.getByTestId('agentes-coding-session-label')).toContainText('Otra aplicación')
  await openFile(page)
  await expect(page.locator('.monaco-editor').first()).toContainText('module.exports = 9;')
  await expect(page.locator('.monaco-editor').first()).not.toContainText('module.exports = 7;')
  expect(state.files['app.js']).toBe('module.exports = 1;\n')
  expect(state.otherFiles['app.js']).toBe('module.exports = 9;\n')
  expect(state.errors).toEqual([])
})
