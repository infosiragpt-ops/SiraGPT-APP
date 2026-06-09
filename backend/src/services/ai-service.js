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
const { getBreaker, CircuitBreakerError } = require('./circuit-breaker');
const {
    buildProviderChatPayload,
    classifyProviderError,
} = require('./ai-product-os/litellm-gateway');
const { applyAnthropicCacheToMessages } = require('./anthropic-cache-formatter');
const { attachConversationSummary } = require('./conversation-summarizer');

let __anthropicSummarizerClient = null;
function getAnthropicSummarizerClient() {
    if (__anthropicSummarizerClient) return __anthropicSummarizerClient;
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.SIRA_ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    try {
        const Anthropic = require('@anthropic-ai/sdk');
        __anthropicSummarizerClient = new Anthropic({ apiKey, fetch: sharedFetch });
        return __anthropicSummarizerClient;
    } catch (err) {
        console.warn('[conversation-summarizer] anthropic client init failed:', err?.message || err);
        return null;
    }
}
const { GEMA4_MODEL_ID } = require('./plan-credits-catalog');
const { sharedFetch } = require('../utils/provider-http-agent');

const HEARTBEAT_INTERVAL_MS = 15000;

// Bounded timeout (ms) for the direct OpenAI REST calls made through axios
// (container file upload + code-interpreter image download). The OpenAI SDK
// client has its own timeout, but these two raw axios calls did not — a
// stalled TCP connection or an unresponsive endpoint would hang the whole
// request indefinitely, tying up the handler. Configurable via
// SIRAGPT_OPENAI_HTTP_TIMEOUT_MS, clamped to [1s, 10min]; default 2min to
// accommodate large file transfers.
const OPENAI_HTTP_TIMEOUT_MS = (() => {
    const raw = Number(process.env.SIRAGPT_OPENAI_HTTP_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000) return Math.floor(raw);
    return 120_000;
})();

/**
 * writeWithBackpressure — write a frame to an Express response and, if
 * the kernel send buffer is full, await the `drain` event before
 * resolving. Returning the awaitable from inside the provider read loop
 * propagates pause-pressure naturally: the OpenAI/undici reader stops
 * pulling bytes from the upstream socket while we wait. Without this we
 * would queue chunks in V8 indefinitely on slow clients (mobile uplink,
 * large HTML artifacts, etc.) and trade latency for memory.
 */
function writeWithBackpressure(res, frame) {
    if (!res || res.writableEnded || res.destroyed) return Promise.resolve(false);
    let ok;
    try { ok = res.write(frame); }
    catch { return Promise.resolve(false); }
    if (ok !== false) return Promise.resolve(true);
    return new Promise((resolve) => {
        const cleanup = () => {
            res.off?.('drain', onDrain);
            res.off?.('close', onTerminal);
            res.off?.('error', onTerminal);
        };
        const onDrain = () => { cleanup(); resolve(true); };
        const onTerminal = () => { cleanup(); resolve(false); };
        res.on('drain', onDrain);
        res.on('close', onTerminal);
        res.on('error', onTerminal);
    });
}

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
            defaults.push('moonshotai/kimi-k2.6');
        }
        if (process.env.DEEPSEEK_API_KEY) {
            defaults.push('deepseek-v4-flash');
        }
        if (process.env.GEMINI_API_KEY) {
            defaults.push('gemini-2.5-flash');
        }
        defaults.push('gpt-3.5-turbo');
        return [...new Set(defaults)];
    }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Siragpt 1.0 — modelo combinado ──────────────────────────
// Base de razonamiento: openai/gpt-oss-120b vía OpenRouter.
// Preprocesador de visión: gemini-2.5-flash-lite vía Gemini directo.
// Cuando el usuario envía imágenes con siragpt-1.0, primero las describimos
// con Gemini y el texto resultante se inyecta en el prompt antes de llamar
// al modelo base (que no soporta visión).
const SIRAGPT_COMBINED_ID = 'siragpt-1.0';
const SIRAGPT_BASE_MODEL = 'openai/gpt-oss-120b';
const SIRAGPT_VISION_MODEL = 'gemini-2.5-flash-lite';

