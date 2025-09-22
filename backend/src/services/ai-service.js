// file: services/ai-service.js

const OpenAI = require('openai');
const prisma = require('../config/database');

class AIService {
    /**
     * Provider ke naam ke hisab se sahi configured AI client return karta hai.
     * @param {string} provider - Provider ka naam (e.g., "OpenAI", "Gemini", "OpenRouter")
     * @returns {OpenAI} - OpenAI client ka instance
     */
    getClient(provider) {
        if (provider === "Gemini") {
            return new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });
        }

        if (provider === "OpenRouter") {
            return new OpenAI({
                apiKey: process.env.OPENROUTER_API_KEY,
                baseURL: "https://openrouter.ai/api/v1",
            });
        }

        // Default provider OpenAI hai
        return new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * AI se response generate karta hai aur client ko stream karta hai.
     * @param {object} options - Options ka object
     * @param {string} options.provider - Istemaal hone wala provider
     * @param {string} options.model - Istemaal hone wala model
     * @param {Array<object>} options.messages - AI ko bhejne ke liye messages ka array
     * @param {import('express').Response} options.res - Express response object jis par stream likha jayega
     * @returns {Promise<string>} - Poora generate kiya hua content
     */
    async generateStream({ provider, model, messages, res }) {
        let fullResponseContent = '';
        try {
            const client = this.getClient(provider);

            const payload = {
                model: model,
                messages: messages,
                stream: true,
            };


            if (model.includes('gpt-5')) {

                console.log(`Using special parameter 'max_completion_tokens' for model: ${model}`);
                payload.max_completion_tokens = 8192;

            } else {

                console.log(`Using standard parameter 'max_tokens' for model: ${model}`);
                payload.max_tokens = 8192;
            }
            const stream = await client.chat.completions.create(payload);

            // Stream se data parhein aur client ko bhejein
            for await (const chunk of stream) {
                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    fullResponseContent += contentChunk;
                    // Client ko data chunk bhejein
                    res.write(`data: ${JSON.stringify({ content: contentChunk })}\n\n`);
                }
            }

            return fullResponseContent;
        } catch (apiError) {
            console.error(`Error from ${provider} API:`, apiError);
            // Client ko error ka message bhejein
            res.write(`data: ${JSON.stringify({ error: `AI service (${provider}) is temporarily unavailable.` })}\n\n`);
            // Error ko aage pass karein takay route handler usko log kar sake
            throw apiError;
        }
    }
}

// Service ka ek hi instance banayein aur export karein
module.exports = new AIService();