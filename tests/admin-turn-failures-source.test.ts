import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8")

test("admin layout mounts the admin-wide failed-turn listener inside the admin guard", () => {
  const layout = read("app/admin/layout.tsx")
  assert.match(layout, /import \{ TurnFailureAlertsProvider \} from "@\/lib\/admin\/turn-failure-alerts"/)
  const guard = layout.indexOf("<AuthGuard requireAdmin={true}>")
  const provider = layout.indexOf("<TurnFailureAlertsProvider>")
  assert.ok(guard > 0 && provider > guard, "the listener polls admin-only endpoints: it must live inside the admin guard")
})

test("the «Logs» menu item shows the unseen failure badge", () => {
  const sidebar = read("components/admin-sidebar.tsx")
  assert.match(sidebar, /useTurnFailureAlerts\(\)\?\.unseen/)
  assert.match(sidebar, /item\.url === "\/admin\/logs" && unseenFailures > 0/)
  assert.match(sidebar, /data-testid="admin-logs-failure-badge"/)
})

test("Logs opens on «Fallos de respuesta» with the global error-sound toggle", () => {
  const page = read("app/admin/logs/page.tsx")
  assert.match(page, /useState<string>\("fallos"\)/)
  assert.match(page, /<TabsTrigger value="fallos"[^>]*>\s*Fallos de respuesta/)
  assert.match(page, /<TurnFailuresPanel \/>/)
  assert.match(page, /Sonido de errores: \{alerts\?\.soundOn \? "activado" : "desactivado"\}/)
  assert.doesNotMatch(page, /const beep = useCallback/, "only failed user turns may sound — the generic audit beep is gone")
  assert.match(page, /isWarnClientEvent/, "warn-level client noise is collapsed")
})

test("the chat stream reports browser-side turn failures with ids only", () => {
  const api = read("lib/api.ts")
  assert.match(api, /reportTurn\(\s*\/No se pudo conectar\/i\.test/)
  assert.match(api, /lastTurnActivityAt = Date\.now\(\);/)
  assert.match(api, /reportTurn\('no_activity'/)
  assert.match(api, /reportTurn\('empty_close', 'El stream cerró sin contenido'\);/)
  assert.match(api, /idempotencyKey: turnKey,/)
  assert.match(api, /getAdminTurnFailuresRecent/)
  const logs = read("lib/client-logs.ts")
  assert.match(logs, /turn\?: ClientTurnSignal \| null/)
  assert.match(logs, /reason: "render_crash" as const, chatId/)
})

test("the alerts provider sounds only failures, throttled, and unlocks audio on the toggle", () => {
  const alerts = read("lib/admin/turn-failure-alerts.tsx")
  assert.match(alerts, /playErrorChime\(ensureAudio\(\), "soft"\)/, "the toggle click plays a soft preview (autoplay unlock)")
  assert.match(alerts, /createAlertThrottle\(\{ minIntervalMs: 5000/)
  assert.match(alerts, /new Notification\(/)
  assert.match(alerts, /ERROR_SOUND_STORAGE_KEY = "sira-admin-error-sound"/)
})
