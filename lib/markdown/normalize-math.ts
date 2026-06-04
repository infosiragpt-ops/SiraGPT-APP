// Many LLMs emit LaTeX using TeX bracket delimiters — `\( ... \)` for inline
// math and `\[ ... \]` for display math — instead of the `$ ... $` / `$$ ... $$`
// dollar delimiters that `remark-math` understands. CommonMark treats `\(` as an
// escaped `(`, so the backslash is stripped during parsing and a remark
// transformer never sees it. The conversion therefore has to happen on the raw
// markdown string *before* it reaches react-markdown.
//
// `normalizeMathDelimiters` rewrites the bracket forms into dollar delimiters
// while leaving fenced code blocks and inline code spans untouched, so code
// samples that legitimately contain `\(` or `\[` are preserved. It is a no-op
// when no bracket delimiters are present and is idempotent (already-converted
// `$ ... $` text contains no `\(` to match), so applying it more than once on
// the same content is safe.

// Capturing group so `String.prototype.split` keeps the code regions in the
// result array (they land on odd indices and are passed through verbatim):
//   1. ``` fenced ``` blocks
//   2. ~~~ fenced ~~~ blocks
//   3. `inline code` spans (single line)
const CODE_REGION = /(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g

function convertBracketMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([^\n]+?)\\\)/g, (_match, body: string) => `$${body}$`)
}

export function normalizeMathDelimiters(input: string): string {
  if (typeof input !== "string") return input
  if (!input.includes("\\(") && !input.includes("\\[")) return input

  const parts = input.split(CODE_REGION)
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]) parts[i] = convertBracketMath(parts[i])
  }
  return parts.join("")
}
