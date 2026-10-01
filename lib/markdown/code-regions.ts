// Small lexical guard for transformations that run before the markdown parser.
// It does not parse markdown; it protects code bytes from prose-only rewrites.
export type MarkdownFence = { marker: string; length: number }

export function openingCodeFence(line: string): MarkdownFence | null {
  const match = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null
  return { marker: match[1][0], length: match[1].length }
}

export function closesCodeFence(line: string, fence: MarkdownFence): boolean {
  const match = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*\r?$/.exec(line)
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length)
}

export function hasOpenCodeFence(content: string): boolean {
  let fence: MarkdownFence | null = null
  for (const line of content.split("\n")) {
    if (fence) {
      if (closesCodeFence(line, fence)) fence = null
    } else {
      fence = openingCodeFence(line)
    }
  }
  return fence !== null
}

function transformOutsideCodeSpans(text: string, transform: (prose: string) => string): string {
  const runs = Array.from(text.matchAll(/`+/g))
  // The next run with the exact same length closes a code span. Precompute it
  // in one pass so long malformed input does not trigger quadratic searches.
  const nextSame: Array<number | undefined> = []
  const byLength = new Map<number, number>()
  for (let i = runs.length - 1; i >= 0; i--) {
    nextSame[i] = byLength.get(runs[i][0].length)
    byLength.set(runs[i][0].length, i)
  }
  let cursor = 0
  let output = ""
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i].index!
    let escapes = 0
    for (let p = start - 1; p >= 0 && text[p] === "\\"; p--) escapes++
    if (escapes % 2 === 1 || nextSame[i] === undefined) continue
    const closing = nextSame[i]!
    const end = runs[closing].index! + runs[closing][0].length
    output += transform(text.slice(cursor, start)) + text.slice(start, end)
    cursor = end
    i = closing
  }
  return output + transform(text.slice(cursor))
}

export function transformOutsideCode(content: string, transform: (prose: string) => string): string {
  let fence: MarkdownFence | null = null
  let fenceStart = 0
  let cursor = 0
  let offset = 0
  let output = ""
  for (const line of content.split(/(?<=\n)/)) {
    const withoutNewline = line.replace(/\r?\n$/, "")
    if (fence) {
      if (closesCodeFence(withoutNewline, fence)) {
        output += content.slice(fenceStart, offset + line.length)
        cursor = offset + line.length
        fence = null
      }
    } else {
      fence = openingCodeFence(withoutNewline)
      if (fence) {
        output += transformOutsideCodeSpans(content.slice(cursor, offset), transform)
        fenceStart = offset
      }
    }
    offset += line.length
  }
  // An unfinished fence is still code while streaming. Preserve it verbatim.
  return output + (fence ? content.slice(fenceStart) : transformOutsideCodeSpans(content.slice(cursor), transform))
}
