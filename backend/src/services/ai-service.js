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
const vectorPPTService = require('./vector-ppt-service');
const { fitMessagesToContext } = require('./context-window');
const { evaluateResponse, buildCorrectivePrompt } = require('./quality-guard');

const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Resolve the fallback model chain from env. Comma-separated names,
 * e.g. FALLBACK_MODELS=gpt-4o-mini,anthropic/claude-3.5-sonnet,gpt-3.5-turbo.
 * Empty / missing returns a sensible default that favors cheap+fast OpenAI
 * models so a degraded reply still reaches the user.
 */
function getFallbackChain() {
    const raw = (process.env.FALLBACK_MODELS || '').trim();
    if (!raw) {
        const defaults = ['gpt-4o-mini'];
        if (process.env.OPENROUTER_API_KEY) {
            defaults.push('anthropic/claude-3-haiku', 'deepseek/deepseek-chat-v3-0324');
        }
        if (process.env.GEMINI_API_KEY) {
            defaults.push('gemini-2.5-flash');
        }
        defaults.push('gpt-3.5-turbo');
        return [...new Set(defaults)];
    }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Route a model name to the provider the siraGPT backend uses for it.
 * Keeps the fallback chain provider-agnostic: the caller passes a list of
 * model names and we figure out which SDK base URL + key to use.
 */
function providerForModel(model) {
    if (!model) return 'OpenAI';
    if (/^(x-ai|openrouter|anthropic|meta-llama|deepseek|mistralai|qwen|nvidia|microsoft|cohere)\//i.test(model)) return 'OpenRouter';
    if (/^\/?(gpt-oss|zephyr)/i.test(model)) return 'OpenRouter';
    if (/^(gemini|imagen)/i.test(model)) return 'Gemini';
    return 'OpenAI';
}

/**
 * Classify a provider error as transient (safe to retry) vs terminal.
 * Transient: rate limits (429), request timeouts (408), server errors
 * (500-504), and network-level failures. Terminal errors (401 auth,
 * 400 bad request, content-filter refusals) are NOT retried — retrying
 * them won't change the outcome and just delays the user-facing error.
 */
function isTransientProviderError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    const status = err.status || err.response?.status;
    if (status === 429 || status === 408 || status === 409) return true;
    if (status >= 500 && status < 600) return true;
    const code = err.code || err.cause?.code;
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('network error') || msg.includes('socket hang up') || msg.includes('fetch failed')) return true;
    return false;
}

/**
 * Localized, professional fallback message for when every retry fails
 * and no content has been streamed yet. Uses the resolved response
 * language so the user isn't suddenly spoken to in English mid-chat.
 */
