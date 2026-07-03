import { describe, expect, it } from "vitest"

import {
  IMAGE_WRAP_MAX_BYTES,
  assetKindFor,
  destPathForUpload,
  formatBytes,
  groupWorkspaceAssets,
  imageWrapperSvg,
  planUpload,
  totalAssetBytes,
} from "@/lib/code-agent/workspace-assets"

describe("groupWorkspaceAssets", () => {
  const files = {
    "src/App.tsx": { content: "x".repeat(400) },
    "src/main.tsx": { content: "y".repeat(100) },
    "src/index.css": { content: "z".repeat(50) },
    "public/logo.svg": { content: "<svg/>" },
    "data/rows.csv": { content: "a,b\n1,2" },
    "README.md": { content: "# hi" },
  }

  it("groups by kind with sizes, ordered images-first", () => {
    const groups = groupWorkspaceAssets(files)
    expect(groups.map((g) => g.kind)).toEqual(["image", "code", "style", "data", "doc"])
    const code = groups.find((g) => g.kind === "code")!
    expect(code.files.map((f) => f.path)).toEqual(["src/App.tsx", "src/main.tsx"]) // size desc
    expect(code.bytes).toBe(500)
    expect(totalAssetBytes(groups)).toBe(400 + 100 + 50 + 6 + 7 + 4)
  })

  it("tolerates empty/invalid input and plain strings", () => {
    expect(groupWorkspaceAssets(null)).toEqual([])
    expect(groupWorkspaceAssets({})).toEqual([])
    const groups = groupWorkspaceAssets({ "a.css": "body{}" })
    expect(groups[0].kind).toBe("style")
  })

  it("classifies extensions", () => {
    expect(assetKindFor("x/y.png")).toBe("image")
    expect(assetKindFor("schema.prisma")).toBe("data")
    expect(assetKindFor("notes.txt")).toBe("doc")
    expect(assetKindFor("Makefile")).toBe("other")
  })
})

describe("formatBytes", () => {
  it("formats B/KB/MB", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
    expect(formatBytes(-1)).toBe("0 B")
  })
})

describe("destPathForUpload", () => {
  it("sanitises names into public/", () => {
    expect(destPathForUpload("Mi Logo (1).SVG", [])).toBe("public/mi-logo-1.svg")
  })

  it("avoids collisions with numeric suffixes", () => {
    const existing = ["public/logo.svg", "public/logo-2.svg"]
    expect(destPathForUpload("logo.svg", existing)).toBe("public/logo-3.svg")
  })
})

describe("planUpload", () => {
  it("routes text-like files to write-text", () => {
    expect(planUpload({ name: "styles.css", type: "text/css", size: 10 }, []).action).toBe("write-text")
    expect(planUpload({ name: "data.json", type: "application/json", size: 10 }, []).action).toBe("write-text")
    expect(planUpload({ name: "icon.svg", type: "image/svg+xml", size: 10 }, []).action).toBe("write-text")
  })

  it("wraps small raster images and rejects large ones", () => {
    const small = planUpload({ name: "photo.png", type: "image/png", size: 1000 }, [])
    expect(small.action).toBe("wrap-image")
    if (small.action === "wrap-image") expect(small.path.endsWith(".png.svg")).toBe(true)

    const large = planUpload({ name: "big.png", type: "image/png", size: IMAGE_WRAP_MAX_BYTES + 1 }, [])
    expect(large.action).toBe("register-only")
  })

  it("registers unsupported binaries", () => {
    expect(planUpload({ name: "video.mp4", type: "video/mp4", size: 10 }, []).action).toBe("register-only")
  })
})

describe("imageWrapperSvg", () => {
  it("embeds the data-url and escapes quotes", () => {
    const svg = imageWrapperSvg('data:image/png;base64,AAA"BBB')
    expect(svg).toContain("<svg xmlns=")
    expect(svg).toContain("&quot;BBB")
    expect(svg).not.toContain('AAA"BBB')
  })
})
