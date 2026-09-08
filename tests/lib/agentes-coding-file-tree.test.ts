import { describe, expect, it } from "vitest"

import { applyMapHints, buildFileTree, languageFromPath } from "@/lib/agentes-coding/file-tree"

describe("agentes-coding file tree", () => {
  it("nests paths and sorts directories first", () => {
    const tree = buildFileTree([
      { path: "z.ts" },
      { path: "src/app.ts" },
      { path: "src/lib/util.ts" },
    ])
    expect(tree.map((node) => node.name)).toEqual(["src", "z.ts"])
    expect(tree[0].kind).toBe("dir")
    expect(tree[0].children?.map((node) => node.name)).toEqual(["lib", "app.ts"])
    expect(tree[0].children?.[0].children?.[0]).toMatchObject({
      name: "util.ts",
      path: "src/lib/util.ts",
      kind: "file",
    })
  })

  it("maps extensions to Monaco language ids", () => {
    expect(languageFromPath("src/app.tsx")).toBe("typescript")
    expect(languageFromPath("README.md")).toBe("markdown")
    expect(languageFromPath("notes")).toBe("plaintext")
  })

  it("applyMapHints attaches scores to files and max to dirs", () => {
    const tree = buildFileTree([{ path: "src/app.ts" }, { path: "z.ts" }])
    const scored = applyMapHints(tree, [
      { path: "src/app.ts", score: 0.9 },
      { path: "z.ts", score: 0.2 },
    ])
    expect(scored.find((node) => node.name === "src")?.score).toBe(0.9)
    expect(scored[0].children?.[0]).toMatchObject({ path: "src/app.ts", score: 0.9 })
  })
})
