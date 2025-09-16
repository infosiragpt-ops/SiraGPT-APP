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

     calculateTextTokens(text, modelName = "gpt-3.5-turbo") {
        // YAHAN PAR TABDEELI HAI
        let modelForTiktoken;

        if (modelName.includes('/')) {
            modelForTiktoken = 'gpt-4';
        } else {
            // Agar yeh normal OpenAI model hai, to usko waise hi istemal karen.
            modelForTiktoken = modelName;
        }

        try {
            // Ab hum hamesha ek valid model name istemal kar rahe hain.
            const enc = encoding_for_model(modelForTiktoken);
            const tokens = enc.encode(text);
            enc.free(); // cleanup
            return tokens.length;
        } catch (err) {
            // Agar phir bhi koi error aaye (e.g., naya OpenAI model jo tiktoken mein nahi hai),
            // to fallback istemal karen.
            console.warn(`Tiktoken model '${modelForTiktoken}' (from '${modelName}') not found. Using fallback calculation.`);
            // fallback to rough estimate
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
