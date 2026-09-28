/**
 * Live progress helpers for the thinking timeline — what the software is
 * doing right now, told in real numbers (words written, step durations, the
 * model's current line of thought). Pure: no React, no DOM, so node --test
 * covers every formatter and the timeline components stay thin.
 */

/** Stage phases another surface owns: AgenticSteps / AgentTrace draw them. */
export const OWNED_ELSEWHERE_PHASES: ReadonlySet<string> = new Set(["agent_step", "agent_model"])

const WORD_RE = /\S+/g
const SPACE_RE = /\s/

/** Whitespace-separated words («420 palabras»). */
export function countWords(text: string | null | undefined): number {
  if (typeof text !== "string" || !text) return 0
  const matches = text.match(WORD_RE)
  return matches ? matches.length : 0
}

/**
 * Word counter for a streaming answer: when the new text extends the previous
 * one only the appended suffix is counted, so a long answer is never re-read
 * from the start on every flush. Any other change (replace, regenerate)
 * falls back to a full recount.
 */
export function createIncrementalWordCounter(): (text: string | null | undefined) => number {
  let prevText = ""
  let prevCount = 0
  return (input) => {
    const text = typeof input === "string" ? input : ""
    if (text === prevText) return prevCount
    let count: number
    if (prevText && text.length > prevText.length && text.startsWith(prevText)) {
      const suffix = text.slice(prevText.length)
      const joined = !SPACE_RE.test(prevText[prevText.length - 1]) && !SPACE_RE.test(suffix[0])
      const added = countWords(suffix)
      count = prevCount + added - (joined && added > 0 ? 1 : 0)
    } else {
      count = countWords(text)
    }
    prevText = text
    prevCount = count
    return count
  }
}

/** «420» · «1.240» · «12.340» — Spanish grouping, done by hand (es does not group 4 digits). */
export function formatCount(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  const digits = String(n)
  let out = ""
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i
    out += digits[i]
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += "."
  }
  return out
}

const decimalSeparatorCache = new Map<string, string>()

/** «,» for Spanish (the default: backend labels are Spanish), the locale's own separator otherwise. */
export function decimalSeparator(locale?: string | null): string {
  const key = String(locale || "").trim()
  if (!key || /^es\b/i.test(key)) return ","
  const known = decimalSeparatorCache.get(key)
  if (known) return known
  let sep = ","
  try {
    const part = new Intl.NumberFormat(key).formatToParts(1.5).find((p) => p.type === "decimal")
    if (part && part.value) sep = part.value
  } catch {
    sep = ","
  }
  decimalSeparatorCache.set(key, sep)
  return sep
}

/**
 * «180 ms» · «1,8 s» · «12 s» · «1 min 5 s» — empty for an unknown duration.
 * The decimal separator follows `locale` («1.8 s» in English); Spanish by default.
 */
export function formatStepDuration(ms: number | null | undefined, locale?: string | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return ""
  if (ms < 999.5) return `${Math.round(ms)} ms`
  if (ms < 9950) {
    const tenths = Math.round(ms / 100) / 10
    return `${String(tenths).replace(".", decimalSeparator(locale))} s`
  }
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`
}

const DURATION_MENTION_RE = /(^|[^A-Za-z0-9À-ɏ])\d+(?:[.,]\d+)?\s?(?:ms|s|min)(?![A-Za-z0-9À-ɏ])/

/**
 * The text already states a duration («… empezó a razonar · 3,2 s», «400 ms»):
 * a finished row then shows no second, differently measured one.
 */
export function mentionsDuration(text: string | null | undefined): boolean {
  return typeof text === "string" && DURATION_MENTION_RE.test(text)
}

/** A bare «Pensando…» carries no information — the loader may rotate its fallback phrases. */
export function isGenericThinkingLabel(label: string | null | undefined): boolean {
  const text = String(label || "").replace(/\s+/g, " ").trim()
  if (!text) return true
  return /^(pensando|thinking)(…|\.\.\.)?$/i.test(text)
}

const MAX_HEADLINE = 120

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[#*_`>~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The model's current line of thought: first sentence of the last non-empty
 * paragraph of the live reasoning, markdown stripped, ≤120 chars.
 */
export function latestReasoningHeadline(reasoning: string | null | undefined): string {
  if (typeof reasoning !== "string" || !reasoning.trim()) return ""
  const paragraphs = reasoning.split(/\n\s*\n/)
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const clean = stripMarkdown(paragraphs[i])
    if (!clean) continue
    const match = clean.match(/^.*?[.!?…](?=\s|$)/)
    const sentence = (match ? match[0] : clean).trim()
    return sentence.length > MAX_HEADLINE ? `${sentence.slice(0, MAX_HEADLINE - 1).trimEnd()}…` : sentence
  }
  return ""
}

const SENTINEL_OPEN_RE = /^\s*```agent-task-state[^\n]*\n/

/**
 * The answer carries the agentic ```agent-task-state sentinel: AgenticSteps
 * renders the loop and owns the live status line of this turn.
 */
export function hasAgentSentinel(content: string | null | undefined): boolean {
  return typeof content === "string" && SENTINEL_OPEN_RE.test(content)
}

/** The visible answer text: the leading ```agent-task-state sentinel block is not prose. */
export function answerTextForCounter(content: string | null | undefined): string {
  const text = typeof content === "string" ? content : ""
  const open = text.match(SENTINEL_OPEN_RE)
  if (!open) return text
  const rest = text.slice(open[0].length)
  const close = rest.search(/(^|\n)```[ \t]*(\n|$)/)
  if (close === -1) return ""
  const after = rest.slice(close).replace(/^\n?```[ \t]*\n?/, "")
  return after.replace(/^\s+/, "")
}
