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
    assert.match(pane, /Preparando escritorio/)
    assert.match(pane, /\/desktop\/status/)
    assert.match(pane, /poolWarm/)
  })

  it("renders the noVNC frame from a same-origin /sessions embed path", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /ComputerViewer/)
    assert.match(pane, /\/sessions\/\$\{id\}\/novnc\/vnc\.html/)
    assert.match(pane, /attachUrl/)
  })

  it("wires the F7 desktop session to DesktopScreen without ripping the orch path", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    const screen = source("components/desktop/DesktopScreen.tsx")
    assert.match(pane, /DesktopScreen/)
    assert.match(pane, /next\/dynamic/)
    assert.match(pane, /ssr:\s*false/)
    assert.match(pane, /\/desktop\/sessions/)
    assert.match(pane, /viewOnly=\{desktopLease\.inputMode !== "human"\}/)
    assert.doesNotMatch(pane, /api\.siragpt\.com/)
    assert.doesNotMatch(pane, /La vista en vivo llega en la siguiente fase/)
    assert.match(screen, /desktop-rfb-client/)
    assert.doesNotMatch(screen, /@novnc\/novnc\/lib\/rfb/)
    assert.match(screen, /viewOnly/)
    assert.match(screen, /\/ws\/desktop/)
    assert.doesNotMatch(screen, /api\.siragpt\.com/)
    assert.doesNotMatch(screen, /DeepSeek|deepseek|model_id/)
    const rfb = source("components/desktop/desktop-rfb-client.ts")
    assert.match(rfb, /from ["']@novnc\/novnc["']/)
    assert.doesNotMatch(rfb, /@novnc\/novnc\/lib/)
  })

  it("promotes the live desktop with Abrir into a 90% overlay without remounting", () => {
    const pane = source("components/code/department-computer-pane.tsx")
    assert.match(pane, /data-testid="computer-abrir"/)
    assert.match(pane, /data-testid="computer-abrir-overlay"/)
    assert.match(pane, /Maximize2/)
    assert.match(pane, />\s*Abrir\s*</)
    assert.match(pane, /aria-label="Cerrar"/)
    assert.match(pane, /setExpanded\(true\)/)
    assert.match(pane, /setExpanded\(false\)/)
    assert.match(pane, /event\.key === "Escape"/)
    assert.match(pane, /left-\[5vw\]/)
    assert.match(pane, /top-\[5vh\]/)
    assert.match(pane, /h-\[90vh\]/)
    assert.match(pane, /w-\[90vw\]/)
    assert.match(pane, /fixed inset-0/)
    assert.match(pane, /bg-black\/60/)
    assert.doesNotMatch(pane, /key=\{[^}]*expanded/)
    assert.match(pane, /PensandoBars/)
  })
})

describe("computer orchestrator Grok Bot desktop", () => {
  it("starts Chrome without a visible window and still serves websockify 6080", () => {
    const sh = source("services/computer-orchestrator/start-desktop.sh")
    const df = source("services/computer-orchestrator/Dockerfile")
    assert.match(sh, /--no-startup-window/)
    assert.doesNotMatch(sh, /about:blank/)
    assert.match(sh, /websockify --web="\$NOVNC_WEB" 6080 127\.0\.0\.1:5901/)
    assert.match(sh, /x11vnc .* -rfbport 5901/)
    assert.match(sh, /Xvfb :1 -screen 0 1920x1080x24/)
    assert.match(sh, /--remote-debugging-port=9222/)
    assert.match(sh, /compuser/)
    assert.match(sh, /plank/)
    assert.match(sh, /pkill -x xfce4-panel/)
    assert.match(sh, /sira-gray-fabric\.jpg/)
    assert.match(df, /plank/)
    assert.match(df, /desktop-look/)
    assert.match(source("services/computer-orchestrator/desktop-look/plank/launchers/10-chrome.dockitem"), /google-chrome\.desktop/)
    assert.match(source("services/computer-orchestrator/desktop-look/plank/launchers/20-thunar.dockitem"), /thunar\.desktop/)
    assert.match(source("services/computer-orchestrator/desktop-look/plank/launchers/30-terminal.dockitem"), /xfce4-terminal\.desktop/)
  })
})
