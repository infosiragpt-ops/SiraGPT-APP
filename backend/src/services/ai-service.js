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

            // Enhanced web development detection - covers all possible web projects
            const webDevKeywords = [
                // General web development
                'website', 'webpage', 'web page', 'web app', 'web application', 'site', 'html', 'css', 'javascript', 'js',
                'frontend', 'front-end', 'ui', 'user interface', 'responsive', 'mobile-first', 'bootstrap', 'tailwind',
                
                // Specific project types
                'portfolio', 'landing page', 'home page', 'dashboard', 'admin panel', 'login page', 'register', 'signup',
                'ecommerce', 'e-commerce', 'online store', 'shop', 'shopping cart', 'product page', 'checkout',
                'blog', 'news site', 'article', 'cms', 'content management',
                'social media', 'social network', 'chat app', 'messaging', 'forum', 'community',
                'business site', 'corporate', 'company website', 'agency', 'startup',
                'restaurant', 'menu', 'booking', 'reservation', 'hotel', 'travel',
                'education', 'learning', 'course', 'school', 'university', 'academy',
                'real estate', 'property', 'listing', 'gallery', 'photography',
                'medical', 'healthcare', 'clinic', 'doctor', 'appointment',
                'fitness', 'gym', 'workout', 'health', 'nutrition',
                'finance', 'banking', 'investment', 'calculator', 'budget',
                'game', 'gaming', 'quiz', 'interactive', 'animation',
                
                // Actions
                'create', 'build', 'make', 'design', 'develop', 'code', 'generate'
            ];
            
            const isWebDevRequest = webDevKeywords.some(keyword => 
                lastUserMessage.includes(keyword.toLowerCase())
            );

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

            if (isWebDevRequest) {
                // Enhanced prompt for web development requests with performance optimization
                const webDevSystemMessage = {
                    role: 'system',
                    content: `You are an expert web developer. Create modern, responsive websites with the following guidelines:

**PERFORMANCE OPTIMIZATION:**
- Write efficient, clean code with minimal bloat
- Use modern CSS and JavaScript techniques
- Optimize for fast rendering and low memory usage
- Focus on essential functionality first
- Add progressive enhancement for advanced features

**CODE STRUCTURE:**
1. **Use proper code blocks:** \`\`\`html, \`\`\`css, \`\`\`javascript
2. **Single HTML file approach** - embed CSS/JS inline for easy testing
3. **Modern, responsive design** - mobile-first, flexbox/grid
4. **Clean, semantic HTML** with accessibility features
5. **Efficient CSS** - use CSS variables, modern techniques
6. **Functional JavaScript** - ES6+, event delegation, clean code

**DESIGN PRINCIPLES:**
- Modern UI with good contrast and typography
- Responsive design (mobile, tablet, desktop)
- Professional color schemes and spacing
- Smooth animations and interactions
- Cross-browser compatibility
- Fast loading and optimized performance

**PROJECT TYPES TO SUPPORT:**
- Portfolios, landing pages, business sites
- E-commerce, product pages, shopping carts  
- Dashboards, admin panels, forms
- Blogs, news sites, content management
- Social media, chat apps, forums
- Educational, booking, gallery sites
- And any other web application requested

**OUTPUT FORMAT:**
Provide complete, working code that users can immediately copy, paste, and run. Focus on core functionality and modern design patterns.`
                };
                messages.unshift(webDevSystemMessage);
            }


            const payload = {
                model: model,
                messages: messages,
                stream: true,
            };


            // if (model.includes('gpt-5')) {

            //     console.log(`Using special parameter 'max_completion_tokens' for model: ${model}`);
            //     payload.max_completion_tokens = 8192;

            // } else {

            //     console.log(`Using standard parameter 'max_tokens' for model: ${model}`);
            //     payload.max_tokens = 8192;
            // }
            const stream = await client.chat.completions.create(payload, { signal });

            // Advanced streaming with adaptive batching and memory management
            let chunkCount = 0;
            let batchBuffer = '';
            let totalLength = 0;
            const dynamicBatchSize = 75; // Optimized for large responses
            const flushInterval = 80; // Reduced for better responsiveness
            const maxResponseSize = 100000; // 100KB limit per response for memory safety
            let lastFlush = Date.now();
            
            for await (const chunk of stream) {
                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    // Memory safety check
                    if (totalLength + contentChunk.length > maxResponseSize) {
                        console.warn(`Response size limit reached: ${totalLength} chars`);
                        break;
                    }
                    
                    fullResponseContent += contentChunk;
                    batchBuffer += contentChunk;
                    totalLength += contentChunk.length;
                    chunkCount++;
                    
                    // Adaptive batching based on content type and size
                    const isCodeBlock = contentChunk.includes('```');
                    const hasLineBreaks = contentChunk.includes('\n');
                    const currentBatchSize = isCodeBlock ? dynamicBatchSize * 2 : dynamicBatchSize;
                    
                    const shouldFlush = batchBuffer.length >= currentBatchSize || 
                                       (Date.now() - lastFlush) > flushInterval ||
                                       (hasLineBreaks && batchBuffer.length > 30) || // Quick flush for readability
                                       isCodeBlock; // Immediate flush for code blocks
                    
                    if (shouldFlush && batchBuffer.trim()) {
                        res.write(`data: ${JSON.stringify({ content: batchBuffer })}\n\n`);
                        batchBuffer = '';
                        lastFlush = Date.now();
                        
                        // Periodic memory cleanup for very large responses
                        if (chunkCount % 100 === 0 && global.gc) {
                            setImmediate(() => global.gc());
                        }
                    }
                }
            }
            
            // Flush remaining content
            if (batchBuffer.trim()) {
                res.write(`data: ${JSON.stringify({ content: batchBuffer })}\n\n`);
            }
            
            console.log(`Stream completed: ${fullResponseContent.length} chars, ${chunkCount} chunks (batched)`);
        

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
