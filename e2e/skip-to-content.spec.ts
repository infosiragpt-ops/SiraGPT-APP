import { expect, test, type Locator } from "@playwright/test"

async function isOutsideViewport(link: Locator) {
  return link.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return rect.bottom <= 0
      || rect.right <= 0
      || rect.top >= window.innerHeight
      || rect.left >= window.innerWidth
  })
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`skip link is hidden until keyboard focus (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.goto("/auth/login", { waitUntil: "domcontentloaded" })

    const skipLink = page.locator("a.skip-to-content")
    await expect(skipLink).toHaveCount(1)
    await expect(skipLink).not.toBeFocused()
    await expect(skipLink).toHaveCSS("opacity", "0")
    await expect(skipLink).toHaveCSS("pointer-events", "none")
    await expect.poll(() => isOutsideViewport(skipLink)).toBe(true)

    await page.keyboard.press("Tab")

    await expect(skipLink).toBeFocused()
    await expect(skipLink).toHaveCSS("opacity", "1")
    await expect.poll(() => isOutsideViewport(skipLink)).toBe(false)
    expect(await skipLink.evaluate((node) => node.matches(":focus-visible"))).toBe(true)

    await page.keyboard.press("Tab")

    await expect(skipLink).not.toBeFocused()
    await expect(skipLink).toHaveCSS("opacity", "0")
    await expect.poll(() => isOutsideViewport(skipLink)).toBe(true)
  })
}
