/**
 * remark plugin: a "heading" that is really a paragraph (models sometimes
 * wrap a whole one-paragraph answer in `#`/`**…**` heading syntax) renders
 * as body text instead of a giant title. Headings are demoted when their
 * plain text is longer than `maxChars` (default 160) — real headings are
 * short; a 300-character "heading" is a paragraph wearing a hat.
 */

type Node = { type: string; depth?: number; children?: Node[]; value?: string; data?: unknown }

function textOf(node: Node): string {
  if (typeof node.value === "string") return node.value
  return (node.children || []).map(textOf).join("")
}

export function demoteOverlongHeadings(tree: Node, maxChars = 160): number {
  let demoted = 0
  const visit = (node: Node) => {
    if (!node || !Array.isArray(node.children)) return
    for (const child of node.children) {
      if (child.type === "heading" && textOf(child).trim().length > maxChars) {
        child.type = "paragraph"
        delete child.depth
        delete child.data
        demoted += 1
      }
      visit(child)
    }
  }
  visit(tree)
  return demoted
}

export function remarkDemoteOverlongHeadings(options: { maxChars?: number } = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Number(options.maxChars) : 160
  return (tree: Node) => {
    demoteOverlongHeadings(tree, maxChars)
  }
}

export default remarkDemoteOverlongHeadings
