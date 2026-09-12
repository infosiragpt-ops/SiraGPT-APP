import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

/**
 * Regression guards for the media-catalog loading path of the composer
 * (Imágenes / Voz / Video / Música chips).
 *
 * Production symptom: with the Video chip on, the composer refetched
 * `/api/ai/models?type=VIDEO` in a loop, because the activation effect
 * listed the catalog array (replaced by every fetch) and the selected model
 * in its own dependency list. Each iteration bypassed the HTTP cache and
 * made the backend re-sync 51 manifest rows — the "models load slowly"
 * report. These source-level checks pin the shape of the fix.
 */
const chatSource = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const apiSource = readFileSync("lib/api.ts", "utf8")

function videoActivationEffect(): string {
  const start = chatSource.indexOf("if (!isVideoGenerationActive && chatType !== 'video') return;")
  assert.ok(start > 0, "video activation effect must exist")
  const end = chatSource.indexOf("]);", start)
  return chatSource.slice(start, end + 3)
}

describe("composer media catalog — no refetch loop, one request per activation", () => {
  it("the VIDEO activation effect does not depend on the state it updates", () => {
    const effect = videoActivationEffect()
    const deps = effect.slice(effect.lastIndexOf("}, ["))
    assert.match(deps, /\[chatType, isVideoGenerationActive, refreshVideoModels\]/)
    assert.doesNotMatch(deps, /videoCatalogModels\b/)
    assert.doesNotMatch(deps, /selectedVideoModel\b/)
    // The selection reconciles through a functional update + a ref mirror,
    // so neither value has to be a dependency.
    assert.match(effect, /setSelectedVideoModel\(\(current\) =>/)
    assert.match(effect, /videoCatalogModelsRef\.current\.length > 0/)
  })

  it("refreshVideoModels keeps the ref mirror in sync with the state", () => {
    const start = chatSource.indexOf("const refreshVideoModels = React.useCallback(async () => {")
    assert.ok(start > 0)
    const body = chatSource.slice(start, chatSource.indexOf("}, []);", start))
    assert.match(body, /videoCatalogModelsRef\.current = models;/)
    assert.match(body, /setVideoCatalogModels\(models\);/)
  })

  it("the IMAGE activation effect stays loop-free too", () => {
    const start = chatSource.indexOf("if (!isImageGenerationActive && chatType !== 'image') return;")
    assert.ok(start > 0)
    const effect = chatSource.slice(start, chatSource.indexOf("]);", start) + 3)
    const deps = effect.slice(effect.lastIndexOf("}, ["))
    assert.match(deps, /\[chatType, isImageGenerationActive, refreshImageModels\]/)
  })

  it("apiClient.getAIModels coalesces concurrent identical reads without memoising", () => {
    const start = apiSource.indexOf("async getAIModels(")
    assert.ok(start > 0)
    const body = apiSource.slice(start, apiSource.indexOf("\n  }\n", start))
    assert.match(body, /this\._aiModelsInFlight\.get\(endpoint\)/)
    assert.match(body, /this\._aiModelsInFlight\.set\(endpoint, pending\)/)
    assert.match(body, /\.finally\(/, "the in-flight slot is released on settle")
    assert.match(body, /'Cache-Control': 'no-cache'/, "still a live read: admin activations show immediately")
    assert.doesNotMatch(body, /ttl|expiresAt|Date\.now\(\)/, "no client-side TTL memo")
    assert.match(apiSource, /private _aiModelsInFlight = new Map<string, Promise<any>>\(\);/)
  })
})
