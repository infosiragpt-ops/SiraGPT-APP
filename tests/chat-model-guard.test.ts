import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  DEEPSEEK_PROVIDER,
  GREETING_NOT_VIDEO_MESSAGE,
  NON_CHAT_VIDEO_MESSAGE,
  isGreetingChatPrompt,
  isNonChatMediaModel,
  isNonChatVideoModel,
  resolveChatTurnModel,
} from "../lib/chat/chat-model-guard"

const SEEDANCE = {
  name: "bytedance/seedance-2.0/text-to-video",
  displayName: "Seedance 2.0 Text to Video",
  provider: "fal.ai",
  type: "VIDEO",
}

describe("chat-model-guard · greetings", () => {
  for (const prompt of ["hola", "Hola!", "hi", "gracias", "ok", "qué tal", "Que tal"]) {
    it(`treats "${prompt}" as a greeting`, () => {
      assert.equal(isGreetingChatPrompt(prompt), true)
    })
  }

  it("does not treat a video request as a greeting", () => {
    assert.equal(isGreetingChatPrompt("créame un video de un gato"), false)
  })
})

describe("chat-model-guard · non-chat models", () => {
  it("flags Seedance and other video ids as non-chat", () => {
    assert.equal(isNonChatVideoModel(SEEDANCE), true)
    assert.equal(isNonChatMediaModel(SEEDANCE.name), true)
    assert.equal(isNonChatMediaModel("fal-ai/kling-video/v3/pro/text-to-video"), true)
    assert.equal(isNonChatMediaModel({ name: "deepseek-v4-flash", type: "TEXT" }), false)
  })
})

describe("chat-model-guard · /agentes turn routing", () => {
  it("sends hola on Seedance to DeepSeek Flash, never the video job", () => {
    const turn = resolveChatTurnModel({
      selectedModel: SEEDANCE.name,
      provider: SEEDANCE.provider,
      prompt: "hola",
      model: SEEDANCE,
    })
    assert.equal(turn.action, "chat")
    assert.equal(turn.name, DEEPSEEK_FLASH)
    assert.equal(turn.provider, DEEPSEEK_PROVIDER)
    assert.equal(turn.disableAgentic, true)
    assert.equal(turn.remapped, true)
  })

  it("keeps DeepSeek Pro when the user picked Pro and says hola", () => {
    const turn = resolveChatTurnModel({
      selectedModel: "deepseek/deepseek-v4-pro",
      provider: "DeepSeek",
      prompt: "hola",
    })
    assert.equal(turn.action, "chat")
    assert.equal(turn.name, DEEPSEEK_PRO)
    assert.equal(turn.provider, DEEPSEEK_PROVIDER)
    assert.equal(turn.disableAgentic, true)
  })

  it("remaps a greeting on Kimi/OpenRouter to DeepSeek Flash", () => {
    const turn = resolveChatTurnModel({
      selectedModel: "moonshotai/kimi-k2.6",
      provider: "OpenRouter",
      prompt: "hola",
    })
    assert.equal(turn.action, "chat")
    assert.equal(turn.name, DEEPSEEK_FLASH)
    assert.equal(turn.provider, DEEPSEEK_PROVIDER)
    assert.equal(turn.remapped, true)
  })

  it("rejects a chat-only prompt on Seedance without starting a video job", () => {
    const turn = resolveChatTurnModel({
      selectedModel: SEEDANCE.name,
      provider: "fal.ai",
      prompt: "explícame la fotosíntesis",
      model: SEEDANCE,
    })
    assert.equal(turn.action, "reject_media")
    assert.equal(turn.kind, "video")
    assert.equal(turn.message, NON_CHAT_VIDEO_MESSAGE)
  })

  it("lets a real video prompt stay on Seedance", () => {
    const turn = resolveChatTurnModel({
      selectedModel: SEEDANCE.name,
      provider: "fal.ai",
      prompt: "crea un video de un gato en la playa",
      model: SEEDANCE,
    })
    assert.equal(turn.action, "media")
    assert.equal(turn.name, SEEDANCE.name)
    assert.equal(turn.kind, "video")
  })

  it("exposes the Spanish greeting-vs-video copy", () => {
    assert.match(GREETING_NOT_VIDEO_MESSAGE, /saludo no genera video/i)
  })
})
