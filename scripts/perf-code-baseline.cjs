#!/usr/bin/env node
/**
 * perf-code-baseline.cjs — harness reproducible de rendimiento del /code.
 *
 * Mide, contra un dev server (PLAYWRIGHT_BASE_URL o http://127.0.0.1:3011):
 *   1. Carga del /code con el mock office-scale (196 workers): TTI estimado
 *      (interactividad: paint + 5s sin long tasks), LCP via PerformanceObserver,
 *      TBT (suma de long tasks en ventana 5s), memoria JS heap.
 *   2. Apertura de la megaoficina: time-to-office-ready (data-office-ready),
 *      draw calls, triángulos (mismos budgets del spec e2e).
 *   3. Sesión larga: repite N runs (simula eventos de runs en el store local)
 *      y mide heap JS del renderer + contadores de workers después de cada run.
 *
 * Uso:
 *   node scripts/perf-code-baseline.cjs                 # baseline
 *   PLAYWRIGHT_BASE_URL=... node scripts/perf-code-baseline.cjs
 *   RUNS=12 node scripts/perf-code-baseline.cjs         # repeticiones (sesión larga)
 *
 * Salida: JSON a stdout con timestamps en ms y memoria en MB.
 */

/* eslint-disable no-console */
const { chromium } = require('playwright')

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const RUNS = Number(process.env.RUNS || 8)

const SCALE_WORKERS = 196
const OFFICE_READY_BUDGET_MS = 15_000

const now = '2026-08-10T16:00:00.000Z'

const AGENT_COMPANY_DEPARTMENTS = [
  { id: 'ceo-office', name: 'CEO Office', mission: 'Dirigir la empresa', desiredAgents: 1 },
  { id: 'product-engineering', name: 'Producto', mission: 'Construir el producto', desiredAgents: 48 },
  { id: 'marketing', name: 'Marketing', mission: 'Captar clientes', desiredAgents: 32 },
  { id: 'research', name: 'Investigación', mission: 'Investigar el mercado', desiredAgents: 24 },
  { id: 'operations', name: 'Operaciones', mission: 'Operar la empresa', desiredAgents: 24 },
  { id: 'finance', name: 'Finanzas', mission: 'Cuidar las finanzas', desiredAgents: 16 },
  { id: 'security', name: 'Seguridad', mission: 'Proteger la plataforma', desiredAgents: 16 },
  { id: 'support', name: 'Soporte', mission: 'Atender clientes', desiredAgents: 16 },
  { id: 'localization', name: 'Localización', mission: 'Traducir el producto', desiredAgents: 20 },
].map((d, i) => ({ ...d, id: d.id, companyRank: i }))

const departmentPools = AGENT_COMPANY_DEPARTMENTS.map((department) => ({
  id: `pool-${department.id}`,
  projectId: 'codex-office-scale-196',
  departmentId: department.id,
  size: department.desiredAgents || 1,
  dailyBudgetUsd: 25,
  enabled: true,
  createdAt: now,
  updatedAt: now,
}))

const runs = AGENT_COMPANY_DEPARTMENTS.flatMap((department, departmentIndex) => {
  const runCount = (department.desiredAgents || 1) - (department.id === 'ceo-office' ? 1 : 0)
  return Array.from({ length: runCount }, (_, workerIndex) => {
    const active = departmentIndex === 0 || workerIndex === 0 || (
      department.id === 'product-engineering' && workerIndex === 1
    )
    const sequence = departmentIndex * 100 + workerIndex
    return {
      id: `scale-run-${department.id}-${workerIndex + 1}`,
      projectId: 'codex-office-scale-196',
      departmentPoolId: `pool-${department.id}`,
      swarmTaskId: null,
      mode: 'build',
      status: active ? 'running' : 'done',
      tier: 'pro',
      model: 'gpt-5.4',
      planRunId: null,
      prompt: `[PROACTIVO · ${department.name}] Worker ${workerIndex + 1}: ${department.mission}`,
      error: null,
      createdAt: new Date(Date.parse(now) - (sequence + 10) * 1000).toISOString(),
      startedAt: new Date(Date.parse(now) - (sequence + 9) * 1000).toISOString(),
      finishedAt: active ? null : new Date(Date.parse(now) - sequence * 1000).toISOString(),
      updatedAt: new Date(Date.parse(now) - sequence * 1000).toISOString(),
    }
  })
})

const project = {
  id: 'office-scale-196',
  name: 'SiraGPT',
  description: 'Empresa de agentes a escala real',
  instructions: null,
  isStarred: false,
  shareId: null,
  createdAt: now,
  updatedAt: now,
  files: [],
  chats: [],
}

const user = {
  id: 'office-scale-user',
  name: 'Valeria Castro',
  email: 'valeria@example.com',
  plan: 'PRO',
  isAdmin: true,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: now,
  updatedAt: now,
}

