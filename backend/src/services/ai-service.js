// file: services/ai-service.js

const OpenAI = require('openai');
const { toFile } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Make sure to install this package: npm install @google/generative-ai
const fs = require('fs');
const prisma = require('../config/database');
const { GoogleGenAI, Modality } = require("@google/genai");
const path = require('path');
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




    async generateStream({ provider, model, messages, res, signal, streamId }) {
        let fullResponseContent = '';
        try {
            const client = this.getClient(provider);

            // Check if the user is asking for a chart
            const lastUserMessage = messages[messages.length - 1].content.toLowerCase();
            const chartKeywords = ['chart', 'graph', 'plot', 'diagram', 'visualize'];
            const isChartRequest = chartKeywords.some(keyword => lastUserMessage.includes(keyword));

            if (isChartRequest) {
                // Modify the system prompt to request JSON for charts
                const systemMessage = {
                    role: 'system',
                    content: `You are an expert AI assistant. When asked to create a chart, you must respond with a JSON object that can be used with the recharts library. The JSON object should have the following structure:
{
  "type": "bar", // or "line", "pie", "area", etc.
  "data": [ // array of data objects
    { "name": "Jan", "value": 4000 },
    { "name": "Feb", "value": 3000 }
  ],
  "config": { // chart configuration
    "title": "Chart Title",
    "dataKey": "value",
    "xAxisKey": "name",
    "xAxisLabel": "X-Axis Label",
    "yAxisLabel": "Y-Axis Label",
    "fill": "#8884d8"
  }
}
Do not include any other text or explanations in your response. Just the JSON object.`
                };
                messages.unshift(systemMessage);
            }


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
            const stream = await client.chat.completions.create(payload, { signal });

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
            if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
                console.warn(`AI stream aborted by client for provider: ${provider}.`);
                // Agar request abort ho gayi hai, toh koi error message client ko na bhejein
                // aur jo content receive hua hai, wahi return karein
                return fullResponseContent;
            }
            console.error(`Error from ${provider} API:`, apiError);
            res.write(`data: ${JSON.stringify({ error: `AI service (${provider}) is temporarily unavailable or stream was interrupted.` })}\n\n`);
            throw apiError;
        }
    }

    async generateImageFromImage(imagePath, prompt, provider) {
        try {
            if (provider === "Gemini") {
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

                const imageData = fs.readFileSync(imagePath);
                const base64Image = imageData.toString("base64");

                const requestPrompt = [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType: "image/png",
                            data: base64Image,
                        },
                    },
                ];

                const response = await ai.models.generateContent({
                    model: "gemini-2.5-flash-image-preview",
                    contents: requestPrompt,
                });

                for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        return part.inlineData.data;
                    }
                }

                throw new Error("No image returned by Gemini");

            } else {
                const openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY,
                });

                const imageFile = await toFile(fs.createReadStream(imagePath), null, {
                    type: "image/png",
                });

                const response = await openai.images.edit({
                    image: imageFile,
                    prompt: prompt,
                    model: 'gpt-image-1',
                    n: 1,
                    size: '1024x1024',
                    quality: 'auto',
                });

                const image_base64 = response.data[0].b64_json;
                return image_base64;

            }
        } catch (error) {
            console.error("Error:", error.message);
            throw error;
        }
    }

}


// Service ka ek hi instance banayein aur export karein
module.exports = new AIService();
