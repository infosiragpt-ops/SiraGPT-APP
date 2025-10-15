// file: services/ai-service.js

const OpenAI = require('openai');
const { toFile } = require('openai');
const fs = require('fs');
const prisma = require('../config/database');
const { GoogleGenAI, Modality } = require("@google/genai");
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const PptxGenJS = require('pptxgenjs');

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

    /**
     * Generate an image using DALL-E
     * @param {string} prompt - Text prompt for image generation
     * @param {string} provider - AI provider
     * @param {string} model - AI model
     * @returns {Promise<string|null>} - Base64 encoded image or null
     */
    async generateImage(prompt, provider = "OpenAI", model = "dall-e-3") {
        try {
            const client = this.getClient(provider);
            console.log(`🎨 Generating image with DALL-E for prompt: "${prompt}"`);

            const response = await client.images.generate({
                model: model,
                prompt: prompt,
                n: 1,
                size: "1024x1024",
                quality: "standard",
                response_format: "b64_json",
            });

            const image_b64 = response.data[0].b64_json;
            return image_b64;

        } catch (error) {
            console.error('❌ Error generating image with DALL-E:', error.message);
            return null; // Return null if image generation fails
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

    /**
     * Generate a PowerPoint presentation using AI
     * @param {string} prompt - User's request for PPT content
     * @param {string} provider - AI provider to use
     * @param {string} model - AI model to use
     * @returns {Promise<object>} - Generated PPT file information
     */
    async generatePPT(prompt, provider = "OpenAI", model = "gpt-4o") {
        try {
            const client = this.getClient(provider);

            // Create a detailed prompt for generating PPT structure
            const systemMessage = {
                role: 'system',
                content: `You are an expert presentation creator. When asked to create a PowerPoint presentation, you must respond with a JSON object that contains the presentation structure. The JSON should have this format:
{
  "title": "Presentation Title",
  "slides": [
    {
      "type": "title",
      "title": "Main Title",
      "subtitle": "A concise and engaging subtitle for the presentation"
    },
    {
      "type": "content",
      "title": "Slide Title",
      "content": [
        "First detailed bullet point explaining a key concept.",
        "Second bullet point elaborating on the previous one with examples.",
        "Third bullet point providing further insights or data.",
        "Fourth conclusive bullet point summarizing the slide's topic."
      ]
    },
    {
      "type": "two-column",
      "title": "Comparative Analysis",
      "leftContent": ["Point 1 with details", "Point 2 with details"],
      "rightContent": ["Counter-point A with details", "Counter-point B with details"]
    },
    {
      "type": "content-with-image",
      "title": "Visualizing the Concept",
      "content": ["Bullet point explaining the visual.", "Another point on its importance."],
      "imagePrompt": "A photorealistic image of a modern office with people collaborating."
    }
  ]
}

Available slide types: "title", "content", "two-column", "content-with-image".
For "content-with-image" slides, provide a concise, descriptive \`imagePrompt\` for DALL-E to generate a relevant image.
The first slide must always be of type "title" and must include a subtitle.
Generate 5-10 slides based on the topic. For each content slide, generate at least 4-6 meaningful and detailed bullet points.
The content should be clear, concise, professional, and easy to understand.
Only respond with the JSON object, no additional text.`
            };

            const messages = [
                systemMessage,
                {
                    role: 'user',
                    content: `Create a professional PowerPoint presentation about: ${prompt}`
                }
            ];

            console.log('🎨 Generating PPT structure with AI...');

            const response = await client.chat.completions.create({
                model: model,
                messages: messages
            });

            const aiResponse = response.choices[0].message.content;

            // Parse JSON response
            let pptStructure;
            try {
                // Try to extract JSON if wrapped in markdown code blocks
                const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                const jsonString = jsonMatch ? jsonMatch[1] : aiResponse;
                pptStructure = JSON.parse(jsonString.trim());
            } catch (parseError) {
                console.error('Failed to parse AI response as JSON:', parseError);
                throw new Error('AI did not return valid JSON structure');
            }

            // Generate the actual PPT file
            const ppt = new PptxGenJS();

            // Set presentation properties
            ppt.author = 'AI Assistant';
            ppt.company = 'Your Company';
            ppt.subject = pptStructure.title || 'AI Generated Presentation';
            ppt.title = pptStructure.title || 'Presentation';

            // Define color scheme
            const colors = {
                primary: '0078D4',
                secondary: '4A5568',
                accent: '38B2AC',
                background: 'FFFFFF',
                text: '1A202C'
            };

            const timestamp = Date.now();

            // Process each slide
            for (const [index, slideData] of pptStructure.slides.entries()) {
                const slide = ppt.addSlide();

                // Add a slide master for consistent branding
                slide.addText(`Slide ${slide.slideNumber}`, {
                    x: 0.5, y: '95%', w: '90%', h: 0.25,
                    align: 'center', fontSize: 10, color: colors.secondary
                });


                if (slideData.type === 'title') {
                    // Title slide
                    slide.background = { color: colors.primary };
                    slide.addText(slideData.title, {
                        x: 0.5,
                        y: 2.0,
                        w: 9.0,
                        h: 1.5,
                        fontSize: 44,
                        bold: true,
                        color: 'FFFFFF',
                        align: 'center'
                    });
                    if (slideData.subtitle) {
                        slide.addText(slideData.subtitle, {
                            x: 0.5,
                            y: 3.8,
                            w: 9.0,
                            h: 0.8,
                            fontSize: 24,
                            color: 'FFFFFF',
                            align: 'center'
                        });
                    }
                } else if (slideData.type === 'content') {
                    // Content slide with bullet points
                    slide.addText(slideData.title, {
                        x: 0.5,
                        y: 0.5,
                        w: 9.0,
                        h: 0.8,
                        fontSize: 32,
                        bold: true,
                        color: colors.primary
                    });

                    const bulletPoints = slideData.content.map(point => ({
                        text: point,
                        options: { bullet: true, fontSize: 18, color: colors.text }
                    }));

                    slide.addText(bulletPoints, {
                        x: 0.5,
                        y: 1.5,
                        w: 9.0,
                        h: 4.0,
                        fontSize: 18,
                        color: colors.text
                    });
                } else if (slideData.type === 'two-column') {
                    // Two-column slide
                    slide.addText(slideData.title, {
                        x: 0.5,
                        y: 0.5,
                        w: 9.0,
                        h: 0.8,
                        fontSize: 32,
                        bold: true,
                        color: colors.primary
                    });

                    // Left column
                    const leftBullets = slideData.leftContent.map(point => ({
                        text: point,
                        options: { bullet: true, fontSize: 16, color: colors.text }
                    }));
                    slide.addText(leftBullets, {
                        x: 0.5,
                        y: 1.5,
                        w: 4.25,
                        h: 4.0
                    });

                    // Right column
                    const rightBullets = slideData.rightContent.map(point => ({
                        text: point,
                        options: { bullet: true, fontSize: 16, color: colors.text }
                    }));
                    slide.addText(rightBullets, {
                        x: 5.25,
                        y: 1.5,
                        w: 4.25,
                        h: 4.0
                    });
                } else if (slideData.type === 'content-with-image') {
                    // Content slide with an image
                    slide.addText(slideData.title, {
                        x: 0.5, y: 0.5, w: 9.0, h: 0.8,
                        fontSize: 32, bold: true, color: colors.primary
                    });

                    // Text content on the left
                    const bulletPoints = (slideData.content || []).map(point => ({
                        text: point,
                        options: { bullet: true, fontSize: 16, color: colors.text }
                    }));
                    slide.addText(bulletPoints, {
                        x: 0.5, y: 1.5, w: 4.5, h: 4.0
                    });

                    // Image on the right
                    if (slideData.imagePrompt) {
                        console.log(`🖼️ Generating image for slide: "${slideData.title}"`);
                        const imageB64 = await this.generateImage(slideData.imagePrompt);
                        if (imageB64) {
                            // Add image to PPTX from base64
                            slide.addImage({
                                data: `data:image/png;base64,${imageB64}`,
                                x: 5.5, y: 1.5, w: 4.0, h: 4.0,
                            });

                            // Save the image to a file for frontend access
                            try {
                                const imageBuffer = Buffer.from(imageB64, 'base64');
                                const imagesDir = path.join(__dirname, '../../uploads/images');
                                await fs.promises.mkdir(imagesDir, { recursive: true });
                                const imageFilename = `ppt-image-${timestamp}-${index}.png`;
                                const imageFilepath = path.join(imagesDir, imageFilename);
                                await fs.promises.writeFile(imageFilepath, imageBuffer);

                                // Update the slide data with the public URL
                                slideData.imageUrl = `/uploads/images/${imageFilename}`;
                                console.log(`✅ Image saved and URL set for frontend: ${slideData.imageUrl}`);
                            } catch (saveError) {
                                console.error('Error saving presentation image:', saveError);
                            }
                        } else {
                            console.log(`⚠️ Image generation failed, skipping image for this slide.`);
                        }
                    }
                }
            }

            // Save the presentation
            const uploadsDir = path.join(__dirname, '../../uploads/presentations');
            await fs.promises.mkdir(uploadsDir, { recursive: true });

            const filename = `presentation-${timestamp}.pptx`;
            const filepath = path.join(uploadsDir, filename);

            await ppt.writeFile({ fileName: filepath });

            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
            const downloadUrl = `${baseUrl}/uploads/presentations/${filename}`;

            console.log('✅ PPT generated successfully:', filename);

            return {
                filename,
                downloadUrl,
                structure: pptStructure,
                slideCount: pptStructure.slides.length
            };

        } catch (error) {
            console.error('❌ Error generating PPT:', error);
            throw error;
        }
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
