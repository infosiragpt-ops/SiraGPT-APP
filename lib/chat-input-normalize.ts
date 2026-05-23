/**
 * Normalize and validate the text the user typed in the chat composer
 * before it goes into `handleSend` / the backend.
 *
 * What this guards against:
 *
 *   - Zero-width characters & BOMs leaking in from copy-paste (they
 *     do not render but cost tokens and confuse model tokenisation).
 *   - U+2028 / U+2029 paragraph/line separators that some PDF
 *     extractors emit. Browsers render them as newlines but JSON
 *     stringify them differently, which has caused parser drift in
 *     downstream tools.
 *   - NUL bytes from binary-ish pastes (can break Postgres TEXT).
 *   - Catastrophic input length. A 10 MB paste should not sit in
 *     React state and stream to the model. We cap and toast.
 *
 * Mirrors the auth-side normalizers (normalizeLoginEmail /
 * normalizeLoginPassword) so the codebase has one obvious pattern
 * for "clean up untrusted user text".
 *
 * Regexes are built at runtime via String.fromCharCode so the source
 * file is plain ASCII (no embedded control chars or zero-width junk).
 */

/** Hard cap on chat-composer text. ~100 k chars is roughly a paperback novel. */
export const MAX_CHAT_INPUT_CHARS = 100_000;

const codepoint = (n: number) => String.fromCharCode(n);
const range = (lo: number, hi: number) => `${codepoint(lo)}-${codepoint(hi)}`;

// Zero-width chars U+200B..U+200D, word joiner U+2060, BOM U+FEFF.
const ZERO_WIDTH_AND_BOM_RE = new RegExp(
  `[${range(0x200b, 0x200d)}${codepoint(0x2060)}${codepoint(0xfeff)}]`,
  "g",
);

// Line separator U+2028, paragraph separator U+2029 -> normal newline.
const LINE_PARA_SEP_RE = new RegExp(
  `[${codepoint(0x2028)}${codepoint(0x2029)}]`,
  "g",
);

const NUL_RE = new RegExp(codepoint(0x00), "g");

// C0 controls 0x01-0x08, 0x0B-0x0C, 0x0E-0x1F and C1 controls 0x7F-0x9F.
// Keeps TAB (0x09), LF (0x0A) and CR (0x0D) intact.
const FORBIDDEN_CONTROLS_RE = new RegExp(
  `[${range(0x01, 0x08)}${range(0x0b, 0x0c)}${range(0x0e, 0x1f)}${range(
    0x7f,
    0x9f,
  )}]`,
  "g",
);

export type NormalizedChatInput = {
  /** Cleaned text. Always a string; may be empty after stripping. */
  value: string;
  /** True if any character was stripped or replaced. */
  changed: boolean;
  /** True if raw.length exceeded the cap and we truncated. */
  truncated: boolean;
  /** Original length, for telemetry / debugging. */
  originalLength: number;
};

export function normalizeChatInput(raw: unknown): NormalizedChatInput {
  const original =
    typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const originalLength = original.length;

  let value = original
    .replace(ZERO_WIDTH_AND_BOM_RE, "")
    .replace(LINE_PARA_SEP_RE, "\n")
    .replace(NUL_RE, "")
    .replace(FORBIDDEN_CONTROLS_RE, "");

  let truncated = false;
  if (value.length > MAX_CHAT_INPUT_CHARS) {
    value = value.slice(0, MAX_CHAT_INPUT_CHARS);
    truncated = true;
  }

  return {
    value,
    changed: value !== original,
    truncated,
    originalLength,
  };
}

/**
 * Should we block submit and toast the user? Currently only
 * `truncated` warrants a visible warning. Other cleanups happen
 * silently because they are invisible to the user anyway.
 */
export function shouldWarnUser(normalized: NormalizedChatInput): boolean {
  return normalized.truncated;
}
