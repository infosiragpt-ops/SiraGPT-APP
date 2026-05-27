type ModelIconInput = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
  icon?: string | null
  type?: string | null
}

const has = (value: string, pattern: RegExp) => pattern.test(value)
const normalize = (value: string | null | undefined) => String(value || "").trim()
const normalizedSearchText = (model: ModelIconInput) => {
  const modelName = normalize(model.name).replace(/^~/, "")
  const displayName = normalize(model.displayName)
  const provider = normalize(model.provider)
  const icon = normalize(model.icon)
  return `${modelName} ${displayName} ${provider} ${icon}`.toLowerCase()
}

export const MODEL_PROVIDER_ORDER = [
  "OpenAI",
  "Anthropic",
  "Google",
  "xAI",
  "DeepSeek",
  "Moonshot AI",
  "Qwen",
  "Meta",
  "Mistral AI",
  "NVIDIA",
  "Poolside",
  "Z.ai",
  "ByteDance Seed",
  "Groq",
  "Ollama",
  "OpenRouter",
  "Otros",
] as const

export function resolveModelProviderName(model: ModelIconInput | null | undefined): string {
  if (!model) return "Otros"

  const searchable = normalizedSearchText(model)
  const provider = normalize(model.provider)

  if (has(searchable, /openai\/|(^|[/\s-])(gpt|chatgpt|dall[-\s]?e)\b/)) return "OpenAI"
  if (has(searchable, /anthropic\/|claude/)) return "Anthropic"
  if (has(searchable, /google\/|gemini|gemma|imagen|veo|lyria/)) return "Google"
  if (has(searchable, /x-ai\/|\bxai\b|grok/)) return "xAI"
  if (has(searchable, /deepseek/)) return "DeepSeek"
  if (has(searchable, /moonshotai\/|moonshot|kimi/)) return "Moonshot AI"
  if (has(searchable, /qwen\/|qwen|alibaba/)) return "Qwen"
  if (has(searchable, /ollama/)) return "Ollama"
  if (has(searchable, /meta-llama\/|meta\/|llama/)) return "Meta"
  if (has(searchable, /mistralai\/|mistral|codestral/)) return "Mistral AI"
  if (has(searchable, /nvidia\/|nvidia|nemotron/)) return "NVIDIA"
  if (has(searchable, /poolside\/|poolside|laguna/)) return "Poolside"
  if (has(searchable, /\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/)) return "Z.ai"
  if (has(searchable, /bytedance-seed\/|seedream|bytedance|doubao/)) return "ByteDance Seed"

  if (provider) return provider
  return "Otros"
}

export function compareModelProviders(a: string, b: string): number {
  const ia = MODEL_PROVIDER_ORDER.indexOf(a as (typeof MODEL_PROVIDER_ORDER)[number])
  const ib = MODEL_PROVIDER_ORDER.indexOf(b as (typeof MODEL_PROVIDER_ORDER)[number])

  if (ia === -1 && ib === -1) return a.localeCompare(b)
  if (ia === -1) return 1
  if (ib === -1) return -1
  return ia - ib
}

export function resolveProviderIconName(provider: string | null | undefined): string {
  const name = normalize(provider)
  if (!name) return "Bot"

  return resolveModelIconName({
    name,
    displayName: name,
    provider: name,
  })
}

export function resolveModelIconName(model: ModelIconInput | null | undefined): string {
  if (!model) return "Bot"

  const provider = normalize(model.provider).toLowerCase()
  const explicitIcon = model.icon || undefined
  const searchable = normalizedSearchText(model)

  if (has(searchable, /(^|[/\s-])(gpt|chatgpt|dall[-\s]?e)\b|openai\//)) return "ChatGPTLogo"
  if (has(searchable, /gemini|google\/|imagen|veo/)) return "GeminiLogo"
  if (has(searchable, /claude|anthropic\//)) return "ClaudeLogo"
  if (has(searchable, /grok|x-ai\//)) return "GrokLogo"
  if (has(searchable, /deepseek/)) return "DeepseekLogo"
  if (has(searchable, /kimi|moonshot/)) return "KimiLogo"
  if (has(searchable, /\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/)) return "ZaiLogo"
  if (has(searchable, /seedream|bytedance|doubao/)) return "SeedreamLogo"
  if (has(searchable, /qwen|alibaba/)) return "QwenLogo"
  if (has(searchable, /ollama/)) return "OllamaLogo"
  if (has(searchable, /llama|meta-llama|meta\//)) return "MetaLogo"
  if (has(searchable, /mistral|codestral/)) return "MistralLogo"
  if (has(searchable, /nvidia|nemotron/)) return "NvidiaLogo"
  if (has(searchable, /poolside|laguna/)) return "PoolsideLogo"

  if (explicitIcon && explicitIcon !== "OpenRouterLogo") return explicitIcon
  if (provider.includes("openai")) return "ChatGPTLogo"
  if (provider.includes("gemini") || provider.includes("google")) return "GeminiLogo"
  if (provider.includes("anthropic")) return "ClaudeLogo"
  if (provider.includes("deepseek")) return "DeepseekLogo"
  if (provider.includes("xai") || provider.includes("x-ai")) return "GrokLogo"
  if (provider.includes("qwen") || provider.includes("alibaba")) return "QwenLogo"
  if (provider.includes("moonshot") || provider.includes("kimi")) return "KimiLogo"
  if (provider.includes("meta")) return "MetaLogo"
  if (provider.includes("mistral")) return "MistralLogo"
  if (provider.includes("nvidia")) return "NvidiaLogo"
  if (provider.includes("poolside")) return "PoolsideLogo"
  if (provider.includes("ollama")) return "OllamaLogo"
  if (provider.includes("openrouter")) return "OpenRouterLogo"

  return explicitIcon || "Bot"
}
