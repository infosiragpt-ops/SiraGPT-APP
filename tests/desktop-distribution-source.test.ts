import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

test("desktop shell keeps hardened browser boundaries and recovery", () => {
  const source = read("apps/desktop/main.cjs")
  assert.match(source, /requestSingleInstanceLock/)
  assert.match(source, /contextIsolation: true/)
  assert.match(source, /nodeIntegration: false/)
  assert.match(source, /sandbox: true/)
  assert.match(source, /setPermissionCheckHandler/)
  assert.match(source, /certificate-error/)
  assert.match(source, /will-redirect/)
  assert.match(source, /onOAuth/)
  assert.match(source, /offline\.html/)
  assert.match(source, /SiraGPTDesktop\/\$\{app\.getVersion\(\)\}/)
})

test("desktop package includes deep links, offline assets, and both Mac architectures", () => {
  const desktopPackage = JSON.parse(read("apps/desktop/package.json"))
  assert.ok(desktopPackage.build.files.includes("runtime.cjs"))
  assert.ok(desktopPackage.build.files.includes("offline.html"))
  assert.equal(desktopPackage.build.afterPack, "apps/desktop/after-pack.cjs")
  assert.deepEqual(desktopPackage.build.protocols[0].schemes, ["siragpt"])
  const macArchitectures = desktopPackage.build.mac.target.flatMap((target: { arch: string[] }) => target.arch)
  assert.ok(macArchitectures.includes("arm64"))
  assert.ok(macArchitectures.includes("x64"))
  assert.equal(desktopPackage.build.mac.extendInfo.NSAppTransportSecurity.NSAllowsArbitraryLoads, false)
  const afterPack = read("apps/desktop/after-pack.cjs")
  assert.match(afterPack, /NSAppTransportSecurity\.NSAllowsArbitraryLoads/)
  assert.match(afterPack, /value !== "false"/)
  const rootPackage = JSON.parse(read("package.json"))
  assert.match(rootPackage.scripts["desktop:dist:mac"], /--arm64 --x64/)
  assert.match(read("scripts/build-desktop.sh"), /--mac dmg zip --arm64 --x64/)
  assert.match(read("apps/desktop/offline.html"), /Content-Security-Policy/)
})

test("downloads page resolves real desktop releases without presenting beta as signed", () => {
  const page = read("app/descargas/page.tsx")
  const card = read("components/desktop/desktop-download-card.tsx")
  const redirectRoute = read("app/api/desktop/download/route.ts")
  assert.match(page, /DesktopDownloadCard platform="macos"/)
  assert.match(page, /DesktopDownloadCard platform="windows"/)
  assert.match(card, /Versión de evaluación/)
  assert.match(card, /api\/desktop\/download\?platform=/)
  assert.match(card, /channel=beta/)
  assert.match(redirectRoute, /resolveDesktopRelease/)
  assert.doesNotMatch(page, /Las apps de las tiendas oficiales están en camino/)
})

test("desktop QA workflow can publish durable checksummed prereleases", () => {
  const workflow = read(".github/workflows/native-desktop.yml")
  assert.match(workflow, /publish_prerelease:/)
  assert.match(workflow, /Publish desktop beta prerelease/)
  assert.match(workflow, /SHA256SUMS\.txt/)
  assert.match(workflow, /gh release create/)
})
