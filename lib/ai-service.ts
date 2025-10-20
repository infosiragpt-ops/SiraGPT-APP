// "use client"

// // AI Service for multiple providers
// export interface AIProvider {
//   name: string
//   models: string[]
//   generateText: (prompt: string, model: string, apiKey: string) => Promise<string>
//   generateImage?: (prompt: string, model: string, apiKey: string) => Promise<string> // Image generation ke liye naya function

// }

// class OpenAIProvider implements AIProvider {
//   name = "OpenAI"
//   models = ["gpt-4", "gpt-3.5-turbo"]

//   async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
//     try {
//       const response = await fetch("https://api.openai.com/v1/chat/completions", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${apiKey}`,
//         },
//         body: JSON.stringify({
//           model: model,
//           messages: [{ role: "user", content: prompt }],
//           max_tokens: 1000,
//         }),
//       })

//       console.log(response);


//       if (!response.ok) {
//         throw new Error(`OpenAI API error: ${response.statusText}`)
//       }

//       const data = await response.json()
//       return data.choices[0].message.content
//     } catch (error) {
//       console.error("OpenAI API error:", error)
//       return "I apologize, but I'm having trouble connecting to OpenAI right now. Please try again later."
//     }
//   }

//   async generateImage(prompt: string, model: string, apiKey: string): Promise<string> {
//     try {
//       const response = await fetch("https://api.openai.com/v1/images/generations", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${apiKey}`,
//         },
//         body: JSON.stringify({
//           model: model,
//           prompt: prompt,
//           n: 1,
//           size: "1024x1024",
//         }),
//       })

//       if (!response.ok) {
//         throw new Error(`OpenAI Image API error: ${response.statusText}`)
//       }

//       const data = await response.json()
//       return data.data[0].url // Generate ki gayi image ka URL lautayein
//     } catch (error) {
//       console.error("OpenAI Image API error:", error)
//       return "Maaf kijiye, abhi OpenAI se image banane mein samasya aa rahi hai. Kripya baad mein prayas karein."
//     }
//   }
// }

// class AnthropicProvider implements AIProvider {
//   name = "Anthropic"
//   models = ["claude-3-opus", "claude-3-sonnet"]

//   async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
//     try {
//       const response = await fetch("https://api.anthropic.com/v1/messages", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           "x-api-key": apiKey,
//           "anthropic-version": "2023-06-01",
//         },
//         body: JSON.stringify({
//           model: model,
//           max_tokens: 1000,
//           messages: [{ role: "user", content: prompt }],
//         }),
//       })

//       if (!response.ok) {
//         throw new Error(`Anthropic API error: ${response.statusText}`)
//       }

//       const data = await response.json()
//       return data.content[0].text
//     } catch (error) {
//       console.error("Anthropic API error:", error)
//       return "I apologize, but I'm having trouble connecting to Claude right now. Please try again later."
//     }
//   }
// }

// class GroqProvider implements AIProvider {
//   name = "Groq"
//   models = ["llama2-70b-4096", "mixtral-8x7b-32768"]

//   async generateText(prompt: string, model: string, apiKey: string): Promise<string> {
//     try {
//       const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${apiKey}`,
//         },
//         body: JSON.stringify({
//           model: model,
//           messages: [{ role: "user", content: prompt }],
//           max_tokens: 1000,
//         }),
//       })

//       if (!response.ok) {
//         throw new Error(`Groq API error: ${response.statusText}`)
//       }

//       const data = await response.json()
//       return data.choices[0].message.content
//     } catch (error) {
//       console.error("Groq API error:", error)
//       return "I apologize, but I'm having trouble connecting to Groq right now. Please try again later."
//     }
//   }
// }

// // Simulated providers for demo
// class SimulatedProvider implements AIProvider {
//   name: string
//   models: string[]

//   constructor(name: string, models: string[]) {
//     this.name = name
//     this.models = models
//   }

//   async generateText(prompt: string, model: string): Promise<string> {
//     // Simulate API delay
//     await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000))

