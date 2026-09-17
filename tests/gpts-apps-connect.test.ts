import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  CONNECT_COPY,
  catalogNavigateUrl,
  connectGptStoreApp,
  firstPartyOAuthStartPath,
  isHealthConnected,
  resolveConnectPlan,
  type ConnectableApp,
  type ConnectGptStoreAppDeps,
} from "../lib/gpts-apps-connect"

const linkedin: ConnectableApp = {
  id: "linkedin",
  name: "LinkedIn",
  domain: "linkedin.com",
}
const indeed: ConnectableApp = {
  id: "indeed",
  name: "Indeed",
  domain: "indeed.com",
}
const etsy: ConnectableApp = {
  id: "etsy",
  name: "Etsy",
  domain: "etsy.com",
}
const github: ConnectableApp = {
  id: "github",
  name: "GitHub",
  domain: "github.com",
}
const xApp: ConnectableApp = {
  id: "x",
  name: "X",
  domain: "x.com",
}
const facebook: ConnectableApp = {
  id: "facebook",
  name: "Facebook",
  domain: "facebook.com",
}

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8")
}

function fakeDeps(overrides: Partial<ConnectGptStoreAppDeps> = {}): ConnectGptStoreAppDeps & {
  calls: {
    fetch: Array<{ path: string; init?: RequestInit }>
    ensure: string[]
    navigate: Array<{ conversationId: string; url: string }>
    create: string[]
    open: Array<{ conversationId: string; url: string }>
    assign: string[]
    login: string[]
  }
} {
  const calls = {
    fetch: [] as Array<{ path: string; init?: RequestInit }>,
    ensure: [] as string[],
    navigate: [] as Array<{ conversationId: string; url: string }>,
    create: [] as string[],
    open: [] as Array<{ conversationId: string; url: string }>,
    assign: [] as string[],
    login: [] as string[],
  }
  return {
    calls,
    isAuthenticated: true,
    defaultModel: "deepseek-chat",
    currentConversationId: null,
    requireLogin: (next) => {
      calls.login.push(next || "")
    },
    fetchJson: async (requestPath, init) => {
      calls.fetch.push({ path: requestPath, init })
      return { ok: true, status: 200, body: { url: "https://oauth.example/authorize" } }
    },
    ensureComputer: async (conversationId) => {
      calls.ensure.push(conversationId)
      return { sessionId: "sess-1", conversationId, conversationBound: true }
    },
    navigateComputer: async (conversationId, url) => {
      calls.navigate.push({ conversationId, url })
    },
    createConversation: async (title) => {
      calls.create.push(title)
      return { id: "chat-new" }
    },
    openComputerOverlay: (conversationId, url) => {
      calls.open.push({ conversationId, url })
    },
    assignLocation: (url) => {
      calls.assign.push(url)
    },
    ...overrides,
  }
}