function isSiragptCombined(model) {
    if (!model) return false;
    return /^siragpt-1(\.0)?$/i.test(String(model).trim());
}

/**
 * Route a model name to the provider the siraGPT backend uses for it.
 * Keeps the fallback chain provider-agnostic: the caller passes a list of
 * model names and we figure out which SDK base URL + key to use.
 */
function providerForModel(model) {
    if (!model) return 'OpenAI';
    const m = String(model).trim();
    const configuredGema4Model = String(process.env.GEMA4_MODEL_ID || GEMA4_MODEL_ID).trim();
    if (m === configuredGema4Model || /^gema4[-\s]?31b$/i.test(m)) {
        return process.env.GEMA4_PROVIDER || 'OpenAI';
    }
    if (isSiragptCombined(m)) return 'OpenRouter';
    if (/^deepseek-(v\d|chat|reasoner)/i.test(m)) return 'DeepSeek';
    if (/^(claude|anthropic\/)/i.test(m)) return 'OpenRouter';
    if (/^(openai|google|x-ai|openrouter|meta-llama|deepseek|mistralai|qwen|z-ai|nvidia|microsoft|cohere|moonshotai)\//i.test(m)) return 'OpenRouter';
    if (/^\/?(gpt-oss|zephyr)/i.test(m)) return 'OpenRouter';
    if (/^(gemini|imagen)/i.test(m)) return 'Gemini';
    return 'OpenAI';
}

function normalizeChatProvider(provider, model) {
    const p = String(provider || '').trim();
    if (/^anthropic$/i.test(p)) return 'OpenRouter';
    if (!p) return providerForModel(model);
    return p;
}

function normalizeModelForProvider(provider, model) {
    const m = String(model || '').trim();
    if (!m) return m;
    if (/^openrouter$/i.test(String(provider || '')) && /^claude/i.test(m) && !m.includes('/')) {
        return `anthropic/${m}`;
    }
    return m;
}

function modelSupportsVision(provider, model) {
    const normalizedProvider = String(provider || '').toLowerCase();
    const normalizedModel = String(model || '').toLowerCase();

    if (normalizedProvider === 'deepseek') return false;
    if (normalizedProvider === 'gemini') return /^gemini/.test(normalizedModel);
    if (normalizedProvider === 'openai') {
        return /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision)/i.test(normalizedModel);
    }
    if (normalizedProvider === 'openrouter') {
        return /(gpt-4o|gpt-4\.1|gpt-5|gemini|claude|qwen.*vl|vision|llava|pixtral)/i.test(normalizedModel);
    }
    return false;
}

function selectVisionRuntime(provider, model) {
    if (modelSupportsVision(provider, model)) {
        return { provider, model, switched: false };
    }
    if (process.env.OPENAI_API_KEY) {
        return {
            provider: 'OpenAI',
            model: process.env.VISION_MODEL || 'gpt-4o-mini',
            switched: true,
        };
    }
    if (process.env.GEMINI_API_KEY) {
        return {
            provider: 'Gemini',
            model: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
            switched: true,
        };
    }
    if (process.env.OPENROUTER_API_KEY) {
        return {
            provider: 'OpenRouter',
            model: process.env.OPENROUTER_VISION_MODEL || 'openai/gpt-4o-mini',
            switched: true,
        };
    }
    return { provider, model, switched: false };
}

function shouldAttachVisionContent(provider, model, visionRuntime = selectVisionRuntime(provider, model)) {
    return Boolean(visionRuntime && visionRuntime.switched) || modelSupportsVision(provider, model);
}

