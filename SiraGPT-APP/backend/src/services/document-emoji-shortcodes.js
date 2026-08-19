'use strict';

/**
 * document-emoji-shortcodes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects :shortcode: emoji references (GitHub, Slack, Discord, gitmoji) plus
 * unicode emoji code points. Useful for tone/sentiment context in chat docs
 * and commit messages.
 *
 *   - shortcode: :rocket:, :fire:, :+1:, :white_check_mark:
 *   - gitmoji:   🚀 :sparkles: :bug: in commit messages
 *   - unicode emoji code-points (BMP and supplementary)
 *
 * Public API:
 *   extractEmojiShortcodes(text)             → { entries, totals, total }
 *   buildEmojiShortcodesForFiles(files)      → { perFile, aggregate, totals }
 *   renderEmojiShortcodesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 4500;

const SHORTCODE_RE = /:([a-z0-9][a-z0-9_+-]{1,40}):/g;
// Pattern for unicode emoji: most pictographic ranges in BMP and supplementary planes
const UNICODE_EMOJI_RE = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

const GITMOJI = new Set([
  'sparkles', 'tada', 'bug', 'fire', 'rocket', 'lipstick', 'recycle',
  'wrench', 'lock', 'arrow_up', 'arrow_down', 'memo', 'hammer', 'wastebasket',
  'green_heart', 'rotating_light', 'pencil2', 'art', 'zap', 'bulb',
  'wheelchair', 'truck', 'globe_with_meridians', 'package', 'chart_with_upwards_trend',
  'see_no_evil', 'children_crossing', 'building_construction', 'iphone', 'busts_in_silhouette',
  'speech_balloon', 'card_file_box', 'loud_sound', 'mute', 'people_holding_hands',
]);

const SENTIMENT = {
  '+1': 'positive', 'thumbsup': 'positive', 'heart': 'positive', 'tada': 'positive',
  'rocket': 'positive', 'fire': 'positive', 'sparkles': 'positive', 'star': 'positive',
  'green_heart': 'positive', 'white_check_mark': 'positive', 'heavy_check_mark': 'positive',
  '-1': 'negative', 'thumbsdown': 'negative', 'broken_heart': 'negative',
  'x': 'negative', 'no_entry': 'negative', 'warning': 'caution',
  'rotating_light': 'caution', 'rage': 'negative',
  'thinking': 'neutral', 'eyes': 'neutral', 'shrug': 'neutral',
  'bug': 'caution', 'wrench': 'caution',
};

function classifyShortcode(code) {
  if (SENTIMENT[code]) return SENTIMENT[code];
  if (GITMOJI.has(code)) return 'gitmoji';
  return 'other';
}

function extractEmojiShortcodes(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { positive: 0, negative: 0, caution: 0, neutral: 0, gitmoji: 0, other: 0, unicode: 0 };

  function push(code, kind, source) {
    const key = `${source}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ code, kind, source });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SHORTCODE_RE.lastIndex = 0;
  let m;
  while ((m = SHORTCODE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const code = m[1];
    push(code, classifyShortcode(code), 'shortcode');
  }

  if (entries.length < MAX_PER_FILE) {
    UNICODE_EMOJI_RE.lastIndex = 0;
    while ((m = UNICODE_EMOJI_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const code = m[0];
      push(code, 'unicode', 'unicode');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildEmojiShortcodesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { positive: 0, negative: 0, caution: 0, neutral: 0, gitmoji: 0, other: 0, unicode: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractEmojiShortcodes(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.source}:${e.code}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderEmojiShortcodesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## EMOJI SHORTCODES & UNICODE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      if (e.source === 'shortcode') {
        lines.push(`- :${e.code}: (${e.kind})`);
      } else {
        lines.push(`- ${e.code} (unicode)`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractEmojiShortcodes,
  buildEmojiShortcodesForFiles,
  renderEmojiShortcodesBlock,
  _internal: { classifyShortcode, SENTIMENT, GITMOJI },
};
