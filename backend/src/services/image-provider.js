'use strict';

/**
 * F4 PR15 — Image provider abstraction.
 *
 * Wraps the underlying image-generation backends behind a stable
 * `generate(spec)` interface so route handlers can switch providers
 * via env `IMAGE_PROVIDER` without changes. Three providers ship in
 * this PR:
 *
 *   - mock   (default)  — placeholder URL, no external call. Useful
 *                         for unit tests + the F4 "transparent mock"
 *                         disclaimer when no API key is present.
 *   - openai            — calls the OpenAI Images API (DALL-E).
 *                         Requires OPENAI_API_KEY.
 *   - none              — disabled; every request fails 503. Use this
 *                         on prod when you want to surface "service
 *                         under maintenance" without changing code.
 *
 * Returns shape:
 *   { ok: true, assets: [{ url, format, sizeBytes? }], providerUsed }
 *   { ok: false, code: 'PROVIDER_DOWN' | 'MODERATED' | 'PROVIDER_ERROR',
 *     reason?: string, providerUsed }
 *
 * Refund-on-failure is handled by the caller via charge-credits.refundLastCharge.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROVIDER = process.env.IMAGE_PROVIDER || 'openai';

function pickProvider(spec) {
  if (spec && spec.provider) return spec.provider;
  return DEFAULT_PROVIDER;
}

function buildMockSvg(prompt) {
  // Tiny inline SVG placeholder so a UI can render *something* during
  // the F4 rollout while a real provider key is being wired up.
  const safePrompt = String(prompt || '').slice(0, 80).replace(/[<>&]/g, ' ');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">',
    '  <rect width="100%" height="100%" fill="#0d1117"/>',
    '  <text x="50%" y="48%" text-anchor="middle" fill="#7d8590" font-family="system-ui" font-size="20">Vista previa simulada</text>',
    `  <text x="50%" y="56%" text-anchor="middle" fill="#7d8590" font-family="system-ui" font-size="14">${safePrompt}</text>`,
    '</svg>',
  ].join('\n');
}

async function generateMock(spec) {
  const { prompt, n = 1 } = spec;
  const assets = [];
  for (let i = 0; i < Math.min(n, 4); i += 1) {
    assets.push({
      url: 'data:image/svg+xml;utf8,' + encodeURIComponent(buildMockSvg(prompt)),
      format: 'svg',
      sizeBytes: 512,
      isMock: true,
    });
  }
  return { ok: true, assets, providerUsed: 'mock' };
}

async function generateOpenAI(spec) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, code: 'PROVIDER_DOWN', reason: 'OPENAI_API_KEY missing', providerUsed: 'openai' };
  }
  // Lazy-require to keep the module loadable in environments without
  // the OpenAI SDK installed (tests / mock-only servers).
  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch (_err) {
    return { ok: false, code: 'PROVIDER_DOWN', reason: 'openai sdk not installed', providerUsed: 'openai' };
  }
  try {
    const client = new (OpenAI.OpenAI || OpenAI)({ apiKey });
    const size = spec.size || '1024x1024';
    const n = Math.min(spec.n || 1, 4);
    // Bound the provider call: a hung DALL-E request would otherwise block
    // the image job until an outer timeout (or never). Per-request timeout
    // via the OpenAI SDK (default 120s, env-overridable).
    const imageTimeoutMs = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 120_000;
    const result = await client.images.generate({
      model: spec.model || 'dall-e-3',
      prompt: String(spec.prompt || '').slice(0, 4000),
      size,
      n,
    }, { timeout: imageTimeoutMs });
    const assets = (result?.data || []).map((d) => ({
      url: d.url || (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ''),
      format: d.url ? 'url' : 'png',
    }));
    return { ok: true, assets, providerUsed: 'openai' };
  } catch (err) {
    const moderated =
      err && err.code === 'content_policy_violation' ||
      (err && err.message && /content policy|moderation/i.test(err.message));
    return {
      ok: false,
      code: moderated ? 'MODERATED' : 'PROVIDER_ERROR',
      reason: err && err.message,
      providerUsed: 'openai',
    };
  }
}

async function generateNone() {
  return { ok: false, code: 'PROVIDER_DOWN', reason: 'IMAGE_PROVIDER=none', providerUsed: 'none' };
}

async function generate(spec) {
  const provider = pickProvider(spec);
  switch (provider) {
    case 'mock':   return generateMock(spec);
    case 'openai': return generateOpenAI(spec);
    case 'none':   return generateNone();
    default:
      return { ok: false, code: 'PROVIDER_DOWN', reason: `unknown provider ${provider}`, providerUsed: provider };
  }
}

module.exports = { generate, pickProvider, DEFAULT_PROVIDER };
