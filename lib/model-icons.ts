type ModelIconInput = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
  icon?: string | null
  type?: string | null
}

const has = (value: string, pattern: RegExp) => pattern.test(value)

export function resolveModelIconName(model: ModelIconInput | null | undefined): string {
  if (!model) return "Bot"

  const modelName = String(model.name || "").toLowerCase()
  const displayName = String(model.displayName || "").toLowerCase()
  const provider = String(model.provider || "").toLowerCase()
  const explicitIcon = model.icon || undefined
  const searchable = `${modelName} ${displayName}`

  if (has(searchable, /(^|[/\s-])(gpt|chatgpt|dall[-\s]?e)\b|openai\//)) return "ChatGPTLogo"
  if (has(searchable, /gemini|google\/|imagen|veo/)) return "GeminiLogo"
  if (has(searchable, /claude|anthropic\//)) return "ClaudeLogo"
  if (has(searchable, /grok|x-ai\//)) return "GrokLogo"
  if (has(searchable, /deepseek/)) return "DeepseekLogo"
  if (has(searchable, /kimi|moonshot/)) return "KimiLogo"
  if (has(searchable, /\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/)) return "ZaiLogo"
  if (has(searchable, /seedream|bytedance|doubao/)) return "SeedreamLogo"
  if (has(searchable, /qwen|alibaba/)) return "QwenLogo"
  if (has(searchable, /llama|meta-llama|meta\//)) return "MetaLogo"
  if (has(searchable, /mistral|codestral/)) return "MistralLogo"

  if (explicitIcon && explicitIcon !== "OpenRouterLogo") return explicitIcon
  if (provider.includes("openai")) return "ChatGPTLogo"
  if (provider.includes("gemini") || provider.includes("google")) return "GeminiLogo"
  if (provider.includes("anthropic")) return "ClaudeLogo"
  if (provider.includes("deepseek")) return "DeepseekLogo"
  if (provider.includes("xai") || provider.includes("x-ai")) return "GrokLogo"
  if (provider.includes("openrouter")) return "OpenRouterLogo"

  return explicitIcon || "Bot"
}
