import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

test("downloads page teaches the iPhone Safari install path as a first-class section", () => {
  const page = read("app/descargas/page.tsx")
  const iphoneCard = read("components/mobile/iphone-install-card.tsx")

  assert.match(page, /IphoneInstallCard/)
  assert.match(page, /iPhone, Android, Mac y Windows/)
  assert.match(iphoneCard, /id="iphone"/)
  assert.match(iphoneCard, /Compartir/)
  assert.match(iphoneCard, /Añadir a pantalla de inicio/)
  // Safari on iOS has no beforeinstallprompt — the guide must not depend on it.
  assert.doesNotMatch(iphoneCard, /addEventListener\(["']beforeinstallprompt/)
})

test("downloads page offers a real Android APK download backed by the mobile release API", () => {
  const page = read("app/descargas/page.tsx")
  const androidCard = read("components/mobile/android-download-card.tsx")
  const downloadRoute = read("app/api/mobile/download/route.ts")
  const releasesRoute = read("app/api/mobile/releases/route.ts")

  assert.match(page, /AndroidDownloadCard/)
  assert.match(androidCard, /id="android"/)
  assert.match(androidCard, /api\/mobile\/download\?platform=android/)
  assert.match(androidCard, /Descargar APK/)
  assert.match(androidCard, /Instalar aplicación/)
  assert.match(androidCard, /issues\/5/)
  assert.match(downloadRoute, /resolveMobileRelease/)
  assert.match(releasesRoute, /resolveMobileReleaseCatalog/)
})

test("downloads page never advertises a fake App Store listing", () => {
  const sources = [
    read("app/descargas/page.tsx"),
    read("components/mobile/iphone-install-card.tsx"),
    read("components/mobile/android-download-card.tsx"),
    read("components/mobile/mobile-install-coach.tsx"),
  ]
  for (const source of sources) {
    assert.doesNotMatch(source, /https?:\/\/apps\.apple\.com/)
    assert.doesNotMatch(source, /https?:\/\/play\.google\.com/)
    assert.doesNotMatch(source, /Download on the App Store/i)
    assert.doesNotMatch(source, /Consíguelo en el App Store/i)
  }
  // The App Store card is an honest status card gated on owner actions.
  const page = read("app/descargas/page.tsx")
  assert.match(page, /App Store \(nativa Capacitor\)/)
  assert.match(page, /Pendiente/)
  assert.match(page, /issues\/6/)
  assert.match(page, /iPhone Simulator/)
})

test("iOS install coach is persistent, dismissible, and Chrome reuses PWAInstallPrompt", () => {
  const coach = read("components/mobile/mobile-install-coach.tsx")
  assert.match(coach, /detectInstallSurface/)
  assert.match(coach, /Instalar en iPhone/)
  assert.match(coach, /localStorage/)
  assert.match(coach, /PWAInstallPrompt/)
})

test("mobile fallback APK points at the known public QA release", () => {
  const lib = read("lib/mobile-releases.ts")
  assert.match(
    lib,
    /https:\/\/github\.com\/infosiragpt-ops\/SiraGPT-APP\/releases\/download\/native-mobile-qa-v0\.4\.4-92849df\/SiraGPT-92849df-debug\.apk/,
  )
})

test("Caddy routes mobile release endpoints to the frontend before the backend API wildcard", () => {
  const caddy = read("deploy/Caddyfile")
  const mobileRoute = caddy.indexOf("handle /api/mobile/*")
  const backendApiRoute = caddy.indexOf("handle /api/*")
  assert.ok(mobileRoute >= 0, "Caddy must route mobile release endpoints")
  assert.ok(mobileRoute < backendApiRoute, "mobile routes must be handled before the backend API wildcard")
  assert.match(caddy.slice(mobileRoute, backendApiRoute), /reverse_proxy frontend:3000/)
})

test("home download buttons land on the sections that teach install", () => {
  const home = read("app/home-page.tsx")
  assert.match(home, /\/descargas#iphone/)
  assert.match(home, /\/descargas#android/)
  const iphoneCard = read("components/mobile/iphone-install-card.tsx")
  const androidCard = read("components/mobile/android-download-card.tsx")
  assert.match(iphoneCard, /scroll-mt-24/)
  assert.match(androidCard, /scroll-mt-24/)
})
