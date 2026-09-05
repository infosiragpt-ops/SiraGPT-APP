import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { promisify } from "node:util"
import { Document, Packer, Paragraph } from "docx"
import { expect, test, type Page } from "@playwright/test"

// Browser plugin not available: use the repository's Playwright runner.
// Real login, upload, API, DB, storage and validator. Only the Stop tests delay
// a real request; they never replace its response. No skips or login-wall passes.
test.describe.configure({ retries: 0, timeout: 180_000 })
test.use({ trace: "off", video: "off", screenshot: "off" }) // never record credentials

const OWNER = "doc-real-phase1-authorized-budget"
const FILE_NAME = "document-sandbox-browser.docx"
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PROMPT = "No cambies nada; devuelve el documento original intacto."
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const backendRequire = createRequire(path.join(process.cwd(), "backend/package.json"))
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Required isolated E2E setting: ${name}`)
  return value
}
function localUrl(name: string): string {
  const value = required(name)
  const url = new URL(value)
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must address the isolated loopback test environment`)
  }
  return value.replace(/\/+$/, "")
}
async function api(page: Page, endpoint: string, body?: object) {
  const base = localUrl("NEXT_PUBLIC_API_URL").replace(/\/api$/, "") + "/api"
  return page.evaluate(async ({ url, payload }) => {
    const token = localStorage.getItem("auth-token")
    const response = await fetch(url, { method: payload ? "POST" : "GET", credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) })
    if (!response.ok) throw new Error(`E2E API returned HTTP ${response.status}`)
    return response.json()
  }, { url: `${base}${endpoint}`, payload: body })
}
async function login(page: Page) {
  localUrl("PLAYWRIGHT_BASE_URL")
  localUrl("NEXT_PUBLIC_API_URL")
  expect(required("DOC_SANDBOX_E2E_ISOLATED")).toBe("1")
  const model = required("DOC_SANDBOX_E2E_MODEL")
  await page.addInitScript(({ model }) => {
    if (sessionStorage.getItem("document-sandbox-e2e-initialized")) return
    sessionStorage.setItem("document-sandbox-e2e-initialized", "1")
    localStorage.removeItem("currentChatId")
    localStorage.setItem("sira:chat:pinned-model", model)
    localStorage.setItem("sira:chat:last-model", model)
    localStorage.setItem("sira.composer.access", "workspace")
  }, { model })
  await page.goto("/auth/login")
  await page.locator("#email").fill(required("DOC_SANDBOX_E2E_EMAIL"))
  await page.locator("#password").fill(required("DOC_SANDBOX_E2E_PASSWORD"))
  const loggedIn = page.waitForResponse(response => /\/api\/auth\/login$/.test(new URL(response.url()).pathname)
    && response.request().method() === "POST")
  await page.locator('form button[type="submit"]').click()
  expect((await loggedIn).status(), "Real password authentication must succeed").toBe(200)
  await page.goto("/agentes")
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 60_000 })
  expect(new URL(page.url()).pathname).toMatch(/\/agentes\/?$/)
  expect(await page.title()).not.toBe("")
  return model
}
async function emptyChat(page: Page, model: string) {
  const { chat } = await api(page, "/chats", { title: "Document sandbox browser verification", model })
  expect(typeof chat?.id).toBe("string")
  await page.evaluate(id => localStorage.setItem("currentChatId", id), chat.id)
  await page.reload()
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible()
  return chat.id as string
}
async function attach(page: Page) {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph("Documento sintético para comprobar el transporte del navegador."),
    new Paragraph("CENTINELA_DOC_SANDBOX_BROWSER_ORIGINAL"),
  ] }] }))
  const uploaded = page.waitForResponse(response => /\/api\/files\/upload$/.test(new URL(response.url()).pathname)
    && response.request().method() === "POST")
  await page.locator('input[type="file"]').first().setInputFiles({ name: FILE_NAME, mimeType: MIME, buffer: bytes })
  expect((await uploaded).ok(), "Original upload must reach the real file API").toBe(true)
  await page.getByTestId("chat-composer-surface").locator("textarea").fill(PROMPT)
  await expect(page.getByRole("button", { name: "Enviar (⏎)", exact: true })).toBeEnabled({ timeout: 60_000 })
  return bytes
}

