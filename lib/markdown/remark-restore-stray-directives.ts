import { SKIP, visit } from "unist-util-visit"

/**
 * remark-restore-stray-directives — `remark-directive` is in the chat
 * pipeline only for `:::note`-style callouts, but it also reads every
 * `:name` in prose as a text directive: «a las 16:44» became «a las 16» plus
 * an empty directive `44` that rendered as a stray block (the minutes gone,
 * the paragraph broken into small lines). Same for «9:00», «2:1», «Juan 3:16».
 *
 * Every text or leaf directive the callout transform did not claim goes back
 * to the exact characters the model wrote. Container directives keep their
 * existing behaviour (only the allowlisted callouts render).
 */

type DirectiveNode = {
  type: string
  name?: string
  data?: { hName?: string }
  children?: Array<{ type: string; value?: string }>
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

function labelText(node: DirectiveNode): string {
  return (node.children || []).map((child) => (typeof child.value === "string" ? child.value : "")).join("")
}

function originalText(node: DirectiveNode, source: string): string {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start === "number" && typeof end === "number" && end > start && end <= source.length) {
    return source.slice(start, end)
  }
  const marker = node.type === "leafDirective" ? "::" : ":"
  const label = labelText(node)
  return `${marker}${node.name || ""}${label ? `[${label}]` : ""}`
}

export function remarkRestoreStrayDirectives() {
  return function transformer(tree: unknown, file?: { value?: unknown }) {
    const source = typeof file?.value === "string" ? file.value : String(file?.value ?? "")
    visit(tree as any, (node: DirectiveNode, index: number | undefined, parent: { children: unknown[] } | undefined) => {
      if (!parent || index === undefined) return
      if (node.type !== "textDirective" && node.type !== "leafDirective") return
      if (node.data?.hName) return
      const text = { type: "text", value: originalText(node, source) }
      parent.children.splice(index, 1, node.type === "leafDirective" ? { type: "paragraph", children: [text] } : text)
      return [SKIP, index + 1]
    })
  }
}
