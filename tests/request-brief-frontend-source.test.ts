import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

// Source guards for the request-brief frontend wiring: the typed SSE frames
// reach the placeholder message, the «Entendí» line is mounted once per
// assistant bubble, and the clarify frame feeds the existing decision panel.

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

test("lib/api.ts parses the request_brief and intent.clarify_options frames into typed callbacks", () => {
  const api = read("lib/api.ts")
  assert.match(api, /export type RequestBriefPayload = \{/)
  assert.match(api, /export type ClarifyOptionsPayload = \{/)
  assert.match(api, /export function parseRequestBriefPayload\(raw: unknown\): RequestBriefPayload \| null/)
  assert.match(api, /onRequestBrief\?: \(brief: RequestBriefPayload\) => void/)
  assert.match(api, /onClarifyOptions\?: \(payload: ClarifyOptionsPayload\) => void/)
  assert.match(api, /jsonData\.type === 'request_brief'\) \{\s*const brief = parseRequestBriefPayload\(jsonData\.brief\)\s*if \(brief && options\.onRequestBrief\) options\.onRequestBrief\(brief\)/)
  assert.match(api, /jsonData\.type === 'intent\.clarify_options' && typeof jsonData\.question === 'string'/)
  // Both branches run BEFORE the generic activity/stage branch so they are
  // never mistaken for a stage row.
  assert.ok(api.indexOf("jsonData.type === 'request_brief'") < api.indexOf("(jsonData.type === 'activity' || jsonData.type === 'stage')"))
})

test("the chat context stores the brief on the placeholder and turns the clarify frame into decision-panel metadata", () => {
  const ctx = read("lib/chat-context-integrated.tsx")
  assert.match(ctx, /requestBrief\?: RequestBriefPayload \| null/)
  assert.match(ctx, /onRequestBrief: \(brief: RequestBriefPayload\) => \{\s*if \(isCancelled\(\)\) return\s*patchPlaceholder\(\(msg: any\) => \(\{ \.\.\.msg, requestBrief: brief \}\)\)/)
  assert.match(ctx, /metadata: \{ \.\.\.metadata, kind: 'clarification', question: payload\.question, options: payload\.options \}/)
  // lib/chat-work-status builds the panel from exactly that shape.
  const status = read("lib/chat-work-status.ts")
  assert.match(status, /candidate\.kind === "clarification"/)
})

test("the assistant bubble mounts the «Entendí» line once, after the thinking surface, and re-renders when the brief changes", () => {
  const bubble = read("components/message-component.tsx")
  assert.match(bubble, /import \{ RequestBriefLine, extractRequestBrief \} from "@\/components\/chat\/request-brief-line"/)
  assert.match(bubble, /const requestBriefView = isAssistant \? extractRequestBrief\(message\) : null;/)
  const mounts = bubble.match(/<RequestBriefLine brief=\{requestBriefView\} live=\{Boolean\(isStreaming\)\} \/>/g) || []
  assert.equal(mounts.length, 1)
  assert.match(bubble, /\{requestBriefView && !isThinking && !message\.error \? \(/)
  assert.match(bubble, /if \(a\.requestBrief !== b\.requestBrief\) return false/)
})

test("the «Entendí» line hides small talk, offers one correction and pre-fills the composer", () => {
  const line = read("components/chat/request-brief-line.tsx")
  assert.match(line, /if \(!brief \|\| brief\.trivial \|\| !brief\.summary\) return null/)
  assert.match(line, /export const REQUEST_BRIEF_CORRECTION_PREFILL = "No era eso\. Lo que quiero es: "/)
  assert.match(line, /setComposerPrefill\(REQUEST_BRIEF_CORRECTION_PREFILL\)/)
  assert.match(line, /data-testid="request-brief-line"/)
  // Persisted rows read metadata.requestBrief (what the backend saves).
  assert.match(line, /const raw = meta\?\.requestBrief/)
})
