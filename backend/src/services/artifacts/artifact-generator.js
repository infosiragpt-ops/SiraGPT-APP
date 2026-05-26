/**
 * artifact-generator — produce interactive visualizations as
 * self-contained HTML, inspired by Claude.ai's artifact feature.
 *
 * When the user asks to "grafica", "visualiza", "anima" a concept
 * (especially alongside an image like a math diagram), a text response
 * is unsatisfying. An interactive visualization — slider + live values
 * + SVG that redraws — explains the concept far better.
 *
 * This module asks the LLM to produce a single self-contained HTML
 * document with inline CSS + JS + SVG that implements the requested
 * visualization. The frontend mounts it in an iframe sandbox so the
 * generated JS can't touch the parent page.
 *
 * Output contract (the LLM is instructed to follow this):
 *   - One complete <!DOCTYPE html>...</html> document.
 *   - All CSS inlined in <style>.
 *   - All JS inlined in <script>, no external URLs.
 *   - No network requests, no <iframe>, no external libraries.
 *   - Interactive: sliders, buttons, or hover; state updates the view.
 *   - Renders at 800×600 or smaller; responsive within that.
 *   - Uses a neutral palette matching the host chat (light bg, dark text).
 *   - Accessible: labels on controls, keyboard-operable.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_VISION_MODEL = 'gpt-4o';
const MAX_IMAGES = 4;

const SYSTEM_PROMPT = `You are a front-end engineer. The user wants an INTERACTIVE VISUALIZATION to understand a concept. You will produce ONE self-contained HTML document that implements it.

Output format — STRICT JSON, nothing else:
{
  "title": "<short descriptive title>",
  "description": "<one sentence explaining what the viewer does>",
  "html": "<full <!DOCTYPE html> document as a single string>"
}

Rules for the HTML document:

1. Self-contained.
   - Everything inline: <style> in <head>, <script> at the end of <body>.
   - NO external CSS/JS/font/image URLs. No CDNs. No imports. No \`<iframe>\`.
   - No fetch(), no XHR, no WebSocket, no localStorage.

2. Interactive.
   - At least one control (range slider, buttons, toggle, or hover).
   - State updates re-render the view in real time.
   - Use vanilla JS — NO React, Vue, Svelte. SVG or Canvas only.

3. Visually clean.
   - Palette: white/near-white background, slate dark text (#111-#333),
     1-2 accent colors (blue #2563eb, red #dc2626).
   - Fonts: system-ui stack, no font imports.
   - Max width 800px, max height 600px total viewer, responsive within.
   - Controls above or beside the visual, aligned cleanly.

4. Clear affordances.
   - Every control has a visible label (e.g. "α: 36°" next to the slider).
   - Computed values shown in cards or inline text.

5. Accessible.
   - All controls have <label> or aria-label.
   - Keyboard: sliders work with arrow keys, buttons with Enter/Space.

6. Safe.
   - No eval(), no new Function(), no innerHTML with user data.
   - All user input via built-in DOM events.

If the user's request is not visualization-friendly (pure text answer,
ambiguous, or the concept is not geometric/numeric), respond with:
{"title": "", "description": "", "html": "", "refused": true, "reason": "<one sentence>"}`;

function buildUserPrompt(userRequest, imageDescription) {
  const parts = [`USER REQUEST: ${String(userRequest).slice(0, 2000)}`];
  if (imageDescription) {
    parts.push(`REFERENCE IMAGE DESCRIPTION: ${String(imageDescription).slice(0, 2000)}`);
  }
  parts.push(
    'Produce the artifact JSON now. The HTML must be complete, interactive, and render on first load without a build step.',
  );
  return parts.join('\n\n');
}

function buildVisionUserContent(userRequest, imageDataUrls) {
  const textPrefix =
    `USER REQUEST: ${String(userRequest).slice(0, 2000)}\n\n` +
    `The attached image(s) are the reference. LOOK AT THE IMAGE carefully and reproduce the underlying concept as an interactive HTML visualization. ` +
    `If the image shows a trigonometric circle, build an SVG with a draggable angle slider and live sen/cos/tan readouts. ` +
    `If it shows a function graph, build an SVG plot with sliders for the function parameters. ` +
    `If it shows a geometric figure, build an SVG where the user can manipulate the defining variables.\n\n` +
    'Produce the artifact JSON now. The HTML must be complete, interactive, and render on first load without a build step.';
  const content = [{ type: 'text', text: textPrefix }];
  for (const url of imageDataUrls.slice(0, MAX_IMAGES)) {
    if (typeof url === 'string' && url.startsWith('data:image/')) {
      content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }
  }
  return content;
}

/**
 * Generate an interactive artifact for a user request.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.userRequest        — e.g. "grafica", "visualiza el ciclo de krebs"
 * @param {string} [args.imageDescription] — optional prose describing an attached image
 * @param {string[]} [args.imageDataUrls]  — optional data:image/... URLs; switches
 *                                           to a vision-capable model so the LLM
 *                                           sees the reference before producing HTML
 * @param {string} [args.model='gpt-4o-mini' or 'gpt-4o' when images present]
 * @param {number} [args.maxHtmlChars=40000] — safety cap on generated HTML size
 *
 * @returns {Promise<{
 *   title: string,
 *   description: string,
 *   html: string,
 *   refused: boolean,
 *   reason: string,
 *   size: number,
 * }>}
 */
