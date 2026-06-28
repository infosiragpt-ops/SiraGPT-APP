import { expect, test } from "@playwright/test";

/**
 * Duplicate message prevention E2E
 *
 * This test ensures that rapid double-sends (double Enter, double click,
 * or rapid re-renders) do not create duplicate user messages.
 *
 * The test is designed to fail if the bug returns.
 */

test.describe("duplicate message prevention", () => {
  test("should not duplicate user message on rapid double send", async ({ page }) => {
    // Note: This test assumes an authenticated session or test user.
    // In CI it may need to be skipped or use a seeded test account.

    await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Wait for the chat interface to be ready
    const composer = page.locator('textarea[placeholder*="Escribe"], textarea[aria-label*="mensaje"], [data-testid="chat-composer"]').first();

    // If we can't find the composer, the test is inconclusive (auth wall)
    if (!(await composer.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, "Composer not visible — likely auth wall or different UI");
      return;
    }

    const testMessage = `test-duplicate-${Date.now()}`;

    // Type the message
    await composer.fill(testMessage);

    // Rapid double send (simulates double Enter or double click)
    const sendButton = page.locator('button[aria-label*="Enviar"], button:has(svg.lucide-send), [data-testid="send-button"]').first();

    if (await sendButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Click twice rapidly
      await Promise.all([
        sendButton.click({ force: true }),
        sendButton.click({ force: true })
      ]);
    } else {
      // Fallback: press Enter twice rapidly
      await composer.press("Enter");
      await composer.press("Enter");
    }

    // Wait a bit for any potential duplicate processing
    await page.waitForTimeout(1500);

    // Count how many times the test message appears in the chat
    const messageCount = await page.locator(`text=${testMessage}`).count();

    // We expect exactly 1 occurrence, not 2 or more
    expect(messageCount, `Expected 1 message with text "${testMessage}", but found ${messageCount}`).toBe(1);
  });
});
