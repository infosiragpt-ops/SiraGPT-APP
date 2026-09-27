import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"

// Edición milimétrica — one timeline per turn: document creation
// (/api/doc/generate) streams the AgentRunner's stage v2 rows; the chat keeps
// them on the placeholder (ActivityRail while it works) and on the delivered
// message (finished timeline), in the normal send and in the edit-and-resend path.
const source = fs.readFileSync(path.join(process.cwd(), "lib", "chat-context-integrated.tsx"), "utf8")

test("doc generation keeps the runner rows on the placeholder and the delivered message", () => {
  const start = source.indexOf("} else if (intent === 'doc' || intent === 'ppt') {")
  const end = source.indexOf("} else if (intent === 'viz') {", start)
  assert.ok(start >= 0 && end > start)
  const branch = source.slice(start, end)
  assert.match(branch, /let docActivity: ActivityStep\[\] = \[\]/)
  assert.match(branch, /progressPct: lastPct, activityLog: docActivity/)
  assert.match(branch, /if \(ev\.tool \|\| ev\.callId\) docActivity = appendActivity\(docActivity, ev\)/)
  assert.match(branch, /activityLog: finalizeActivity\(docActivity\)/)
  // The cancellation fence stays right before the billable call.
  assert.match(branch, /throwIfTurnCancelled\(\);[\s\S]{0,500}apiClient\.generateDocStream\(/)
})

test("edit-and-resend of a document request keeps the same timeline", () => {
  const start = source.indexOf("let docFinalMsg: any = null;")
  const end = source.indexOf("pendingStopsRef.current.delete(currentChat.id);", start)
  assert.ok(start >= 0 && end > start)
  const branch = source.slice(start, end)
  assert.match(branch, /progressPct: docPct, activityLog: docActivity/)
  assert.match(branch, /if \(ev\.tool \|\| ev\.callId\) docActivity = appendActivity\(docActivity, ev\)/)
  assert.match(branch, /activityLog: finalizeActivity\(docActivity\)/)
})
