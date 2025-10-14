// file: services/ai-service.js

const OpenAI = require('openai');
const { toFile } = require('openai');
const fs = require('fs');
const prisma = require('../config/database');
const { GoogleGenAI, Modality } = require("@google/genai");
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

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

    // --- 2️⃣ Enhanced multilingual patterns for web UI requests ---
    const webPatterns = [
      // English patterns
      /(web\s*app|website|web\s*page|web\s*site|landing\s*page|home\s*page)/i,
      /(create.*page|build.*site|make.*website|design.*page)/i,
      /(dashboard|admin\s*panel|user\s*interface|UI|frontend)/i,
      /(login\s*page|signup\s*form|contact\s*form|registration)/i,
      /(portfolio|gallery|blog|e-?commerce|shopping)/i,
      
      // Urdu/Hindi patterns  
      /(ویب\s*سائٹ|ویب\s*پیج|صفحہ|ڈیش\s*بورڈ)/i,
      /(بنائیں|بنانا|ڈیزائن)/i,
      
      // Arabic patterns
      /(موقع\s*ويب|صفحة\s*ويب|تصميم|إنشاء)/i,
      
      // Spanish/Portuguese patterns
      /(pagina\s*web|sitio\s*web|página|criar|diseñar)/i,
      
      // Other common patterns
      /(サイト|网站|сайт|웹사이트)/i
    ];
    
    if (webPatterns.some(pattern => pattern.test(recentText))) return true;

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
     * Helper function to convert image file to base64 format for vision API
     * @param {string} imagePath - Path to the image file
     * @param {string} mimeType - MIME type of the image
     * @returns {object} - Formatted image object for vision API
     */
    async prepareImageForVision(imagePath, mimeType) {
        try {
            const fullPath = path.isAbsolute(imagePath) 
                ? imagePath 
                : path.join(__dirname, '../../', imagePath);
            
            if (!fs.existsSync(fullPath)) {
                console.error(`Image file not found: ${fullPath}`);
                return null;
            }

            const imageData = fs.readFileSync(fullPath);
            const base64Image = imageData.toString('base64');
            
            return {
                type: 'image_url',
                image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                    detail: 'high' // Use high detail for better analysis
                }
            };
        } catch (error) {
            console.error('Error preparing image for vision:', error);
            return null;
        }
    }

    /**
     * AI se response generate karta hai aur client ko stream karta hai.
     * @param {object} options - Options ka object
     * @param {string} options.provider - Istemaal hone wala provider
     * @param {string} options.model - Istemaal hone wala model
     * @param {Array<object>} options.messages - AI ko bhejne ke liye messages ka array
     * @param {import('express').Response} options.res - Express response object jis par stream likha jayega
     * @param {Array<object>} options.files - Uploaded files ka array (optional)
     * @returns {Promise<string>} - Poora generate kiya hua content
     */
    async generateStream({ provider, model, messages, res, signal, streamId, files }) {
        let fullResponseContent = '';
        try {
            const client = this.getClient(provider);

            // Check if the user is asking for a chart
            const lastUserMessage = messages[messages.length - 1].content;
            const lastMessageText = typeof lastUserMessage === 'string' 
                ? lastUserMessage 
                : lastUserMessage.find(item => item.type === 'text')?.text || '';
            
            const chartKeywords = ['chart', 'graph', 'plot', 'diagram', 'visualize'];
            const isChartRequest = chartKeywords.some(keyword => 
                lastMessageText.toLowerCase().includes(keyword)
            );
   // Dynamic intent detection (heuristics + tiny classifier fallback)
            const isWebDevRequest = await this.detectWebIntent(client, model, lastMessageText);

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

            // ✅ IMPROVED: Handle images properly for vision API
            if (files && files.length > 0) {
                const imageFiles = files.filter(f => f.mimeType && f.mimeType.startsWith('image/'));
                
                if (imageFiles.length > 0) {
                    console.log(`📸 Processing ${imageFiles.length} image(s) for vision API`);
                    
                    const lastMessage = messages[messages.length - 1];
                    const textContent = typeof lastMessage.content === 'string' 
                        ? lastMessage.content 
                        : lastMessage.content.find(item => item.type === 'text')?.text || '';
                    
                    // Build content array with text and images
                    const contentArray = [
                        { type: 'text', text: textContent }
                    ];
                    
                    // Add all images to the content
                    for (const imageFile of imageFiles) {
                        const imageContent = await this.prepareImageForVision(imageFile.path, imageFile.mimeType);
                        if (imageContent) {
                            contentArray.push(imageContent);
                            console.log(`✅ Added image to vision API: ${imageFile.name}`);
                        }
                    }
                    
                    lastMessage.content = contentArray;
                }
            }
            if (isWebDevRequest) {
                // PREMIUM Web Development System Message
                const webDevSystemMessage = {
                    role: 'system',
                    content: `You are an elite UI/UX designer and front-end architect, specializing in creating award-winning, visually stunning websites. Your work rivals the best designs on Dribbble, Behance, and Awwwards. Create websites that are both beautiful and highly functional.

**� CRITICAL SUCCESS REQUIREMENTS:**

**1. SINGLE FILE OUTPUT (MANDATORY):**
- ALWAYS output ONE complete HTML file with ALL code inline
- Never split into separate HTML, CSS, or JS files
- All styles go in <style> tags in the <head>
- All JavaScript goes in <script> tags before </body>
- Zero external dependencies or imports
- Must work perfectly when saved as .html and opened in browser

**2. VISUAL EXCELLENCE (PREMIUM QUALITY):**
- Modern, luxury design aesthetics (Apple, Tesla, Stripe quality)
- Perfect color harmony with professional palettes
- Advanced CSS: gradients, shadows, backdrop-filter, transforms
- Smooth micro-interactions and hover effects
- Premium typography with perfect hierarchy
- Glassmorphism/neumorphism where appropriate
- Subtle animations that enhance UX

**3. CODE ARCHITECTURE:**
- Clean, semantic HTML5 structure
- Modern CSS Grid and Flexbox layouts
- CSS Custom Properties for consistent theming
- Mobile-first responsive design
- Vanilla JavaScript (ES6+) for interactivity
- Optimized for performance and accessibility

**4. DESIGN PATTERNS:**
- Hero sections with compelling visuals
- Perfect spacing and alignment (8px grid system)
- Professional forms with beautiful styling
- Interactive buttons with hover states
- Card-based layouts with subtle shadows
- Consistent visual rhythm and flow

**5. INTERACTIVITY:**
- Smooth scroll behaviors
- Form validation with beautiful feedback
- Interactive navigation elements
- Dynamic content updates
- Responsive mobile menu
- Loading states and transitions

**6. TECHNICAL EXCELLENCE:**
- Fast loading and optimized rendering
- Cross-browser compatibility
- Accessibility (ARIA labels, keyboard navigation)
- SEO-optimized structure
- Progressive enhancement

**🎨 VISUAL INSPIRATION:**
Target the quality of: Apple product pages, Stripe dashboard, Linear design, Vercel landing pages, Figma marketing sites, Notion interfaces.

**📋 OUTPUT RULES:**
1. Start immediately with \`\`\`html
2. Include complete DOCTYPE and HTML structure
3. Embed ALL styles in <style> tags
4. Embed ALL scripts in <script> tags
5. End with \`\`\`
6. NO explanatory text before or after code
7. Ensure immediate functionality when opened in browser

**💎 QUALITY STANDARD:**
Every element should feel intentionally designed, polished, and premium. The user should be amazed by both visual appeal and smooth functionality. Make it feel like a $50,000 custom website.`
                };
                messages.unshift(webDevSystemMessage);
            }


            const payload = {
                model: model,
                messages: messages,
                stream: true,
            };

            console.log(`🤖 Generating response with ${provider} - ${model}`);
            console.log(`📝 Messages count: ${messages.length}`);

            const stream = await client.chat.completions.create(payload, { signal });

            // Optimized streaming - no content limits, better performance
            let chunkCount = 0;
            let batchBuffer = '';
            let lastFlush = Date.now();
            
            // Optimized settings for better performance
            const batchSize = 150; // Larger batches reduce UI updates
            const flushInterval = 100; // Balanced flush timing
            
            for await (const chunk of stream) {
                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    fullResponseContent += contentChunk;
                    batchBuffer += contentChunk;
                    chunkCount++;
                    
                    const timeSinceLastFlush = Date.now() - lastFlush;
                    const hasNewlines = contentChunk.includes('\n');
                    
                    // Simple, efficient batching - no complex detection
                    const shouldFlush = 
                        batchBuffer.length >= batchSize || 
                        timeSinceLastFlush >= flushInterval ||
                        (hasNewlines && batchBuffer.length > 50);
                    
                    if (shouldFlush && batchBuffer.trim()) {
                        res.write(`data: ${JSON.stringify({ content: batchBuffer })}\n\n`);
                        batchBuffer = '';
                        lastFlush = Date.now();
                    }
                }
                
                // Quick abort check
                if (signal && signal.aborted) {
                    console.log('Stream aborted by client');
                    break;
                }
            }
            
            // Flush any remaining content
            if (batchBuffer.trim()) {
                res.write(`data: ${JSON.stringify({ content: batchBuffer })}\n\n`);
            }

            console.log(`✅ Response generated successfully (${fullResponseContent.length} characters)`);
            return fullResponseContent;
        } catch (apiError) {
            if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
                console.warn(`AI stream aborted by client for provider: ${provider}.`);
                return fullResponseContent;
            }
            console.error(`❌ Error from ${provider} API:`, apiError.message || apiError);
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

    // Helper: Upload file to OpenAI
    async uploadFileToContainer(filepath, containerId) {
        const form = new FormData();
        form.append('file', fs.createReadStream(filepath));

        const response = await axios.post(
            `https://api.openai.com/v1/containers/${containerId}/files`,
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        );

        return response.data;
    }

    async generateChartWithCodeInterpreter(messages, fileId) {
        const client = this.getClient("OpenAI");

        // Combine messages into a single string prompt for the 'input' field
        const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\\n\\n');
        let instructions = `
You are a data visualization expert. Based on the conversation history, when asked to create a chart or graph,
write and run Python code to generate the visualization.
You must save the output as an image file and provide a reference to it.
You are a professional developer; I will give you a scenario, you understand that and create a chart accordingly. Whenever a chart or graph is discussed, you write and run code using the python tool to answer the question.
`;

        let containerId = null;
        let tempContainer = null;

        if (fileId) {
            const fileRecord = await prisma.file.findUnique({ where: { id: fileId } });
            if (!fileRecord || !fs.existsSync(fileRecord.path)) {
                throw new Error("File not found or path is invalid for chart generation.");
            }

            tempContainer = await client.containers.create({
                name: `chart-gen-container-${Date.now()}`,
            });
            containerId = tempContainer.id;

            await this.uploadFileToContainer(fileRecord.path, containerId);
            console.log(`File ${fileRecord.originalName} uploaded to container ${containerId} for chart generation.`);

            instructions += `\n\nA file named '${fileRecord.originalName}' has been uploaded and is available in your environment. Please use this file to generate the requested chart.`;
        }

        const resp = await client.responses.create({
            model: "gpt-4.1",
            tools: [
                {
                    type: "code_interpreter",
                    container: containerId ? containerId : { type: "auto" },
                },
            ],
            instructions,
            input: prompt,
        });

        let pythonCode = null;
        let imageUrl = null;

        // Find the code and the file citation from the response
        for (const output of resp.output) {
            if (output.type === 'code_interpreter_call') {
                pythonCode = output.code;
            }
            if (output.type === 'message' && output.content) {
                for (const contentItem of output.content) {
                    if (contentItem.annotations) {
                        for (const annotation of contentItem.annotations) {
                            if (annotation.type === 'container_file_citation') {
                                const { file_id, container_id } = annotation;
                                if (file_id && container_id) {
                                    console.log(`Found file citation: container_id=${container_id}, file_id=${file_id}`);

                                    const downloadUrl = `https://api.openai.com/v1/containers/${container_id}/files/${file_id}/content`;
                                    const imageResponse = await axios.get(downloadUrl, {
                                        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                                        responseType: 'arraybuffer'
                                    });

                                    const uploadsDir = path.join(__dirname, '../../uploads/images');
                                    await fs.promises.mkdir(uploadsDir, { recursive: true });

                                    const timestamp = Date.now();
                                    const filename = `chart-${timestamp}.png`;
                                    const filepath = path.join(uploadsDir, filename);

                                    await fs.promises.writeFile(filepath, imageResponse.data);

                                    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
                                    imageUrl = `${baseUrl}/uploads/images/${filename}`;
                                    console.log(`Image saved successfully at: ${imageUrl}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        return { imageUrl, pythonCode, response: resp.output };
    }
}

module.exports = new AIService();
