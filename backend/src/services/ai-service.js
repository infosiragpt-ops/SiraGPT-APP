
const prisma = require('../config/database');

class OpenAIProvider {
    constructor() {
        this.name = "OpenAI";
        this.models = ["gpt-4", "gpt-4.1"];
        this.imageModels = ["dall-e-3"];
    }

    async generateText(prompt, model, apiKey, chatId) {
        try {
            // Step 1: get previous chat history from DB
            const history = await prisma.message.findMany({
                where: { chatId },
                orderBy: { timestamp: 'asc' }
            });

            // Step 2: convert DB messages to OpenAI format
            const messages = history.map(m => ({
                role: m.role === 'USER' ? 'user' : 'assistant',
                content: m.content
            }));

            console.log(messages);

            // Step 3: add current prompt at the end
            messages.push({ role: "user", content: prompt });

            // Step 4: call OpenAI API with full conversation
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    max_tokens: 1000
                }),
            });

            console.log("OpenAI API response status:", response.status);

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error("OpenAI API errors:", error);
            return "I apologize, but I'm having trouble connecting to OpenAI right now. Please try again later.";
        }
    }

    async generateImage(prompt, model, apiKey) {

        try {
            const response = await fetch("https://api.openai.com/v1/images/generations", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    n: 1,
                    size: "1024x1024",

                }),
            });


            console.log(JSON.stringify({
                model: model,
                prompt: prompt,
                n: 1,
                size: "1024x1024",
            }));
            if (!response.ok) {
                throw new Error(`OpenAI Image API error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.data[0].url;
        } catch (error) {
            console.error("OpenAI Image API error:", error);
            return "Maaf kijiye, abhi OpenAI se image banane mein samasya aa rahi hai. Kripya baad mein prayas karein.";
        }
    }
}

class AnthropicProvider {
    constructor() {
        this.name = "Anthropic";
        this.models = ["claude-3-opus", "claude-3-sonnet"];
    }

    async generateText(prompt, model, apiKey) {
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
            });

            if (!response.ok) {
                throw new Error(`Anthropic API error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.content[0].text;
        } catch (error) {
            console.error("Anthropic API error:", error);
            return "I apologize, but I'm having trouble connecting to Claude right now. Please try again later.";
        }
    }
}

class GroqProvider {
    constructor() {
        this.name = "Grok";
        this.models = ["llama2-70b-4096", "mixtral-8x7b-32768"];
    }

    async generateText(prompt, model, apiKey) {
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
            });

            if (!response.ok) {
                throw new Error(`Groq API error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error("Groq API error:", error);
            return "I apologize, but I'm having trouble connecting to Groq right now. Please try again later.";
        }
    }
}

class SimulatedProvider {
    constructor(name, models) {
        this.name = name;
        this.models = models;
    }

    async generateText(prompt, model) {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        const responses = [
            `Hello! I'm ${this.name} (${model}). I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.`,
            `That's an interesting question! As ${this.name}, I can help you with that. Let me provide you with a comprehensive answer.`,
            `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.`,
            `I'd be happy to help you with that inquiry. Based on my knowledge as ${this.name}, here's what I can tell you.`,
            `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.`,
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }
}

class AIService {
    constructor() {
        this.providers = new Map();
        this.apiKeys = new Map();
        this.providers.set("ChatGPT", new OpenAIProvider());
        this.providers.set("Claude", new AnthropicProvider());
        this.providers.set("Grok", new GroqProvider());
        this.providers.set("DeepSeek", new SimulatedProvider("DeepSeek", ["deepseek-chat", "deepseek-coder"]));
        this.providers.set("Gemini", new SimulatedProvider("Gemini", ["gemini-pro", "gemini-pro-vision"]));
    }

    setApiKey(provider, apiKey) {
        this.apiKeys.set(provider, apiKey);
    }

    async generateResponse(provider, model, prompt, chatId) {
        const aiProvider = this.providers.get(provider);
        if (!aiProvider) {
            throw new Error(`Provider ${provider} not found`);
        }
        const apiKey = process.env.OPENAI_API_KEY;
        // const apiKey = this.apiKeys.get(provider) || "";

        if (!apiKey && (provider === "ChatGPT" || provider === "Claude" || provider === "Grok")) {
            const simulatedProvider = new SimulatedProvider(provider, aiProvider.models);
            return simulatedProvider.generateText(prompt, model);
        }
        return aiProvider.generateText(prompt, model, apiKey, chatId);
    }

    async generateImageResponse(provider, model, prompt) {
        const aiProvider = this.providers.get(provider);
        if (!aiProvider || !aiProvider.generateImage) {
            throw new Error(`Provider ${provider} does not support image generation`);
        }
        const apiKey = this.apiKeys.get(provider) || "";
        return aiProvider.generateImage(prompt, model, apiKey);
    }

    getAvailableProviders() {
        return Array.from(this.providers.keys());
    }

    getModelsForProvider(provider) {
        const aiProvider = this.providers.get(provider);
        return aiProvider ? aiProvider.models : [];
    }

    getImageModelsForProvider(provider) {
        const aiProvider = this.providers.get(provider);
        return aiProvider && aiProvider.imageModels ? aiProvider.imageModels : [];
    }
}

module.exports = new AIService();