async function verifiedBackendBudget(): Promise<number> {
  // Inspect only the fixed, isolated app container. Its index.js owns the
  // document worker in this harness. Never print .Config.Env or provider keys.
  const run = promisify(execFile)
  const container = "doc-sandbox-browser-backend"
  const format = '{"scope":{{json (index .Config.Labels "siragpt.scope")}},"running":{{json .State.Running}},"ports":{{json (index .HostConfig.PortBindings "15161/tcp")}},"network":{{json .HostConfig.NetworkMode}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"workdir":{{json .Config.WorkingDir}},"user":{{with (index .Config "User")}}{{json .}}{{else}}""{{end}},"mounts":{{json .Mounts}}}'
  const metadata = JSON.parse((await run("docker", ["inspect", "--format", format, container], { timeout: 10_000 })).stdout)
  expect(metadata.scope).toBe("doc-sandbox-phase1-test")
  expect(metadata.running).toBe(true)
  expect(metadata.network).toMatch(/^doc-sandbox-/)
  expect(metadata.entrypoint).toEqual(["node"])
  expect(metadata.command).toEqual(["index.js"])
  expect(metadata.workdir).toBe("/app/backend")
  expect(metadata.user).toBe("1000:1000")
  expect(metadata.ports).toEqual([{ HostIp: "127.0.0.1", HostPort: "15161" }])
  const inspected = await run("docker", ["exec", container, "node", "-e", `
    try {
      const primary = process.env.PRISMA_DATABASE_URL || process.env.DATABASE_URL;
      const conflict = Boolean(process.env.PRISMA_DATABASE_URL && process.env.DATABASE_URL && process.env.PRISMA_DATABASE_URL !== process.env.DATABASE_URL);
      const url = new URL(primary);
      console.log(JSON.stringify({ valid: !conflict, environment: process.env.NODE_ENV, engine: process.env.DOC_SANDBOX_ENGINE,
        maxCostUsd: Number(process.env.DOC_SANDBOX_MAX_COST_USD), port: Number(process.env.PORT),
        stagingRoot: process.env.DOC_SANDBOX_VALIDATION_STAGING_ROOT,
        databaseHost: url.hostname, databaseName: url.pathname, schema: url.searchParams.get('schema') || 'public' }));
    } catch { console.log(JSON.stringify({ valid: false })); }
  `], { timeout: 10_000 })
  const config = JSON.parse(inspected.stdout)
  expect(config).toMatchObject({ valid: true, environment: "test", engine: "anthropic", port: 15161, schema: "doc_sandbox_real_phase1" })
  expect(["doc-sandbox-test-postgres", "doc-sandbox-history-postgres"]).toContain(config.databaseHost)
  expect(config.databaseName).toBe(new URL(required("DOC_SANDBOX_REAL_DATABASE_URL")).pathname)
  // Paid acceptance needs the trusted worker's launcher and a shared private
  // staging directory. This does not add either mount to the no-provider harness.
  expect(config.stagingRoot).toMatch(/^\/home\/user\/deployments\/doc-sandbox-phase1-tests\/paid-validation-[A-Za-z0-9-]+$/)
  expect(await realpath(config.stagingRoot)).toBe(config.stagingRoot)
  const staging = await lstat(config.stagingRoot)
  expect(staging.isDirectory() && !staging.isSymbolicLink()).toBe(true)
  expect(staging.mode & 0o777).toBe(0o700)
  expect(staging.uid).toBe(1000)
  const binds = metadata.mounts.filter((mount: { Type: string }) => mount.Type === "bind")
  expect(metadata.mounts.every((mount: { Type: string }) => ["bind", "tmpfs"].includes(mount.Type))).toBe(true)
  expect(binds).toHaveLength(3)
  expect(binds).toEqual(expect.arrayContaining([
    expect.objectContaining({ Source: process.cwd(), Destination: "/app", RW: false }),
    expect.objectContaining({ Source: config.stagingRoot, Destination: config.stagingRoot, RW: true }),
    expect.objectContaining({ Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false }),
  ]))
  expect(new URL(localUrl("NEXT_PUBLIC_API_URL")).origin).toBe("http://127.0.0.1:15161")
  expect(Number.isFinite(config.maxCostUsd) && config.maxCostUsd > 0).toBe(true)
  return config.maxCostUsd
}

for (const initial of ["new", "empty"] as const) {
  test(`Stop during ${initial} chat admission retains the original and creates no job @no-provider-call`, async ({ page }) => {
    const model = await login(page)
    if (initial === "empty") await emptyChat(page, model)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.name))
    await attach(page)
    const admissions: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/docs\/jobs\/?$/.test(new URL(request.url()).pathname)) admissions.push("POST")
    })
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    let requested!: () => void
    const reachedPreflight = new Promise<void>(resolve => { requested = resolve })
    await page.route(/\/api\/docs\/jobs\/capabilities\?/, async route => {
      requested()
      await delayed
      await route.continue().catch(() => {}) // Stop may have already aborted this real request.
    })
    try {
      await page.getByRole("button", { name: "Enviar (⏎)", exact: true }).click()
      await reachedPreflight
      const stop = page.getByRole("button", { name: "Detener generación", exact: true })
      await expect(stop).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`stop-${initial}.png`) })
      await stop.click()
      await expect(page.getByTestId("chat-composer-surface").locator("textarea")).toHaveValue(PROMPT)
      await expect(stop).toHaveCount(0)
      expect(admissions).toHaveLength(0)
      expect(errors).toEqual([])
    } finally { release() }
  })
}