//     const responses = [
//       `Hello! I'm ${this.name} (${model}). I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.`,
//       `That's an interesting question! As ${this.name}, I can help you with that. Let me provide you with a comprehensive answer.`,
//       `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.`,
//       `I'd be happy to help you with that inquiry. Based on my knowledge as ${this.name}, here's what I can tell you.`,
//       `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.`,
//     ]

//     return responses[Math.floor(Math.random() * responses.length)]
//   }
// }

// export class AIService {
//   private providers: Map<string, AIProvider> = new Map()
//   private apiKeys: Map<string, string> = new Map()

//   constructor() {
//     // Initialize providers
//     this.providers.set("ChatGPT", new OpenAIProvider())
//     this.providers.set("Claude", new AnthropicProvider())
//     this.providers.set("Grok", new GroqProvider())
//     this.providers.set("DeepSeek", new SimulatedProvider("DeepSeek", ["deepseek-chat", "deepseek-coder"]))
//     this.providers.set("Gemini", new SimulatedProvider("Gemini", ["gemini-pro", "gemini-pro-vision"]))
//   }

//   setApiKey(provider: string, apiKey: string) {
//     this.apiKeys.set(provider, apiKey)
//   }

//   async generateResponse(provider: string, model: string, prompt: string): Promise<string> {
//     const aiProvider = this.providers.get(provider)
//     if (!aiProvider) {
//       throw new Error(`Provider ${provider} not found`)
//     }

//     const apiKey = this.apiKeys.get(provider) || ""

//     // For demo purposes, use simulated responses if no API key
//     if (!apiKey && (provider === "ChatGPT" || provider === "Claude" || provider === "Grok")) {
//       const simulatedProvider = new SimulatedProvider(provider, aiProvider.models)
//       return simulatedProvider.generateText(prompt, model)
//     }

//     return aiProvider.generateText(prompt, model, apiKey)
//   }


//   async generateImageResponse(provider: string, model: string, prompt: string): Promise<string> {
//     const aiProvider = this.providers.get(provider)
//     if (!aiProvider || !aiProvider.generateImage) {
//       throw new Error(`Provider ${provider} image generation ko support nahi karta.`)
//     }

//     const apiKey = this.apiKeys.get(provider) || ""
//     return aiProvider.generateImage(prompt, model, apiKey)
//   }


//   getAvailableProviders(): string[] {
//     return Array.from(this.providers.keys())
//   }

//   getModelsForProvider(provider: string): string[] {
//     const aiProvider = this.providers.get(provider)
//     return aiProvider ? aiProvider.models : []
//   }

//   getImageModelsForProvider(provider: string): string[] {
//     const aiProvider = this.providers.get(provider)
//     // TypeScript ko yeh batane ke liye ki 'imageModels' maujood ho sakta hai, ek type cast ka istemal karein
//     const providerWithImageModels = aiProvider as any;
//     return providerWithImageModels?.imageModels ? providerWithImageModels.imageModels : []
//   }
// }

// export const aiService = new AIService()


"use client"

// Enhanced AI Service with real API integration
export interface AIProvider {
  name: string
  models: string[]
  generateText: (prompt: string, model: string, apiKey: string, files?: any[]) => Promise<AIResponse>
  generateImage?: (prompt: string, apiKey: string) => Promise<string>
}

export interface AIResponse {
  content: string
  images?: string[]
  tokens?: number
}

class OpenAIProvider implements AIProvider {
  name = "OpenAI"
  models = ["gpt-4", "gpt-3.5-turbo", "gpt-4-vision-preview"]

