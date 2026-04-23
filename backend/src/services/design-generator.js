/**
 * design-generator — turn a user's chat instruction into a single
 * self-contained HTML document that renders in the Design studio
 * canvas iframe.
 *
 * Why one HTML file:
 *   - The canvas iframe can sandbox one document cleanly. No bundler,
 *     no React hydration — the output just runs.
 *   - Iteration is trivially deterministic: every generation is the
 *     CURRENT version; no diff reconciliation needed.
 *   - Export to .html becomes a download-the-string away.
 *
 * Per-kind system prompts:
 *   - prototype (wireframe)  : grey placeholders, system-ui type,
 *                              semantic structure, no brand colour.
 *   - prototype (high)       : tasteful warm palette, serif display
 *                              type, subtle shadows + micro-anim.
 *   - slide_deck             : <section> per slide on a 16:9 stage,
 *                              keyboard nav already wired.
 *   - other                  : general "well-designed responsive
 *                              single-file site" prompt.
 *
 * The generator ALWAYS asks the model for the full HTML doc (not a
 * diff). When an existing `html` is provided we pass it as context
 * so the model can "modify the existing file" rather than start
 * from scratch — but the output shape is identical.
 */

const OpenAI = require('openai');

const DEFAULT_MODEL = 'gpt-4o';
const MAX_HTML_CHARS_IN_PROMPT = 24000;

// ─── Provider routing ─────────────────────────────────────────────────────
//
// The design studio's model dropdown lets the user pick from any of
// the ~345 text models in AiModel. These resolve to three distinct
// upstream providers, each with its own API base + key. Mirrors the
// routing logic in routes/ai.js so anything that works in the main
// chat also works in the design canvas.

function clientForModel(modelName) {
  if (!modelName) return null;
  const m = String(modelName);
  // OpenRouter catches everything that looks like a namespaced slug
  // (anthropic/..., x-ai/..., openrouter/..., meta-llama/..., etc.).
  if (/^(anthropic|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|google|moonshotai)\//i.test(m)
      || m.includes('/gpt-oss')) {
    return {
      provider: 'OpenRouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    };
  }
  if (m.includes('gemini') || m.includes('imagen')) {
    return {
      provider: 'Gemini',
      client: new OpenAI({
        apiKey: process.env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      }),
    };
  }
  return {
    provider: 'OpenAI',
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  };
}

// ─── System prompts ───────────────────────────────────────────────────────

const CORE_RULES = `You are a senior product designer using the siraGPT Design studio.
Your output must be exactly ONE complete HTML5 document — starting with \`<!DOCTYPE html>\` and ending with \`</html>\`.

Strict output contract:
- Output ONLY the HTML. No markdown code fences. No prose before or after. No explanations.
- Use Tailwind CSS via the CDN: <script src="https://cdn.tailwindcss.com"></script> in <head>.
- Load the Inter font from Google Fonts by default; pair with Georgia or Playfair Display for serif headings when a high-fidelity mood is called for.
- All interactivity (tabs, modals, dropdowns, charts) must be vanilla JS inline in a single <script> tag. No external JS other than the Tailwind CDN.
- Use Lucide icons inline via https://unpkg.com/lucide@latest when iconography is needed. Initialise in the script.
- Must be responsive: look correct at 1440px, 1024px, 768px, and 375px.
- Be accessible: semantic landmarks, alt text, labelled inputs, sufficient contrast.
- Do not use placeholder like "lorem ipsum" unless the user asked for dummy copy — pick realistic sample content relevant to the brief.`

const PROMPTS = {
  prototype_wireframe:
`${CORE_RULES}

You are building a WIREFRAME. Constraints:
- Monochrome only: greys from neutral-100 to neutral-900, plus white.
- Placeholder boxes for images (rounded-md bg-neutral-200 with a subtle diagonal lines via SVG pattern or a simple dashed border).
- System-ui / sans only. No decorative fonts.
- Emphasis on structure and hierarchy — show the page skeleton, information architecture, and interaction targets.`,

  prototype_high:
`${CORE_RULES}

You are building a HIGH-FIDELITY prototype. Constraints:
- Tasteful palette. Default to warm neutrals (cream #F6F1E7, charcoal #1A1918, terracotta accent #C05621) unless the user's brief specifies otherwise.
- Pair Inter (sans) with Playfair Display or Fraunces (serif) for hero headings only — keep body in Inter.
- Real-looking content, subtle shadows, careful spacing. Micro-animations via Tailwind's transition classes.
- Feel: editorial, confident, a little brand-forward. Not generic SaaS.`,

  slide_deck:
`${CORE_RULES}

You are building a SLIDE DECK. Constraints:
- Each slide is a <section data-slide> element, sized 16:9 (aspect ratio aspect-video) filling the viewport.
- Inline JS to navigate with Left/Right arrow keys AND PageUp/PageDown. Current slide index in the URL hash (#3) so refresh preserves position.
- Show a tiny dot-pagination in the bottom-right.
- Title slides: big serif headline centre-left, small accent sub-head. Content slides: clear H2 + either one big visual idea OR a 2-3 column split.
- Default palette: warm cream background with charcoal text and a terracotta accent. Consistent across the deck.
- No more than 6-8 slides unless the user asks for more. Quality over quantity.
- If speakerNotes is enabled, add an <aside data-notes> under each slide with 1-2 sentences of what the presenter would say, hidden by default (display:none) with a keyboard shortcut "n" to toggle a notes overlay.`,

  other:
`${CORE_RULES}

You are building a one-off page of whatever shape fits the brief — a landing page, dashboard, form, marketing splash, admin panel. Use your judgement on palette and typography, but keep the document self-contained and styled well.`,
};

function systemPromptFor({ kind, fidelity, speakerNotes }) {
  if (kind === 'slide_deck') {
    return PROMPTS.slide_deck + (speakerNotes ? '\n- Speaker notes ENABLED on every slide.' : '');
  }
  if (kind === 'prototype') {
    return fidelity === 'wireframe' ? PROMPTS.prototype_wireframe : PROMPTS.prototype_high;
  }
  return PROMPTS.other;
}

// ─── Output sanitiser ─────────────────────────────────────────────────────
//
// Even with strict instructions, models occasionally wrap the HTML in
// ```html ... ``` fences or prefix it with "Here is the HTML:". We
// clean those cases so the iframe always receives a valid doc. The
// assertion is mild — if we can find <!DOCTYPE html> anywhere in the
// response, we slice from there; if not, we return the raw output so
// the caller can surface the failure to the user.

function extractHtml(raw) {
  if (!raw) return '';
  let s = String(raw);
  // Strip ```html fences
  s = s.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '');
  const i = s.indexOf('<!DOCTYPE');
  if (i > 0) s = s.slice(i);
  return s.trim();
}

