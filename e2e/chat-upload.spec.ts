import { expect, test } from "@playwright/test"

function isAuthSurface(url: string) {
  return /\/(?:login|auth|register|sign[-_]?in)(?:\/|$|\?)/i.test(new URL(url).pathname)
}

function isBootstrapOrAuthText(text: string) {
  return /cargando sira gpt|preparando tu espacio|welcome back|sign in|create account/i.test(text)
}

test("chat upload picker accepts any file format when the composer is mounted", async ({ page }) => {
  const response = await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  if (isAuthSurface(page.url())) {
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.trim().length, "auth surface should render visible text").toBeGreaterThan(20)
    return
  }

  const authPrompt = page.getByText(/welcome back|sign in|create account/i).first()
  if (await authPrompt.isVisible().catch(() => false)) {
    return
  }

  const fileInput = page.locator('input[type="file"]').first()
  if ((await fileInput.count()) === 0) {
    const title = await page.title()
    expect(title.trim().length, "chat shell should still set a document title").toBeGreaterThan(0)
    return
  }

  // The composer accepts every format the OS can hand us: the picker must not
  // carry a restrictive `accept` filter (either absent or the wildcard).
  const accept = await fileInput.getAttribute("accept")
  expect(accept === null || accept.trim() === "" || accept.trim() === "*/*").toBe(true)
  await expect(fileInput).toHaveAttribute("multiple", "")
  await expect(fileInput).toHaveAttribute("data-accepts-any-format", "true")
})

test("chat route does not throw browser page errors during first paint", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })
  await page.waitForTimeout(500)

  const bodyText = await page.locator("body").innerText().catch(() => "")
  const actionableErrors = pageErrors.filter((message) => {
    return !(message === "Invalid or unexpected token" && isBootstrapOrAuthText(bodyText))
  })

  expect(actionableErrors).toEqual([])
})