  async generateText(prompt: string, model: string, apiKey: string, files?: any[]): Promise<AIResponse> {
    try {
      const messages: any[] = []

      // Add file context if files are provided
      if (files && files.length > 0) {
        const fileContext = files.map(file => {
          if (file.extractedText) {
            return `File: ${file.name}\nContent: ${file.extractedText}`
          }
          return `File: ${file.name} (${file.type})`
        }).join('\n\n')

        messages.push({
          role: "system",
          content: `You have access to the following files:\n\n${fileContext}\n\nUse this information to answer the user's questions.`
        })
      }

      // Add user message with image support
      const userMessage: any = {
        role: "user",
        content: []
      }

      // Add text content
      userMessage.content.push({
        type: "text",
        text: prompt
      })

      // Add images if present
      if (files) {
        files.forEach(file => {
          if (file.type?.startsWith('image/') && file.url) {
            userMessage.content.push({
              type: "image_url",
              image_url: {
                url: file.url
              }
            })
          }
        })
      }

      messages.push(userMessage)

      const response = await fetch("/api/proxy/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model === "gpt-4-vision-preview" ? "gpt-4-vision-preview" : model,
          messages: messages,
          max_tokens: 2000,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`)
      }

      const data = await response.json()
      return {
        content: data.choices[0].message.content,
        tokens: data.usage?.total_tokens
      }
    } catch (error) {
      console.error("OpenAI API error:", error)
      return {
        content: "I apologize, but I'm having trouble connecting to OpenAI right now. Please check your API key and try again.",
        tokens: 0
      }
    }
  }

  async generateImage(prompt: string, apiKey: string): Promise<string> {
    try {
      console.log("generateImage ai.ts", apiKey);

      const response = await fetch("/api/proxy/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({

          model: "dall-e-3",
          prompt: prompt,
          n: 1,
          size: "1024x1024",
        }),
      })


      if (!response.ok) {
        throw new Error(`OpenAI Image API error: ${response.statusText}`)
      }

      const data = await response.json()
      console.log(data.data[0].url, "generateImage");

      return data.data[0].url
    } catch (error) {
      console.error("OpenAI Image API error:", error)
      throw error
    }
  }
}

class AnthropicProvider implements AIProvider {
  name = "Anthropic"
  models = ["claude-3-opus", "claude-3-sonnet", "claude-3-haiku"]

  async generateText(prompt: string, model: string, apiKey: string, files?: any[]): Promise<AIResponse> {
    try {
      let fullPrompt = prompt

      // Add file context
      if (files && files.length > 0) {
        const fileContext = files.map(file => {
          if (file.extractedText) {
            return `File: ${file.name}\nContent: ${file.extractedText}`
          }
          return `File: ${file.name} (${file.type})`
        }).join('\n\n')

        fullPrompt = `Context from uploaded files:\n\n${fileContext}\n\nUser question: ${prompt}`
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2000,
          messages: [{ role: "user", content: fullPrompt }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.statusText}`)
      }

      const data = await response.json()
      return {
        content: data.content[0].text,
        tokens: data.usage?.input_tokens + data.usage?.output_tokens
      }
    } catch (error) {
      console.error("Anthropic API error:", error)
      return {
        content: "I apologize, but I'm having trouble connecting to Claude right now. Please check your API key and try again.",
        tokens: 0
      }
    }
  }
}

// Enhanced AI Service
export class AIService {
  private providers: Map<string, AIProvider> = new Map()
  private apiKeys: Map<string, string> = new Map()

  constructor() {
    this.providers.set("ChatGPT", new OpenAIProvider())
    this.providers.set("Claude", new AnthropicProvider())

    // Load API keys from environment or localStorage
    this.loadApiKeys()
  }

  private loadApiKeys() {
    // Try to load from environment first
    if (typeof window !== 'undefined') {
      const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY
      const anthropicKey = localStorage.getItem('anthropic_api_key') || process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY

      if (openaiKey) this.apiKeys.set("ChatGPT", openaiKey)
      if (anthropicKey) this.apiKeys.set("Claude", anthropicKey)
    }
  }

  setApiKey(provider: string, apiKey: string) {
    this.apiKeys.set(provider, apiKey)
    if (typeof window !== 'undefined') {
      localStorage.setItem(`${provider.toLowerCase()}_api_key`, apiKey)
    }
  }

  async generateResponse(provider: string, model: string, prompt: string, files?: any[]): Promise<AIResponse> {
    const aiProvider = this.providers.get(provider)
    if (!aiProvider) {
      throw new Error(`Provider ${provider} not found`)
    }

    const apiKey = this.apiKeys.get(provider)
    if (!apiKey) {
      return {
        content: `Please set your ${provider} API key in settings to use this model.`,
        tokens: 0
      }
    }

    return aiProvider.generateText(prompt, model, apiKey, files)
  }

