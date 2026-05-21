import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test"
import path from "node:path"
import fs from "node:fs"

// The extension exposes the `chrome.*` MV3 surface inside service-worker and
// extension-page evaluations. We don't depend on `@types/chrome`, so declare
// the global as `any` to keep the spec compiling under strict mode.
declare const chrome: any

/**
 * Sira Appshots — extension load smoke.
 *
 * Loads the MV3 extension under `extension/` into a real Chromium via
 * `--load-extension` and verifies the parts of the capture flow we *can*
 * automate without driving the native `chrome.desktopCapture` picker:
 *
 *   - the service worker registers and exposes the runtime API
 *   - `manifest.json` is well-formed and declares the ⌘⇧S shortcut
 *   - the popup HTML renders the "Sin vincular" state from a clean store
 *   - the options page persists a token + apiBase into `chrome.storage.local`
 *   - re-opening the popup after vinculación switches to the "Vinculado" state
 *
 * Anything beyond this (the native picker, the offscreen `getUserMedia`
 * grab, and the upload to /api/appshots/capture) is covered by the manual QA
 * script in `extension/README.md` — Chrome forbids automating the picker.
 *
 * The spec auto-skips when Chromium can't load extensions in the current
 * environment (typical of headless-only CI without Xvfb): persistent
 * contexts with `--load-extension` require a UI surface even with the new
 * headless mode.
 */

const EXTENSION_PATH = path.resolve(__dirname, "..", "extension")

async function waitForServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker | null> {
  const existing = context.serviceWorkers()
  if (existing.length > 0) return existing[0]
  return Promise.race<Worker | null>([
    context.waitForEvent("serviceworker").then((w) => w),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

test.describe("extension appshots", () => {
  let context: BrowserContext | null = null
  let serviceWorker: Worker | null = null
  let extensionId: string | null = null
  let skipReason: string | null = null

  test.beforeAll(async () => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, "manifest.json"))) {
      skipReason = `extension/ not found at ${EXTENSION_PATH}`
      return
    }
    try {
      context = await chromium.launchPersistentContext("", {
        headless: true,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          "--no-sandbox",
        ],
      })
    } catch (err) {
      skipReason = `chromium.launchPersistentContext failed: ${(err as Error).message}`
      return
    }
    serviceWorker = await waitForServiceWorker(context)
    if (!serviceWorker) {
      skipReason = "extension service worker did not register within 10s (likely headless without extension support)"
      return
    }
    // chrome-extension://<id>/background.js → grab the id from the worker URL.
    const match = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)\//)
    extensionId = match?.[1] ?? null
    if (!extensionId) {
      skipReason = `could not parse extension id from ${serviceWorker.url()}`
    }
  })

  test.afterAll(async () => {
    if (context) await context.close().catch(() => {})
  })

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "")
  })

  test("manifest declares the ⌘⇧S capture shortcut and required permissions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_PATH, "manifest.json"), "utf8"))
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background?.service_worker).toBe("background.js")
    expect(manifest.permissions).toEqual(expect.arrayContaining(["desktopCapture", "offscreen", "storage"]))
    const shortcut = manifest.commands?.["capture-window"]?.suggested_key
    expect(shortcut?.default).toBe("Ctrl+Shift+S")
    expect(shortcut?.mac).toBe("Command+Shift+S")
  })

  test("service worker exposes the appshots runtime APIs", async () => {
    const apis = await serviceWorker!.evaluate(() => ({
      hasOnMessage: typeof chrome.runtime?.onMessage?.addListener === "function",
      hasDesktopCapture: typeof chrome.desktopCapture?.chooseDesktopMedia === "function",
      hasOffscreen: typeof chrome.offscreen?.createDocument === "function",
      hasStorage: typeof chrome.storage?.local?.get === "function",
      hasCommands: typeof chrome.commands?.onCommand?.addListener === "function",
    }))
    expect(apis).toEqual({
      hasOnMessage: true,
      hasDesktopCapture: true,
      hasOffscreen: true,
      hasStorage: true,
      hasCommands: true,
    })
  })

  test("popup renders 'Sin vincular' when storage is empty and hides the capture button", async () => {
    // Ensure a clean store before mounting the popup.
    await serviceWorker!.evaluate(async () => {
      await chrome.storage.local.clear()
    })
    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(popup.locator("#status")).toContainText(/sin vincular/i, { timeout: 5_000 })
    await expect(popup.locator("#capture")).toBeHidden()
    await popup.close()
  })

  test("options page persists token + apiBase, popup then shows 'Vinculado'", async () => {
    const options = await context!.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    await options.locator("#token").fill("appshots_test_token_xyz")
    await options.locator("#apiBase").fill("https://staging.siragpt.com")
    await options.locator("#save").click()
    await expect(options.locator("#status")).toContainText(/guardado/i, { timeout: 5_000 })

    const stored = await serviceWorker!.evaluate(() =>
      chrome.storage.local.get(["siraAppshotsToken", "siraAppshotsApiBase"]),
    )
    expect(stored).toEqual({
      siraAppshotsToken: "appshots_test_token_xyz",
      siraAppshotsApiBase: "https://staging.siragpt.com",
    })
    await options.close()

    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(popup.locator("#status")).toContainText(/vinculado/i, { timeout: 5_000 })
    await expect(popup.locator("#capture")).toBeVisible()
    await popup.close()
  })

  test("capture-now message surfaces the missing-token error when storage is cleared", async () => {
    // Reset to an unlinked state so runCapture() short-circuits with the
    // user-facing error instead of trying to open the native picker.
    await serviceWorker!.evaluate(async () => {
      await chrome.storage.local.clear()
    })
    const reply = await serviceWorker!.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "appshots:capture-now" }, (response: unknown) => {
            resolve(response)
          })
        }),
    )
    expect(reply).toMatchObject({ ok: false })
    expect(String((reply as { error?: string }).error || "")).toMatch(/vincular/i)
  })
})
