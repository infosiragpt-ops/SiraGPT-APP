// file: prisma/seed.js

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// YEH AAPKI MUKAMMAL AUR FINAL LIST HAI
const modelsToSeed = [
    // ================================= //
    // ====== TEXT GENERATION MODELS ====== //
    // ================================= //

    // --- OpenAI Models (via Direct API) ---
    // Sabhi OpenAI models ke liye ChatGPTLogo ka istemal
    { name: 'gpt-5', displayName: 'GPT-5', provider: 'OpenAI', type: 'TEXT', icon: 'ChatGPTLogo', description: 'OpenAI ka agli nasl ka sabse taqatwar model.', isActive: true },
    { name: 'gpt-5-mini', displayName: 'GPT-5 Mini', provider: 'OpenAI', type: 'TEXT', icon: 'ChatGPTLogo', description: 'GPT-5 ka chota, tez aur kargar variant.', isActive: true },
    { name: 'gpt-4o', displayName: 'GPT-4o', provider: 'OpenAI', type: 'TEXT', icon: 'ChatGPTLogo', description: 'OpenAI ka omni-model jo text, audio aur vision par kaam karta hai.', isActive: true },
    { name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', provider: 'OpenAI', type: 'TEXT', icon: 'ChatGPTLogo', description: 'GPT-4o ka compact aur efficient version.', isActive: true },
    { name: 'gpt-4.1', displayName: 'GPT-4.1', provider: 'OpenAI', type: 'TEXT', icon: 'ChatGPTLogo', description: 'GPT-4 ki ek advanced aur behtar iteration.', isActive: true },

    // --- OpenRouter — unified on Kimi K2.6 (moonshotai/kimi-k2.6) ---
    {
      name: 'moonshotai/kimi-k2.6',
      displayName: 'Kimi K2.6',
      provider: 'OpenRouter',
      type: 'TEXT',
      icon: 'KimiLogo',
      description: 'Moonshot Kimi K2.6 via OpenRouter: multimodal, long context, coding and agentic tasks.',
      isActive: true,
    },

    // --- Gemini Models (via Direct API) ---
    // Sabhi Gemini models ke liye GeminiLogo ka istemal
    { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'Gemini', type: 'TEXT', icon: 'GeminiLogo', description: 'Google ka sabse capable Gemini model.', isActive: true },
    { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'Gemini', type: 'TEXT', icon: 'GeminiLogo', description: 'Google ka tez aur efficient Gemini model.', isActive: true },

    // ================================== //
    // ====== IMAGE GENERATION MODELS ====== //
    // ================================== //

    // --- OpenAI Image Models ---
    // DALL-E bhi OpenAI product hai, isliye ChatGPTLogo
    { name: 'openai/dall-e-3', displayName: 'DALL-E 3', provider: 'OpenAI', type: 'IMAGE', icon: 'ChatGPTLogo', description: 'OpenAI ka high-quality image generation model.', isActive: true },

    // --- Gemini Image Models ---
    // Imagen bhi Google/Gemini product hai, isliye GeminiLogo
    { name: 'google/imagen-3-0', displayName: 'Imagen 3', provider: 'Gemini', type: 'IMAGE', icon: 'GeminiLogo', description: 'Google ka photorealistic image generation model.', isActive: true },
];

async function main() {
    console.log(`Starting to seed ${modelsToSeed.length} curated models...`);

    for (const modelData of modelsToSeed) {
        const model = await prisma.aiModel.upsert({
            where: { name: modelData.name },
            update: modelData,
            create: modelData,
        });
        console.log(`[${model.type}] Upserted model: ${model.displayName}`);
    }

    console.log(`Seeding finished successfully.`);
}

main()
    .catch((e) => {
        console.error("Aapki seed script mein error aa gaya hai:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