async function fulfillJson(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

async function mockScaleOffice(page) {
  await page.addInitScript(({ activeProject, currentUser, timestamp }) => {
    const session = {
      id: 'scale-ceo-session',
      workspaceId: activeProject.id,
      title: 'CEO Office',
      turns: [{
        id: 'scale-ceo-turn',
        role: 'assistant',
        content: 'Coordinando la compañía completa.',
      }],
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
      agent: {
        phase: 'generating',
        intakeStep: 0,
        context: { goal: 'Coordinar la compañía completa' },
      },
    }

    localStorage.setItem('auth-token', 'office-scale-token')
    localStorage.setItem('siragpt:office-sound-enabled', 'off')
    localStorage.setItem('code-workspace:active-folder', JSON.stringify(activeProject))
    localStorage.setItem(
      'code-workspace:agent-sessions:v1',
      JSON.stringify({
        sessions: [session],
        activeByWorkspace: { [activeProject.id]: session.id },
      }),
    )
    localStorage.setItem(
      'code-workspace:codex-registry',
      JSON.stringify([{
        id: activeProject.id,
        name: activeProject.name,
        kind: 'project',
        updatedAt: Date.parse(timestamp),
      }]),
    )
    localStorage.setItem('siragpt:codex-project:scale-ceo-session', 'codex-office-scale-196')
    localStorage.setItem('office-scale:user', JSON.stringify(currentUser))
  }, { activeProject: project, currentUser: user, timestamp: now })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, '')

    if (path === '/auth/me') return fulfillJson(route, { user })
    if (path === '/health' && request.method() === 'HEAD') return route.fulfill({ status: 204 })
    if (path === '/health') return fulfillJson(route, { status: 'healthy' })
    if (path === '/projects' && request.method() === 'GET') {
      return fulfillJson(route, { projects: [project] })
    }
    if (path === `/projects/${project.id}` && request.method() === 'GET') {
      return fulfillJson(route, { project })
    }
    if (path === '/codex/health') {
      return fulfillJson(route, { ok: true, enabled: true, previewOrigin: 'https://preview.example.test' })
    }
    if (path === '/codex/access') {
      return fulfillJson(route, { ok: true, enabled: true, canRun: true, allowlistConfigured: true })
    }
    if (path === '/codex/company-associations' && request.method() === 'GET') {
      return fulfillJson(route, {
        company: {
          id: project.id,
          name: project.name,
          organizationId: null,
          type: 'webapp',
          updatedAt: now,
        },
        association: {
          id: 'office-scale-association',
          source: 'manual',
          organizationId: null,
          linkedAt: now,
          updatedAt: now,
          codexProject: {
            id: 'codex-office-scale-196',
            name: 'SiraGPT',
            organizationId: null,
            status: 'ready',
            updatedAt: now,
          },
          connectors: [],
        },
        candidates: [],
        connectors: [],
        requiresAssociation: false,
      })
    }
    if (/^\/codex\/projects\/[^/]+\/proactive$/.test(path)) {
      return fulfillJson(route, {
        state: {
          enabled: false,
          enabledAt: null,
          dayKey: '2026-08-10',
          runsToday: runs.length,
          deptIndex: 0,
          lastCycleAt: now,
          lastError: null,
          costTodayUsd: 1.96,
          dailyBudgetUsd: 25,
          budgetBlocked: false,
        },
        departments: AGENT_COMPANY_DEPARTMENTS.map((department) => ({
          ...department,
          custom: false,
          enabled: true,
        })),
        departmentPools,
        capacity: {
          departments: AGENT_COMPANY_DEPARTMENTS.length,
          logicalAgents: SCALE_WORKERS,
          departmentPools: departmentPools.length,
          physicalAgents: SCALE_WORKERS,
          writerConcurrency: 16,
          dailyBudgetUsd: 25,
          strategy: 'isolated_worktrees_serialized_merge',
        },
      })
    }
    if (/^\/codex\/projects\/[^/]+\/company-resources$/.test(path)) {
      return fulfillJson(route, { resources: { assignments: {}, pinned: [], revision: 0 } })
    }
    if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === 'GET') {
      return fulfillJson(route, { runs })
    }
    if (/^\/codex\/projects\/[^/]+\/checkpoints$/.test(path)) {
      return fulfillJson(route, { checkpoints: [] })
    }
    if (/^\/codex\/projects\/[^/]+\/mission-evidence$/.test(path)) {
      return fulfillJson(route, {
        ledger: {
          version: 1,
          summary: {
            missions: 0,
            completed: 0,
            blocked: 0,
            pendingReview: 0,
            approved: 0,
            reports: 0,
            emailQueued: 0,
          },
          records: [],
          reports: [],
        },
      })
    }
    if (path === '/ai/models') {
      return fulfillJson(route, {
        models: [{
          id: 'office-model',
          name: 'gpt-5.4',
          displayName: 'GPT-5.4',
          provider: 'OpenAI',
          type: 'TEXT',
        }],
      })
    }
    if (path === '/payments/subscription') {
      return fulfillJson(route, {
        plan: 'PRO',
        status: 'active',
        subscription: null,
        apiUsage: 0,
        monthlyLimit: 100_000,
      })
    }
    if (path === '/users/me/notifications') {
      return fulfillJson(route, { items: [], total: 0, unreadCount: 0 })
    }
    if (path === '/cowork/approvals') return fulfillJson(route, { approvals: [] })
    if (path === '/social-posts/operations') {
      return fulfillJson(route, {
        policy: {
          enabled: false,
          mode: 'review',
          autopilot: false,
          objective: '',
          dailyLimit: 1,
          platforms: { facebook: false, linkedin: false, x: false },
          workspaceId: project.id,
          updatedAt: now,
        },
        providers: [],
        metrics: { queued: 0, publishedToday: 0 },
      })
    }
    if (path === '/social-posts' || path === '/social-posts/') {
      return fulfillJson(route, { posts: [] })
    }
    if (path === '/codex/projects') {
      return fulfillJson(route, {
        projects: [{ id: 'codex-office-scale-196', name: 'SiraGPT', status: 'ready' }],
      })
    }
    if (path === '/chats') {
      return fulfillJson(route, {
        chats: [],
        pagination: { page: 1, limit: 20, total: 0, pages: 0 },
      })
    }

    return fulfillJson(route, {})
  })
}

