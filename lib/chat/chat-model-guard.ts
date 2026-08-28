export const DEEPSEEK_FLASH = "deepseek-v4-flash"
export const DEEPSEEK_PRO = "deepseek-v4-pro"
export const DEEPSEEK_PROVIDER = "DeepSeek"

export const NON_CHAT_VIDEO_MESSAGE =
  "Este modelo es para video. Elige DeepSeek V4 Flash o Pro para chatear."
export const NON_CHAT_IMAGE_MESSAGE =
  "Este modelo es para imagen. Elige DeepSeek V4 Flash o Pro para chatear."
export const NON_CHAT_AUDIO_MESSAGE =
  "Este modelo es para audio. Elige DeepSeek V4 Flash o Pro para chatear."
export const GREETING_NOT_VIDEO_MESSAGE =
  "Un saludo no genera video. Escribe qué video quieres crear, o elige DeepSeek V4 Flash o Pro para chatear."

const GREETING_RE =
  /^(?:[¿¡]\s*)?(hola+|hello|hi|hey|holi|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|que\s+tal|como\s+estas|como\s+vas|como\s+andas|gracias|muchas\s+gracias|ok(?:ay)?|vale|si|no)[\s.!?¿¡,]*$/i

const VIDEO_INTENT_RE =
  /\b(video|clip|reel|tiktok|animaci[oó]n|text-to-video|image-to-video|reference-to-video|seedance)\b/i

const IMAGE_INTENT_RE =
  /\b(imagen|image|photo|foto|picture|dibujo|logo|ilustraci[oó]n|render)\b/i

const AUDIO_INTENT_RE =
  /\b(audio|voz|voice|tts|m[uú]sica|cancion|canci[oó]n|speech|podcast)\b/i

export type ChatTurnAction = "chat" | "media" | "reject_media"

export type ChatTurnDecision = {
  action: ChatTurnAction
  name: string
  provider: string
  disableAgentic: boolean
  remapped: boolean
  message?: string
  kind?: "video" | "image" | "audio"
}

export type ChatModelLike = {
  name?: string
  displayName?: string
  provider?: string
  type?: string
  kind?: string
}

