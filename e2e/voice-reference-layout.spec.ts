import { expect, test, type Page } from '@playwright/test'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, locale: 'es-PE', viewport: { width: 1200, height: 698 } })
test.describe.configure({ timeout: 120_000 })

function wav(seconds: number) {
  const data = Buffer.alloc(44 + seconds * 16000 * 2)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40)
  return { name: 'muestra.wav', mimeType: 'audio/wav', buffer: data }
}

async function setup(page: Page, ready = true) {
  const errors: string[] = []
  const clones: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'voice-layout-test')
    localStorage.setItem('sira:composer:voice:model', 'ElevenLabs')
  })
  const user = { id: 'voice-test', name: 'Valeria', email: 'qa@example.com', plan: 'PRO', isAdmin: false }
  const chat = { id: 'voice-chat', title: 'Voz', model: 'deepseek-v4-flash', messages: [], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' }
  let voices: unknown[] = []
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api/, '')
    let body: unknown = {}
    if (path === '/auth/me') body = { user }
    else if (path === '/users/me/notifications') body = { items: [], unreadCount: 0 }
    else if (path === '/cowork/approvals') body = { approvals: [] }
    else if (path === '/health') body = { status: 'healthy' }
    else if (path === '/ai/models') body = { models: [{ id: 'm1', name: 'deepseek-v4-flash', displayName: 'Sira Rápido', provider: 'DeepSeek', type: 'TEXT', isActive: true }, { id: 'a2', name: 'ElevenLabs', displayName: 'ElevenLabs', provider: 'ElevenLabs', type: 'AUDIO', isActive: true }, { id: 'a1', name: 'sira-voz', displayName: 'Sira Voz', provider: 'VoiceStudio', type: 'AUDIO', isActive: true }] }
    else if (path === '/payments/subscription') body = { plan: 'PRO', status: 'active', apiUsage: 0, monthlyLimit: 100000 }
    else if (path === '/chats') body = req.method() === 'POST' ? { chat } : { chats: [], pagination: { page: 1, total: 0, pages: 0 } }
    else if (path === '/voice-studio/status') body = { ok: ready, configured: true, status: ready ? 'ready' : 'unreachable', limits: { maxVoices: 30 } }
    else if (path === '/voice-studio/voices') body = { voices }
    else if (path === '/voice-studio/jobs') body = { jobs: [] }
    else if (path === '/voice-studio/voices/clone') {
      clones.push(req.postData() || '')
      const voice = { id: 'cloned-1', name: 'Mi muestra', language: 'Spanish' }
      voices = [voice]; body = { voice }
    }
    else if (path === '/elevenlabs/voices') body = { voices: ['Valor', 'Jane', 'Will', 'Elariel X', 'Hannibal'].map((name, i) => ({ voiceId: `catalog-${i}`, name, category: 'Narración', description: 'Voz natural y clara' })) }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/agentes', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-testid="chat-composer-surface"]:visible').last()).toBeVisible({ timeout: 90_000 })
  if ((page.viewportSize()?.width || 0) >= 768) await page.keyboard.press('Control+b')
  const plus = page.getByRole('button', { name: 'Adjuntar archivos y herramientas' })
  // Next's development indicator overlaps the bottom-left composer on small screens.
  // Exercise the real keyboard path (no forced click / hidden app overlay).
  if ((page.viewportSize()?.width || 0) < 768) { await plus.focus(); await plus.press('Enter') }
  else await plus.click({ timeout: 10000 })
  await page.getByRole('menuitem', { name: /Texto a voz/ }).click()
  await expect(page.getByTestId('voice-create-panel')).toBeVisible()
  return { errors, clones }
}

async function instant(page: Page) {
  await page.getByTestId('voice-clone-instant').click()
  await expect(page.getByTestId('voice-sample-dropzone')).toBeVisible()
}

test('reference states: sidebar + composer, central upload, close and reopen without modal', async ({ page }, info) => {
  const { errors } = await setup(page)
  const panelBox = await page.getByTestId('voice-create-panel').boundingBox()
  const composerBox = await page.locator('[data-testid=chat-composer-surface]:visible').last().boundingBox()
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(panelBox!.x)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByPlaceholder('Escribe el texto que quieres convertir en voz')).toBeVisible()
  await page.mouse.move(600, 80)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('voice-panel.png') })
  await instant(page)
  await expect(page.getByTestId('voice-create-panel')).toBeVisible()
  expect((await page.getByTestId('voice-sample-dropzone').boundingBox())!.width).toBeLessThanOrEqual(560)
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toBeDisabled()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('voice-upload.png') })
  await page.getByRole('button', { name: 'Cerrar creación de voz' }).click()
  await expect(page.getByTestId('voice-clone-workspace')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cerrar panel de voz' }).click()
  await page.getByRole('button', { name: 'Crear voz', exact: true }).click()
  await expect(page.getByTestId('voice-create-panel')).toBeVisible()
  expect(errors).toEqual([])
})

