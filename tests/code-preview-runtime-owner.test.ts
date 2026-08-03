import assert from "node:assert/strict"
import test from "node:test"

import {
  previewRuntimeStopUrl,
  samePreviewRuntimeOwner,
  stopPreviewRuntimeOwner,
  stopPreviewRuntimeOwnerKeepalive,
  transitionPreviewRuntimeOwner,
  type PreviewRuntimeOwner,
  type PreviewRuntimeStops,
} from "../lib/code-preview-runtime-owner"

function stopRecorder() {
  const calls: string[] = []
  const stops: PreviewRuntimeStops = {
    codex: (id) => calls.push(`codex:${id}`),
    github: (id) => calls.push(`github:${id}`),
    host: (id) => calls.push(`host:${id}`),
  }
  return { calls, stops }
}

test("switching Codex project A to B stops A only", async () => {
  const { calls, stops } = stopRecorder()
  const next = await transitionPreviewRuntimeOwner(
    { kind: "codex", id: "project-a" },
    { kind: "codex", id: "project-b" },
    stops,
  )

  assert.deepEqual(calls, ["codex:project-a"])
  assert.deepEqual(next, { kind: "codex", id: "project-b" })
})

test("switching a host run to Codex stops the host only", async () => {
  const { calls, stops } = stopRecorder()
  await transitionPreviewRuntimeOwner(
    { kind: "host", id: "host-run" },
    { kind: "codex", id: "project-b" },
    stops,
  )

  assert.deepEqual(calls, ["host:host-run"])
})

test("restarting the same owner does not stop its active runtime", async () => {
  const { calls, stops } = stopRecorder()
  const owner: PreviewRuntimeOwner = { kind: "github", id: "repo-1" }
  await transitionPreviewRuntimeOwner(owner, owner, stops)

  assert.equal(samePreviewRuntimeOwner(owner, { kind: "github", id: "repo-1" }), true)
  assert.deepEqual(calls, [])
})

test("pagehide cleanup targets the exact current owner and uses keepalive", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const owner: PreviewRuntimeOwner = { kind: "codex", id: "project-b" }
  await stopPreviewRuntimeOwnerKeepalive(owner, {
    apiBaseUrl: "https://api.example.test/api/",
    bearerToken: "test-token",
    csrfToken: null,
    fetchImpl: (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 204 })
    }) as typeof fetch,
  })

  assert.equal(previewRuntimeStopUrl(owner, "https://api.example.test/api/"), "https://api.example.test/api/codex/projects/project-b/preview/stop")
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "https://api.example.test/api/codex/projects/project-b/preview/stop")
  assert.equal(requests[0]?.init?.method, "POST")
  assert.equal(requests[0]?.init?.keepalive, true)
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), "Bearer test-token")
})

test("explicit owner stop never consults a global project", async () => {
  const { calls, stops } = stopRecorder()
  await stopPreviewRuntimeOwner({ kind: "github", id: "repo-exact" }, stops)
  assert.deepEqual(calls, ["github:repo-exact"])
})
