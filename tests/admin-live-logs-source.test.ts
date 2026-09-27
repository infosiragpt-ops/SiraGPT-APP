import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8")

test("Admin → Logs exposes «Registros en vivo» backed by the live panel", () => {
  const page = read("app/admin/logs/page.tsx")
  assert.match(page, /import \{ LiveLogsPanel \} from "@\/components\/admin\/live-logs\/live-logs-panel"/)
  assert.match(page, /Registros en vivo/)
  assert.match(page, /<LiveLogsPanel/)
})

test("the live stream never uses EventSource or puts a token in the URL", () => {
  const service = read("lib/admin/live-logs-service.ts")
  assert.match(service, /authenticatedFetch\(url/)
  assert.doesNotMatch(service, /new EventSource/)
  assert.doesNotMatch(service, /[?&]token=/)
  assert.match(service, /\/admin\/logs\/live/)
  assert.match(service, /\/admin\/logs\/request\//)
})

test("backend mounts the three admin log routes and captures from the first line of index.js", () => {
  const admin = read("backend/src/routes/admin.js")
  assert.match(admin, /router\.get\('\/logs\/live', adminLiveLogs\.live\)/)
  assert.match(admin, /router\.get\('\/logs\/search', adminLiveLogs\.search\)/)
  assert.match(admin, /router\.get\('\/logs\/request\/:reqId', adminLiveLogs\.request\)/)
  const index = read("backend/index.js")
  const install = index.indexOf("liveLogs.install()")
  assert.ok(install > 0 && install < index.indexOf("require('./src/services/agents/agent-system')"), "capture must install before the boot logs")
  assert.match(index, /app\.use\(liveLogs\.requestContextMiddleware\)/)
  const pino = read("backend/src/middleware/logger.js")
  assert.match(pino, /streamWrite: tapLiveLogs/)
})

test("live rows carry a selection checkbox before the time and copy only the selected lines", () => {
  const panel = read("components/admin/live-logs/live-logs-panel.tsx")
  assert.match(panel, /data-testid="live-logs-select-all"/)
  assert.match(panel, /data-testid="live-log-select"/)
  assert.match(panel, /data-testid="live-logs-copy-selected"/)
  assert.match(panel, /copyLines\(selectedLines\)/)
  assert.match(panel, /toggleLine\(line\.id, e\.shiftKey\)/)
  // The checkbox column comes first, before «Hora».
  assert.match(panel, /grid-cols-\[18px_92px_/)
})
