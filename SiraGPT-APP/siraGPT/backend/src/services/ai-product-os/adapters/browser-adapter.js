/**
 * browser-adapter — contract for the "Navegador y scraping" layer.
 *
 * Designed to bind cleanly to:
 *   - Playwright   (Chromium / Firefox / WebKit, BrowserContext per task)
 *   - Browser Use  (LLM-driven web navigation)
 *   - Puppeteer    (Chrome DevTools Protocol)
 *   - Browserless  (managed Playwright cloud)
 *
 * The existing browser-agent.js provides the policy + evidence trail
 * layer. This adapter wraps a CONCRETE driver (Playwright / Puppeteer /
 * etc.) so browser-agent.run() can be backed by any of them without
 * touching its callers.
 *
 * Public methods:
 *
 *   launch({ headless, vendor })  → returns a session_handle
 *   newContext(session, { userAgent, locale, viewport })
 *   newPage(context)              → returns page_handle
 *   close(session)
 *
 *   The actual run(action, args) lives in browser-agent.js; this
 *   adapter exposes the underlying driver.run(action, args) that
 *   browser-agent calls.
 */

const VENDORS = Object.freeze(["playwright", "puppeteer", "browser-use", "browserless", "stub"]);

function createBrowserAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`browser-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);
  return {
    vendor,
    provider: impl,
    async launch(opts = {}) { return impl.launch(opts); },
    async newContext(session, opts = {}) { return impl.newContext(session, opts); },
    async newPage(ctx) { return impl.newPage(ctx); },
    async close(session) { return impl.close(session); },

    /**
     * driver — pass-through to the underlying driver's run() / screenshot()
     * methods. browser-agent.js consumes this.
     */
    driver() {
      return {
        run: (action, args) => impl.run(action, args),
        screenshot: (opts) => impl.screenshot ? impl.screenshot(opts) : null,
      };
    },

    capabilities() {
      return {
        vendor,
        engines: impl.engines || ["chromium"],
        supports_screenshots: typeof impl.screenshot === "function",
        supports_network_intercept: Boolean(impl.supports_network_intercept),
        supports_pdf_export: Boolean(impl.supports_pdf_export),
        supports_video_recording: Boolean(impl.supports_video_recording),
      };
    },
  };
}

function validateProvider(p) {
  for (const m of ["launch", "newContext", "newPage", "close", "run"]) {
    if (typeof p[m] !== "function") throw new Error(`browser-adapter: provider missing ${m}()`);
  }
}

function createStubProvider() {
  let sessionSeq = 0;
  let pageSeq = 0;
  return {
    engines: ["chromium-stub"],
    supports_network_intercept: false,
    supports_pdf_export: false,
    supports_video_recording: false,

    async launch(opts) {
      const id = `stub_session_${++sessionSeq}`;
      return { id, headless: Boolean(opts.headless) };
    },
    async newContext(session, opts) {
      return { id: `${session.id}.ctx`, userAgent: opts.userAgent || "siraGPT-stub/1.0", locale: opts.locale || "es" };
    },
    async newPage(ctx) {
      return { id: `${ctx.id}.page_${++pageSeq}`, ctx_id: ctx.id };
    },
    async close(session) { return { ok: true, id: session.id }; },

    async run(action, args) {
      // Deterministic synthetic responses for tests / dev.
      switch (action) {
        case "navigate": return { url: args.url, status: 200 };
        case "extract_text": return { text: `[stub text for ${args.selector}]` };
        case "extract_table": return { rows: [["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]] };
        case "wait_for": return { selector: args.selector };
        case "click":
        case "type":
        case "select":
        case "press":
        case "scroll":
        case "go_back":
        case "go_forward":
        case "reload":
        case "close":
          return { action, ok: true };
        default:
          return { action, ok: true, stub: true };
      }
    },

    async screenshot() {
      // 1x1 transparent PNG as a stable artefact id.
      return { id: `stub_shot_${Date.now().toString(16)}`, mime: "image/png", bytes: 0 };
    },
  };
}

module.exports = {
  createBrowserAdapter,
  createStubProvider,
  VENDORS,
};