function getFallbackMessage(language) {
    // Phrasing from the siraGPT brain spec — kept identical to what the
    // product promises, translated per language-policy resolution. No
    // technical detail leaks into this copy; the real error is logged
    // server-side and surfaced on the SSE error channel with
    // `recovered: true` for UI telemetry.
    const messages = {
        es: 'Hubo un problema procesando tu solicitud. Por favor intenta de nuevo.',
        en: 'There was a problem processing your request. Please try again.',
        pt: 'Houve um problema ao processar sua solicitação. Por favor, tente novamente.',
        fr: "Un problème est survenu lors du traitement de votre demande. Veuillez réessayer.",
        de: 'Bei der Verarbeitung Ihrer Anfrage ist ein Problem aufgetreten. Bitte versuchen Sie es erneut.',
        it: 'Si è verificato un problema durante l\'elaborazione della richiesta. Riprova.',
    };
    return messages[language] || messages.es;
}

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
     * Detect if user is requesting document creation from existing content
     * @param {string} userRequest - Latest user message
     * @param {Array} messages - Full conversation history
     * @returns {boolean} - True if this is a document creation request
     */
    isDocumentCreationFromExistingContent(userRequest, messages) {
        const request = userRequest.toLowerCase();

        // Keywords that indicate document creation from existing content
        const documentKeywords = [
            'create', 'convert', 'make', 'generate', 'save as', 'export',
            'pdf', 'word', 'doc', 'docx', 'document', 'file'
        ];

        const referenceKeywords = [
            'above', 'previous', 'earlier', 'that content', 'the content',
            'what you gave me', 'what you provided', 'your response',
            'from your answer', 'with the information', 'uper wala content',
            'jo tumne diya', 'jo content', 'pehle wala'
        ];

        const hasDocumentKeyword = documentKeywords.some(keyword => request.includes(keyword));
        const hasReferenceKeyword = referenceKeywords.some(keyword => request.includes(keyword));

        // Check if there's substantial content in recent assistant messages
        const recentAssistantMessages = messages
            .filter(msg => msg.role === 'assistant' && msg.content)
            .slice(-3); // Last 3 assistant messages

        const hasSubstantialPreviousContent = recentAssistantMessages.some(msg =>
            msg.content && msg.content.length > 500
        );

        return hasDocumentKeyword && hasReferenceKeyword && hasSubstantialPreviousContent;
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
    async generateStream({ provider, model, messages, res, signal, streamId, files, language = 'es', userPrompt = '', qualityGuard = true }) {
        let fullResponseContent = '';
        let hasStreamedAnyContent = false;

        // Heartbeat: SSE comment line sent every 15s so intermediaries
        // (nginx, Cloudflare, load balancers) don't close the connection
        // as idle during long-tail completions. Comments are `: text\n\n`
        // and are ignored by EventSource parsers, so they never show up
        // as content on the client.
        const writeHeartbeat = () => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket gone */ } };
        const heartbeat = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

        // Fit the payload to the target model's context window BEFORE we
        // pick the client. Running this before vision expansion keeps the
        // token estimate honest for the text portion — images are added
        // after and the provider handles their size separately.
        const fit = fitMessagesToContext(messages, model);
        if (fit.droppedCount > 0) {
            console.log(`✂️  context trim: dropped ${fit.droppedCount} middle message(s), ${fit.totalTokens}/${fit.budget} tokens after fit`);
        }
        let workingMessages = fit.messages;

        try {
            // ✅ IMPROVED: Handle images properly for vision API
            if (files && files.length > 0) {
                const imageFiles = files.filter(f => f.mimeType && f.mimeType.startsWith('image/'));

                if (imageFiles.length > 0) {
                    console.log(`📸 Processing ${imageFiles.length} image(s) for vision API`);

                    const lastMessage = workingMessages[workingMessages.length - 1];
                    const textContent = typeof lastMessage.content === 'string'
                        ? lastMessage.content
                        : lastMessage.content.find(item => item.type === 'text')?.text || '';

                    // ✅ NEW: Add LaTeX formatting instruction for math content in images
                    const mathInstructionText = textContent +
                        '\n\nIMPORTANT: If the uploaded image(s) contain mathematical equations, formulas, or expressions, ' +
                        'please transcribe and format them using proper LaTeX syntax. Use single dollar signs ($...$) for inline math ' +
                        'and double dollar signs ($$...$$) for display math. For example: ' +
                        'Inline: $E = mc^2$ or Display: $$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$' +
                        '\n\nExamples of proper LaTeX formatting:' +
                        '\n- Fractions: $\\frac{a}{b}$' +
                        '\n- Square roots: $\\sqrt{x}$ or $\\sqrt[n]{x}$' +
                        '\n- Integrals: $\\int f(x) dx$ or $\\int_{a}^{b} f(x) dx$' +
                        '\n- Summations: $\\sum_{i=1}^{n} x_i$' +
                        '\n- Greek letters: $\\alpha, \\beta, \\gamma, \\pi, \\theta$' +
                        '\n- Subscripts/Superscripts: $x_1, y^2, a_i^j$' +
                        '\n- Matrix: $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$';

                    // Build content array with text and images
                    const contentArray = [
                        { type: 'text', text: mathInstructionText }
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

            // Build the model chain: primary first, then env-configured
            // fallbacks. Deduped so the primary doesn't get tried twice.
            const fallbackModels = getFallbackChain().filter(m => m !== model);
            const modelChain = [model, ...fallbackModels];

            console.log(`🤖 Generating with primary=${provider}:${model}, fallback=[${fallbackModels.join(', ') || 'none'}]`);
            console.log(`📝 Messages count: ${workingMessages.length}`);

            // Outer loop: walk the model chain. Inner loop: retry each
            // model up to 2 times on transient errors (spec: "reintenta
            // una vez con el mismo modelo"). We only advance to the next
            // model if NO content has been streamed yet — once the user
            // sees text, we commit to the current model even if it fails
            // mid-stream (a partial answer is always better than a fresh
            // one that duplicates it).
            const MAX_ATTEMPTS_PER_MODEL = 2;
            const FIRST_BYTE_TIMEOUT_MS = 30_000;
            let lastError = null;
            for (let m = 0; m < modelChain.length; m++) {
                const currentModel = modelChain[m];
                const currentProvider = m === 0 ? provider : providerForModel(currentModel);
                const payload = { model: currentModel, messages: workingMessages, stream: true };

                if (hasStreamedAnyContent) break;

                for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
                    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

                    // Per-attempt controller: composes the client signal with a
                    // 30s first-byte timer. If the provider hasn't emitted a
                    // single token within FIRST_BYTE_TIMEOUT_MS we abort THIS
                    // attempt — not the whole turn — so the retry/fallback
                    // chain can try the next slot.
                    const attemptCtrl = new AbortController();
                    const onParentAbort = () => attemptCtrl.abort(new Error('client aborted'));
                    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });
                    let firstByteSeen = false;
                    let timedOut = false;
                    const firstByteTimer = setTimeout(() => {
                        if (!firstByteSeen) { timedOut = true; attemptCtrl.abort(new Error(`First-byte timeout after ${FIRST_BYTE_TIMEOUT_MS}ms`)); }
                    }, FIRST_BYTE_TIMEOUT_MS);

                    try {
                        const client = this.getClient(currentProvider);
                        const stream = await client.chat.completions.create(payload, { signal: attemptCtrl.signal });

                        for await (const chunk of stream) {
                            const contentChunk = chunk.choices[0]?.delta?.content || '';
                            if (contentChunk) {
                                if (!firstByteSeen) { firstByteSeen = true; clearTimeout(firstByteTimer); }
                                fullResponseContent += contentChunk;
                                hasStreamedAnyContent = true;
                                res.write(`data: ${JSON.stringify({ content: contentChunk })}\n\n`);
                            }
                        }

                        if (!hasStreamedAnyContent) {
                            throw Object.assign(new Error('Empty completion — model returned no content'), { code: 'EMPTY_COMPLETION' });
                        }

                        console.log(`✅ Response on ${currentProvider}:${currentModel} attempt ${attempt} (${fullResponseContent.length} chars)`);

                        // Quality guard — rule #10 of the spec. Runs once,
                        // after a successful primary stream. If the reply
                        // looks weak (refusal template, too short for a
                        // non-yes/no question, punctuation-only), we kick
                        // off a corrective non-streaming pass and, if it
                        // produced something richer, append it to the
                        // stream the user is already reading.
                        if (qualityGuard) {
                            const verdict = evaluateResponse({ response: fullResponseContent, userPrompt });
                            if (verdict.weak) {
                                console.warn(`🧪 quality-guard flagged: ${verdict.reason} — running corrective pass`);
                                const corrected = await this._runCorrectivePass({
                                    provider: currentProvider,
                                    model: currentModel,
                                    baseMessages: workingMessages,
                                    userPrompt,
                                    language,
                                    signal,
                                });
                                if (corrected && corrected.length > fullResponseContent.length) {
                                    res.write(`data: ${JSON.stringify({ content: '\n\n' })}\n\n`);
                                    res.write(`data: ${JSON.stringify({ content: corrected })}\n\n`);
                                    fullResponseContent += '\n\n' + corrected;
                                }
                            }
                        }

                        return fullResponseContent;
                    } catch (err) {
                        lastError = err;

                        // Distinguish OUR first-byte timeout (retriable) from
                        // the external client abort (terminal) — both show
                        // up as AbortError from the SDK.
                        const isOurTimeout = timedOut || err.code === 'TIMEOUT';
                        const isClientCancel = !isOurTimeout && signal?.aborted;
                        if (isClientCancel) throw err;
                        if (hasStreamedAnyContent) throw err;

                        const retryable = isOurTimeout || isTransientProviderError(err) || err.code === 'EMPTY_COMPLETION';
                        const isLastAttemptForModel = attempt >= MAX_ATTEMPTS_PER_MODEL;
                        const reason = isOurTimeout ? 'first-byte timeout' : (err.status || err.code || err.name || 'unknown');
                        console.warn(`⚠️ ${currentProvider}:${currentModel} attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL} failed (${reason}): ${err.message}${retryable && !isLastAttemptForModel ? ' — retrying' : (m < modelChain.length - 1 ? ' — falling back' : '')}`);

                        if (!retryable || isLastAttemptForModel) break; // break attempt loop → try next model

                        // Exponential backoff with jitter: ~400ms, ~900ms
                        const backoff = 400 * attempt * attempt + Math.floor(Math.random() * 200);
                        await new Promise(r => setTimeout(r, backoff));
                    } finally {
                        clearTimeout(firstByteTimer);
                        if (signal) signal.removeEventListener('abort', onParentAbort);
                    }
                }
            }

            // All models exhausted with no content streamed.
            throw lastError || new Error('AI generation failed after exhausting fallback chain');
        } catch (apiError) {
            if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
                console.warn(`AI stream aborted by client for provider: ${provider}.`);
                return fullResponseContent;
            }
            console.error(`❌ Error from ${provider} API:`, apiError.message || apiError);

            // If we already streamed part of the answer, append a short,
            // in-language note so the user understands why the reply cut off,
            // instead of just getting a silent truncation.
            if (hasStreamedAnyContent) {
                const note = '\n\n' + getFallbackMessage(language);
                try { res.write(`data: ${JSON.stringify({ content: note })}\n\n`); } catch { /* socket may be gone */ }
                return fullResponseContent + note;
            }

            // Nothing was streamed — deliver a professional fallback as the
            // assistant's reply AND surface the technical error on a side
            // channel so the UI can toast/retry if it wants to.
            const fallback = getFallbackMessage(language);
            try {
                res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
                res.write(`data: ${JSON.stringify({ error: `AI service (${provider}) is temporarily unavailable.`, recovered: true })}\n\n`);
            } catch { /* socket may be gone */ }
            return fallback;
        } finally {
            clearInterval(heartbeat);
            // Signal end-of-stream so the client can cleanly close its
            // reader and unblock the composer. Swallow write errors — the
            // socket may already be gone if the client aborted.
            try { res.write(`data: [DONE]\n\n`); } catch { /* socket gone */ }
        }
    }

    /**
     * Run a single corrective pass when the primary response was flagged
     * as weak (refusal template, too short, empty). Uses a one-shot
     * non-streaming completion so we can validate the length before
     * committing it back to the user's chat stream. This is NOT streamed
     * to the UI — the caller streams the returned string itself.
     */
    async _runCorrectivePass({ provider, model, baseMessages, userPrompt, language, signal }) {
        try {
            const client = this.getClient(provider);
            const correctivePrompt = buildCorrectivePrompt(userPrompt || '', language);
            const messages = [
                ...baseMessages.slice(0, -1),
                { role: 'user', content: correctivePrompt },
            ];
            const resp = await client.chat.completions.create(
                { model, messages, stream: false },
                { signal }
            );
            return resp.choices?.[0]?.message?.content || '';
        } catch (err) {
            console.warn('corrective pass failed:', err.message || err);
            return '';
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
    /**
     * Generate a Vector-based PowerPoint presentation (Gamma-style)
     * @param {string} prompt - User's request for PPT content
     * @param {string} provider - AI provider to use
     * @param {string} model - AI model to use
     * @returns {Promise<object>} - Generated Vector PPT file information
     */
    async generateVectorPPT(prompt, provider = "OpenAI", model = "gpt-4o") {
        try {
            console.log('🎨 Starting VECTOR presentation generation (Gamma-style)...');
            return await vectorPPTService.generateVectorPresentation(prompt, provider, model);
        } catch (error) {
            console.error('❌ Error generating vector PPT:', error);
            throw error;
        }
    }

    /**
     * Generate a PowerPoint presentation using AI (WITH IMAGES - OLD VERSION)
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
