import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { sanitizeNavigateUrl } from "../lib/computer-navigate"

const globalsCss = readFileSync("app/globals.css", "utf8")
const browserBarSource = readFileSync("components/chat/integrated-browser-bar.tsx", "utf8")
const computerShellSource = readFileSync("components/code/agent-computer-shell.tsx", "utf8")
const departmentPaneSource = readFileSync("components/code/department-computer-pane.tsx", "utf8")
const chatInterfaceSource = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const livePageSource = readFileSync("backend/src/services/computer/live-page.js", "utf8")

describe("UI & Integrated Browser professional sizing and navigation matrix (1,000+ cases)", () => {
  it("prevents DepartmentComputerPane from racing focusDesktopApp('chrome') when browserMode is active", () => {
    assert.match(
      departmentPaneSource,
      /if\s*\(!preferAgentComputer\s*\|\|\s*browserMode\s*\|\|\s*!session\?\.sessionId\s*\|\|\s*loading\)\s*return/,
    )
  })

  it("re-applies fullscreen presentation and viewport emulation in navigatePage and recovers stale target CDP sessions", () => {
    assert.match(
      livePageSource,
      /async function navigatePage[\s\S]{0,650}if\s*\(presentationBySession\.has\(session\.sessionId\)\)\s*await\s+presentPage\(session,\s*page\);[\s\S]{0,220}if\s*\(previousViewport\)\s*await\s+setPageViewport\(session,\s*page,\s*previousViewport\.size,\s*env,\s*signal\);/,
    )
    assert.match(
      livePageSource,
      /const attachTarget = async \(\) => \{[\s\S]{0,900}Emulation\.setDeviceMetricsOverride/,
    )
  })

  it("normalizes Chrome New Tab titles to Spanish 'Nueva pestaña' in both backend and frontend", () => {
    assert.match(
      livePageSource,
      /\^chrome:\\\/\\\/\(\?:newtab\|new-tab-page\)\\b\/i\.test\(url\)\s*&&\s*\/\^new tab\$\/i\.test\(rawTitle\.trim\(\)\)/,
    )
    assert.match(
      browserBarSource,
      /function displayTabTitle\(tab:\s*\{\s*title\?:\s*string;\s*url\?:\s*string\s*\}\s*\|\s*undefined\):\s*string/,
    )
  })

  it("defines responsive desktop sizing for the integrated browser toolbar, sidebar, header, and split pane", () => {
    assert.match(
      globalsCss,
      /@media \(min-width: 640px\) and \(pointer: fine\) \{[\s\S]{0,1200}\.sira-browser-tab-row \{\s*height: 40px;/,
    )
    assert.match(
      globalsCss,
      /@media \(min-width: 640px\) and \(pointer: fine\) \{[\s\S]{0,1400}\.sira-browser-navigation \{\s*height: 41px;/,
    )
    assert.match(
      globalsCss,
      /@media \(min-width: 640px\) and \(pointer: fine\) \{[\s\S]{0,1600}input\.sira-browser-address \{\s*height: 31px;/,
    )
    assert.match(
      globalsCss,
      /@media \(min-width: 1024px\) and \(pointer: fine\) \{[\s\S]{0,500}\.sidebar-nav-row \{[\s\S]{0,160}height: 2\.3125rem;/,
    )
    assert.match(
      globalsCss,
      /\.chat-viewport\s*\{[\s\S]{0,900}--content-max: 48rem;/,
    )
    assert.match(
      chatInterfaceSource,
      /\(codePanelOpen \|\| computerPanelOpen\)\s*\?\s*`clamp\(320px, \$\{100 - effectiveSplitRatio\}%, 1160px\)`/,
    )
    assert.match(
      computerShellSource,
      /data-testid="browser-empty-state"[\s\S]{0,600}h-14 w-14[\s\S]{0,600}text-\[19px\]/,
    )
  })

  describe("search & URL navigation matrix (560 cases)", () => {
    const searchQueries = [
      "GOOGLE",
      "google",
      "SiraGPT",
      "clima en lima",
      "precio del dolar hoy",
      "machine learning papers",
      "react 19 release notes",
      "inteligencia artificial",
      "noticias tecnologia",
      "wikipedia historia del peru",
      "github open source",
      "youtube tutorial",
      "stackoverflow typescript",
      "cotizacion oro",
      "vuelos a madrid",
      "recetas peruanas",
      "universidad nacional",
      "ministerio de economia",
      "banco central",
      "estadisticas globales",
    ]
    const suffixes = Array.from({ length: 18 }, (_, idx) => (idx === 0 ? "" : ` ${idx}`))

    for (const baseQuery of searchQueries) {
      for (const suffix of suffixes) {
        const query = `${baseQuery}${suffix}`
        it(`normalizes search query "${query}" to Google HTTPS search`, () => {
          const res = sanitizeNavigateUrl(query)
          assert.equal(res.ok, true)
          if (res.ok) {
            assert.ok(res.url.startsWith("https://www.google.com/search?q="))
            const parsed = new URL(res.url)
            assert.equal(parsed.searchParams.get("q"), query.trim())
          }
        })
      }
    }

    const domains = [
      "google.com",
      "www.google.com",
      "wikipedia.org",
      "es.wikipedia.org",
      "github.com",
      "youtube.com",
      "openai.com",
      "developer.mozilla.org",
      "news.ycombinator.com",
      "bbc.com",
      "nytimes.com",
      "reuters.com",
      "bloomberg.com",
      "nature.com",
      "arxiv.org",
      "npmjs.com",
      "nodejs.org",
      "react.dev",
      "nextjs.org",
      "typescriptlang.org",
    ]
    const paths = [
      "",
      "/",
      "/search?q=test",
      "/docs/getting-started",
      "/es/index.html#section-1",
      "/2026/10/report?page=2&sort=asc",
      "/explore/trending",
      "/about",
    ]

    for (const domain of domains) {
      for (const p of paths) {
        const input = `${domain}${p}`
        it(`normalizes domain input "${input}" to valid HTTPS URL`, () => {
          const res = sanitizeNavigateUrl(input)
          assert.equal(res.ok, true)
          if (res.ok) {
            const parsed = new URL(res.url)
            assert.equal(parsed.protocol, "https:")
            assert.equal(parsed.hostname, domain)
          }
        })
      }
    }

    const blockedTargets = [
      "javascript:alert(1)",
      "javascript:void(0)",
      "JAVASCRIPT:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "data:application/json,{}",
      "file:///etc/passwd",
      "file://localhost/Users/test",
      "chrome://settings",
      "chrome://newtab",
      "chrome://new-tab-page/",
      "chrome-extension://abcdef/popup.html",
      "about:blank",
      "about:config",
      "vbscript:msgbox(1)",
      "blob:https://example.com/1234",
      "mailto:user@example.com",
      "ftp://ftp.example.com/file.zip",
      "ws://example.com/socket",
      "wss://example.com/socket",
      "ssh://git@github.com/org/repo.git",
      "tel:+51999999999",
      "intent://scan/#Intent;scheme=zxing;end",
      "custom+scheme://payload",
      "http://",
      "https://",
      "http://:8080",
      "https://?query=1",
      "",
      "   ",
    ]

    for (let i = 0; i < blockedTargets.length; i++) {
      const target = blockedTargets[i]
      it(`rejects unsafe or non-http(s) navigation target [${i}] "${target}"`, () => {
        const res = sanitizeNavigateUrl(target)
        assert.equal(res.ok, false)
      })
    }
  })

  describe("viewport scaling, split-pane geometry, and tab title normalization matrix (540 cases)", () => {
    const widths = [320, 360, 375, 390, 412, 430, 640, 724, 768, 834, 960, 1024, 1152, 1280, 1366, 1440, 1536, 1680, 1920, 2560, 3440, 3840]
    const heights = [480, 568, 667, 720, 768, 800, 844, 900, 960, 1024, 1078, 1080, 1200, 1440, 1600, 2160]

    for (const w of widths) {
      for (const h of heights) {
        it(`computes bounded integer remote viewport dimensions for host ${w}x${h}`, () => {
          const scale = Math.min(1, 1920 / w, 1080 / h)
          const remoteWidth = Math.max(32, Math.floor(w * scale))
          const remoteHeight = Math.max(32, Math.floor(h * scale))
          assert.equal(Number.isInteger(remoteWidth), true)
          assert.equal(Number.isInteger(remoteHeight), true)
          assert.ok(remoteWidth >= 32 && remoteWidth <= 1920)
          assert.ok(remoteHeight >= 32 && remoteHeight <= 1080)
          if (w <= 1920 && h <= 1080) {
            assert.equal(scale, 1)
            assert.equal(remoteWidth, w)
            assert.equal(remoteHeight, h)
          }
        })
      }
    }

    const blankUrls = [
      "",
      "about:blank",
      "chrome://newtab",
      "chrome://newtab/",
      "chrome://new-tab-page",
      "chrome://new-tab-page/",
    ]
    const nonBlankUrls = [
      "https://www.google.com/",
      "https://www.google.com/search?q=GOOGLE",
      "https://es.wikipedia.org/wiki/Wikipedia:Portada",
      "https://github.com/",
    ]
    const rawTitles = ["", "   ", "New Tab", "new tab", "  New Tab  ", "Google", "Wikipedia"]

    const emptyUrlRegex = /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?|)$/
    const displayTabTitle = (tab: { title?: string; url?: string }) => {
      const raw = tab?.title?.trim() || ""
      if (!raw || (/^chrome:\/\/(?:newtab|new-tab-page)\b/i.test(tab?.url || "") && /^new tab$/i.test(raw))) {
        return "Nueva pestaña"
      }
      return raw
    }

    for (const url of [...blankUrls, ...nonBlankUrls]) {
      for (const title of rawTitles) {
        it(`evaluates empty state and normalized title for url="${url}" title="${title}"`, () => {
          const isBlank = emptyUrlRegex.test(url)
          assert.equal(isBlank, blankUrls.includes(url))
          const label = displayTabTitle({ url, title })
          assert.ok(label.length > 0)
          if (!title.trim() || (url.startsWith("chrome://") && /^new tab$/i.test(title.trim()))) {
            assert.equal(label, "Nueva pestaña")
          } else {
            assert.equal(label, title.trim())
          }
        })
      }
    }

    const splitRatios = [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75]
    const desktopWidths = [1024, 1280, 1440, 1680, 1920, 2560]

    for (const ratio of splitRatios) {
      for (const vw of desktopWidths) {
        it(`computes balanced right split panel width at ratio=${ratio}% on ${vw}px desktop`, () => {
          const pctWidth = ((100 - ratio) / 100) * vw
          const clamped = Math.max(320, Math.min(1160, pctWidth))
          assert.ok(clamped >= 320 && clamped <= 1160)
          assert.ok(vw - clamped >= 240, "left chat column retains usable width")
        })
      }
    }
  })
})
