---
name: LaTeX bracket-delimiter normalization
description: Why LLM math (\( \) / \[ \]) needs pre-parse string normalization, not a remark plugin
---

# LaTeX bracket delimiters in chat markdown

LLMs frequently emit math with TeX bracket delimiters `\( ... \)` (inline) and
`\[ ... \]` (display). `remark-math` only recognizes `$...$` / `$$...$$`, so
bracket math renders as literal text unless converted.

**Rule:** convert bracket delimiters to dollar delimiters with a *string
preprocessor that runs BEFORE react-markdown/remark parse* — not a remark/rehype
transformer.

**Why:** CommonMark parsing strips the backslash in `\(` during tokenization, so
by the time any remark transformer runs the marker is already gone — a plugin can
never reliably see `\(`. A previous attempt at a remark transformer
(`remark-bracket-math`) failed for exactly this reason and was deleted.

**How to apply:**
- The helper lives in `lib/markdown/normalize-math.ts` (`normalizeMathDelimiters`).
- It splits on a code-region regex (fenced ``` / ~~~ and inline `` ` ``) and only
  transforms non-code segments, so code samples containing `\(` are untouched.
- It is idempotent and a no-op when no brackets are present (cheap fast path).
- Wire it at the render chokepoint: `MessageContent` normalizes the `content` prop
  once (useMemo) — this covers direct ReactMarkdown, the streaming head/tail split
  (`splitStableHead`), and `MemoMarkdownBlock`. `MemoMarkdownBlock` also normalizes
  defensively for reuse elsewhere; the double pass is safe because it's idempotent.
- Conversion order matters: display `\[...\]`→`$$...$$` first, then inline
  `\(...\)`→`$...$`.
