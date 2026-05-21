const { PrismaClient } = require("@prisma/client");
const { encoding_for_model } = require("tiktoken"); // import tiktoken
const prisma = new PrismaClient();

const usageService = {
    /**
     * Records the usage of a specific AI model for a user.
     */
    async recordUsage(userId, modelName, tokensUsed, costTotal) {
        try {
            // ✅ Save in ApiUsage
            await prisma.apiUsage.create({
                data: {
                    userId,
                    model: modelName,
                    tokens: tokensUsed,
                    cost: costTotal,
                },
            });

            // ✅ Update user's total usage
            await prisma.user.update({
                where: { id: userId },
                data: {
                    apiUsage: { increment: tokensUsed },
                },
            });
        } catch (error) {
            console.error("Error recording usage:", error);
            throw new Error("Failed to record usage.");
        }
    },

    /**
     * Calculates tokens for text-based AI models (Gemini, OpenAI).
     * Uses tiktoken for accurate calculation.
     */
    // calculateTextTokens(text, model = "gpt-3.5-turbo") {
    //     try {
    //         const enc = encoding_for_model(model);
    //         const tokens = enc.encode(text);
    //         enc.free(); // cleanup
    //         return tokens.length;
    //     } catch (err) {
    //         console.error("Error calculating tokens:", err);
    //         // fallback to rough estimate
    //         return Math.ceil(text.length / 4);
    //     }
    // },

    /**
     * Mapeo de nombres de modelo "lógicos" (los que viajan por nuestro chat
     * — claude-opus-4-7, deepseek-v4-flash, gemini-2.5-pro, gpt-5, …) al
     * encoder de tiktoken más cercano. tiktoken solo trae tokenizers de
     * OpenAI, así que para todo lo demás elegimos `cl100k_base` vía gpt-4
     * (suficientemente preciso para contar contexto en estimación gruesa)
     * y para variantes OpenAI nuevas las redirigimos al encoder base
     * conocido. Esto evita el ruido `Tiktoken model 'X' not found` en
     * producción sin perder precisión real (el conteo era un estimado
     * incluso cuando "funcionaba", porque para no-OpenAI no hay tokenizer
     * oficial en tiktoken).
     */
    _resolveTiktokenModel(modelName) {
        if (!modelName || typeof modelName !== 'string') return 'gpt-4';
        const m = modelName.toLowerCase();
        // OpenRouter o cualquier ruta tipo "vendor/model"
        if (m.includes('/')) return 'gpt-4';
        // Familias no-OpenAI: usamos el encoder de OpenAI como aproximación
        if (m.startsWith('claude-')) return 'gpt-4';
        if (m.startsWith('deepseek')) return 'gpt-4';
        if (m.startsWith('gemini')) return 'gpt-4';
        if (m.startsWith('llama') || m.startsWith('mistral') || m.startsWith('mixtral')) return 'gpt-4';
        if (m.startsWith('command') || m.startsWith('qwen') || m.startsWith('grok')) return 'gpt-4';
        // OpenAI nuevos (gpt-5, gpt-4.5, o3, o4, etc.) → cl100k base via gpt-4
        if (/^gpt-(5|6|7|4\.5|4o|4-1)/.test(m)) return 'gpt-4';
        if (/^o\d/.test(m)) return 'gpt-4';
        // Para el resto, intenta el nombre tal cual.
        return modelName;
    },

    calculateTextTokens(text, modelName = "gpt-3.5-turbo") {
        const modelForTiktoken = this._resolveTiktokenModel(modelName);
        try {
            const enc = encoding_for_model(modelForTiktoken);
            const tokens = enc.encode(text);
            enc.free();
            return tokens.length;
        } catch (err) {
            // Solo llegamos aquí si tiktoken no conoce ni siquiera 'gpt-4',
            // lo que no debería pasar nunca. Usamos el fallback gross.
            if (process.env.LOG_TIKTOKEN_FALLBACK === '1') {
                console.warn(`Tiktoken fallback for '${modelForTiktoken}' (from '${modelName}'): ${err?.message || err}`);
            }
            return Math.ceil(text.length / 4);
        }
    },

    /**
     * Calculates tokens for audio-based AI models (placeholder).
     */
    calculateAudioTokens(audioData) {
        if (audioData?.duration) {
            return Math.ceil(audioData.duration / 60) * 100; // 100 tokens/min
        }
        if (audioData?.textLength) {
            return this.calculateTextTokens(audioData.textLength);
        }
        return 500;
    },

    /**
     * Calculates tokens for video-based AI models (placeholder).
     */
    calculateVideoTokens(videoData) {
        if (videoData?.duration) {
            return Math.ceil(videoData.duration / 60) * 1000; // 1000 tokens/min
        }
        return 2000;
    },

    /**
     * Check if user has enough tokens.
     */
    async hasEnoughTokens(userId, requiredTokens) {
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { availableTokens: true },
            });

            if (!user) {
                console.warn(`User with ID ${userId} not found.`);
                return false;
            }

            return user.availableTokens >= requiredTokens;
        } catch (error) {
            console.error("Error checking user tokens:", error);
            throw new Error("Failed to check user tokens.");
        }
    },

    /**
     * Deduct tokens from user balance.
     */
    async deductTokens(userId, tokensToDeduct) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: {
                    availableTokens: { decrement: tokensToDeduct },
                },
            });
        } catch (error) {
            console.error("Error deducting tokens:", error);
            throw new Error("Failed to deduct tokens.");
        }
    },
};

module.exports = usageService;
