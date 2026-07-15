import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../..")
const FETCH_SCAN_ROOTS = ["app", "components", "hooks", "lib"] as const

const AUTHENTICATED_SIRA_TRANSPORTS = [
  "lib/admin-credits-service.ts",
  "lib/agent-task-service.ts",
  "lib/agentic-search-service.ts",
  "lib/ai-service.ts",
  "lib/api-client-react/src/custom-fetch.ts",
  "lib/api.ts",
  "lib/auth-context-new.tsx",
  "lib/auth/mfa-totp.ts",
  "lib/builder/intake-service.ts",
  "lib/client-logs.ts",
  "lib/code-agent/subagent.ts",
  "lib/code-runner/host-runner-service.ts",
  "lib/codex/codex-api.ts",
  "lib/codex/run-stream.ts",
  "lib/credits-service.ts",
  "lib/database-new.ts",
  "lib/deployments/deployments-api.ts",
  "lib/design-service.ts",
  "lib/github-codex-service.ts",
  "lib/github-service.ts",
  "lib/gmail-service.ts",
  "lib/gpts-service.ts",
  "lib/hosting-service.ts",
  "lib/images-service.ts",
  "lib/marco-teorico-service.ts",
  "lib/notifications/push.ts",
  "lib/opencode/opencode-service.ts",
  "lib/plan-service.ts",
  "lib/project-documents-service.ts",
  "lib/projects-service.ts",
  "lib/settings-context.tsx",
  "lib/workspace-workflow-service.ts",
] as const

type RawFetchAllowance = {
  file: string
  reason: string
  accepts: (callText: string) => boolean
  required?: boolean
}

function isNonMutatingFetchCall(text: string): boolean {
  return !/\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i.test(text)
}

