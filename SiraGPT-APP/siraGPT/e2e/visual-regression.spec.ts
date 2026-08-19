import { test, expect } from '@playwright/test';

const KEY_ROUTES = [
  { name: 'Home', path: '/' },
  { name: 'Chat', path: '/chat' },
  { name: 'Settings', path: '/settings' },
  { name: 'Projects', path: '/projects' },
  { name: 'Auth', path: '/auth' },
  { name: 'Profile', path: '/profile' },
  { name: 'Plan', path: '/plan' },
  { name: 'Thesis', path: '/thesis' },
  { name: 'Library', path: '/library' },
  { name: 'Search Brain', path: '/search-brain' },
];

for (const route of KEY_ROUTES) {
  test(`visual regression: ${route.name} page renders`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: 'networkidle' });

    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({ fullPage: true });

    expect(screenshot).toMatchSnapshot({
      name: `${route.path.replace(/\//g, '_') || 'root'}.png`,
      maxDiffPixelRatio: 0.02,
      threshold: 0.1,
    });
  });
}
