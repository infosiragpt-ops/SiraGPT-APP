import { test, expect } from '@playwright/test';

/**
 * @visual-regression — pixel comparison of key SiraGPT surfaces per PR.
 *
 * How it works:
 * - Baselines live under tests/visual-snapshots/, rendered on Linux
 *   (CI runner rendering must match — commit Linux-generated PNGs only).
 * - ci.yml visual-regression-check runs this spec as a HARD gate: any
 *   diff beyond 2% of pixels fails CI and uploads diffs for review.
 * - New routes: add an entry to KEY_ROUTES, generate its baselines with
 *   `npx playwright test e2e/visual-regression.spec.ts --update-snapshots`
 *   from a Linux environment, and commit the new PNGs.
 *
 * Local usage:
 *   npm run test:visual            # compare against committed baselines
 *   npm run test:visual:update     # regenerate baselines locally (darwin
 *                                  # renders differ from Linux — do NOT
 *                                  # commit locally generated baselines)
 *
 * Determinism guards (why screenshots are stable across runs):
 * - locale pinned via accept-language header (middleware otherwise
 *   resolves it from IP/headers, which vary by runner region)
 * - animations/transitions/caret disabled at the Playwright level
 * - fonts wait via networkidle + document.fonts.ready
 * - dynamic regions opt out by wrapping content in `[data-visual-mask]`,
 *   masked during comparison
 */

const KEY_ROUTES = [
  // NOTE: pricing lives as a section of the landing page
  // (components/landing/PricingSection.tsx), not under /pricing — the
  // home capture covers it.
  { name: 'home', path: '/' },
  { name: 'login', path: '/auth/login' },
  { name: 'register', path: '/auth/register' },
  { name: 'chat', path: '/chat' },
  { name: 'settings', path: '/settings' },
  { name: 'plan', path: '/plan' },
  { name: 'projects', path: '/projects' },
  { name: 'library', path: '/library' },
  { name: 'search-brain', path: '/search-brain' },
] as const;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const MASK_SELECTOR = '[data-visual-mask]';

test.describe('@visual-regression key-screen snapshots', () => {
  test.use({
    // Pin the locale so CI runners in different regions render the same
    // surface: without the cookie, middleware.ts resolves locale from
    // Accept-Language/IP, which varies by runner location.
    extraHTTPHeaders: { 'accept-language': 'es' },
  });

  for (const route of KEY_ROUTES) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      // Full-page captures only on desktop: mobile fullPage on long pages
      // produces multi-megabyte baselines dominated by scrollable lists,
      // which maximizes flake surface without adding review value.
      const fullPage = vpName === 'desktop';
      const shotName = `${route.name}-${vpName}.png`;

      test(`@visual-regression ${route.name} @ ${vpName}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(route.path, { waitUntil: 'domcontentloaded' });

        // Chat keeps SSE/websockets open forever; networkidle would hang.
        // Other routes settle quickly — give them up to 10s to go quiet.
        await page
          .waitForLoadState('networkidle', { timeout: 10_000 })
          .catch(() => {});

        await page.evaluate(() => document.fonts.ready);

        // Only pass a mask when the page actually declares masked regions;
        // an unmatched mask locator would throw.
        const maskTargets = await page.locator(MASK_SELECTOR).count();
        await expect(page).toHaveScreenshot(shotName, {
          fullPage,
          animations: 'disabled',
          caret: 'hide',
          ...(maskTargets > 0 ? { mask: [page.locator(MASK_SELECTOR)] } : {}),
          maxDiffPixelRatio: 0.02,
        });
      });
    }
  }
});
