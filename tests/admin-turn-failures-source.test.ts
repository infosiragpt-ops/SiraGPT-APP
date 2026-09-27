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
  assert.match(sidebar, /useTurnFailureAlerts\(\)\?\.totalUnseen/, "failed turns + new system issues")
  assert.match(sidebar, /item\.url === "\/admin\/logs" && unseenFailures > 0/)
  assert.match(sidebar, /data-testid="admin-logs-failure-badge"/)
})

test("Logs opens on «Fallos de respuesta» with the global error-sound toggle", () => {
  const page = read("app/admin/logs/page.tsx")
  assert.match(page, /useState<string>\("fallos"\)/)
  // Tabs are data: one entry per view, rendered by a single map.
  assert.match(page, /const logsTabs: LogsTab\[\] = \[/)
  assert.match(page, /value: "fallos",\s*label: "Fallos de respuesta",/)
  assert.match(page, /\{ value: "auditoria", label: "Auditoría", render: \(\) => auditPanel \}/)
  assert.match(page, /value: "errores",\s*label: "Errores del sistema",/)
  assert.match(page, /render: \(\) => <SystemIssuesPanel \/>/)
  assert.match(page, /\{ value: "vivo", label: "Registros en vivo", render: \(\) => <LiveLogsPanel \/> \}/)
  // Tab order: Fallos de respuesta · Errores del sistema · Registros en vivo · Auditoría
  assert.ok(page.indexOf('value: "fallos"') < page.indexOf('value: "errores"'))
  assert.ok(page.indexOf('value: "errores"') < page.indexOf('value: "vivo"'))
  assert.ok(page.indexOf('value: "vivo"') < page.indexOf('value: "auditoria"'))
  assert.match(page, /\{logsTabs\.map\(\(t\) => \(\s*<TabsTrigger key=\{t\.value\} value=\{t\.value\}/)
  assert.match(page, /render: \(\) => <TurnFailuresPanel \/>/)
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
  assert.match(alerts, /audioFactory = getErrorSoundContext/, "one shared AudioContext for every admin view")
  assert.match(alerts, /from "@\/lib\/admin\/error-sound"/)
  assert.match(alerts, /createAlertThrottle\(\{ minIntervalMs: 5000/)
  assert.match(alerts, /new Notification\(/)
  assert.match(read("lib/admin/error-sound.ts"), /ERROR_SOUND_STORAGE_KEY = "sira-admin-error-sound"/)
})

test("the failure detail offers the request's backend log lines only when that endpoint exists", () => {
  const detail = read("components/admin/turn-failures/turn-failure-detail.tsx")
  assert.match(detail, /apiClient\.getAdminRequestLogs\(reqId\)/)
  assert.match(detail, /if \(!lines \|\| lines\.length === 0\) return null/, "hidden until GET /admin/logs/request/:reqId answers with lines")
  const api = read("lib/api.ts")
  assert.match(api, /\/admin\/logs\/request\/\$\{encodeURIComponent\(reqId\)\}`, \{ suppressFailureLog: true, maxRetries: 0 \}/)
})

test("the /agentes voice catalog asks for voices only once it is opened", () => {
  const modal = read("components/voice/voice-catalog-modal.tsx")
  assert.match(modal, /useVoices\(\{ enabled: open \}\)/)
  assert.match(modal, /configured === false/)
  const hook = read("hooks/use-voices.tsx")
  assert.match(hook, /globalConfigured = response\?\.configured !== false/)
})

test("new system issues sound with the «critical» tone; repeats never reach the listener", () => {
  const alerts = read("lib/admin/turn-failure-alerts.tsx")
  assert.match(alerts, /playErrorChime\(ensureAudio\(\), "critical"\)/)
  assert.match(alerts, /apiClient\.getAdminSystemIssuesRecent\(since\)/)
  assert.match(alerts, /ISSUES_SEEN_AT_STORAGE_KEY = "sira-admin-system-issues-seen-at"/)
  // «Registros en vivo» error lines reuse the same sound (user-facing only).
  assert.match(alerts, /LIVE_LOG_ERRORS_EVENT = "sira:admin-live-log-errors"/)
  assert.match(alerts, /window\.addEventListener\(LIVE_LOG_ERRORS_EVENT, onLiveErrors\)/)
  assert.match(read("components/admin/live-logs/live-logs-panel.tsx"), /new CustomEvent\("sira:admin-live-log-errors"/)
  const panel = read("components/admin/system-issues/system-issues-panel.tsx")
  assert.match(panel, /alerts\?\.setViewingIssues\(true\)/)
  assert.match(panel, /<IssueSparkline values=\{it\.sparkline\}/)
})
