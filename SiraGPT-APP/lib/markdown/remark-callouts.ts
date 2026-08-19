import { visit } from "unist-util-visit"

/**
 * remark-callouts — turns `:::note` / `:::warning` / `:::tip` /
 * `:::info` / `:::caution` container directives into a controlled
 * `<aside class="callout callout-{kind}" role="note">…</aside>`
 * shape that the rehype-sanitize schema in `markdown-sanitize.ts`
 * already whitelists.
 *
 * Why a curated allowlist (not a generic directive→tag mapping):
 *   The chat content stream is LLM output. A generic mapping would
 *   let a model emit `:::script` and slip arbitrary tags through.
 *   Restricting to five known kinds keeps the surface tight: any
 *   unknown directive is left as a no-op (no rendered output, no
 *   thrown error, just dropped).
 *
 * Usage with react-markdown:
 *   <ReactMarkdown
 *     remarkPlugins={[remarkGfm, remarkMath, remarkDirective, remarkCallouts]}
 *     rehypePlugins={markdownRehypePlugins}>
 *
 * Authoring:
 *   :::note
 *   Heads up about something subtle.
 *   :::
 *
 *   :::warning
 *   This action is irreversible.
 *   :::
 */

const ALLOWED_KINDS = new Set([
  "note",
  "warning",
  "tip",
  "info",
  "caution",
])

type DirectiveNode = {
  type: "containerDirective" | "leafDirective" | "textDirective"
  name: string
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

export function remarkCallouts() {
  return function transformer(tree: unknown) {
    visit(tree as any, (node: DirectiveNode) => {
      // Only container directives become callouts. Leaf and text
      // directives are intentionally ignored — `:::note` is the only
      // form we render today.
      if (node.type !== "containerDirective") return
      if (!ALLOWED_KINDS.has(node.name)) return

      const data = (node.data ||= {})
      data.hName = "aside"
      data.hProperties = {
        className: ["callout", `callout-${node.name}`],
        role: "note",
        "data-callout-kind": node.name,
      }
    })
  }
}

export const CALLOUT_KINDS = Array.from(ALLOWED_KINDS)
