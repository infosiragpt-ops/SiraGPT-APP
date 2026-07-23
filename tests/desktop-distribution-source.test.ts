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

test("desktop package includes a deterministic Microsoft Store AppX route", () => {
  const desktopPackage = JSON.parse(read("apps/desktop/package.json"))
  const rootPackage = JSON.parse(read("package.json"))
  const appx = desktopPackage.build.appx

  assert.equal(appx.identityName, "SiraGPT.QA")
  assert.equal(appx.publisher, "CN=SiraGPT QA")
  assert.equal(appx.applicationId, "SiraGPT")
  assert.equal(appx.artifactName, "SiraGPT-Store-${version}-${arch}.${ext}")
  assert.ok(appx.languages.includes("es-PE"))
  assert.ok(appx.languages.includes("en-US"))
  assert.deepEqual(appx.capabilities, ["runFullTrust"])
  assert.equal(rootPackage.scripts["desktop:dist:win:store"], "node scripts/build-windows-store-appx.js")
  assert.equal(rootPackage.scripts["desktop:validate:win:store"], "node scripts/validate-windows-store-appx.js")

  const buildScript = read("scripts/build-windows-store-appx.js")
  assert.match(buildScript, /WINDOWS_STORE_PACKAGE_MODE/)
  assert.match(buildScript, /Partial Microsoft Store identity is unsafe/)
  assert.match(buildScript, /unsigned-microsoft-store-handoff/)
  assert.match(buildScript, /storeSubmissionReady: mode === "store"/)
  assert.match(read("scripts/validate-windows-store-appx.js"), /AppxManifest\.xml/)
  assert.match(read("scripts/generate-windows-appx-assets.js"), /Wide310x150Logo\.png/)
})

test("downloads page resolves real desktop releases without presenting beta as signed", () => {
  const page = read("app/descargas/page.tsx")
  const card = read("components/desktop/desktop-download-card.tsx")
  const redirectRoute = read("app/api/desktop/download/route.ts")
  const caddy = read("deploy/Caddyfile")
  assert.match(page, /DesktopDownloadCard platform="macos"/)
  assert.match(page, /DesktopDownloadCard platform="windows"/)
  assert.match(card, /Versión de evaluación/)
  assert.match(card, /api\/desktop\/download\?platform=/)
  assert.match(card, /channel=beta/)
  assert.match(redirectRoute, /resolveDesktopRelease/)
  const desktopRoute = caddy.indexOf("handle /api/desktop/*")
  const backendApiRoute = caddy.indexOf("handle /api/*")
  assert.ok(desktopRoute >= 0, "Caddy must route desktop release endpoints")
  assert.ok(desktopRoute < backendApiRoute, "desktop routes must be handled before the backend API wildcard")
  assert.match(caddy.slice(desktopRoute, backendApiRoute), /reverse_proxy frontend:3000/)
  assert.doesNotMatch(page, /Las apps de las tiendas oficiales están en camino/)
})

test("desktop QA workflow can publish durable checksummed prereleases", () => {
  const workflow = read(".github/workflows/native-desktop.yml")
  assert.match(workflow, /publish_prerelease:/)
  assert.match(workflow, /Publish desktop beta prerelease/)
  assert.match(workflow, /SHA256SUMS\.txt/)
  assert.match(workflow, /gh release create/)
  assert.match(workflow, /Build Microsoft Store AppX/)
  assert.match(workflow, /Validate Microsoft Store AppX/)
  assert.match(workflow, /WINDOWS_STORE_IDENTITY_NAME/)
})
