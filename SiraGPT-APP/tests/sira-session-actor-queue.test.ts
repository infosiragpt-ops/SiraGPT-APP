import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const {
  createSessionActorQueue,
  buildChatTurnActorKey,
} = require(path.join(
  process.cwd(),
  "backend/src/services/sira/session-actor-queue.js",
))
const {
  handleChatTurn,
} = require(path.join(
  process.cwd(),
  "backend/src/services/sira/chat-controller.js",
))
const {
  createInMemoryStorage,
  createSiraStorage,
} = require(path.join(
  process.cwd(),
  "backend/src/services/sira/storage-schema.js",
))

const flushQueue = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("sira session actor queue", () => {
  it("serializes work for the same chat actor", async () => {
    const queue = createSessionActorQueue()
    const events: string[] = []
    let releaseFirst: () => void = () => {}

    const first = queue.run("chat:1", async () => {
      events.push("first:start")
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push("first:end")
      return "first"
    })
    const second = queue.run("chat:1", async () => {
      events.push("second:start")
      return "second"
    })

    await flushQueue()
    assert.deepEqual(events, ["first:start"])
    assert.equal(queue.getPendingCountForActor("chat:1"), 2)

    releaseFirst()
    assert.equal(await first, "first")
    assert.equal(await second, "second")
    await flushQueue()
    assert.deepEqual(events, ["first:start", "first:end", "second:start"])
    assert.equal(queue.getPendingCountForActor("chat:1"), 0)
    assert.equal(queue.snapshot().active_actors, 0)
  })

  it("does not block independent chat actors", async () => {
    const queue = createSessionActorQueue()
    const events: string[] = []
    let releaseFirst: () => void = () => {}

    const first = queue.run("chat:1", async () => {
      events.push("first:start")
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push("first:end")
    })
    const second = queue.run("chat:2", async () => {
      events.push("second:start")
      return "second"
    })

    await flushQueue()
    assert.deepEqual(events, ["first:start", "second:start"])
    assert.equal(await second, "second")
    releaseFirst()
    await first
  })

  it("routes chat controller turns through the actor queue key", async () => {
    const seenKeys: string[] = []
    const storage = createSiraStorage({
      adapter: createInMemoryStorage(),
      idFactory: (prefix: string) => `${prefix}_test_${seenKeys.length}_${Date.now()}`,
    })
    const sessionQueue = {
      async run(actorKey: string, op: () => Promise<unknown>) {
        seenKeys.push(actorKey)
        return op()
      },
    }

    const result = await handleChatTurn({
      conversationId: "Conv A",
      userId: "User 1",
      userMessage: "crea un documento word profesional sobre marketing",
      selectedModel: { provider: "test", modelId: "model-a" },
      dryRun: true,
    }, { storage, sessionQueue })

    assert.equal(result.stage, "delivered")
    assert.deepEqual(seenKeys, [
      buildChatTurnActorKey({ conversationId: "Conv A", userId: "User 1" }),
    ])
  })
})
