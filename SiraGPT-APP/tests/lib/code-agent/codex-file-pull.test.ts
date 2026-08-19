import { describe, expect, it } from "vitest"

import { pullProjectFiles, type CodexFileReader } from "@/lib/code-agent/codex-file-pull"

const reader = (fn: (path: string, call: number) => { content?: string } | Error): CodexFileReader => {
  const calls = new Map<string, number>()
  return {
    async readFileContent(_projectId, path) {
      const n = (calls.get(path) ?? 0) + 1
      calls.set(path, n)
      const out = fn(path, n)
      if (out instanceof Error) throw out
      return out
    },
  }
}

describe("pullProjectFiles", () => {
  it("recovers transient failures with one sequential retry", async () => {
    const api = reader((path, call) =>
      path === "b.ts" && call === 1 ? new Error("blip") : { content: `x-${path}` },
    )
    const r = await pullProjectFiles(api, "p", ["a.ts", "b.ts", "c.ts"])
    expect(r.failed).toEqual([])
    expect(r.files).toHaveLength(3)
  })

  it("reports persistently unreadable paths", async () => {
    const api = reader((path) => (path === "b.ts" ? new Error("down") : { content: "x" }))
    const r = await pullProjectFiles(api, "p", ["a.ts", "b.ts", "c.ts"])
    expect(r.failed).toEqual(["b.ts"])
    expect(r.files).toHaveLength(2)
  })

  it("skips empty-content files without counting them as failures", async () => {
    const api = reader((path) => ({ content: path === "e.ts" ? "" : "x" }))
    const r = await pullProjectFiles(api, "p", ["a.ts", "e.ts"])
    expect(r.failed).toEqual([])
    expect(r.files).toHaveLength(1)
  })

  it("returns every path as failed when the backend is down", async () => {
    const api = reader(() => new Error("down"))
    const r = await pullProjectFiles(api, "p", ["a.ts", "b.ts"])
    expect(r.failed).toHaveLength(2)
    expect(r.files).toHaveLength(0)
  })
})