describe("gpts apps real connect", () => {
  it("branches first-party OAuth by domain/id and leaves catalog sites on the computer", () => {
    assert.deepEqual(resolveConnectPlan(linkedin), {
      kind: "oauth",
      provider: "linkedin",
      startPath: "/social-posts/connect/linkedin",
    })
    assert.deepEqual(resolveConnectPlan(xApp), {
      kind: "oauth",
      provider: "x",
      startPath: "/social-posts/connect/x",
    })
    assert.deepEqual(resolveConnectPlan({ id: "twitter", name: "Twitter", domain: "twitter.com" }), {
      kind: "oauth",
      provider: "x",
      startPath: "/social-posts/connect/x",
    })
    assert.deepEqual(resolveConnectPlan(facebook), {
      kind: "oauth",
      provider: "facebook",
      startPath: "/social-posts/connect/facebook",
    })
    assert.deepEqual(resolveConnectPlan(github), {
      kind: "oauth",
      provider: "github",
      startPath: "/github/connect",
    })
    assert.deepEqual(resolveConnectPlan({ id: "gmail", name: "Gmail", domain: "gmail.com" }), {
      kind: "oauth",
      provider: "gmail",
      startPath: "/auth/gmail",
    })
    assert.deepEqual(resolveConnectPlan({
      id: "gcalendar",
      name: "Google Calendar",
      domain: "calendar.google.com",
    }), {
      kind: "oauth",
      provider: "google-services",
      startPath: "/auth/google-services",
    })
    assert.deepEqual(resolveConnectPlan(indeed), {
      kind: "computer",
      url: "https://indeed.com",
    })
    assert.deepEqual(resolveConnectPlan(etsy), {
      kind: "computer",
      url: "https://etsy.com",
    })
    assert.equal(firstPartyOAuthStartPath(indeed), null)
    assert.equal(catalogNavigateUrl(indeed), "https://indeed.com")
  })

  it("does not invent OAuth for Indeed, Tarot or Etsy", () => {
    for (const app of [
      indeed,
      etsy,
      { id: "tarot", name: "Tarot", domain: "labyrinthos.co" },
    ]) {
      const plan = resolveConnectPlan(app)
      assert.equal(plan.kind, "computer")
      assert.doesNotMatch(JSON.stringify(plan), /oauth|social-posts|auth\//)
    }
  })

  it("refuses to mark connected and toasts no success when the user is logged out", async () => {
    const deps = fakeDeps({ isAuthenticated: false })
    const result = await connectGptStoreApp(indeed, deps)
    assert.equal(result.status, "login_required")
    assert.equal(result.markConnected, false)
    assert.equal(result.message, CONNECT_COPY.loginRequired)
    assert.deepEqual(deps.calls.login, ["/conexiones"])
    assert.equal(deps.calls.assign.length, 0)
    assert.equal(deps.calls.navigate.length, 0)
  })

  it("starts LinkedIn OAuth without marking Conectada before vault health", async () => {
    const deps = fakeDeps()
    const result = await connectGptStoreApp(linkedin, deps)
    assert.equal(result.status, "oauth_started")
    assert.equal(result.markConnected, false)
    assert.equal(result.redirectUrl, "https://oauth.example/authorize")
    assert.equal(deps.calls.fetch[0]?.path, "/social-posts/connect/linkedin")
    assert.equal(deps.calls.assign.length, 0)
    assert.equal(deps.calls.navigate.length, 0)
    assert.equal(deps.calls.ensure.length, 0)
  })

  it("shows a Spanish error and does not fake Facebook as connected when creds are missing", async () => {
    const deps = fakeDeps({
      fetchJson: async (requestPath) => {
        deps.calls.fetch.push({ path: requestPath })
        return {
          ok: false,
          status: 503,
          body: {
            code: "social_provider_not_configured",
            error: "Facebook OAuth is not configured on the server",
          },
        }
      },
    })
    const result = await connectGptStoreApp(facebook, deps)
    assert.equal(result.status, "error")
    assert.equal(result.markConnected, false)
    assert.equal(result.message, CONNECT_COPY.oauthMissing("Facebook"))
    assert.match(result.message, /credenciales OAuth/)
    assert.doesNotMatch(result.message, /connected|Failed|not configured/i)
    assert.equal(deps.calls.assign.length, 0)
  })

  it("opens the isolated computer on the catalog domain instead of a local stub", async () => {
    const deps = fakeDeps()
    const result = await connectGptStoreApp(indeed, deps)
    assert.equal(result.status, "computer_opened")
    assert.equal(result.markConnected, false)
    assert.equal(result.message, CONNECT_COPY.computerOpened)
    assert.deepEqual(deps.calls.create, ["Conectar Indeed"])
    assert.deepEqual(deps.calls.ensure, ["chat-new"])
    assert.deepEqual(deps.calls.navigate, [{
      conversationId: "chat-new",
      url: "https://indeed.com",
    }])
    assert.deepEqual(deps.calls.open, [{
      conversationId: "chat-new",
      url: "https://indeed.com",
    }])
    assert.equal(result.conversationId, "chat-new")
  })

  it("reuses the open conversation when the computer session already exists", async () => {
    const deps = fakeDeps({ currentConversationId: "chat-open" })
    const result = await connectGptStoreApp(etsy, deps)
    assert.equal(result.status, "computer_opened")
    assert.deepEqual(deps.calls.create, [])
    assert.deepEqual(deps.calls.ensure, ["chat-open"])
    assert.deepEqual(deps.calls.navigate, [{
      conversationId: "chat-open",
      url: "https://etsy.com",
    }])
  })

  it("never marks connected when computer isolation or navigate fails", async () => {
    const deps = fakeDeps({
      navigateComputer: async () => {
        throw new Error("No se pudo aislar la computadora de esta conversación.")
      },
    })
    const result = await connectGptStoreApp(indeed, deps)
    assert.equal(result.status, "error")
    assert.equal(result.markConnected, false)
    assert.equal(result.message, "No se pudo aislar la computadora de esta conversación.")
    assert.equal(deps.calls.open.length, 0)
    assert.equal(deps.calls.assign.length, 0)
  })

  it("keeps Spanish button labels for the four connect states", () => {
    assert.equal(CONNECT_COPY.connect, "Conectar")
    assert.equal(CONNECT_COPY.connecting, "Conectando…")
    assert.equal(CONNECT_COPY.connected, "Conectada")
    assert.equal(CONNECT_COPY.reconnect, "Reconectar")
    assert.equal(CONNECT_COPY.computerOpened, "Abierta en la computadora")
    assert.equal(isHealthConnected("connected"), true)
    assert.equal(isHealthConnected("degraded"), false)
    assert.equal(isHealthConnected("expired"), false)
  })

  it("removes the localStorage stub from the Apps section", () => {
    const section = source("components/gpts/gpts-apps-section.tsx")
    assert.match(section, /connectGptStoreApp/)
    assert.match(section, /CONNECT_COPY/)
    assert.match(section, /\/apps\/connections/)
    assert.match(section, /isHealthConnected/)
    assert.match(section, /agent-computer\/navigate/)
    assert.doesNotMatch(section, /settings\.apps\[id\]\?\.connected/)
    assert.doesNotMatch(section, /toast\.success\(`\$\{app\.name\} conectada`\)/)
    assert.doesNotMatch(section, /update\(\{ apps:/)
  })
})
