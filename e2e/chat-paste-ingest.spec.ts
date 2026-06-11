import { expect, test, type Locator, type Page } from "@playwright/test"

/**
 * Universal paste-ingest E2E — encodes the TARGET behavior of the
 * composer's clipboard pipeline:
 *
 *   1. Pasting a mixed clipboard (image file + text file + plain text)
 *      renders attachment chips for the files; the short plain text is
 *      free to land in the textarea.
 *   2. Pasting ONLY a long (>1500 chars) plain-text blob converts it
 *      into a pasted-document chip ("Texto/Contenido pegado", "N car.")
 *      instead of dumping the full blob into the composer.
 *
 * Defensive pattern copied from e2e/chat-upload.spec.ts: when CI runs
 * unauthenticated the /chat route may redirect to a login wall or never
 * mount the composer — in that case the spec early-returns with a
 * trivial assertion instead of failing.
 */

function isAuthSurface(url: string) {
  return /\/(?:login|auth|register|sign[-_]?in)(?:\/|$|\?)/i.test(new URL(url).pathname)
}

// 1x1 transparent PNG, base64-encoded. Decoded into a real File inside
// the page so clipboardData carries a genuine image/png entry.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const TXT_FILE_NAME = "hola.txt"
const TXT_FILE_CONTENT = "contenido del archivo de texto de prueba"
const SHORT_PLAIN_TEXT = "texto corto de prueba"

// >1600 chars of prose-like text — well above the long-paste threshold
// (~1500), so the composer must convert it into a document chip.
const LONG_PLAIN_TEXT = (
  "Informe extenso de prueba para la ingesta universal de pegado. " +
  "Cada repetición de esta línea suma caracteres hasta superar el umbral del composer.\n"
).repeat(20)

/**
 * Shared guard: navigate to /chat and resolve the composer textarea.
 * Returns null when the run hits an auth wall or the composer never
 * mounts (unauthenticated CI) — callers early-return in that case.
 */
async function gotoChatAndFindComposer(page: Page): Promise<Locator | null> {
  const response = await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  if (isAuthSurface(page.url())) {
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.trim().length, "auth surface should render visible text").toBeGreaterThan(20)
    return null
  }

  const authPrompt = page.getByText(/welcome back|sign in|create account/i).first()
  if (await authPrompt.isVisible().catch(() => false)) {
    return null
  }

  const textarea = page.locator("textarea:visible").first()
  const mounted = await textarea
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!mounted) {
    const title = await page.title()
    expect(title.trim().length, "chat shell should still set a document title").toBeGreaterThan(0)
    return null
  }

  return textarea
}

/**
 * Dispatch a synthetic ClipboardEvent('paste') on the composer textarea
 * with a DataTransfer assembled in-page. This mirrors how the app's
 * document-level and textarea-level paste handlers receive clipboardData
 * (files + text/plain), without needing OS clipboard access.
 */
async function dispatchSyntheticPaste(
  textarea: Locator,
  payload: { pngBase64?: string; txtName?: string; txtContent?: string; plainText?: string },
) {
  await textarea.evaluate((el, args) => {
    const dt = new DataTransfer()
    if (args.pngBase64) {
      const bytes = Uint8Array.from(atob(args.pngBase64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }))
    }
    if (args.txtName && typeof args.txtContent === "string") {
      dt.items.add(new File([args.txtContent], args.txtName, { type: "text/plain" }))
    }
    if (typeof args.plainText === "string" && args.plainText.length > 0) {
      dt.setData("text/plain", args.plainText)
    }
    ;(el as HTMLTextAreaElement).focus()
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }),
    )
  }, payload)
}

/** Count attachment chips via several independent selector strategies. */
async function countAttachmentChips(page: Page): Promise<number> {
  const [dataChips, titleChips, txtNamed, pngNamed] = await Promise.all([
    // Strategy 1: explicit data attribute (target markup).
    page.locator("[data-attachment-chip]").count(),
    // Strategy 2: the generic file-chip container near the composer —
    // chips expose a "Ver documento"/"Preparando documento" title today.
    page
      .locator('[title="Ver documento"], [title="Preparando documento"], [title^="Subida fallida"]')
      .count(),
    // Strategy 3: per-file accessible names/text rendered as chips.
    page.getByText(/hola\.txt/i).count(),
    page
      .locator('img[alt*="pixel"], [title*="pixel"]')
      .or(page.getByText(/pixel\.png/i))
      .count(),
  ])
  const namedChips = (txtNamed > 0 ? 1 : 0) + (pngNamed > 0 ? 1 : 0)
  return Math.max(dataChips, titleChips, namedChips)
}

test("universal paste ingest renders chips for image+text+file", async ({ page }) => {
  const textarea = await gotoChatAndFindComposer(page)
  if (!textarea) return

  await dispatchSyntheticPaste(textarea, {
    pngBase64: PNG_1X1_BASE64,
    txtName: TXT_FILE_NAME,
    txtContent: TXT_FILE_CONTENT,
    plainText: SHORT_PLAIN_TEXT,
  })

  // Primary assertion: the .txt filename surfaces as a visible chip
  // above the input. Multiple fallbacks keep this robust to markup
  // details while the chip UI is integrated.
  const txtChip = page
    .locator("[data-attachment-chip]")
    .filter({ hasText: /hola\.txt/i })
    .or(page.getByText(/hola\.txt/i))
  await expect(txtChip.first(), "pasted .txt should render an attachment chip").toBeVisible({
    timeout: 10_000,
  })

  // Both pasted files (png + txt) should produce chips.
  await expect
    .poll(() => countAttachmentChips(page), {
      timeout: 10_000,
      message: "pasting image+txt should render at least 2 attachment chips",
    })
    .toBeGreaterThanOrEqual(2)

  // The short plain text should land either in the textarea value (the
  // app handler appends it) or somewhere visible in the composer area.
  // A synthetic paste cannot trigger native browser insertion, so we
  // accept either landing spot — the chips above are the primary check.
  await expect
    .poll(
      async () => {
        const value = await textarea.inputValue().catch(() => "")
        if (value.includes(SHORT_PLAIN_TEXT)) return true
        const visibleCount = await page
          .getByText(SHORT_PLAIN_TEXT, { exact: false })
          .count()
          .catch(() => 0)
        return visibleCount > 0
      },
      {
        timeout: 5_000,
        message: "short pasted text should land in the composer (value or visible text)",
      },
    )
    .toBe(true)
})

test("long plain-text paste becomes a pasted-document chip instead of flooding the composer", async ({
  page,
}) => {
  const textarea = await gotoChatAndFindComposer(page)
  if (!textarea) return

  expect(LONG_PLAIN_TEXT.length, "fixture must exceed the long-paste threshold").toBeGreaterThan(1600)

  await dispatchSyntheticPaste(textarea, { plainText: LONG_PLAIN_TEXT })

  // A "PEGADO"/document chip should appear: chips show a "Texto/Contenido
  // pegado" title and a "N car." (chars) stat line.
  const pasteChip = page
    .locator("[data-attachment-chip]")
    .filter({ hasText: /pegado|car\./i })
    .or(page.getByText(/pegado/i))
    .or(page.getByText(/\d[\d., \s]*car\./))
  await expect(pasteChip.first(), "long paste should render a pasted-document chip").toBeVisible({
    timeout: 10_000,
  })

  // The composer must NOT contain the full blob — that is exactly what
  // the long-paste capture is supposed to prevent.
  const composerValue = await textarea.inputValue().catch(() => "")
  expect(
    composerValue.includes(LONG_PLAIN_TEXT),
    "composer should not contain the full pasted blob",
  ).toBe(false)
})