function normalizePrompt(prompt: string): string {
  return String(prompt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function bareModelName(name?: string): string {
  const raw = String(name || "").trim().toLowerCase()
  return raw.includes("/") ? raw.split("/").pop() || raw : raw
}

function blobFor(model?: string | ChatModelLike | null): string {
  if (!model) return ""
  if (typeof model === "string") return model.toLowerCase()
  return `${model.name || ""} ${model.displayName || ""} ${model.provider || ""} ${model.type || ""} ${model.kind || ""}`.toLowerCase()
}

function modelType(model?: string | ChatModelLike | null): string {
  if (!model || typeof model === "string") return ""
  return String(model.type || model.kind || "").trim().toUpperCase()
}

export function isGreetingChatPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  return GREETING_RE.test(normalized)
}

export function isAllowedChatModel(model?: string | ChatModelLike | null): boolean {
  const name = typeof model === "string" ? model : model?.name
  const bare = bareModelName(name)
  return bare === DEEPSEEK_FLASH || bare === DEEPSEEK_PRO || bare === "deepseek-v4-pro" || bare === "deepseek-v4-flash"
}

export function isNonChatVideoModel(model?: string | ChatModelLike | null): boolean {
  const type = modelType(model)
  if (type === "VIDEO") return true
  const blob = blobFor(model)
  if (!blob) return false
  return /video|text-to-video|image-to-video|reference-to-video|seedance|kling|sora|veo|pixverse|hailuo|ltx|wan\/|fal\.ai|fal-ai/i.test(blob)
}

export function isNonChatImageModel(model?: string | ChatModelLike | null): boolean {
  const type = modelType(model)
  if (type === "IMAGE") return true
  const blob = blobFor(model)
  if (!blob) return false
  if (isNonChatVideoModel(model)) return false
  return /image|imagen|dall|seedream|flux|midjourney|ideogram|gpt-image|recraft/i.test(blob)
}

export function isNonChatAudioModel(model?: string | ChatModelLike | null): boolean {
  const type = modelType(model)
  if (type === "AUDIO" || type === "VOICE" || type === "MUSIC") return true
  const blob = blobFor(model)
  if (!blob) return false
  if (isNonChatVideoModel(model) || isNonChatImageModel(model)) return false
  return /\b(tts|elevenlabs|lyria|suno|speech|voice|music)\b/i.test(blob)
}

export function isNonChatMediaModel(model?: string | ChatModelLike | null): boolean {
  return isNonChatVideoModel(model) || isNonChatImageModel(model) || isNonChatAudioModel(model)
}

export function mediaKindForModel(model?: string | ChatModelLike | null): "video" | "image" | "audio" | null {
  if (isNonChatVideoModel(model)) return "video"
  if (isNonChatImageModel(model)) return "image"
  if (isNonChatAudioModel(model)) return "audio"
  return null
}

function rejectMessage(kind: "video" | "image" | "audio"): string {
  if (kind === "image") return NON_CHAT_IMAGE_MESSAGE
  if (kind === "audio") return NON_CHAT_AUDIO_MESSAGE
  return NON_CHAT_VIDEO_MESSAGE
}

function pickChatModel(selectedModel?: string): { name: string; provider: string; remapped: boolean } {
  const wanted = String(selectedModel || "").trim()
  const bare = bareModelName(wanted)
  if (bare === DEEPSEEK_PRO) return { name: DEEPSEEK_PRO, provider: DEEPSEEK_PROVIDER, remapped: false }
  if (bare === DEEPSEEK_FLASH) return { name: DEEPSEEK_FLASH, provider: DEEPSEEK_PROVIDER, remapped: false }
  return { name: DEEPSEEK_FLASH, provider: DEEPSEEK_PROVIDER, remapped: true }
}

function hasMediaIntent(prompt: string, kind: "video" | "image" | "audio"): boolean {
  const normalized = normalizePrompt(prompt)
  if (kind === "video") return VIDEO_INTENT_RE.test(normalized)
  if (kind === "image") return IMAGE_INTENT_RE.test(normalized)
  return AUDIO_INTENT_RE.test(normalized)
}

/**
 * Route a /agentes turn so greetings never enter video/image/audio jobs
 * and never call a non-chat model. Chat models Luis allows: DeepSeek Flash/Pro.
 */
export function resolveChatTurnModel(input: {
  selectedModel?: string
  provider?: string
  prompt?: string
  model?: ChatModelLike | null
} = {}): ChatTurnDecision {
  const selectedModel = String(input.selectedModel || input.model?.name || "").trim()
  const provider = String(input.provider || input.model?.provider || "").trim()
  const prompt = String(input.prompt || "")
  const model = input.model || { name: selectedModel, provider }
  const kind = mediaKindForModel(model)
  const greeting = isGreetingChatPrompt(prompt)

  if (greeting) {
    const chat = pickChatModel(selectedModel)
    return {
      action: "chat",
      name: chat.name,
      provider: chat.provider,
      disableAgentic: true,
      remapped: chat.remapped || Boolean(kind),
    }
  }

  if (kind) {
    if (hasMediaIntent(prompt, kind)) {
      return {
        action: "media",
        name: selectedModel,
        provider: provider || "fal.ai",
        disableAgentic: true,
        remapped: false,
        kind,
      }
    }
    return {
      action: "reject_media",
      name: selectedModel,
      provider: provider || "",
      disableAgentic: true,
      remapped: false,
      kind,
      message: rejectMessage(kind),
    }
  }

  if (isAllowedChatModel(selectedModel)) {
    const chat = pickChatModel(selectedModel)
    return {
      action: "chat",
      name: chat.name,
      provider: DEEPSEEK_PROVIDER,
      disableAgentic: false,
      remapped: false,
    }
  }

  return {
    action: "chat",
    name: selectedModel,
    provider: provider || DEEPSEEK_PROVIDER,
    disableAgentic: false,
    remapped: false,
  }
}