test('decodes real WAV duration, blocks short audio, accepts 10 seconds and creates through authenticated API', async ({ page }) => {
  const { errors, clones } = await setup(page)
  await instant(page)
  const input = page.getByTestId('voice-sample-input'), next = page.getByRole('button', { name: 'Siguiente', exact: true })
  await input.setInputFiles(wav(9))
  await expect(page.getByTestId('voice-clone-workspace').getByRole('alert')).toContainText('al menos 10 segundos')
  await expect(next).toBeDisabled()
  await input.setInputFiles(wav(10))
  await expect(next).toBeEnabled()
  await next.click()
  const submit = page.getByTestId('voice-clone-details').getByRole('button', { name: 'Crear voz', exact: true })
  await expect(submit).toBeDisabled()
  await page.getByLabel('Nombre', { exact: true }).fill('Mi muestra')
  await page.getByRole('checkbox').check()
  await submit.click()
  await expect(page.getByTestId('voice-clone-workspace')).toHaveCount(0)
  await expect(page.getByTestId('voice-create-panel')).toContainText('Mi muestra')
  expect(clones).toHaveLength(1)
  expect(await page.evaluate(() => localStorage.getItem('sira:composer:voice:model'))).toBe('ElevenLabs')
  expect(clones[0]).toContain('muestra.wav')
  expect(errors).toEqual([])
})

test('rejects oversized, unsupported, undecodable and overlong samples', async ({ page }) => {
  await setup(page); await instant(page)
  const input = page.getByTestId('voice-sample-input')
  for (const [file, error] of [
    [{ name: 'large.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }, 'supera los 10 MB'],
    [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('text') }, 'archivo de audio o video'],
    [{ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') }, 'No se pudo leer'],
    [wav(21), 'entre 10 y 20 segundos'],
  ] as const) {
    await input.setInputFiles(file)
    await expect(page.getByTestId('voice-clone-workspace').getByRole('alert')).toContainText(error)
    await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toBeDisabled()
  }
})

test('unavailable cloning service cannot submit or silently switch provider', async ({ page }) => {
  const { clones } = await setup(page, false); await instant(page)
  await page.getByTestId('voice-sample-input').setInputFiles(wav(10))
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('Mi muestra')
  await page.getByRole('checkbox').check()
  await expect(page.getByTestId('voice-clone-details')).toContainText('no está disponible')
  await expect(page.getByTestId('voice-clone-details').getByRole('button', { name: 'Crear voz' })).toBeDisabled()
  expect(clones).toHaveLength(0)
})

test('microphone rejection leaves file upload usable', async ({ page, context }) => {
  await context.clearPermissions()
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Micrófono denegado', 'NotAllowedError') } })
  await page.addInitScript(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); (window as any).__voiceStreams = []
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getMedia(constraints); (window as any).__voiceStreams.push(stream); return stream }
  })
  await setup(page); await instant(page)
  await page.getByRole('button', { name: 'Grabar audio', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Grabar audio', exact: true })).toBeEnabled()
  await page.getByTestId('voice-sample-input').setInputFiles(wav(10))
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toBeEnabled()
})

test('professional cloning keeps 30 minute minimum and other studio tools remain reachable', async ({ page }) => {
  await setup(page)
  await page.getByTestId('voice-clone-professional').click()
  await expect(page.getByTestId('voice-clone-workspace')).toContainText('Se requieren 30 minutos')
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cerrar creación de voz' }).click()
  await page.getByText('Más herramientas de voz').click()
  await page.getByRole('button', { name: 'Transcribir', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByTestId('voice-studio-tab-voices').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('voice-create-panel')).toBeVisible()
})

test('mobile flow scrolls, has no horizontal overflow, and returns to voice choices', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const result = await setup(page); await instant(page)
  expect(result.errors).toEqual([])
  await expect(page.getByTestId('voice-create-panel')).toBeHidden()
  await page.getByRole('button', { name: 'Siguiente', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('voice-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Cerrar creación de voz' }).click()
  await expect(page.getByTestId('voice-create-panel')).toBeVisible()
})

 test('records through real MediaRecorder, then releases the microphone on close', async ({ page }) => {
  await page.addInitScript(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); (window as any).__voiceStreams = []
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getMedia(constraints); (window as any).__voiceStreams.push(stream); return stream }
  })
  await setup(page); await instant(page)
  await page.getByRole('button', { name: 'Grabar audio', exact: true }).click()
  await expect(page.getByRole('button', { name: /Grabando… 10s/ })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: /Grabando…/ }).click()
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => (window as any).__voiceStreams.every((stream: MediaStream) => stream.getTracks().every(t => t.readyState === 'ended')))).toBe(true)
  await page.getByRole('button', { name: 'Cerrar creación de voz' }).click()
  await instant(page)
  await expect(page.getByRole('button', { name: 'Grabar audio', exact: true })).toBeVisible()
 })
