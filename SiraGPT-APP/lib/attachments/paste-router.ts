/**
 * paste-router.ts — Pure clipboard routing decision engine.
 *
 * Operates on already-extracted clipboard data (no DOM event types).
 * Given a PasteInput, decides which composer actions should be produced:
 * file chips, link chips, rich HTML, long-text snippet chips or plain inserts.
 */

export type RoutedAction =
  | { type: 'insert-text'; text: string }
  | { type: 'text-snippet-chip'; text: string; suggestedName: string }
  | { type: 'rich-html'; html: string; plainText: string }
  | { type: 'link-chip'; url: string }
  | { type: 'file-chip'; file: File; kind: string };

export interface PasteInput {
  text?: string | null;
  html?: string | null;
  uriList?: string | null;
  files?: File[];
}

export interface RoutePasteOptions {
  /** Trimmed text longer than this becomes a snippet chip (default 1500). */
  longTextThreshold?: number;
  /** Maximum number of link chips produced from a URL-only paste (default 5). */
  maxLinkChips?: number;
  /** Custom mime/name → kind resolver for file chips. */
  resolveKind?: (mime: string, name: string) => string;
}

const DEFAULT_LONG_TEXT_THRESHOLD = 1500;
const DEFAULT_MAX_LINK_CHIPS = 5;

/** A single whitespace-free http(s) URL token. */
const SINGLE_URL_PATTERN = /^https?:\/\/\S+$/i;

/** Rich formatting tags beyond bare wrappers (<p>/<div>/<span>). */
const RICH_TAG_PATTERN = /<(strong|em|b|i|u|li|ol|ul|table|h[1-6])(\s|\/?>)/i;
const ANCHOR_HREF_PATTERN = /<a\s[^>]*\bhref\s*=/i;

/** Extracts every http(s) URL found anywhere in the text (deduplicated). */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches) return [];
  // Strip common trailing punctuation picked up from prose.
  return dedupe(matches.map((url) => url.replace(/[).,;:!?\]]+$/, '')));
}

/** True when the trimmed content consists ONLY of whitespace-separated http(s) URLs. */
export function isOnlyUrls(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).every((token) => SINGLE_URL_PATTERN.test(token));
}

/**
 * True when the HTML carries real formatting (bold/italic/lists/tables/
 * headings/links) beyond bare <p>/<div>/<span> wrappers.
 */
export function isRichHtml(html: string): boolean {
  if (!html || !html.trim()) return false;
  return RICH_TAG_PATTERN.test(html) || ANCHOR_HREF_PATTERN.test(html);
}

/**
 * Routes extracted clipboard data into composer actions.
 *
 * Priority order:
 * 1. Files → one file-chip per file (+ insert-text when text also present).
 * 2. uriList / URL-only text → one link-chip per unique URL (1..maxLinkChips).
 * 3. Rich HTML → single rich-html action (caller converts to Markdown).
 * 4. Text → snippet chip when longer than threshold, else insert-text.
 * 5. Nothing usable → [].
 */
export function routePaste(input: PasteInput, opts: RoutePasteOptions = {}): RoutedAction[] {
  const longTextThreshold = opts.longTextThreshold ?? DEFAULT_LONG_TEXT_THRESHOLD;
  const maxLinkChips = opts.maxLinkChips ?? DEFAULT_MAX_LINK_CHIPS;
  const resolveKind = opts.resolveKind ?? defaultResolveKind;

  const files = input.files ?? [];
  const text = input.text ?? '';
  const html = input.html ?? '';
  const uriList = input.uriList ?? '';
  const trimmedText = text.trim();

  // Rule 1 — files win; html is ignored, text rides along as a plain insert.
  if (files.length > 0) {
    const actions: RoutedAction[] = files.map((file) => ({
      type: 'file-chip' as const,
      file,
      kind: resolveKind(file.type || '', file.name || ''),
    }));
    if (trimmedText.length > 0) {
      actions.push({ type: 'insert-text', text });
    }
    return actions;
  }

  // Rule 2 — URL-only paste becomes link chips.
  const linkUrls = resolveLinkUrls(uriList, text, maxLinkChips);
  if (linkUrls) {
    return linkUrls.map((url) => ({ type: 'link-chip' as const, url }));
  }

  // Rule 3 — rich HTML (caller converts to Markdown and applies threshold).
  if (html.trim().length > 0 && isRichHtml(html)) {
    const plainText = trimmedText.length > 0 ? text : htmlToPlainText(html);
    return [{ type: 'rich-html', html, plainText }];
  }

  // Rule 4 — plain text: long → snippet chip, otherwise inline insert.
  if (trimmedText.length > 0) {
    if (trimmedText.length > longTextThreshold) {
      return [
        {
          type: 'text-snippet-chip',
          text,
          suggestedName: buildSnippetName(trimmedText.length),
        },
      ];
    }
    return [{ type: 'insert-text', text }];
  }

  // Rule 5 — nothing usable.
  return [];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Deterministic suggested file name derived from the trimmed length. */
function buildSnippetName(length: number): string {
  return `pegado-${length}-caracteres.txt`;
}

function defaultResolveKind(mime: string, _name: string): string {
  const lower = (mime || '').toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Parses a text/uri-list payload (one URL per line, '#' lines are comments).
 * Returns null when any non-comment line is not a valid http(s) URL.
 */
function parseUriList(uriList: string): string[] | null {
  const lines = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return null;
  if (!lines.every((line) => SINGLE_URL_PATTERN.test(line))) return null;
  return lines;
}

/**
 * Resolves the unique URL list for rule 2, or null when the paste should not
 * become link chips (mixed prose, too many URLs, or no URL source at all).
 */
function resolveLinkUrls(uriList: string, text: string, maxLinkChips: number): string[] | null {
  let candidates: string[] | null = null;
  if (uriList.trim().length > 0) {
    candidates = parseUriList(uriList);
  }
  if (!candidates && isOnlyUrls(text)) {
    candidates = text.trim().split(/\s+/);
  }
  if (!candidates) return null;
  const unique = dedupe(candidates);
  if (unique.length < 1 || unique.length > maxLinkChips) return null;
  return unique;
}

/** Naive tag-stripping fallback used when no plain-text alternative exists. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
