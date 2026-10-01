// Many LLMs emit LaTeX using TeX bracket delimiters — `\( ... \)` for inline
// math and `\[ ... \]` for display math — instead of the `$ ... $` / `$$ ... $$`
// dollar delimiters that `remark-math` understands. CommonMark treats `\(` as an
// escaped `(`, so the backslash is stripped during parsing and a remark
// transformer never sees it. The conversion therefore has to happen on the raw
// markdown string *before* it reaches react-markdown.
//
// `normalizeMathDelimiters` does three things, always leaving fenced code
// blocks and inline code spans untouched (code samples that legitimately
// contain `\(`, `\[` or `$` are preserved):
//   1. escapes currency dollars (`$10 y $20`) so single-dollar math does not
//      swallow ordinary prose between two prices;
//   2. turns a whole-line `\[ … \]` or `$$ … $$` into a real display block
//      (`$$` alone on its own lines) — remark-math parses a one-line `$$…$$`
//      as inline math;
//   3. rewrites the remaining bracket forms into dollar delimiters.
// It is a no-op when there is nothing to rewrite and is idempotent, so
// applying it more than once on the same content is safe.

import { transformOutsideCode } from "./code-regions"

const BLOCK_LINE = (_m: string, ind: string, body: string) =>
  `${ind}$$\n${ind}${body.trim()}\n${ind}$$`

function convertBracketMath(text: string): string {
  return (
    text
      // A whole-line \[ … \] or $$ … $$ must become a real display block ($$
      // alone on its own lines), otherwise remark-math parses it as inline math.
      .replace(/^([ \t]*)\\\[([^\n]+?)\\\][ \t]*$/gm, BLOCK_LINE)
      .replace(/^([ \t]*)\$\$([^$\n]+)\$\$[ \t]*$/gm, BLOCK_LINE)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `$$${body}$$`)
      // Trim the body: `\(5 \)` → `$5 $` would read as a price on a second
      // pass (the streaming head is normalized twice) and lose its math.
      .replace(/\\\(([^\n]+?)\\\)/g, (_match, body: string) => `$${body.trim() || body}$`)
  )
}

// Pandoc rule: a `$` right before a digit is a currency sign, not an opening
// math delimiter, when the next `$` on the same line is missing, has
// whitespace before it or is followed by a digit ("$10 y $20", "$10-$20").
// Real math like `$2x$` or `$3 + 4$` is left alone. Runs before the bracket
// conversion so only dollars the model typed are considered.
function escapeCurrencyDollars(text: string): string {
  if (!text.includes("$")) return text
  return text
    .split("\n")
    .map((line) =>
      line.replace(/\$(?=\d)/g, (m: string, i: number) => {
        if (i > 0 && /[\\$]/.test(line[i - 1])) return m
        const next = line.indexOf("$", i + 1)
        return next === -1 || /\s/.test(line[next - 1]) || /\d/.test(line[next + 1] ?? "")
          ? "\\$"
          : m
      }),
    )
    .join("\n")
}

export function normalizeMathDelimiters(input: string): string {
  if (typeof input !== "string") return input
  if (!input.includes("\\(") && !input.includes("\\[") && !input.includes("$")) return input

  return transformOutsideCode(input, (prose) => convertBracketMath(escapeCurrencyDollars(prose)))
}