/**
 * Classify a provider error as transient (safe to retry) vs terminal.
 * Transient: rate limits (429), request timeouts (408), server errors
 * (500-504), and network-level failures. Terminal errors (401 auth,
 * 400 bad request, content-filter refusals) are NOT retried — retrying
 * them won't change the outcome and just delays the user-facing error.
 */
function isTransientProviderError(err) {
    if (!err || err.name === 'AbortError') return false;
    return classifyProviderError(err).retryable === true;
}

function currentThinkingLevel() {
    return process.env.SIRA_THINKING_LEVEL || process.env.DEEPSEEK_V4_THINKING || 'high';
}

function normalizeTemperature(value, fallback = 0.55) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(2, Math.max(0, numeric));
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
     * Devuelve el cliente de IA correctamente configurado según el nombre del proveedor.
     * @param {string} provider - Nombre del proveedor (p. ej. "OpenAI", "Gemini", "OpenRouter")
     * @returns {OpenAI} - Instancia del cliente de OpenAI
     */
    getClient(provider) {
        // Route every provider through the shared keep-alive fetch so we
        // amortize TLS handshakes across requests. See provider-http-agent.js.
        const baseOpts = { fetch: sharedFetch };

        if (provider === "Gemini") {
            return new OpenAI({
                ...baseOpts,
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });
        }

        if (provider === "OpenRouter") {
            return new OpenAI({
                ...baseOpts,
                apiKey: process.env.OPENROUTER_API_KEY,
                baseURL: "https://openrouter.ai/api/v1",
                defaultHeaders: {
                    'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
                    'X-Title': 'SiraGPT',
                },
            });
        }

        if (provider === "DeepSeek") {
            return new OpenAI({
                ...baseOpts,
                apiKey: process.env.DEEPSEEK_API_KEY,
                baseURL: "https://api.deepseek.com",
            });
        }

        // Proveedor por defecto: OpenAI
        return new OpenAI({
            ...baseOpts,
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
     * Genera la respuesta de la IA y la envía al cliente mediante streaming.
     * @param {object} options - Objeto de opciones
     * @param {string} options.provider - Proveedor a utilizar
     * @param {string} options.model - Modelo a utilizar
     * @param {Array<object>} options.messages - Array de mensajes a enviar a la IA
     * @param {import('express').Response} options.res - Objeto Express response sobre el que se hará el streaming
     * @param {Array<object>} options.files - Array de archivos subidos (opcional)
     * @returns {Promise<string>} - Contenido completo generado
     */
    /**
     * Siragpt 1.0 — preprocesa imágenes adjuntas con Gemini 2.5 Flash Lite
     * y devuelve una descripción de texto. La descripción se inyecta en el
     * último mensaje del usuario y las imágenes se quitan del payload para
     * que el modelo base (openai/gpt-oss-120b, solo texto) pueda responder.
     * Devuelve null si Gemini falla; el caller decide cómo degradar.
     */
    async describeImagesWithGemini(imageFiles, userText) {
        if (!process.env.GEMINI_API_KEY) {
            console.warn('[siragpt-1.0] GEMINI_API_KEY no configurada — no se puede preprocesar visión');
            return null;
        }
        try {
            const client = this.getClient('Gemini');
            const contentArray = [{
                type: 'text',
                text: `Describe en español, con detalle y precisión, lo que aparece en la(s) imagen(es) adjunta(s). ` +
                    `Si contienen texto, transcríbelo literalmente preservando saltos de línea. ` +
                    `Si contienen ecuaciones, formúlalas en LaTeX. ` +
                    `Si es un diagrama, describe su estructura. ` +
                    `Pregunta original del usuario para contexto: "${(userText || '').slice(0, 500)}"`,
            }];
            for (const f of imageFiles) {
                const img = await this.prepareImageForVision(f.path, f.mimeType);
                if (img) contentArray.push(img);
            }
            const completion = await client.chat.completions.create({
                model: SIRAGPT_VISION_MODEL,
                messages: [{ role: 'user', content: contentArray }],
                stream: false,
                temperature: 0.2,
            });
            const text = completion?.choices?.[0]?.message?.content || '';
            return typeof text === 'string' ? text.trim() : null;
        } catch (err) {
            console.error('[siragpt-1.0] Fallo preprocesando imágenes con Gemini:', err?.message || err);
            return null;
        }
    }

    /**
     * Describe imágenes adjuntas con el runtime de visión que esté
     * configurado (OpenAI → Gemini → OpenRouter, según selectVisionRuntime).
     * A diferencia de describeImagesWithGemini, no depende de una key
     * concreta. Devuelve la descripción en texto o null si no hay proveedor
     * de visión disponible o la llamada falla; el caller decide cómo degradar.
     * @param {Array<{path: string, mimeType: string}>} imageFiles
     * @param {string} userText - pregunta original del usuario (contexto)
     */
    async describeAttachedImages(imageFiles, userText) {
        const runtime = selectVisionRuntime('', '');
        if (!runtime.switched) {
            console.warn('[vision-describe] sin proveedor de visión configurado — no se pueden describir imágenes');
            return null;
        }
        try {
            const client = this.getClient(runtime.provider);
            const contentArray = [{
                type: 'text',
                text: `Describe en español, con detalle y precisión, lo que aparece en la(s) imagen(es) adjunta(s). ` +
                    `Si contienen texto, transcríbelo literalmente preservando saltos de línea. ` +
                    `Si contienen ecuaciones, formúlalas en LaTeX. ` +
                    `Si es un diagrama, logotipo o ilustración, describe su estructura, formas y colores. ` +
                    `Pregunta original del usuario para contexto: "${(userText || '').slice(0, 500)}"`,
            }];
            for (const f of imageFiles) {
                const img = await this.prepareImageForVision(f.path, f.mimeType);
                if (img) contentArray.push(img);
            }
            if (contentArray.length === 1) return null;
            const completion = await client.chat.completions.create({
                model: runtime.model,
                messages: [{ role: 'user', content: contentArray }],
                stream: false,
                temperature: 0.2,
            });
            const text = completion?.choices?.[0]?.message?.content || '';
            return typeof text === 'string' && text.trim() ? text.trim() : null;
        } catch (err) {
            console.error('[vision-describe] fallo describiendo imágenes:', err?.message || err);
            return null;
        }
    }

    async generateStream({ provider, model, messages, systemBlocks, chatId, res, signal, streamId, files, language = 'es', userPrompt = '', qualityGuard = true, temperature = 0.55, skipDoneSentinel = false }) {
        // ── Siragpt 1.0 — modelo combinado ──
        // Si el caller pidió siragpt-1.0 y hay imágenes adjuntas, las
        // describimos primero con Gemini 2.5 Flash Lite, inyectamos la
        // descripción en el último mensaje y vaciamos `files` para que el
        // pipeline siguiente trate la conversación como texto puro. Luego
        // remapeamos a openai/gpt-oss-120b vía OpenRouter (modelo base).
        if (isSiragptCombined(model)) {
            const imageFiles = Array.isArray(files)
                ? files.filter(f => f && f.mimeType && f.mimeType.startsWith('image/'))
                : [];
            if (imageFiles.length > 0) {
                const lastMsg = messages[messages.length - 1];
                const userText = typeof lastMsg?.content === 'string'
                    ? lastMsg.content
                    : (Array.isArray(lastMsg?.content)
                        ? (lastMsg.content.find(p => p.type === 'text')?.text || '')
                        : '');
                console.log(`[siragpt-1.0] Preprocesando ${imageFiles.length} imagen(es) con ${SIRAGPT_VISION_MODEL}`);
                const description = await this.describeImagesWithGemini(imageFiles, userText);
                if (description) {
                    const block = `\n\n[Análisis visual realizado por Gemini 2.5 Flash Lite sobre ${imageFiles.length} imagen(es) adjunta(s):]\n${description}\n[Fin del análisis visual]`;
                    if (lastMsg) lastMsg.content = (userText || '') + block;
                } else {
                    if (lastMsg) lastMsg.content = (userText || '') +
                        `\n\n[No se pudo analizar la(s) imagen(es) adjunta(s). Responde sobre el texto disponible.]`;
                }
                // Vaciar files: el modelo base no soporta visión.
                files = [];
            }
            provider = 'OpenRouter';
            model = SIRAGPT_BASE_MODEL;
        }

        provider = normalizeChatProvider(provider, model);
        model = normalizeModelForProvider(provider, model);
        let fullResponseContent = '';
        let hasStreamedAnyContent = false;
        const normalizedTemperature = normalizeTemperature(temperature);

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

        // Conversation summarizer — when fitMessagesToContext drops the
        // middle of a long thread, replace the static "[Nota interna: se
        // omitieron N mensaje(s)]" breadcrumb with a real LLM-generated
        // summary so the model regains context about what was discussed
        // in the gap. Best-effort: silent fallback on any failure keeps
        // us on the original breadcrumb.
        if (fit.droppedCount > 0 && Array.isArray(fit.droppedMessages) && fit.droppedMessages.length > 0) {
            try {
                const summaryResult = await attachConversationSummary({
                    messages: workingMessages,
                    droppedMessages: fit.droppedMessages,
                    chatId: chatId || `anon:${streamId || 'x'}`,
                    language,
                    anthropicClient: getAnthropicSummarizerClient(),
                });
                if (summaryResult.applied) {
                    workingMessages = summaryResult.messages;
                    console.log(`📚 conversation summary: applied reason=${summaryResult.reason} dropped=${fit.droppedCount}`);
                } else if (summaryResult.reason && summaryResult.reason !== 'no_breadcrumb' && summaryResult.reason !== 'no_dropped') {
                    console.log(`📚 conversation summary: skipped reason=${summaryResult.reason}`);
                }
            } catch (_summarizerErr) { /* keep the original breadcrumb */ }
        }

        // Anthropic prompt-cache hook. When the caller supplied
        // `systemBlocks` (the structured form of the system prompt) and
        // the downstream provider is Anthropic — directly or via
        // OpenRouter routed to Claude — rewrite the leading system
        // message into content-block form so the gateway can place
        // `cache_control: { type: 'ephemeral' }` markers on the stable
        // groups (master rules, persona, project, user profile,
        // memory). For every other provider this is a no-op.
        if (Array.isArray(systemBlocks) && systemBlocks.length > 0) {
            const cacheAttempt = applyAnthropicCacheToMessages(workingMessages, systemBlocks, { provider, model });
            if (cacheAttempt.applied) {
                workingMessages = cacheAttempt.messages;
                console.log(`🧊 anthropic cache: applied=${cacheAttempt.applied} breakpoints=${cacheAttempt.breakpoints} provider=${provider} model=${model}`);
            }
        }

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

                    // Add hard vision instructions so text-only fallback answers
                    // never claim the uploaded image cannot be processed.
                    const mathInstructionText = textContent +
                        '\n\nIMAGE PROCESSING CONTRACT: The uploaded image(s) are attached to this same message as vision inputs. ' +
                        'Inspect those image inputs directly. If the user asks to transcribe, return the visible text exactly and preserve line breaks when useful. ' +
                        'Do not say that images cannot be processed unless every image attachment failed to load server-side.' +
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

                    if (contentArray.some(part => part.type === 'image_url')) {
                        const visionRuntime = selectVisionRuntime(provider, model);
                        if (shouldAttachVisionContent(provider, model, visionRuntime)) {
                            if (visionRuntime.switched) {
                                console.log(`[vision] Routing image turn through vision-capable runtime: ${provider}:${model} -> ${visionRuntime.provider}:${visionRuntime.model}`);
                                provider = visionRuntime.provider;
                                model = visionRuntime.model;
                            } else {
                                console.log(`[vision] Using selected vision-capable runtime: ${provider}:${model}`);
                            }
                            lastMessage.content = contentArray;
                        } else {
                            const imageCount = contentArray.filter(p => p.type === 'image_url').length;
                            const imageNames = imageFiles.map(f => f.name || f.originalName || 'imagen').join(', ');
                            console.warn(`[vision] No vision-capable model available for ${provider}:${model} — stripping ${imageCount} image(s) from message`);
                            const textPart = contentArray.find(p => p.type === 'text');
                            const notice = `\n\n[El usuario adjuntó ${imageCount} imagen(es): ${imageNames}. Este modelo no soporta entrada de imagen, por lo que las imágenes no pudieron ser procesadas. Responde basándote en el texto disponible.]`;
                            lastMessage.content = (textPart?.text || '') + notice;
                        }
                    } else {
                        lastMessage.content = contentArray;
                    }
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
                const currentRuntimeModel = normalizeModelForProvider(currentProvider, currentModel);
                // OpenRouter reasoning models (gpt-oss family) stream their
                // chain-of-thought in `delta.reasoning` and leave `delta.content`
                // empty until the very end. Asking OpenRouter to exclude the
                // reasoning makes the model still think internally but only
                // stream the final answer, so the user sees tokens immediately
                // instead of hitting the 30s first-byte timeout.
                const extraPayload = { temperature: normalizedTemperature };
                if (currentProvider === 'OpenRouter' && /gpt-oss/i.test(currentRuntimeModel)) {
                    extraPayload.reasoning = { exclude: true };
                }
                const providerPayload = buildProviderChatPayload({
                    provider: currentProvider,
                    model: currentRuntimeModel,
                    messages: workingMessages,
                    stream: true,
                    thinkingLevel: currentThinkingLevel(),
                    extra: extraPayload,
                });
                const payload = providerPayload.payload;

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
                        // Per-(provider, model) circuit breaker: if a provider
                        // has been failing consistently, short-circuit the call
                        // so we move to the next model in the chain instantly
                        // instead of waiting for another timeout. On recovery,
                        // a single probe call flips us back to CLOSED.
                        const breaker = getBreaker(`${currentProvider}:${currentRuntimeModel}`, {
                            failureThreshold: 5,
                            resetTimeoutMs: 60_000,
                        });
                        const stream = await breaker.execute(() =>
                            client.chat.completions.create(payload, { signal: attemptCtrl.signal })
                        );

                        for await (const chunk of stream) {
                            const delta = chunk.choices[0]?.delta || {};
                            // DeepSeek emits `reasoning_content`; OpenRouter emits `reasoning`.
                            // Tracking both prevents the first-byte timeout from firing while
                            // a reasoning model is still in its internal-thinking phase.
                            const reasoningChunk = delta.reasoning_content || delta.reasoning || '';
                            const contentChunk = delta.content || '';
                            if (reasoningChunk && !firstByteSeen) {
                                firstByteSeen = true;
                                clearTimeout(firstByteTimer);
                            }
                            if (contentChunk) {
                                if (!firstByteSeen) { firstByteSeen = true; clearTimeout(firstByteTimer); }
                                fullResponseContent += contentChunk;
                                hasStreamedAnyContent = true;
                                await writeWithBackpressure(res, `data: ${JSON.stringify({ content: contentChunk })}\n\n`);
                            }
                        }

                        if (!hasStreamedAnyContent) {
                            throw Object.assign(new Error('Empty completion — model returned no content'), { code: 'EMPTY_COMPLETION' });
                        }
                        // Whitespace/punctuation-only deltas count as empty:
                        // the provider streamed bytes but no actual answer.
                        // Reset accumulators AND emit a clear-frame so the
                        // retry / fallback chain starts clean instead of
                        // appending the next answer to a leading space.
                        if (!fullResponseContent.replace(/[\s.,!?¿¡:;\-—…“”"'`()\[\]{}]+/g, '')) {
                            try { res.write(`data: ${JSON.stringify({ replace: true, content: '' })}\n\n`); } catch { /* socket gone */ }
                            fullResponseContent = '';
                            hasStreamedAnyContent = false;
                            throw Object.assign(new Error('Empty completion — model streamed only whitespace'), { code: 'EMPTY_COMPLETION' });
                        }

                        console.log(`✅ Response on ${currentProvider}:${currentRuntimeModel} attempt ${attempt} (${fullResponseContent.length} chars)`);

                        // Quality guard — rule #10 of the spec. Runs once,
                        // after a successful primary stream. If the reply
                        // looks weak (refusal template, too short for a
                        // non-yes/no question, punctuation-only), we kick
                        // off a corrective non-streaming pass and, if it
                        // produced something richer, replace the already
                        // streamed text in the UI and persist that corrected
                        // version as the final assistant message.
                        if (qualityGuard) {
                            const verdict = evaluateResponse({ response: fullResponseContent, userPrompt });
                            if (verdict.weak) {
                                console.warn(`🧪 quality-guard flagged: ${verdict.reason} — running corrective pass`);
                                const corrected = await this._runCorrectivePass({
                                    provider: currentProvider,
                                    model: currentRuntimeModel,
                                    baseMessages: workingMessages,
                                    userPrompt,
                                    language,
                                    signal,
                                    temperature: normalizedTemperature,
                                });
                                const cleanCorrected = (corrected || '').trim();
                                const correctedVerdict = evaluateResponse({ response: cleanCorrected, userPrompt });
                                const longEnoughToReplace = cleanCorrected.length >= Math.max(40, Math.floor(fullResponseContent.trim().length * 0.8));
                                if (cleanCorrected && !correctedVerdict.weak && longEnoughToReplace) {
                                    res.write(`data: ${JSON.stringify({ replace: true, content: cleanCorrected })}\n\n`);
                                    fullResponseContent = cleanCorrected;
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
                        // Empty-completion reset (above) already cleared
                        // hasStreamedAnyContent + fullResponseContent, so
                        // this guard naturally lets EMPTY_COMPLETION fall
                        // into the retry/fallback path. Defensive check in
                        // case a future refactor reorders things.
                        if (hasStreamedAnyContent && err.code !== 'EMPTY_COMPLETION') throw err;

                        // CircuitBreakerError means this provider is currently
                        // shorted. Don't waste retries here — fall straight to
                        // the next model in the chain.
                        if (err instanceof CircuitBreakerError) {
                            console.warn(`⚡ ${currentProvider}:${currentModel} breaker OPEN (next probe at ${err.nextAttemptAt.toISOString()}) — skipping to fallback`);
                            break;
                        }

                        const retryable = isOurTimeout || isTransientProviderError(err) || err.code === 'EMPTY_COMPLETION';
                        const isLastAttemptForModel = attempt >= MAX_ATTEMPTS_PER_MODEL;
                        const classified = classifyProviderError(err);
                        const reason = isOurTimeout ? 'first-byte timeout' : (classified.error_class || err.status || err.code || err.name || 'unknown');
                        console.warn(`⚠️ ${currentProvider}:${currentRuntimeModel} attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL} failed (${reason}): ${err.message}${retryable && !isLastAttemptForModel ? ' — retrying' : (m < modelChain.length - 1 ? ' — falling back' : '')}`);

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
            // reader and unblock the composer. When skipDoneSentinel is
            // set the caller (route handler) writes [DONE] after DB
            // persistence so the client doesn't race a selectChat before
            // the assistant message is committed.
            if (!skipDoneSentinel) {
              try { res.write(`data: [DONE]\n\n`); } catch { /* socket gone */ }
            }
        }
    }

    /**
     * Run a single corrective pass when the primary response was flagged
     * as weak (refusal template, too short, empty). Uses a one-shot
     * non-streaming completion so we can validate the length before
     * committing it back to the user's chat stream. This is NOT streamed
     * to the UI — the caller streams the returned string itself.
     */
    async _runCorrectivePass({ provider, model, baseMessages, userPrompt, language, signal, temperature = 0.55 }) {
        // The corrective pass runs AFTER the user-visible stream finished, on
        // the same SSE connection — the client only gets [DONE] (and
        // un-pins the stop button) when this returns. Without a hard ceiling,
        // a slow non-streaming completion can keep the composer locked for
        // 30-60s even though the response is already on screen. Cap at
        // CORRECTIVE_PASS_TIMEOUT_MS (env-tunable, default 8s) and silently
        // bail — the original streamed answer stays as-is, and [DONE] fires
        // promptly so the UI returns to send-mode.
        const TIMEOUT_MS = Number(process.env.CORRECTIVE_PASS_TIMEOUT_MS) || 8000;
        const timeoutCtrl = new AbortController();
        const timer = setTimeout(() => timeoutCtrl.abort(new Error('corrective_pass_timeout')), TIMEOUT_MS);
        const onParentAbort = () => timeoutCtrl.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) timeoutCtrl.abort(signal.reason);
            else signal.addEventListener('abort', onParentAbort, { once: true });
        }
        try {
            const client = this.getClient(provider);
            const correctivePrompt = buildCorrectivePrompt(userPrompt || '', language);
            const messages = [
                ...baseMessages.slice(0, -1),
                { role: 'user', content: correctivePrompt },
            ];
            const providerPayload = buildProviderChatPayload({
                provider,
                model,
                messages,
                stream: false,
                thinkingLevel: currentThinkingLevel(),
                extra: { temperature: normalizeTemperature(temperature) },
            });
            const resp = await client.chat.completions.create(
                providerPayload.payload,
                { signal: timeoutCtrl.signal }
            );
            return resp.choices?.[0]?.message?.content || '';
        } catch (err) {
            const wasTimeout = timeoutCtrl.signal.aborted && err?.name === 'AbortError'
                && !signal?.aborted;
            if (wasTimeout) {
                console.warn(`corrective pass abandoned after ${TIMEOUT_MS}ms — returning original response`);
            } else {
                console.warn('corrective pass failed:', err.message || err);
            }
            return '';
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onParentAbort);
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
                    // gemini-2.5-flash-image-preview → 404 on this account;
                    // gemini-2.5-flash-image is the current edit model.
                    model: "gemini-2.5-flash-image",
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
    async generateImage(prompt, provider = "OpenAI", model = "gpt-image-2") {
        try {
            const client = this.getClient(provider);
            console.log(`🎨 Generating image with gpt-image-2 for prompt: "${prompt}"`);

            const response = await client.images.generate({
                // dall-e-3 was removed from this account (400 model does not
                // exist) → default to gpt-image-2, which REJECTS response_format
                // (b64_json by default) and only accepts auto/high/medium/low
                // quality (rejects 'standard'/'hd').
                model: model,
                prompt: prompt,
                n: 1,
                size: "1024x1024",
                quality: "auto",
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
                timeout: OPENAI_HTTP_TIMEOUT_MS,
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
                                        responseType: 'arraybuffer',
                                        timeout: OPENAI_HTTP_TIMEOUT_MS,
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

const service = new AIService();
service.__test = {
    modelSupportsVision,
    selectVisionRuntime,
    shouldAttachVisionContent,
    providerForModel,
    normalizeChatProvider,
    normalizeModelForProvider,
};
service.modelSupportsVision = modelSupportsVision;
service.selectVisionRuntime = selectVisionRuntime;
service.OPENAI_HTTP_TIMEOUT_MS = OPENAI_HTTP_TIMEOUT_MS;

module.exports = service;
