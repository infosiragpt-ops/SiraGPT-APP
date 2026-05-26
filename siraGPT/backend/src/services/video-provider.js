'use strict';

/**
 * F4 PR17 — Video provider abstraction + transparent disclaimer.
 *
 * Wraps Pika / Runway / Sora behind a single `generate(spec)` interface
 * (matching the image-provider shape) so the existing video route can
 * switch backends via env `VIDEO_PROVIDER` without code changes. Until
 * a real key is wired, the default is `mock` and the UI is expected
 * (F3 PR12) to surface a "Vista previa simulada — IA real próximamente"
 * disclaimer for honesty.
 *
 *   mock   (default)  — embedded SVG storyboard, no external call.
 *   pika              — Pika Labs REST. Requires PIKA_API_KEY.
 *   runway            — Runway Gen-3 REST. Requires RUNWAY_API_KEY.
 *   none              — disabled.
 *
 * Returns shape:
 *   { ok: true, assets: [{ url, format, durationSeconds, isMock? }], providerUsed, provisional? }
 *   { ok: false, code: 'PROVIDER_DOWN'|'MODERATED'|'PROVIDER_ERROR'|'NOT_READY', reason?, providerUsed }
 *
 * `provisional: true` on a mock result is the contract the UI checks
 * for the disclaimer — never sent on real provider output.
 */

const DEFAULT_PROVIDER = process.env.VIDEO_PROVIDER || 'mock';

function effectiveProvider(spec) {
  if (spec && spec.provider) return spec.provider;
  return DEFAULT_PROVIDER;
}

function providerStatus() {
  const provider = DEFAULT_PROVIDER;
  let configured = false;
  let reason = null;
  switch (provider) {
    case 'mock':
      configured = true;
      reason = 'mock provider always available; results are placeholders';
      break;
    case 'pika':
      configured = !!process.env.PIKA_API_KEY;
      if (!configured) reason = 'PIKA_API_KEY missing';
      break;
    case 'runway':
      configured = !!process.env.RUNWAY_API_KEY;
      if (!configured) reason = 'RUNWAY_API_KEY missing';
      break;
    case 'none':
      configured = false;
      reason = 'VIDEO_PROVIDER=none';
      break;
    default:
      configured = false;
      reason = `unknown provider ${provider}`;
  }
  return {
    provider,
    configured,
    reason,
    isMock: provider === 'mock',
    disclaimer:
      provider === 'mock'
        ? 'Vista previa simulada — IA real próximamente'
        : null,
  };
}

function mockStoryboardSvg({ prompt, durationSeconds }) {
  const safePrompt = String(prompt || '').slice(0, 80).replace(/[<>&]/g, ' ');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">',
    '  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '    <stop offset="0%" stop-color="#0d1117"/>',
    '    <stop offset="100%" stop-color="#161b22"/>',
    '  </linearGradient></defs>',
    '  <rect width="100%" height="100%" fill="url(#g)"/>',
    '  <text x="50%" y="46%" text-anchor="middle" fill="#c9d1d9" font-family="system-ui" font-size="36">Vista previa simulada</text>',
    `  <text x="50%" y="54%" text-anchor="middle" fill="#7d8590" font-family="system-ui" font-size="20">${safePrompt}</text>`,
    `  <text x="50%" y="62%" text-anchor="middle" fill="#7d8590" font-family="system-ui" font-size="16">${durationSeconds || 4}s · 24fps · mock</text>`,
    '</svg>',
  ].join('\n');
}

async function generateMock(spec) {
  const duration = Math.min(Math.max(spec.durationSeconds || 4, 1), 30);
  return {
    ok: true,
    provisional: true,
    providerUsed: 'mock',
    assets: [
      {
        url: 'data:image/svg+xml;utf8,' + encodeURIComponent(mockStoryboardSvg({ prompt: spec.prompt, durationSeconds: duration })),
        format: 'svg',
        durationSeconds: duration,
        fps: 24,
        isMock: true,
      },
    ],
  };
}

async function generatePika(spec) {
  if (!process.env.PIKA_API_KEY) {
    return { ok: false, code: 'PROVIDER_DOWN', reason: 'PIKA_API_KEY missing', providerUsed: 'pika' };
  }
  // Real call deferred — keep the contract surface stable. Mock until
  // the API key + webhook secret are configured.
  return {
    ok: false,
    code: 'NOT_READY',
    reason: 'Pika integration stubbed: webhook + worker land in F4 follow-up',
    providerUsed: 'pika',
  };
}

async function generateRunway(spec) {
  if (!process.env.RUNWAY_API_KEY) {
    return { ok: false, code: 'PROVIDER_DOWN', reason: 'RUNWAY_API_KEY missing', providerUsed: 'runway' };
  }
  return {
    ok: false,
    code: 'NOT_READY',
    reason: 'Runway integration stubbed: webhook + worker land in F4 follow-up',
    providerUsed: 'runway',
  };
}

async function generateNone() {
  return { ok: false, code: 'PROVIDER_DOWN', reason: 'VIDEO_PROVIDER=none', providerUsed: 'none' };
}

async function generate(spec = {}) {
  const provider = effectiveProvider(spec);
  switch (provider) {
    case 'mock':   return generateMock(spec);
    case 'pika':   return generatePika(spec);
    case 'runway': return generateRunway(spec);
    case 'none':   return generateNone();
    default:
      return { ok: false, code: 'PROVIDER_DOWN', reason: `unknown provider ${provider}`, providerUsed: provider };
  }
}

module.exports = { generate, providerStatus, effectiveProvider, DEFAULT_PROVIDER };
