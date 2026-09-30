/**
 * Repairs the still-growing tail of a streaming markdown answer before it is
 * parsed, so half-written constructs don't flash as raw text: an unclosed
 * `**bold`, a half-typed `[link](https://exa`, or a table header row that has
 * no `|---|` delimiter yet. Only the live tail goes through here; the final
 * message is always rendered from the untouched source.
 */

const FENCE_LINE = /^\s*(`{3,}|~{3,})/
const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

export function repairStreamingTail(tail: string): string {
  if (!tail) return tail
  const lines = tail.split("\n")

  // Inside an open fenced block: the code renderer already copes; leave it.
  if (lines.filter((line) => FENCE_LINE.test(line)).length % 2 === 1) return tail

  // A trailing pipe-table block without its delimiter row is not a table yet.
  let end = lines.length
  while (end > 0 && /^\s*\|/.test(lines[end - 1])) end--
  if (end < lines.length) {
    const block = lines.slice(end)
    if (!block.some((line) => TABLE_DELIMITER_ROW.test(line))) lines.length = end
  }
  if (lines.length === 0) return ""

  let last = lines[lines.length - 1]
  // Drop an in-flight link or image at the end of the last line.
  last = last.replace(/!?\[[^\]\n]*\]\([^)\s]*$/, "").replace(/!?\[[^\]\n]*$/, "")

  // Balance markers, ignoring complete inline code spans and a list bullet.
  const scan = last.replace(/`[^`]*`/g, "").replace(/^\s*[*+-]\s+/, "")
  const ticks = (scan.match(/`/g) || []).length
  if (ticks % 2 === 1) {
    last += "`"
  } else if ((scan.match(/\*\*/g) || []).length % 2 === 1 && !/\*\*\s*$/.test(last)) {
    last += "**"
  }
  lines[lines.length - 1] = last
  return lines.join("\n")
}
