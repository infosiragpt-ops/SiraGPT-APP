"use client"

// AI Service for multiple providers
export interface AIProvider {
  name: string
  models: string[]
  generateText: (prompt: string, model: string, apiKey: string) => Promise<string>
}

class OpenAIProvider implements AIProvider {
  name = "OpenAI"
  models = ["gpt-4", "gpt-3.5-turbo"]

  async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`)
      }

      const data = await response.json()
      return data.choices[0].message.content
    } catch (error) {
      console.error("OpenAI API error:", error)
      return "I apologize, but I'm having trouble connecting to OpenAI right now. Please try again later."
    }
  }
}

class AnthropicProvider implements AIProvider {
  name = "Anthropic"
  models = ["claude-3-opus", "claude-3-sonnet"]

  async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.statusText}`)
      }

      const data = await response.json()
      return data.content[0].text
    } catch (error) {
      console.error("Anthropic API error:", error)
      return "I apologize, but I'm having trouble connecting to Claude right now. Please try again later."
    }
  }
}

class GroqProvider implements AIProvider {
  name = "Groq"
  models = ["llama2-70b-4096", "mixtral-8x7b-32768"]

  async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
        }),
      })

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.statusText}`)
      }

      const data = await response.json()
      return data.choices[0].message.content
    } catch (error) {
      console.error("Groq API error:", error)
      return "I apologize, but I'm having trouble connecting to Groq right now. Please try again later."
    }
  }
}

// Simulated providers for demo
class SimulatedProvider implements AIProvider {
  name: string
  models: string[]

  constructor(name: string, models: string[]) {
    this.name = name
    this.models = models
  }

  async generateText(prompt: string, model: string): Promise<string> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000))

    const responses = [
      `Hello! I'm ${this.name} (${model}). I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.`,
      `That's an interesting question! As ${this.name}, I can help you with that. Let me provide you with a comprehensive answer.`,
      `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.`,
      `I'd be happy to help you with that inquiry. Based on my knowledge as ${this.name}, here's what I can tell you.`,
      `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.`,
    ]

    return responses[Math.floor(Math.random() * responses.length)]
  }
}

export class AIService {
  private providers: Map<string, AIProvider> = new Map()
  private apiKeys: Map<string, string> = new Map()

  constructor() {
    // Initialize providers
    this.providers.set("ChatGPT", new OpenAIProvider())
    this.providers.set("Claude", new AnthropicProvider())
    this.providers.set("Grok", new GroqProvider())
    this.providers.set("DeepSeek", new SimulatedProvider("DeepSeek", ["deepseek-chat", "deepseek-coder"]))
    this.providers.set("Gemini", new SimulatedProvider("Gemini", ["gemini-pro", "gemini-pro-vision"]))
  }

  setApiKey(provider: string, apiKey: string) {
    this.apiKeys.set(provider, apiKey)
  }

  async generateResponse(provider: string, model: string, prompt: string): Promise<string> {
    const aiProvider = this.providers.get(provider)
    if (!aiProvider) {
      throw new Error(`Provider ${provider} not found`)
    }

    const apiKey = this.apiKeys.get(provider) || ""

    // For demo purposes, use simulated responses if no API key
    if (!apiKey && (provider === "ChatGPT" || provider === "Claude" || provider === "Grok")) {
      const simulatedProvider = new SimulatedProvider(provider, aiProvider.models)
      return simulatedProvider.generateText(prompt, model)
    }

    return aiProvider.generateText(prompt, model, apiKey)
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  getModelsForProvider(provider: string): string[] {
    const aiProvider = this.providers.get(provider)
    return aiProvider ? aiProvider.models : []
  }
}

export const aiService = new AIService()
