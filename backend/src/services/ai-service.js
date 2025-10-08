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
     * Dynamically detect whether the recent user text asks for a front-end website (HTML/CSS/JS UI)
     * Strategy: quick heuristics first; if inconclusive, fall back to a tiny classification call.
     */
    async  detectWebIntent(client, model, recentText) {
  try {
    // --- 1️⃣ Quick heuristic checks (fast path) ---
    // Detects direct code snippets or HTML content
    if (/```(html|css|javascript|js|jsx|tsx)/i.test(recentText)) return true;
    if (/<(html|body|div|section|nav|form|button|input|footer|header)/i.test(recentText)) return true;

    // --- 2️⃣ Multilingual direct pattern for "web" (broad detection) ---
    const webish = /(web\s*app|website|web\s*page|pagina\s*web|page\s*web|サイト|网站|сайт)/i.test(recentText);
    if (webish) return true;

    // --- 3️⃣ AI-based classification (slow but powerful) ---
    if (recentText && recentText.trim().length > 3) {
      const cls = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: `
You are an intent classifier.
Output ONLY one token: WEB_UI or OTHER.

Classify as WEB_UI if the message indicates the user wants to create or see 
a visual user interface in a web browser using HTML, CSS, or JS — 
such as a page, form, dashboard, UI component, or interactive element.

Classify as OTHER for requests about backend logic, APIs, data, or general explanations.

You must understand all languages (English, Urdu, Arabic, Spanish, Japanese, etc.).
Examples of WEB_UI:
- "Make a login page"
- "Create signup form"
- "Design dashboard UI"
- "Página de inicio de sesión"
- "صفحة تسجيل الدخول"
- "Formulario de registro"

Examples of OTHER:
- "Explain HTML tags"
- "Build Node.js API"
- "Database schema"
- "CLI app"
`
          },
          { role: "user", content: recentText }
        ],
        temperature: 0,
        max_tokens: 3
      });

      const intent = cls?.choices?.[0]?.message?.content?.trim()?.toUpperCase() || "";
      if (intent.includes("WEB_UI")) return true;
    }
  } catch (err) {
    console.warn("Web intent detection failed:", err.message || err);
  }

  // --- 4️⃣ Default fallback ---
  return false;
}

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

            // Helpers for detection (normalize lightly to be robust across languages/diacritics)
            const normalize = (s = '') => s
                .toString()
                .toLowerCase()
                .normalize('NFD')
                .replace(/\p{Diacritic}+/gu, '');
            const pickRecentText = (msgs, count = 2) => {
                const userMsgs = msgs.filter(m => (m.role === 'user' || m.role === 'USER'));
                const slice = userMsgs.slice(-count);
                return normalize(slice.map(m => (m.content || '')).join(' \n '));
            };
            const recentText = pickRecentText(messages, 2);

            // Check if the user is asking for a chart (basic English trigger retained)
            const chartKeywords = ['chart', 'graph', 'plot', 'diagram', 'visualize'];
            const isChartRequest = chartKeywords.some(keyword => recentText.includes(keyword));

            // Dynamic intent detection (heuristics + tiny classifier fallback)
            const isWebDevRequest = await this.detectWebIntent(client, model, recentText);

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
                    content: `You are an expert front-end web developer. Create modern, responsive websites with the following guidelines:

**PERFORMANCE OPTIMIZATION:**
- Write efficient, clean code with minimal bloat
- Use modern CSS and JavaScript techniques
- Optimize for fast rendering and low memory usage
- Focus on essential functionality first
- Add progressive enhancement for advanced features

**CODE STRUCTURE:**
1. Prefer a SINGLE code block with a complete HTML document (\`\`\`html ... \`\`\`) that includes inline <style> and <script> so it runs standalone in a browser preview.
2. If multiple blocks are necessary, use \`\`\`html, \`\`\`css, and \`\`\`javascript only.
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

**BEHAVIORAL RULES:**
- Do NOT output backend server code unless explicitly requested. If the user mentions Python/Flask or Node/Express, still provide a front-end that can run standalone in the browser. You may optionally include a short comment indicating how to integrate with a backend, but keep output focused on front-end.
- Ensure the output can be copied and run immediately in a browser.

**PROJECT TYPES TO SUPPORT:**
- Portfolios, landing pages, business sites
- E-commerce, product pages, shopping carts  
- Dashboards, admin panels, forms
- Blogs, news sites, content management
- Social media, chat apps, forums
- Educational, booking, gallery sites
- And any other web application requested

**OUTPUT FORMAT:**
- Output a single, complete \`\`\`html code block whenever possible. Avoid extra explanations before/after the code block.
- The document should include inline <style> and <script> with the required interactivity.`
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
            const dynamicBatchSize = 75; // adaptive below for code blocks
            const flushInterval = 80; // ms
            let lastFlush = Date.now();
            
            for await (const chunk of stream) {
                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    // No hard cap by default; accumulate content
                    
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
