/**
 * Nested file tree from coding-sandbox listFiles entries.
 */

export type FileTreeNode = {
  name: string
  path: string
  kind: "file" | "dir"
  children?: FileTreeNode[]
}

export type CodingFileLike = {
  path: string
  size?: number
}

export function buildFileTree(files: CodingFileLike[]): FileTreeNode[] {
  const root: FileTreeNode[] = []

  for (const file of files) {
    const rel = String(file.path || "").replace(/^\/+/, "").trim()
    if (!rel || rel === ".") continue
    const parts = rel.split("/").filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) continue
    const dirList = parts.length === 0 ? root : walkDirs(root, parts)
    dirList.push({
      name: fileName,
      path: rel,
      kind: "file",
    })
  }

  return sortTree(root)
}

function walkDirs(root: FileTreeNode[], parts: string[]): FileTreeNode[] {
  let current = root
  let prefix = ""
  for (const name of parts) {
    prefix = prefix ? `${prefix}/${name}` : name
    let node = current.find((item) => item.name === name && item.kind === "dir")
    if (!node) {
      node = { name, path: prefix, kind: "dir", children: [] }
      current.push(node)
    } else {
      node.path = prefix
      node.children = node.children || []
    }
    current = node.children as FileTreeNode[]
  }
  return current
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  const copy = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of copy) {
    if (node.children) node.children = sortTree(node.children)
  }
  return copy
}

const LANGUAGE_ALIAS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  htm: "html",
  py: "python",
  go: "go",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
}

export function languageFromPath(filePath: string): string {
  const base = String(filePath || "").split("/").pop() || ""
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : ""
  return LANGUAGE_ALIAS[ext] || "plaintext"
}
