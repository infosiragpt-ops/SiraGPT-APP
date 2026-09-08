import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("always-on computer — bounded reconnect in the viewer", () => {
  it("retries a dead channel a few times, then reports loudly", () => {
    const screen = source("components/desktop/DesktopScreen.tsx")
    assert.match(screen, /DESKTOP_RFB_MAX_RETRIES = 4/)
    assert.match(screen, /DESKTOP_RFB_RETRY_DELAYS_MS = \[1000, 2000, 4000, 8000\]/)
    assert.match(screen, /onConnectionError\?: \(\) => void/)
    assert.match(screen, /attemptsRef\.current >= DESKTOP_RFB_MAX_RETRIES/)
    assert.match(screen, /clearTimeout\(retryTimerRef\.current\)/, "retry timers die with the component")
    assert.doesNotMatch(screen, /while \(true\)|Infinity.*retr|setInterval\(\(\) => \{\s*setRetryNonce/, "no unbounded reconnect loop")
  })

  it("a live drop also rebuilds instead of freezing on the last frame", () => {
    const screen = source("components/desktop/DesktopScreen.tsx")
    assert.match(screen, /if \(firstFrameRef\.current\) \{\s*setStatus\("error"\)\s*onConnectionError\?\.\(\)/)
  })
})

describe("always-on computer — pane acquire, validate, heartbeat, honest error", () => {
  it("retries session acquire with backoff, never on isolation/auth errors", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /COMPUTER_ACQUIRE_ATTEMPTS = 3/)
    assert.match(pane, /COMPUTER_ACQUIRE_RETRY_DELAYS_MS = \[1000, 2500\]/)
    assert.match(pane, /acquireMemberDesktopWithRetry/)
    assert.match(pane, /status === 400 \|\| status === 401 \|\| status === 403 \|\| status === 409/)
    assert.match(pane, /aislar\|isolation\|login\|permiso\|forbidden\|unauthorized/)
  })

  it("revalidates a cached session before trusting it (stale tabs, restarts)", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /validateAgentSession/)
    assert.match(pane, /\/agent-computer\/sessions\/\$\{encodeURIComponent\(id\)\}/)
    assert.match(pane, /sessionCache\.delete\(cacheKey\(chatId \|\| null\)\)/)
  })

  it("heartbeats the live session and rebuilds after consecutive misses", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /COMPUTER_HEARTBEAT_INTERVAL_MS = 60_000/)
    assert.match(pane, /COMPUTER_HEARTBEAT_MAX_MISSES = 2/)
    assert.match(pane, /setInterval\(\(\) => \{/)
    assert.match(pane, /clearInterval\(timer\)/)
  })

  it("shows an honest error with retry instead of spinning forever", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /data-testid="desktop-error-card"/)
    assert.match(pane, /data-testid="desktop-retry"/)
    assert.match(pane, /Reintentar/)
    assert.match(pane, /onConnectionError=\{handleViewerConnectionError\}/)
    assert.match(pane, /autoRebuiltRef/)
    // The loading path keeps its approved copy and testids.
    assert.match(pane, /data-testid="desktop-preparing-label"/)
    assert.match(pane, /PREPARING_DESKTOP_ES\}/)
    assert.match(pane, /data-testid="desktop-prepare-progress"/)
  })

  it("remounts the viewer on rebuild so a new channel always starts clean", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /key=\{`\$\{desktopLease\.sessionId\}:\$\{buildId\}`\}/)
    assert.match(pane, /key=\{`\$\{session\.sessionId\}:\$\{buildId\}`\}/)
  })
})

describe("always-on computer — orchestrator boot reconciliation", () => {
  it("re-registers running desktops after a restart and lists computers", () => {
    const server = source("services/computer-orchestrator/server.js")
    const runtime = source("services/computer-orchestrator/docker-runtime.js")
    assert.match(server, /reconcileContainers/)
    assert.match(server, /sira-ac-user-/)
    assert.match(server, /computer_orchestrator_reconciled/)
    assert.match(runtime, /listComputers/)
    assert.match(runtime, /siragpt\.computer/)
  })
})