async function measure() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mockScaleOffice(page)

  const metrics = {
    baseUrl: BASE_URL,
    scaleWorkers: SCALE_WORKERS,
    runsSimulated: RUNS,
    budgets: {
      officeReadyMs: OFFICE_READY_BUDGET_MS,
      drawCalls: 2500,
      triangles: 300_000,
    },
  }

  // Instrumentación de rendimiento.
  await page.addInitScript(() => {
    window.__perf = {
      longTasks: [],
      lcp: 0,
      ttfb: 0,
      resources: {},
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        })
      }
    }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'largest-contentful-paint') {
          window.__perf.lcp = entry.startTime
        }
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  })

  const navStart = Date.now()
  await page.goto(`${BASE_URL}/code?folder=${project.id}`, { waitUntil: 'domcontentloaded' })
  metrics.navigationStartMs = Date.now() - navStart

  const entry = page.getByTestId('agent-company-live-preview')
  await entry.waitFor({ state: 'visible', timeout: 30_000 })

  // TTI estimado: momento en que la página está lista + ventana de 5s sin
  // long tasks. Proxy: paint estable + último long task.
  await page.waitForTimeout(500)
  const core = await page.evaluate(() => {
    const longTasks = window.__perf.longTasks
    const lastLongTask = longTasks.length > 0
      ? Math.max(...longTasks.map((t) => t.start + t.duration))
      : 0
    const tbt = longTasks.reduce((acc, t) => acc + (t.duration - 50), 0)
    return {
      longTasks: longTasks.length,
      tbt,
      lastLongTaskEnd: lastLongTask,
      lcp: window.__perf.lcp,
      ttfb: window.__perf.ttfb,
      heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
      jsHeapLimitMB: Math.round((performance.memory?.jsHeapSizeLimit || 0) / 1048576),
    }
  })
  metrics.interactive = core

  // Abrir la megaoficina y esperar ready (budget).
  const readyStartedAt = await page.evaluate(() => performance.now())
  await entry.click()
  const dialog = page.getByRole('dialog')
  const scene = page.getByTestId('agent-office-scene')
  const canvas = scene.locator('canvas')
  await dialog.waitFor({ state: 'visible' })
  await scene.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="agent-office-scene"]')
    return el?.getAttribute('data-office-ready') === 'true'
  }, null, { timeout: OFFICE_READY_BUDGET_MS + 5000 })
  const officeReadyMs = await page.evaluate(
    (startedAt) => performance.now() - startedAt,
    readyStartedAt,
  )
  metrics.office = {
    officeReadyMs: Math.round(officeReadyMs),
    drawCalls: Number(await canvas.getAttribute('data-office-draw-calls')),
    triangles: Number(await canvas.getAttribute('data-office-triangles')),
    workers: Number(await canvas.getAttribute('data-office-interactive-worker-count')),
    renderedWorkers: Number(await canvas.getAttribute('data-office-rendered-interactive-worker-count')),
  }

  // Sesión larga: recargar el mock con un volumen de runs creciente y medir
  // heap tras GC (mejor proxy de memoria retenida en el renderer).
  metrics.memorySeries = []
  for (let i = 0; i < RUNS; i += 1) {
    const extraRuns = AGENT_COMPANY_DEPARTMENTS.flatMap((department, departmentIndex) => {
      const runCount = (department.desiredAgents || 1) - (department.id === 'ceo-office' ? 1 : 0)
      return Array.from({ length: runCount }, (_, workerIndex) => {
        const sequence = departmentIndex * 1000 + workerIndex + i * 10000
        return {
          id: `long-session-run-${i}-${department.id}-${workerIndex + 1}`,
          projectId: 'codex-office-scale-196',
          departmentPoolId: `pool-${department.id}`,
          swarmTaskId: null,
          mode: 'build',
          status: 'done',
          tier: 'pro',
          model: 'gpt-5.4',
          planRunId: null,
          prompt: `[PROACTIVO · ${department.name}] Worker ${workerIndex + 1}: ${department.mission} (lote ${i})`,
          error: null,
          createdAt: new Date(Date.parse(now) - (sequence + 10) * 1000).toISOString(),
          startedAt: new Date(Date.parse(now) - (sequence + 9) * 1000).toISOString(),
          finishedAt: new Date(Date.parse(now) - sequence * 1000).toISOString(),
          updatedAt: new Date(Date.parse(now) - sequence * 1000).toISOString(),
        }
      })
    })
    const cumulativeRuns = [...runs, ...extraRuns]
    await page.unroute('**/api/**').catch(() => {})
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, '')
      if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === 'GET') {
        return fulfillJson(route, { runs: cumulativeRuns })
      }
      if (path === '/auth/me') return fulfillJson(route, { user })
      if (path === '/projects' && request.method() === 'GET') {
        return fulfillJson(route, { projects: [project] })
      }
      if (path === `/projects/${project.id}` && request.method() === 'GET') {
        return fulfillJson(route, { project })
      }
      if (path === '/codex/access') {
        return fulfillJson(route, { ok: true, enabled: true, canRun: true, allowlistConfigured: true })
      }
      if (/^\/codex\/projects\/[^/]+\/proactive$/.test(path)) {
        return fulfillJson(route, {
          state: {
            enabled: false,
            enabledAt: null,
            dayKey: '2026-08-10',
            runsToday: cumulativeRuns.length,
            deptIndex: 0,
            lastCycleAt: now,
            lastError: null,
            costTodayUsd: 1.96,
            dailyBudgetUsd: 25,
            budgetBlocked: false,
          },
          departments: AGENT_COMPANY_DEPARTMENTS.map((department) => ({
            ...department,
            custom: false,
            enabled: true,
          })),
          departmentPools,
          capacity: {
            departments: AGENT_COMPANY_DEPARTMENTS.length,
            logicalAgents: SCALE_WORKERS,
            departmentPools: departmentPools.length,
            physicalAgents: SCALE_WORKERS,
            writerConcurrency: 16,
            dailyBudgetUsd: 25,
            strategy: 'isolated_worktrees_serialized_merge',
          },
        })
      }
      return fulfillJson(route, {})
    })

    // Dispara un refresh real del panel (mismo ciclo de polling de 5s).
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('siragpt:codex-project-changed'))
    }).catch(() => {})
    await page.waitForTimeout(1200)

    const sample = await page.evaluate(async () => {
      if (typeof window.gc === 'function') window.gc()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      const canvas = document.querySelector('[data-testid="agent-office-scene"] canvas')
        || document.querySelector('canvas')
      return {
        heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
        workers: Number(canvas?.getAttribute('data-office-interactive-worker-count') || 0),
        frameCount: Number(canvas?.getAttribute('data-frame-count') || 0),
      }
    })
    sample.iteration = i
    metrics.memorySeries.push(sample)
  }

  const sizeReport = await page.evaluate(async () => {
    const entries = performance.getEntriesByType('resource')
    let jsBytes = 0
    let cssBytes = 0
    let jsonBytes = 0
    let largest = { url: '', bytes: 0 }
    for (const entry of entries) {
      const url = entry.name
      const size = entry.transferSize || entry.encodedBodySize || 0
      if (url.includes('/_next/static/chunks/') && url.endsWith('.js')) jsBytes += size
      else if (url.endsWith('.css')) cssBytes += size
      else if (url.endsWith('.json')) jsonBytes += size
      if (size > largest.bytes) largest = { url, bytes: size }
    }
    return {
      jsBytes,
      cssBytes,
      jsonBytes,
      totalBytes: jsBytes + cssBytes + jsonBytes,
      largest,
      resourceCount: entries.length,
    }
  })
  metrics.resources = sizeReport

  await browser.close()
  console.log(JSON.stringify(metrics, null, 2))
}

measure().catch((err) => {
  console.error('perf-code-baseline failed:', err)
  process.exit(1)
})