async function generate({ openai, userRequest, imageDescription, imageDataUrls, model, maxHtmlChars = 40000 }) {
  if (!openai) {
    return { title: '', description: '', html: '', refused: true, reason: 'no LLM client', size: 0 };
  }
  if (!userRequest || typeof userRequest !== 'string' || userRequest.trim().length === 0) {
    return { title: '', description: '', html: '', refused: true, reason: 'empty request', size: 0 };
  }

  const hasImages = Array.isArray(imageDataUrls) && imageDataUrls.length > 0;
  const resolvedModel = model || (hasImages ? DEFAULT_VISION_MODEL : DEFAULT_MODEL);
  const userContent = hasImages
    ? buildVisionUserContent(userRequest, imageDataUrls)
    : buildUserPrompt(userRequest, imageDescription);

  try {
    const resp = await openai.chat.completions.create({
      model: resolvedModel,
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    if (parsed?.refused) {
      return {
        title: '', description: '', html: '',
        refused: true,
        reason: String(parsed?.reason || 'model refused').slice(0, 300),
        size: 0,
      };
    }

    const html = String(parsed?.html || '');
    // Basic validation — the model sometimes drops the doctype even when
    // asked. Reject if the document looks incomplete.
    if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html) || html.length < 200) {
      return {
        title: '', description: '', html: '',
        refused: true,
        reason: 'generated HTML was incomplete',
        size: html.length,
      };
    }
    if (html.length > maxHtmlChars) {
      return {
        title: '', description: '', html: '',
        refused: true,
        reason: `generated HTML exceeds ${maxHtmlChars} chars`,
        size: html.length,
      };
    }

    // Strip any accidental external-resource tags the model slipped in
    // despite the prompt. Not a replacement for iframe sandbox, but
    // belt-and-braces.
    const cleaned = sanitiseArtifactHtml(html);

    return {
      title: String(parsed?.title || '').slice(0, 200),
      description: String(parsed?.description || '').slice(0, 400),
      html: cleaned,
      refused: false,
      reason: '',
      size: cleaned.length,
    };
  } catch (err) {
    console.warn('[artifact-generator] failed:', err.message);
    return {
      title: '', description: '', html: '',
      refused: true,
      reason: `generation error: ${err.message}`,
      size: 0,
    };
  }
}

/**
 * Strip external-resource tags the LLM may have slipped past the prompt.
 * NOT a substitute for iframe sandboxing — the frontend MUST still run
 * the artifact inside <iframe sandbox="allow-scripts">.
 */
function sanitiseArtifactHtml(html) {
  let out = html;
  // Nested iframes are always a smell — strip them.
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '<!-- iframe removed -->');
  // External scripts with src attributes.
  out = out.replace(/<script\b[^>]*\bsrc=['"][^'"]+['"][^>]*>[\s\S]*?<\/script>/gi, '<!-- external script removed -->');
  // External stylesheet links.
  out = out.replace(/<link\b[^>]*\brel=['"]?stylesheet['"]?[^>]*>/gi, '<!-- external stylesheet removed -->');
  // Font imports via @import in <style> — rare but neutralise them.
  out = out.replace(/@import\s+url\([^)]+\);?/g, '/* @import removed */');
  return out;
}

// ─── Intent detection ─────────────────────────────────────────────────────

// Requests that typically want a visualization. Spanish + English.
// We deliberately keep this list short and high-precision; false positives
// would hijack text-only conversations.
const ARTIFACT_INTENT_PATTERNS = [
  // Bare Spanish imperative verbs (with or without accent on any vowel):
  // grafica / gráfica / grafícalo / visualiza / visualízalo /
  // dibuja / dibújalo / diagrama / anímalo, etc.
  /^\s*(gr[aá]f[ií]c\w*|v[ií]sual[ií]z\w*|dib[uú]j\w*|diagr[aá]m\w*|an[ií]m\w*)\b/i,
  // Phrases: "muéstrame una gráfica" / "enséñame un diagrama"
  /^\s*(mu[eé]stra|ens[eé][ñn]a)(me)?\s+(un|el|la|los|una)?\s*(gr[áa]fic\w*|diagrama|visualizaci[óo]n|mapa|esquema)/i,
  // Verbal phrases asking for an interactive thing
  /\b(cr[eé]a|hazme?|genera(me)?|dame)\s+(un[ao]?\s+)?(visualizaci[óo]n|animaci[óo]n|interactiv[oa]|simulaci[óo]n)\b/i,
  // English: "plot", "draw", "animate", "visualize", "interactive"
  /^\s*(animate|render|plot|chart|draw|visuali[sz]e|simulate)\b/i,
  /\b(make|create|build)\s+(an?\s+)?(interactive|animation|visuali[sz]ation|simulation|plot|chart)\b/i,
];

/**
 * Decide if a user message is an artifact request. High-precision
 * matcher: false positives hurt (hijacks normal text chat), false
 * negatives are recoverable (user can re-phrase or hit the explicit
 * artifact endpoint).
 */
function isArtifactRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 3) return false;
  for (const re of ARTIFACT_INTENT_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * Wrap an artifact payload in the inline <artifact> tag that the
 * frontend parser (extractArtifact in InteractiveArtifact.tsx)
 * understands. Callers are responsible for the surrounding intro text.
 */
function wrapArtifact({ title, description, html }) {
  const escAttr = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<artifact title="${escAttr(title)}" description="${escAttr(description)}">\n${html}\n</artifact>`;
}

module.exports = {
  generate,
  isArtifactRequest,
  sanitiseArtifactHtml,
  buildUserPrompt,
  buildVisionUserContent,
  wrapArtifact,
  SYSTEM_PROMPT,
  ARTIFACT_INTENT_PATTERNS,
};
