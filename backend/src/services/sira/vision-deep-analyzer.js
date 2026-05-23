'use strict';

/**
 * vision-deep-analyzer — structured vision analysis that goes BEYOND
 * OCR.
 *
 * Why this exists:
 *  The existing vision path (fileProcessor.processImage + GPT-4o-vision
 *  fallback) is wired for OCR-style "extract any visible text". That's
 *  great for scanned PDFs but loses signal on UI mockups, diagrams,
 *  charts, handwriting, and architectural drawings. This module exposes
 *  a SINGLE entry point that asks vision LLMs the right structured
 *  questions per image kind and parses their JSON answer into a typed
 *  report the rest of the brain can consume.
 *
 *  Crucially, it is PROVIDER-AGNOSTIC: callers pass an `analyzeFn`
 *  callback that does the actual API call (OpenAI, Anthropic, Google
 *  Gemini, local llava, …). The module just orchestrates: classify the
 *  image kind, pick the right prompt, parse the JSON, normalise the
 *  output, attach a confidence score.
 *
 *  Pure orchestrator. The only async path is the analyzeFn the caller
 *  injects. < 5 ms of pure JS overhead per analysis (excluding network).
 *
 * Public API:
 *   analyzeImage({ image, analyzeFn, kinds?, hints? }) → Promise<Report>
 *   getPromptForKind(kind)                              → string
 *   IMAGE_KINDS                                         → string[]
 *
 * Image kinds it can analyse:
 *   - document        scanned/photographed text page
 *   - ui_mockup       app/website screenshot or design
 *   - chart           data viz (bar, line, pie, scatter, etc.)
 *   - diagram         flowchart, architecture, mindmap, ER, sequence
 *   - handwriting     written notes, whiteboard, sticky notes
 *   - photo_scene     general scene/object photo
 *   - logo_branding   marks, identity, icons
 *   - table_image     screenshot of a table / spreadsheet
 *   - map             geographic or schematic map
 *   - code_screenshot screenshot of source code
 *
 *  Report shape:
 *    {
 *      kind: string,
 *      kindConfidence: number 0..1,
 *      structured: <kind-specific payload>,
 *      ocrText: string,          // any extracted text
 *      caption: string,          // one-line summary
 *      warnings: string[],
 *      latency_ms: number,
 *    }
 */

const IMAGE_KINDS = Object.freeze([
  'document', 'ui_mockup', 'chart', 'diagram', 'handwriting',
  'photo_scene', 'logo_branding', 'table_image', 'map', 'code_screenshot',
]);

// ─── Prompts per kind ───────────────────────────────────────────

const PROMPTS = Object.freeze({
  document: `Analyse the document image and return strict JSON:
{
  "kind_evidence": ["why this looks like a document — 1-3 bullets"],
  "ocr_text": "full extracted text in reading order",
  "language": "<ISO 639-1 best guess>",
  "page_type": "letter | invoice | form | report | book | other",
  "tables_present": <true|false>,
  "signatures_present": <true|false>,
  "low_confidence_regions": ["region label (e.g. 'header right side')", ...],
  "caption": "one sentence describing the document"
}`,
  ui_mockup: `Analyse this UI / app screenshot. Return strict JSON:
{
  "kind_evidence": ["why this looks like a UI"],
  "platform": "web | mobile_ios | mobile_android | desktop | unknown",
  "elements": [
    { "type": "button | input | link | nav | icon | image | text | modal | tab | dropdown | toggle | slider | card | chart | table | other",
      "label": "<text on or near the element>",
      "location": "top-left | top | top-right | center | bottom | bottom-left | bottom-right | left | right",
      "state": "default | disabled | active | hover | error" }
  ],
  "color_palette": ["#hex", "#hex", "#hex"],
  "typography_hint": "sans-serif | serif | mono | mixed | unknown",
  "ocr_text": "any text visible verbatim",
  "ui_purpose_guess": "settings | dashboard | onboarding | checkout | search | profile | feed | other",
  "caption": "one sentence describing the screen"
}`,
  chart: `Analyse this chart. Return strict JSON:
{
  "kind_evidence": ["why this looks like a chart"],
  "chart_type": "bar | line | pie | scatter | area | radar | gauge | heatmap | funnel | other",
  "axes": { "x_label": "<text>", "y_label": "<text>", "x_unit": "<unit or null>", "y_unit": "<unit or null>" },
  "series": [ { "label": "<series name>", "approx_values": [<n>, ...] } ],
  "category_labels": ["<labels along x>"],
  "title": "<chart title>",
  "trend_summary": "1 sentence about direction / story",
  "ocr_text": "any visible text",
  "caption": "one sentence describing the chart"
}`,
  diagram: `Analyse this diagram. Return strict JSON:
{
  "kind_evidence": ["why this is a diagram"],
  "diagram_type": "flowchart | architecture | mindmap | sequence | er | class | state | tree | venn | other",
  "nodes": [ { "id": "n1", "label": "<text>", "shape": "rect | round | diamond | cylinder | actor | cloud | other" } ],
  "edges": [ { "from": "n1", "to": "n2", "label": "<text or null>", "kind": "arrow | bidir | dashed | inheritance | composition | other" } ],
  "entry_nodes": ["nN"],
  "ocr_text": "any visible text",
  "mermaid_attempt": "<mermaid syntax sketch — best-effort>",
  "caption": "one sentence describing the diagram"
}`,
  handwriting: `Analyse this handwritten / whiteboard image. Return strict JSON:
{
  "kind_evidence": ["why this is handwriting"],
  "ocr_text": "best-effort transcription preserving line breaks",
  "language": "<ISO 639-1 best guess>",
  "legibility": "high | medium | low",
  "structure": "linear_notes | list | mindmap | math | sketch | mixed",
  "math_present": <true|false>,
  "caption": "one sentence describing the content"
}`,
  photo_scene: `Analyse this scene photo. Return strict JSON:
{
  "kind_evidence": ["why this is a scene photo"],
  "scene_type": "indoor | outdoor | studio | street | nature | event | other",
  "objects": ["object", ...],
  "people_count": <number>,
  "dominant_colors": ["#hex", ...],
  "mood": "neutral | bright | dark | warm | cool | other",
  "ocr_text": "any visible text on signs / objects",
  "caption": "one sentence describing the scene"
}`,
  logo_branding: `Analyse this logo or brand mark. Return strict JSON:
{
  "kind_evidence": ["why this is a logo / mark"],
  "shape": "wordmark | lettermark | emblem | mascot | abstract | combination",
  "primary_text": "<text in the logo or null>",
  "colors": ["#hex", ...],
  "style": "modern | classic | minimal | retro | playful | other",
  "industry_guess": "<best industry guess>",
  "caption": "one sentence describing the mark"
}`,
  table_image: `Analyse this table screenshot. Return strict JSON:
{
  "kind_evidence": ["why this is a table"],
  "headers": ["col1", "col2", ...],
  "rows": [ ["cell", "cell", ...], ... ],
  "row_count": <number>,
  "column_types": ["numeric | currency | percent | date | text", ...],
  "totals_row_present": <true|false>,
  "caption": "one sentence describing the table"
}`,
  map: `Analyse this map. Return strict JSON:
{
  "kind_evidence": ["why this is a map"],
  "map_type": "political | physical | road | thematic | schematic | metro | floor_plan | other",
  "region": "<country or area best guess>",
  "labels_visible": ["label", ...],
  "legend_present": <true|false>,
  "caption": "one sentence describing the map"
}`,
  code_screenshot: `Analyse this code screenshot. Return strict JSON:
{
  "kind_evidence": ["why this is code"],
  "language": "<programming language guess>",
  "ocr_text": "verbatim transcription of visible code",
  "file_name_hint": "<filename guessed from header or null>",
  "lint_warnings": ["any obvious issues", ...],
  "caption": "one sentence describing what the code does"
}`,
});