  async generateImage(provider: string, prompt: string): Promise<string> {
    const aiProvider = this.providers.get(provider)
    if (!aiProvider?.generateImage) {
      throw new Error(`Image generation not supported for ${provider}`)
    }

    const apiKey = "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"
    if (!apiKey) {
      throw new Error(`API key not set for ${provider}`)
    }

    return aiProvider.generateImage(prompt, apiKey)
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  getModelsForProvider(provider: string): string[] {
    const aiProvider = this.providers.get(provider)
    return aiProvider ? aiProvider.models : []
  }

  hasApiKey(provider: string): boolean {
    return this.apiKeys.has(provider)
  }

  async classifyIntent(prompt: string): Promise<string> {
    const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY
    if (!apiKey) {
      console.error("OpenAI API key not found for intent classification.");
      // Fallback to basic keyword matching if API key is not available
      const lowerCasePrompt = prompt.toLowerCase();
      
      // Check for web development keywords first
      if (/\b(website|webpage|web app|html|css|javascript|react|vue|angular|code|programming|developer|portfolio|frontend|backend|component|build.*website|create.*website|design.*website|landing page)\b/i.test(prompt)) {
        return 'webdev';
      }
      
      // Then check for other content types
      if (/\b(generate.*image|create.*image|draw|illustration|artwork|logo|graphic|picture|photo)\b/i.test(prompt)) return 'image';
      if (/\b(generate.*video|create.*video|video.*clip|animation|movie)\b/i.test(prompt)) return 'video';
      if (/\b(ppt|presentation|slides|powerpoint|slideshow)\b/i.test(prompt)) return 'ppt';
      if (/\b(chart|graph|diagram|visualization)\b/i.test(prompt)) return 'chart';
      
      return 'text';
    }

    try {

      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/proxy/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: `You are an expert at classifying user intent. Analyze the user's prompt and classify it into one of these categories:

- 'image': If they want to generate, create, draw, or produce a visual image, artwork, photo, illustration, or graphic design
- 'video': If they want to create, generate, or produce a video, animation, movie clip, or moving visual content  
- 'ppt': If they want to create a presentation, slides, PowerPoint, or slideshow
- 'chart': If they want to create graphs, charts, diagrams, or data visualizations
- 'webdev': If they want to create, build, or design websites, web pages, web applications, This includes requests for HTML, CSS, and JavaScript for a UI.
- 'text': For everything else including: general questions, conversations, text generation, code reviews, debugging, tutorials, explanations, non-web programming, etc.

IMPORTANT:  Requests to explain, review, or debug code should be 'text', not 'webdev'. Only classify as 'webdev' if the user wants to *create* a UI.

Examples:
- "Design a dark mode developer portfolio" → 'webdev' (web development)
- "Create a React component" → 'webdev' (web development) 
- "Build a landing page" → 'webdev' (web development)
- "Make me a website for my business" → 'webdev' (web development)
- "Create HTML/CSS for a login form" → 'webdev' (web development)
- "Generate an image of a cat" → 'image' (visual content)
- "Create a logo design" → 'image' (visual design)
- "Make a video of sunset" → 'video' (video content)
- "Explain how React works" → 'text' (explanation)
- "What is JavaScript?" → 'text' (question)

Respond with only one word: image, video, ppt, chart, webdev, or text.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_completion_tokens: 40, // Fixed for newer models
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }

      const data = await response.json();
      const intent = data.choices[0].message.content.toLowerCase().trim();

      // Validate the response from the model
      if (['image', 'video', 'ppt', 'text', 'chart', 'webdev'].includes(intent)) {
        return intent;
      }
      return 'text'; // Default to text if the response is not one of the expected values
    } catch (error) {
      console.error("Intent classification failed:", error);
      return 'text'; // Default to text on error
    }
  }
}

export const aiService = new AIService()
