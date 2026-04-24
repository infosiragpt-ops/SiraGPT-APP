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

const EFFORT_CONFIG = {
  rapid: {
    label: 'rapid',
    maxTokens: 7000,
    temperature: 0.35,
    repairMode: 'blocking_only',
  },
  balanced: {
    label: 'balanced',
    maxTokens: 9000,
    temperature: 0.38,
    repairMode: 'quality_gate',
  },
  thorough: {
    label: 'thorough',
    maxTokens: 12000,
    temperature: 0.32,
    repairMode: 'always_review',
  },
};

function effortConfig(effort) {
  return EFFORT_CONFIG[effort] || EFFORT_CONFIG.balanced;
}

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
  if (/^deepseek-(v\d|chat|reasoner)/i.test(m.trim())) {
    return {
      provider: 'DeepSeek',
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
      }),
    };
  }
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
- Do not use placeholder like "lorem ipsum" unless the user asked for dummy copy — pick realistic sample content relevant to the brief.

Professional execution loop:
- Treat one user instruction as enough to produce a complete professional deliverable. Do not ask follow-up questions unless the brief is impossible or unsafe.
- Before finalizing, mentally review the page like a senior design director and front-end QA engineer: hierarchy, spacing, responsive behavior, accessibility, and whether controls actually work.
- Include functional logic for the primary user journey: nav links scroll, filters/tabs/modals/forms/cart/calculators/demos update real local state, and CTAs provide visible feedback.
- If the user asks for a sales website, landing page, prototype, dashboard, deck, or product interface, ship a complete first version with polished copy, sections, responsive layout, and realistic interactions from that single prompt.`

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

function effortInstructions(effort) {
  const normalized = effortConfig(effort).label;
  if (normalized === 'rapid') {
    return '\n\nEffort mode: RAPID. Prioritize a complete, clean first version. Keep the implementation concise but still functional.';
  }
  if (normalized === 'thorough') {
    return `\n\nEffort mode: THOROUGH. Work as if you have an extended 30-60 minute design sprint inside this single response:
- Plan the information architecture.
- Produce a polished visual system.
- Implement the primary user flow with real local-state interactions.
- Self-review for layout, responsiveness, accessibility, and broken controls.
- Correct issues before emitting the final HTML.`;
  }
  return '\n\nEffort mode: BALANCED. Produce a polished professional result with working interactions and a quick internal QA pass before final output.';
}

function systemPromptFor({ kind, fidelity, speakerNotes, effort = 'balanced' }) {
  const effortBlock = effortInstructions(effort);
  if (kind === 'slide_deck') {
    return PROMPTS.slide_deck + (speakerNotes ? '\n- Speaker notes ENABLED on every slide.' : '') + effortBlock;
  }
  if (kind === 'prototype') {
    return (fidelity === 'wireframe' ? PROMPTS.prototype_wireframe : PROMPTS.prototype_high) + effortBlock;
  }
  return PROMPTS.other + effortBlock;
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
  const doctype = s.search(/<!doctype\s+html/i);
  if (doctype > 0) s = s.slice(doctype);
  if (doctype === -1) {
    const htmlStart = s.search(/<html[\s>]/i);
    if (htmlStart > -1) s = `<!DOCTYPE html>\n${s.slice(htmlStart)}`;
  }
  const htmlEnd = s.toLowerCase().lastIndexOf('</html>');
  if (htmlEnd > -1) s = s.slice(0, htmlEnd + '</html>'.length);
  return s.trim();
}

function qualityReportForHtml(html, { kind = 'prototype', fidelity = 'high' } = {}) {
  const source = String(html || '');
  const lower = source.toLowerCase();
  const issues = [];
  const warnings = [];
  const addIssue = (id, message) => issues.push({ id, message });
  const addWarning = (id, message) => warnings.push({ id, message });

  if (!/^\s*<!doctype\s+html/i.test(source)) addIssue('missing_doctype', 'Document must start with <!DOCTYPE html>.');
  if (!/<html[\s>]/i.test(source) || !/<\/html>/i.test(source)) addIssue('missing_html_root', 'Document must include a complete <html> root.');
  if (!/<head[\s>]/i.test(source) || !/<\/head>/i.test(source)) addIssue('missing_head', 'Document must include a complete <head>.');
  if (!/<body[\s>]/i.test(source) || !/<\/body>/i.test(source)) addIssue('missing_body', 'Document must include a complete <body>.');
  if (!/name=["']viewport["']/i.test(source)) addIssue('missing_viewport', 'Document must define a responsive viewport meta tag.');
  if (/```/.test(source)) addIssue('markdown_fence', 'Output must not contain markdown fences.');
  if (/(lorem ipsum|todo:|insert your|replace this|your logo here|coming soon placeholder)/i.test(source)) {
    addIssue('placeholder_copy', 'Document contains placeholder copy instead of realistic content.');
  }

  const hasScript = /<script[\s>]/i.test(source);
  const hasInteractionCode = /(addEventListener|querySelector|getElementById|onclick=|onchange=|onsubmit=|function\s+\w+|\)\s*=>)/i.test(source);
  const interactiveElements = (source.match(/<(button|input|select|textarea|form)\b/gi) || []).length;
  const anchorStubs = (source.match(/href=["']#["']/gi) || []).length;

  if (kind !== 'slide_deck' && fidelity !== 'wireframe' && !hasScript) {
    addIssue('missing_script', 'High-fidelity designs need inline JavaScript for the primary interaction path.');
  }
  if (interactiveElements > 0 && !hasInteractionCode) {
    addIssue('inert_controls', 'Interactive controls exist but no event-handling logic was detected.');
  }
  if (anchorStubs > 4) {
    addWarning('many_anchor_stubs', 'Too many href="#" anchors can make the page feel unfinished.');
  }
  if (source.length < 3500 && fidelity !== 'wireframe') {
    addWarning('thin_document', 'High-fidelity output is unusually short for a complete professional design.');
  }
  if (!/(grid|flex|@media|sm:|md:|lg:|minmax|clamp\()/i.test(source)) {
    addWarning('weak_responsive_signals', 'Few responsive layout signals detected.');
  }
  if (!/(aria-|<label|alt=|role=)/i.test(source)) {
    addWarning('weak_accessibility_signals', 'Few accessibility signals detected.');
  }

  const score = Math.max(0, 100 - issues.length * 22 - warnings.length * 7);
  return {
    passed: issues.length === 0 && score >= 75,
    score,
    issues,
    warnings,
  };
}

function shouldRepairDesign(report, effort = 'balanced') {
  const mode = effortConfig(effort).repairMode;
  if (mode === 'blocking_only') return report.issues.length > 0;
  if (mode === 'always_review') return report.issues.length > 0 || report.warnings.length > 0 || report.score < 92;
  return report.issues.length > 0 || report.score < 82;
}

function buildRepairPrompt({ instruction, kind, fidelity, currentHtml, report }) {
  return `The HTML below failed the siraGPT Design quality gate.

Original user instruction:
${instruction}

Design kind: ${kind}${fidelity ? ` (${fidelity})` : ''}

Quality report:
${JSON.stringify(report, null, 2)}

Repair requirements:
- Output the FULL corrected HTML document only.
- Preserve the user's brief and the existing visual direction.
- Fix every issue and as many warnings as possible.
- Ensure the primary controls have real vanilla-JS behavior.
- Keep it self-contained and responsive.

HTML to repair:
${currentHtml}`;
}

async function repairHtml({ openai, model, system, instruction, kind, fidelity, html, report, signal, effort }) {
  const cfg = effortConfig(effort);
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildRepairPrompt({ instruction, kind, fidelity, currentHtml: html, report }) },
    ],
    temperature: 0.18,
    max_tokens: cfg.maxTokens,
  }, { signal });

  const repaired = extractHtml(response.choices?.[0]?.message?.content || '');
  const repairedReport = qualityReportForHtml(repaired, { kind, fidelity });

  // Prefer the repaired version only when it is a valid full document
  // and it does not regress the score. This prevents a second model
  // call from accidentally replacing a usable design with a partial.
  if (repaired && repairedReport.score >= report.score && repairedReport.issues.length <= report.issues.length) {
    return { html: repaired, report: repairedReport };
  }
  return { html, report };
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
    kind, fidelity, speakerNotes, signal, model = DEFAULT_MODEL, effort = 'balanced',
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

  const cfg = effortConfig(effort);
  const system = systemPromptFor({ kind, fidelity, speakerNotes, effort: cfg.label });

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
    temperature: cfg.temperature,
    // High-fidelity prototypes can easily run 8k+ tokens. Streaming
    // avoids SDK HTTP timeouts; 8k is a comfortable ceiling for a
    // single-file HTML doc without ballooning latency.
    max_tokens: cfg.maxTokens,
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
  let cleaned = extractHtml(full);
  let report = qualityReportForHtml(cleaned, { kind, fidelity });

  if (shouldRepairDesign(report, cfg.label)) {
    yield { delta: '', full: cleaned, phase: 'review', report };
    yield { delta: '', full: cleaned, phase: 'repair', report };
    const repaired = await repairHtml({
      openai,
      model,
      system,
      instruction,
      kind,
      fidelity,
      html: cleaned,
      report,
      signal,
      effort: cfg.label,
    });
    cleaned = repaired.html;
    report = repaired.report;
  }

  yield { delta: '', full: cleaned, final: true, quality: report };
}

module.exports = {
  streamGeneration,
  extractHtml,
  systemPromptFor,
  clientForModel,
  effortConfig,
  qualityReportForHtml,
  shouldRepairDesign,
};
