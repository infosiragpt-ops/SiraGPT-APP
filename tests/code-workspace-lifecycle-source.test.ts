import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const pageSource = readFileSync("app/code/page.tsx", "utf8")
const contextSource = readFileSync("lib/code-workspace-context.tsx", "utf8")

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("code workspace lifecycle contracts", () => {
  it("redirects unauthenticated users from an effect instead of render", () => {
    const gate = sliceBetween(
      pageSource,
      "function CodeWorkspaceGate(",
      "/**\n * ActiveFolderHydrator",
    )

    assert.match(gate, /React\.useEffect\(\(\) => \{[\s\S]*?router\.replace\("\/auth\/login\?next=\/code"\)/)
    assert.match(gate, /if \(!user\) return <CodeWorkspaceSkeleton \/>/)
    assert.doesNotMatch(gate, /if \(!user\) \{[\s\S]*?router\.replace/)
  })

  it("clears delayed tool and agent dispatches on effect cleanup", () => {
    assert.match(pageSource, /const timer = window\.setTimeout\([\s\S]*?return \(\) => window\.clearTimeout\(timer\)/)
    assert.match(pageSource, /const primaryTimer = window\.setTimeout\(openAgent, 220\)/)
    assert.match(pageSource, /const retryTimer = window\.setTimeout\(openAgent, 900\)/)
    assert.match(pageSource, /window\.clearTimeout\(primaryTimer\)/)
    assert.match(pageSource, /window\.clearTimeout\(retryTimer\)/)
  })

  it("creates or activates a workspace chat against the latest session store", () => {
    const openNewChat = sliceBetween(
      contextSource,
      "const openWorkspaceNewCodeChat = React.useCallback(",
      "React.useEffect(() => {",
    )

    assert.match(openNewChat, /setChatSessionStore\(\(prev\) => \{/)
    assert.match(openNewChat, /listSessionsForWorkspace\(key, prev\)/)
    assert.match(openNewChat, /setActiveCodeChatSessionRecord\(key, existing\.id, prev\)/)
    assert.match(openNewChat, /createCodeChatSessionRecord\([\s\S]*?prev,[\s\S]*?\)\.store/)
    assert.doesNotMatch(openNewChat, /chatSessionStore/)
  })

  it("derives git mirror commands outside React state updaters", () => {
    assert.match(contextSource, /const stateRef = React\.useRef\(state\)/)
    assert.match(contextSource, /const applyWorkspaceTransition = React\.useCallback/)
    assert.match(contextSource, /commitState\(result\.state\)/)
    assert.match(contextSource, /activeFolderIdRef\.current = nextFolderId/)
    assert.match(contextSource, /dispatchWorkspaceMirror\(activeFolderIdRef\.current, result\.mirror\)/)
    assert.doesNotMatch(contextSource, /let (?:changed|isNew|didRename|didDelete) = false/)
  })
})

describe("code chat orphan recovery", () => {
  it("waits before treating a trailing user bubble as an orphan", () => {
    const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
    assert.match(chat, /}, 800\)/)
    assert.match(chat, /currentLast\.role !== "user"/)
    assert.match(chat, /busyRef\.current \|\| buildingAppRef\.current/)
    assert.match(
      chat,
      /if \(recoveredOrphanTurnRef\.current\.has\(last\.id\)\) return\s+recoveredOrphanTurnRef\.current\.add\(last\.id\)/,
    )
  })
})
