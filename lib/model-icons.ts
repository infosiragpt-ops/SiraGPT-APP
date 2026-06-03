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
  "fal.ai",
  "Kling AI",
  "PixVerse",
  "MiniMax",
  "Wan",
  "LTX",
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
  if (has(searchable, /groq\/|\bgroq\b/)) return "Groq"
  if (has(searchable, /nvidia\/|nvidia|nemotron/)) return "NVIDIA"
  if (has(searchable, /poolside\/|poolside|laguna/)) return "Poolside"
  if (has(searchable, /meta-llama\/|meta\/|llama/)) return "Meta"
  if (has(searchable, /mistralai\/|mistral|codestral/)) return "Mistral AI"
  if (has(searchable, /\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/)) return "Z.ai"
  if (has(searchable, /bytedance-seed\/|seedream|bytedance|doubao/)) return "ByteDance Seed"
  if (has(searchable, /fal\.ai|fal-ai\//)) return "fal.ai"
  if (has(searchable, /kling/)) return "Kling AI"
  if (has(searchable, /pixverse/)) return "PixVerse"
  if (has(searchable, /minimax|hailuo/)) return "MiniMax"
  if (has(searchable, /\bwan\b|wan\//)) return "Wan"
  if (has(searchable, /\bltx\b|ltx-/)) return "LTX"

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

export function resolveModelAttributionName(model: ModelIconInput | null | undefined): string {
  if (!model) return "Otros"

  const provider = normalize(model.provider)
  const searchable = normalizedSearchText(model)
  const icon = resolveModelIconName(model)

  if (has(searchable, /\bgem+?a\b|gema4|gemma/)) return provider || "OpenRouter"

  switch (icon) {
    case "ChatGPTLogo":
    case "ChatGPTPinkLogo":
      return "OpenAI"
    case "ClaudeLogo":
      return "Anthropic"
    case "GeminiLogo":
      return "Google"
    case "GoogleLogo":
      return "Google"
    case "GrokLogo":
      return "xAI"
    case "DeepseekLogo":
      return "DeepSeek"
    case "KimiLogo":
      return "Moonshot AI"
    case "ZaiLogo":
      return "Z.ai"
    case "QwenLogo":
      return "Qwen"
    case "MetaLogo":
      return "Meta"
    case "MistralLogo":
      return "Mistral AI"
    case "NvidiaLogo":
      return "NVIDIA"
    case "PoolsideLogo":
      return "Poolside"
    case "OllamaLogo":
      return "Ollama"
    case "OpenRouterLogo":
      return "OpenRouter"
    case "SeedreamLogo":
      return "ByteDance Seed"
    case "FalLogo":
      return "fal.ai"
    case "SoraLogo":
      return "OpenAI"
    case "KlingLogo":
      return "Kling AI"
    case "ByteDanceLogo":
      return "ByteDance Seed"
    case "PixverseLogo":
      return "PixVerse"
    case "MinimaxLogo":
      return "MiniMax"
    case "WanLogo":
      return "Wan"
    case "LtxLogo":
      return "LTX"
    case "MessageSquare":
      return has(searchable, /grok|x-ai|\bxai\b/) ? "xAI" : "Groq"
    default:
      return provider || "Otros"
  }
}

export function resolveModelIconName(model: ModelIconInput | null | undefined): string {
  if (!model) return "Bot"

  const provider = normalize(model.provider).toLowerCase()
  const explicitIcon = model.icon || undefined
  const searchable = normalizedSearchText(model)

  // SiraGPT "Gema" brand uses the Google "G" logo. Checked before the
  // gpt/openai pattern because the underlying model id may be an OpenAI one
  // (e.g. gpt-4o-mini) which would otherwise win. `\bgema\b` matches "gema"
  // / "gema 4" without matching "gemma" (Google's open model, double m) or
  // "gemini", so those keep their own logos.
  if (has(searchable, /\bgema\b/)) return "GoogleLogo"
  if (explicitIcon && [
    "ChatGPTLogo",
    "GeminiLogo",
    "GrokLogo",
    "QwenLogo",
    "NvidiaLogo",
    "FalLogo",
    "SoraLogo",
    "KlingLogo",
    "ByteDanceLogo",
    "PixverseLogo",
    "MinimaxLogo",
    "WanLogo",
    "LtxLogo",
  ].includes(explicitIcon)) return explicitIcon
  if (has(searchable, /sora/)) return "SoraLogo"
  if (has(searchable, /kling/)) return "KlingLogo"
  if (has(searchable, /pixverse/)) return "PixverseLogo"
  if (has(searchable, /minimax|hailuo/)) return "MinimaxLogo"
  if (has(searchable, /\bwan\b|wan\//)) return "WanLogo"
  if (has(searchable, /\bltx\b|ltx-/)) return "LtxLogo"
  if (has(searchable, /bytedance|seedance|doubao/)) return "ByteDanceLogo"
  if (has(searchable, /(^|[/\s-])(gpt|chatgpt|dall[-\s]?e)\b|openai\//)) return "ChatGPTLogo"
  if (has(searchable, /gemini|google\/|imagen|veo/)) return "GeminiLogo"
  if (has(searchable, /claude|anthropic\//)) return "ClaudeLogo"
  if (has(searchable, /grok|x-ai\//)) return "GrokLogo"
  if (has(searchable, /deepseek/)) return "DeepseekLogo"
  if (has(searchable, /kimi|moonshot/)) return "KimiLogo"
  if (has(searchable, /\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/)) return "ZaiLogo"
  if (has(searchable, /seedream/)) return "SeedreamLogo"
  if (has(searchable, /qwen|alibaba/)) return "QwenLogo"
  if (has(searchable, /ollama/)) return "OllamaLogo"
  if (has(searchable, /groq\/|\bgroq\b/)) return "MessageSquare"
  if (has(searchable, /nvidia|nemotron/)) return "NvidiaLogo"
  if (has(searchable, /poolside|laguna/)) return "PoolsideLogo"
  if (has(searchable, /llama|meta-llama|meta\//)) return "MetaLogo"
  if (has(searchable, /mistral|codestral/)) return "MistralLogo"
  if (has(searchable, /fal\.ai|fal-ai\//)) return "FalLogo"

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
  if (provider.includes("groq")) return "MessageSquare"
  if (provider.includes("openrouter")) return "OpenRouterLogo"
  if (provider.includes("fal.ai") || provider.includes("fal")) return "FalLogo"

  return explicitIcon || "Bot"
}
