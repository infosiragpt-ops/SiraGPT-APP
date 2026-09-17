import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const componentSource = readFileSync(
  join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

const liveAgentTask = sliceBetween(
  componentSource,
  "const handleAgentTask = async (",
  "function FeatureRow(",
)

const completionRefresh = sliceBetween(
  liveAgentTask,
  "markLocalJobIdle(activeChat.id, controller);",
  "} catch (err: any) {",
)

describe("live agent-task background focus contract", () => {
  it("synchronizes chat refs during render before an async completion can read them", () => {
    assert.match(
      componentSource,
      /const currentChatIdRef = React\.useRef<string \| null>\(currentChatId\)\s+currentChatIdRef\.current = currentChatId/,
    )
    assert.match(
      componentSource,
      /const currentChatRef = React\.useRef<any>\(currentChat\)\s+currentChatRef\.current = currentChat/,
    )
    assert.doesNotMatch(
      componentSource,
      /useEffect\(\(\) => \{ currentChatIdRef\.current = currentChatId \}, \[currentChatId\]\)/,
    )
  })

  it("refreshes the completed task only while its chat is still visible", () => {
    assert.match(
      completionRefresh,
      /if \(activeChat\?\.id && currentChatIdRef\.current === activeChat\.id\) \{[\s\S]*void selectChat\(activeChat\.id\)/,
    )
    assert.doesNotMatch(
      completionRefresh,
      /if \(activeChat\?\.id\)\s+(?:void\s+)?selectChat\(activeChat\.id\)/,
    )
  })
})
