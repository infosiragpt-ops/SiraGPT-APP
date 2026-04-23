/**
 * marketing-service — image generation for the Marketing module.
 *
 * The product currently supports a single image model —
 * `openai/gpt-5.4-image-2` — routed through OpenAI's images.generate
 * endpoint. The model name comes from the client; we normalise it
 * (strip the `openai/` prefix) before handing it to the SDK.
 *
 * The function returns a single image as a data URL so the frontend
 * can embed it into the scheduled-post card without a second
 * round-trip. If the user later asks for a /files upload or a
 * permalinked URL, that's a separate persistence path.
 */

const OpenAI = require('openai');

// Single source of truth for which image model the Marketing agent
// uses. Environment override lets ops pin a specific model version
// without a redeploy.
const DEFAULT_IMAGE_MODEL =
  process.env.MARKETING_IMAGE_MODEL || 'openai/gpt-5.4-image-2';

function normaliseModel(name) {
  if (!name) return DEFAULT_IMAGE_MODEL;
  // OpenAI expects the bare model id; strip the provider prefix.
  return String(name).replace(/^openai\//i, '');
}

function orientationToSize(orientation) {
  switch (String(orientation || '').toLowerCase()) {
    case 'vertical':   return '1024x1792';
    case 'horizontal': return '1792x1024';
    case 'cuadrado':
    case 'square':
    default:           return '1024x1024';
  }
}

// Builds a richer prompt from the user's idea + their composer
// filters (color scheme, orientation, animation, price — from the
// UI chips). Keeps the generation on-brand for the product.
function composePrompt({ prompt, color, orientation, animation, price, platforms = [] }) {
  const parts = [String(prompt || '').trim()];
  if (color)   parts.push(`Paleta principal: ${color}.`);
  if (orientation) parts.push(`Composición ${orientation}.`);
  if (animation === 'animados') parts.push('Estética dinámica, apta para animación corta.');
  if (price === 'pro') parts.push('Acabado premium, alta nitidez, iluminación profesional.');
  if (platforms.length) {
    parts.push(
      `Optimizado para publicar en: ${platforms.join(', ')}.`
    );
  }
  parts.push('Sin texto superpuesto. Listo para post de redes sociales.');
  return parts.filter(Boolean).join(' ');
}

async function generateImage({ prompt, model, orientation, color, animation, price, platforms }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY no configurado');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const fullPrompt = composePrompt({ prompt, color, orientation, animation, price, platforms });
  const size = orientationToSize(orientation);

  const resp = await client.images.generate({
    model: normaliseModel(model || DEFAULT_IMAGE_MODEL),
    prompt: fullPrompt,
    size,
    n: 1,
    // Ask OpenAI to embed the image inline so we don't have to fetch
    // a signed URL that expires in ~60 minutes.
    response_format: 'b64_json',
  });

  const b64 = resp?.data?.[0]?.b64_json;
  if (!b64) throw new Error('El modelo no devolvió una imagen');

  return {
    imageUrl: `data:image/png;base64,${b64}`,
    model: normaliseModel(model || DEFAULT_IMAGE_MODEL),
    prompt: fullPrompt,
    size,
  };
}

module.exports = {
  generateImage,
  composePrompt,
  normaliseModel,
  orientationToSize,
  DEFAULT_IMAGE_MODEL,
};
