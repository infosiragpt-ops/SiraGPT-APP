import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("department computer pane API base + errors", () => {
  it("uses the same-origin helper and never localhost:5000 or api.siragpt.com", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const shell = source("components/code/agent-computer-shell.tsx")
    const helper = source("lib/api-base-url.ts")
    for (const [name, src] of [
      ["pane", pane],
      ["panel", panel],
      ["shell", shell],
    ] as const) {
      assert.match(src, /getSameOriginApiBaseUrl/, `${name} must use getSameOriginApiBaseUrl`)
      assert.doesNotMatch(src, /localhost:5000/, `${name} must not hardcode localhost:5000`)
      assert.doesNotMatch(src, /api\.siragpt\.com/, `${name} must not use api.siragpt.com`)
    }
    assert.match(helper, /getSameOriginApiBaseUrl/)
    assert.match(helper, /api\\.siragpt\\.com/)
    assert.match(helper, /NODE_ENV === "production"/)
    assert.match(helper, /localhost:5000/)
    assert.match(helper, /return "\/api"/)
    assert.match(pane, /El escritorio no está disponible/)
    assert.match(pane, /fetch failed/)
    assert.match(pane, /deepseek\|model\[_-]\?id/)
    assert.match(pane, /computer\\\.\(siragpt\|chatagic\)/)
  })

  it("renders the noVNC frame from a same-origin /sessions embed path", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /ComputerViewer/)
    assert.match(pane, /\/sessions\/\$\{id\}\/novnc\/vnc\.html/)
    assert.match(pane, /attachUrl/)
  })
})