function isCredentialFreePublicFetch(text: string): boolean {
  return !/\bAuthorization\b|authHeaders?\s*\(|\bcredentials\s*:\s*["']include["']/i.test(text)
}

// Raw fetch is allowed only for deliberately public or external transports.
// Every exception is narrow to a concrete call shape so adding another call in
// the same file still fails this contract and requires an explicit review.
const RAW_FETCH_ALLOWLIST: RawFetchAllowance[] = [
  {
    file: "app/admin/health/page.tsx",
    reason: "Public same-origin health GET used by the operational dashboard.",
    accepts: (text) => text === 'fetch("/api/health")' && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "app/admin/status/page.tsx",
    reason: "Public Prometheus text endpoint; admin JSON calls use authenticatedFetch.",
    accepts: (text) =>
      text.startsWith('fetch("/metrics",')
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "app/api/agents/run/route.ts",
    reason: "Server-side delivery to the caller-provided external webhook.",
    accepts: (text) => text.startsWith("fetch(webhook_url,"),
  },
  {
    file: "app/demo/page.tsx",
    reason: "Public cached demo POST explicitly requires no account or session.",
    accepts: (text) =>
      text.startsWith('fetch("/api/demo",')
      && /\bmethod\s*:\s*["']POST["']/.test(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "app/documents/page.tsx",
    reason: "External artifact download branch after a trusted-Sira-origin check.",
    accepts: (text) => text === "fetch(href)",
  },
  {
    file: "app/openclaw/native/[[...path]]/route.ts",
    reason: "Server-side proxy to the separately authenticated, loopback-only OpenClaw gateway.",
    accepts: (text) => text.startsWith("fetch(upstreamUrl,"),
  },
  {
    file: "components/SearchPanel.tsx",
    reason: "Injectable external search endpoint branch after trusted Sira URLs use authenticatedFetch.",
    accepts: (text) => text === "fetch(url, { signal: ac.signal })",
  },
  {
    file: "components/WordConnector.tsx",
    reason: "Public or external inline image retrieval for DOCX export.",
    accepts: (text) => text === "fetch(url)",
  },
  {
    file: "components/agentic-steps.tsx",
    reason: "External artifact download branch after a trusted-Sira-origin check.",
    accepts: (text) => text === "fetch(href)",
  },
  {
    file: "components/connection-status.tsx",
    reason: "Public health HEAD probe with an optional external check URL.",
    accepts: (text) =>
      text.startsWith("fetch(checkUrl,")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/desktop/desktop-download-card.tsx",
    reason: "Public same-origin desktop release catalog GET used before login.",
    accepts: (text) =>
      text === 'fetch("/api/desktop/releases?channel=beta", { signal: controller.signal })'
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/design/design-composer.tsx",
    reason: "Public optional-auth AI model catalog GET.",
    accepts: (text) =>
      text === "fetch(`${API_ROOT}/ai/models?type=TEXT`)"
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/document-preview.tsx",
    reason: "Data/blob or external preview branch after trusted Sira assets use authenticatedFetch.",
    accepts: (text) => text === "fetch(normalized)",
  },
  {
    file: "components/download-buttons.tsx",
    reason: "Public or external generated-image download.",
    accepts: (text) => text === "fetch(content)",
  },
  {
    file: "components/fal/fal-model-gallery.tsx",
    reason: "Public cached FAL model manifest GET.",
    accepts: (text) =>
      text === 'fetch("/api/ai/fal-models")'
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/figma-diagram-component.tsx",
    reason: "External Figma/generated image download.",
    accepts: (text) => text === "fetch(imageUrl)",
  },
  {
    file: "components/message-component.tsx",
    reason: "Public or external chart-image download; authenticated document downloads use the shared transport.",
    accepts: (text) => text === "fetch(imageUrl)",
  },
  {
    file: "components/search-brain/UniversalSearchPanel.tsx",
    reason: "Public SearchBrain provider catalog GET.",
    accepts: (text) =>
      text === "fetch(`${API_ROOT}/search-brain/universal/providers`)"
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/search-brain/UniversalSearchPanel.tsx",
    reason: "Public SearchBrain search POST; only user settings routes are authenticated.",
    accepts: (text) =>
      text.startsWith("fetch(`${API_ROOT}/search-brain/universal`,")
      && /\bmethod\s*:\s*["']POST["']/.test(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/settings/settings-panel.tsx",
    reason: "Public optional-auth AI model catalog GET.",
    accepts: (text) =>
      text === "fetch(`${base}/ai/models?type=TEXT`)"
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "components/viewers/UnifiedDocumentViewer.tsx",
    reason: "Data/blob or external viewer asset branch after trusted Sira assets use authenticatedFetch.",
    accepts: (text) => text === "fetch(normalized)",
  },
  {
    file: "lib/attachments/link-preview.ts",
    reason: "Public same-origin link-preview GET with an injectable fetch seam.",
    accepts: (text) => text === "fetch(...args)",
  },
  {
    file: "lib/api.ts",
    reason: "Anonymous quota GET is intentionally unauthenticated.",
    accepts: (text) => text.includes("/ai/anon-quota") && isNonMutatingFetchCall(text),
  },
  {
    file: "lib/authenticated-fetch.ts",
    reason: "Canonical transport dispatch resolves the instrumented global fetch at call time.",
    accepts: (text) => text === "globalThis.fetch(input, init)",
  },
  {
    file: "lib/code-runner/host-runner-service.ts",
    reason: "Public host-runner feature-flag health GET.",
    accepts: (text) =>
      text.includes("${baseUrl}/health")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/codex/codex-api.ts",
    reason: "Public Codex feature-flag health GET.",
    accepts: (text) =>
      text.includes("${BASE}/health")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/deployments/deployments-api.ts",
    reason: "Public deployments feature-flag health GET.",
    accepts: (text) =>
      text.includes("${BASE}/health")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/desktop-releases.ts",
    reason: "Server-side public GitHub release catalog GET with no Sira credentials.",
    accepts: (text) =>
      text === "fetch(RELEASES_API, requestInit)"
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/gpts-service.ts",
    reason: "Public shared-GPT snapshot GET.",
    accepts: (text) =>
      text.includes("/share/${shareId}")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/gpts-service.ts",
    reason: "Public GPT category catalog GET.",
    accepts: (text) =>
      text.includes("${this.baseUrl}/categories")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/next-health.ts",
    reason: "Server-side public backend health probe.",
    accepts: (text) => text.startsWith("fetch(url,") && isNonMutatingFetchCall(text),
  },
  {
    file: "lib/opencode/opencode-service.ts",
    reason: "Public OpenCode feature-flag health GET.",
    accepts: (text) =>
      text.includes("${baseUrl}/health")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/plans-service.ts",
    reason: "Public plan catalog GET.",
    accepts: (text) =>
      text === "fetch(`${API_ROOT}/plans`)"
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/plans-service.ts",
    reason: "Public plan-detail GET.",
    accepts: (text) =>
      text === "fetch(`${API_ROOT}/plans/${code}`)"
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
    required: true,
  },
  {
    file: "lib/projects-service.ts",
    reason: "Public shared-project snapshot GET must not attach user auth.",
    accepts: (text) =>
      text.includes("/share/${shareId}")
      && isNonMutatingFetchCall(text)
      && isCredentialFreePublicFetch(text),
  },
  {
    file: "lib/publishing-console.ts",
    reason: "External GitHub Actions dispatch with its own server credential.",
    accepts: (text) => text.startsWith("fetch(url,"),
  },
  {
    file: "lib/use-backend-ready.ts",
    reason: "Public HEAD readiness probe.",
    accepts: (text) => text.includes("/health/ready") && isNonMutatingFetchCall(text),
  },
  {
    file: "lib/utils.ts",
    reason: "Public/external blob download helper.",
    accepts: (text) => text === "fetch(href)" || text === "fetch(href, init)",
  },
]

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(absolute))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(absolute)
  }
  return out
}

function rawFetchCalls(file: string): string[] {
  const source = fs.readFileSync(file, "utf8")
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const calls: string[] = []

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const isDirectFetch =
        ts.isIdentifier(expression)
        && expression.text === "fetch"
      const isGlobalFetch =
        ts.isPropertyAccessExpression(expression)
        && expression.name.text === "fetch"
        && ts.isIdentifier(expression.expression)
        && ["globalThis", "window", "self"].includes(expression.expression.text)

      if (isDirectFetch || isGlobalFetch) calls.push(node.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return calls
}

describe("authenticated Sira fetch contract", () => {
  it("routes every authenticated Sira service through the shared transport", () => {
    const violations: string[] = []

    for (const relative of AUTHENTICATED_SIRA_TRANSPORTS) {
      const source = fs.readFileSync(path.join(ROOT, relative), "utf8")
      if (!/authenticatedFetch|createAuthenticatedFetch|prepareAuthenticatedRequest/.test(source)) {
        violations.push(relative)
      }
    }

    expect(violations, "services bypassing the shared authenticated transport").toEqual([])
  })

  it("rejects raw fetch calls across frontend trees outside the explicit public/external allowlist", () => {
    const violations: string[] = []

    for (const rootName of FETCH_SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(ROOT, rootName))) {
        const relative = path.relative(ROOT, file).replaceAll(path.sep, "/")
        for (const call of rawFetchCalls(file)) {
          const allowed = RAW_FETCH_ALLOWLIST.some(
            (entry) => entry.file === relative && entry.accepts(call),
          )
          if (!allowed) violations.push(`${relative}: ${call.slice(0, 140)}`)
        }
      }
    }

    expect(violations, "raw fetch calls require a narrow public/external exception").toEqual([])
  })

  it("keeps required public transports on raw fetch", () => {
    const missing = RAW_FETCH_ALLOWLIST
      .filter((entry) => entry.required)
      .filter((entry) => {
        const calls = rawFetchCalls(path.join(ROOT, entry.file))
        return !calls.some(entry.accepts)
      })
      .map((entry) => `${entry.file}: ${entry.reason}`)

    expect(missing, "public endpoints accidentally routed through authenticatedFetch").toEqual([])
  })
})