// ─── Generator ────────────────────────────────────────────────────────────

/**
 * Stream an HTML document. Yields `{ delta, full }` chunks as the
 * model writes. Yields a final `{ delta: '', full: <cleaned> }` at
 * the end so the caller has one place to grab the post-processed
 * document.
 *
 * @param {OpenAI} openai
 * @param {object} args
 * @param {string} args.instruction — user's new message
 * @param {Array}  [args.history]   — prior [{role, content}] messages
 * @param {string} [args.currentHtml] — existing HTML to iterate on
 * @param {string} args.kind
 * @param {string} [args.fidelity]
 * @param {boolean} [args.speakerNotes]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.model]
 */
async function* streamGeneration(openaiIgnored, args) {
  const {
    instruction, history = [], currentHtml = null,
    kind, fidelity, speakerNotes, signal, model = DEFAULT_MODEL,
  } = args;
  if (!instruction) throw new Error('design-generator: instruction required');

  // Route to the right provider. Callers used to pass in a pre-built
  // OpenAI client; we ignore that now (kept in signature for back-
  // compat) and construct the right one based on the model name,
  // because a single design studio session can freely switch between
  // OpenAI / Anthropic / OpenRouter / Gemini per request.
  const routed = clientForModel(model);
  if (!routed || !routed.client) {
    throw new Error(`design-generator: no API key configured for model "${model}"`);
  }
  const openai = routed.client;

  const system = systemPromptFor({ kind, fidelity, speakerNotes });

  // If the project already has HTML, feed it as a user turn BEFORE
  // the new instruction — labelled so the model understands "this
  // is what exists; modify it". We truncate aggressively because
  // large documents + long histories blow the prompt window fast.
  const messages = [{ role: 'system', content: system }];
  for (const h of history) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }
  if (currentHtml) {
    const cappedHtml = currentHtml.length > MAX_HTML_CHARS_IN_PROMPT
      ? currentHtml.slice(0, MAX_HTML_CHARS_IN_PROMPT) + '\n<!-- …truncated for context; output the full document… -->'
      : currentHtml;
    messages.push({
      role: 'user',
      content: `CURRENT DOCUMENT:\n\n${cappedHtml}\n\nCHANGE REQUEST:\n${instruction}\n\nOutput the FULL updated HTML document.`,
    });
  } else {
    messages.push({ role: 'user', content: instruction });
  }

  const stream = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.4,
    // High-fidelity prototypes can easily run 8k+ tokens. Streaming
    // avoids SDK HTTP timeouts; 8k is a comfortable ceiling for a
    // single-file HTML doc without ballooning latency.
    max_tokens: 8000,
    stream: true,
  }, { signal });

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      full += delta;
      yield { delta, full };
    }
  }
  const cleaned = extractHtml(full);
  yield { delta: '', full: cleaned, final: true };
}

module.exports = { streamGeneration, extractHtml, systemPromptFor, clientForModel };