function getPromptForKind(kind) {
  return PROMPTS[kind] || PROMPTS.document;
}

// ─── Kind detection (cheap heuristics + LLM) ──────────────────

const KIND_DETECT_PROMPT = `Classify this image into EXACTLY ONE of these kinds: document, ui_mockup, chart, diagram, handwriting, photo_scene, logo_branding, table_image, map, code_screenshot.
Return strict JSON: { "kind": "<one of the above>", "confidence": <0..1>, "rationale": "<one short sentence>" }.
Pick the kind that captures the PRIMARY information of the image, not background details.`;

async function detectKind({ image, analyzeFn, hints }) {
  // Caller hint short-circuits the detection
  if (hints && typeof hints.kind === 'string' && IMAGE_KINDS.includes(hints.kind)) {
    return { kind: hints.kind, confidence: 1.0, rationale: 'caller hint' };
  }
  try {
    const raw = await analyzeFn({ image, prompt: KIND_DETECT_PROMPT, intent: 'classify_kind' });
    const parsed = parseJsonFromResponse(raw);
    if (parsed && IMAGE_KINDS.includes(String(parsed.kind))) {
      return {
        kind: parsed.kind,
        confidence: clamp(Number(parsed.confidence) || 0.5, 0, 1),
        rationale: String(parsed.rationale || ''),
      };
    }
  } catch { /* fall through to fallback */ }
  return { kind: 'document', confidence: 0.4, rationale: 'fallback — classifier failed' };
}

// ─── JSON parsing safety net ────────────────────────────────

function parseJsonFromResponse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip markdown fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(text); } catch { /* try lenient */ }
  // Find the largest balanced { … } object in the text
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* swallow */ }
  }
  return null;
}

// ─── Public: analyse an image ────────────────────────────────

async function analyzeImage(args = {}) {
  const startedAt = Date.now();
  const warnings = [];
  if (!args.analyzeFn || typeof args.analyzeFn !== 'function') {
    return {
      kind: 'document', kindConfidence: 0, structured: null, ocrText: '', caption: '',
      warnings: ['analyzeFn is required'], latency_ms: 0,
    };
  }
  if (!args.image) {
    return {
      kind: 'document', kindConfidence: 0, structured: null, ocrText: '', caption: '',
      warnings: ['image input missing'], latency_ms: Date.now() - startedAt,
    };
  }
  // Classify
  const detection = await detectKind(args);
  const prompt = getPromptForKind(detection.kind);

  let structured = null;
  try {
    const raw = await args.analyzeFn({ image: args.image, prompt, intent: 'analyze_kind', kind: detection.kind });
    structured = parseJsonFromResponse(raw);
    if (!structured) warnings.push('analyzeFn returned non-JSON; structured analysis empty');
  } catch (err) {
    warnings.push(`analyzeFn threw: ${err && err.message ? err.message : String(err)}`);
  }

  const ocrText = typeof structured?.ocr_text === 'string' ? structured.ocr_text : '';
  const caption = typeof structured?.caption === 'string' ? structured.caption : '';
  return {
    kind: detection.kind,
    kindConfidence: detection.confidence,
    structured: structured || null,
    ocrText,
    caption,
    warnings,
    latency_ms: Date.now() - startedAt,
  };
}

function clamp(n, lo = 0, hi = 1) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

module.exports = {
  analyzeImage,
  getPromptForKind,
  detectKind,
  IMAGE_KINDS,
  _internal: { parseJsonFromResponse, KIND_DETECT_PROMPT, PROMPTS },
};