test("real no-op: original upload → one admission → reload → verified download @real-provider", async ({ page }) => {
  test.setTimeout(660_000)
  expect(required("DOC_SANDBOX_E2E_EXECUTE_REAL"), "Run only after the shared budget and provider cap are verified").toBe("1")
  const maxCost = await verifiedBackendBudget()
  // Reuse the provider-cap guard and aggregate campaign lock; never establish
  // a fresh authorization, new owner, or a separate budget for browser tests.
  const { proofOfProviderCap } = backendRequire("./tests/doc-sandbox-real.cjs")
  const proof = await proofOfProviderCap(5)
  const database = new URL(required("DOC_SANDBOX_REAL_DATABASE_URL"))
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname)
  expect(database.pathname).toMatch(/doc[_-](?:sandbox|phase1)/)
  database.searchParams.delete("schema")
  const { Client } = backendRequire("pg")
  const db = new Client({ connectionString: database.toString(), options: "-c search_path=doc_sandbox_real_phase1" })
  await db.connect()
  let admittedId: string | undefined
  let terminal = false
  try {
    const locked = await db.query("SELECT pg_try_advisory_lock($1,$2) AS acquired", [1768191, 15001])
    expect(locked.rows[0].acquired).toBe(true)
    const authorization = await db.query("SELECT authorized_usd,margin_usd FROM doc_real_authorization WHERE id=$1", ["phase1-user-authorized-five-usd"])
    expect(Number(authorization.rows[0]?.authorized_usd)).toBe(5)
    expect(Number(authorization.rows[0]?.margin_usd)).toBe(0.75)
    const jobs = await db.query("SELECT cost_usd,usage,cost_reservations FROM doc_jobs WHERE user_id=$1", [OWNER])
    let committed = 0
    for (const job of jobs.rows) {
      expect(job.usage?.costUsd, "Unknown provider costs keep the campaign closed").not.toBeNull()
      committed += Number(job.cost_usd)
      for (const reservation of job.cost_reservations) expect(reservation.actualUsd).not.toBeNull()
    }
    expect(Number.isFinite(maxCost) && maxCost > 0).toBe(true)
    expect(committed + maxCost).toBeLessThanOrEqual(4.25)
    expect(maxCost).toBeLessThanOrEqual(proof.remainingUsd)
    const model = await login(page)
    const browserErrors: string[] = []
    page.on("pageerror", error => browserErrors.push(error.name))
    expect((await api(page, "/auth/me")).user.id).toBe(OWNER)
    const chatId = await emptyChat(page, model)
    // A real API-created chat must exist in the same DB/schema as the ledger.
    // Merely pointing the test at a loopback proxy does not establish isolation.
    const shared = await db.query('SELECT id FROM chats WHERE id=$1 AND "userId"=$2', [chatId, OWNER])
    expect(shared.rows).toHaveLength(1)
    const caps = await api(page, `/docs/jobs/capabilities?model=${encodeURIComponent(model)}`)
    expect(caps).toMatchObject({ enabled: true, ready: true, supported: true })
    const bytes = await attach(page)
    const submissions: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/docs\/jobs\/?$/.test(new URL(request.url()).pathname)) submissions.push("POST")
    })
    const accepted = page.waitForResponse(response => /\/api\/docs\/jobs\/?$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST")
    await page.getByRole("button", { name: "Enviar (⏎)", exact: true }).click()
    const response = await accepted
    expect(response.ok()).toBe(true)
    const admitted = await response.json()
    expect(typeof admitted.id).toBe("string")
    admittedId = admitted.id
    await page.reload()
    await expect(page.getByText("El documento se verificó sin modificar su contenido.", { exact: false })).toBeVisible({ timeout: 600_000 })
    const snapshot = await api(page, `/docs/jobs/${admitted.id}`)
    terminal = ["done", "failed", "cancelled"].includes(snapshot.status)
    expect(snapshot).toMatchObject({ status: "done", admissionReady: true, outcome: "unchanged", errorCode: null })
    expect(submissions).toHaveLength(1)
    const output = snapshot.artifacts.find((item: { kind: string }) => item.kind === "output")
    expect(output).toMatchObject({ name: FILE_NAME, sha256: hash(bytes) })
    const downloadPending = page.waitForEvent("download")
    await page.getByRole("button", { name: `Descargar documento: ${FILE_NAME}`, exact: true }).click()
    const download = await downloadPending
    expect(download.suggestedFilename()).toBe(FILE_NAME)
    expect(await download.failure()).toBeNull()
    expect(hash(await readFile((await download.path())!))).toBe(hash(bytes))
    const reportPending = page.waitForEvent("download")
    await page.getByRole("button", { name: "Descargar documento: validation_report.json", exact: true }).click()
    const report = JSON.parse(await readFile((await (await reportPending).path())!, "utf8"))
    expect(report).toMatchObject({ passed: true, originalSha256: hash(bytes), outputSha256: hash(bytes) })
    expect(report.levels).toHaveLength(4)
    for (const level of [1, 2, 3, 4]) expect(report.levels).toContainEqual(expect.objectContaining({ level, applicable: true, passed: true }))
    expect(browserErrors).toEqual([])
    await page.screenshot({ path: test.info().outputPath("verified-noop-download.png") })
  } finally {
    if (admittedId && !terminal) {
      try { await api(page, `/docs/jobs/${admittedId}/cancel`, {}) }
      catch { test.info().annotations.push({ type: "cleanup", description: "Cancellation could not be confirmed; reconcile the durable test job before another campaign." }) }
    }
    await db.end()
  }
})
