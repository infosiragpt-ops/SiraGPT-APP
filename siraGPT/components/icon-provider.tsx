// file: components/icon-provider.tsx

import {
    LucideProps,
    Bot,                // Default
    Sparkles,           // OpenAI (General/Fallback)
    Zap,                // OpenAI (General/Fallback)
    ToyBrick,           // Meta (Llama)
    MessageSquare,      // Groq / xAI (General/Fallback)
    Wind,               // Mistral
    BrainCircuit,       // Deepseek (General/Fallback)
    Code,               // Code Models
    Gem,                // Gemini (General/Fallback)
    Database,           // Databricks
    Cpu,                // NVIDIA
    Banana,             // Custom
    Palette,            // DALL-E (General/Fallback)
    Camera,             // Imagen (General/Fallback)
    Wand2,              // Stable Diffusion
    GalleryHorizontal,  // Baidu
    View,               // Microsoft
    Feather,            // Mistral Vision
    CloudSun,           // Qwen Vision
    Share2              // OpenRouter (General/Fallback)
} from "lucide-react";
import * as React from "react";
import Image from "next/image";

import { useTheme } from "next-themes";

interface IconConfig {
    type: 'svg' | 'png';
    component?: React.ElementType<LucideProps>;
    imagePath?: string;
    filter?: string;
    lightFilter?: string;
    darkFilter?: string;
    preserveColor?: boolean;
}

export const iconMap: { [key: string]: IconConfig } = {
    // --- Default ---
    Bot: { type: 'svg', component: Bot },


    Sparkles: { type: 'svg', component: Sparkles },
    Zap: { type: 'svg', component: Zap },           // OpenAI fallback
    ToyBrick: { type: 'svg', component: ToyBrick }, // Meta (Llama)
    MessageSquare: { type: 'svg', component: MessageSquare }, // xAI fallback
    Wind: { type: 'svg', component: Wind },         // Mistral
    BrainCircuit: { type: 'svg', component: BrainCircuit }, // Deepseek fallback
    Code: { type: 'svg', component: Code },         // Code Models
    Gem: { type: 'svg', component: Gem },           // Gemini fallback
    Database: { type: 'svg', component: Database }, // Databricks
    Cpu: { type: 'svg', component: Cpu },           // NVIDIA (if used)
    Share2: { type: 'svg', component: Share2 },     // OpenRouter fallback

    // --- Image Model Lucide Icons ---
    Palette: { type: 'png', imagePath: '/icons/dalle.png' },   // DALL-E fallback
    Camera: { type: 'svg', component: Camera },     // Imagen fallback
    Wand2: { type: 'svg', component: Wand2 },       // Stable Diffusion
    GalleryHorizontal: { type: 'svg', component: GalleryHorizontal }, // Baidu
    View: { type: 'svg', component: View },         // Microsoft
    Feather: { type: 'svg', component: Feather },   // Mistral Vision
    CloudSun: { type: 'svg', component: CloudSun }, // Qwen Vision

    // --- Custom PNG Icons (Make sure these paths are correct in your /public/icons folder) ---
    Banana: { type: 'png', imagePath: '/icons/banana.png' }, // Custom example
    Magic: { type: 'png', imagePath: '/icons/openai.svg', lightFilter: "none", darkFilter: "invert(1)" },

    ChatGPTLogo: { type: 'png', imagePath: '/icons/openai.svg', lightFilter: "none", darkFilter: "invert(1)" },
    ChatGPTPinkLogo: {
        type: 'png',
        imagePath: '/icons/openai.svg',
        filter: "brightness(0) saturate(100%) invert(30%) sepia(88%) saturate(2833%) hue-rotate(310deg) brightness(99%) contrast(95%)",
        preserveColor: true,
    },
    DeepseekLogo: { type: 'png', imagePath: '/icons/deepseek.png', preserveColor: true },    // DeepSeek whale icon
    GrokLogo: { type: 'png', imagePath: '/icons/grok.png', preserveColor: true },            // Official Grok/xAI Logo
    OpenRouterLogo: { type: 'png', imagePath: '/icons/openrouter.png', preserveColor: true }, // Official OpenRouter Logo
    GeminiLogo: { type: 'png', imagePath: '/icons/gemini.svg', preserveColor: true },        // Official Gemini/Google AI Logo
    ClaudeLogo: { type: 'png', imagePath: '/icons/claude.png', preserveColor: true },        // Official Claude/Anthropic Logo
    KimiLogo: { type: 'png', imagePath: '/icons/kimi.png', preserveColor: true },
    ZaiLogo: { type: 'png', imagePath: '/icons/z-ai.svg', preserveColor: true },
    SeedreamLogo: { type: 'svg', component: Palette },
    QwenLogo: { type: 'svg', component: CloudSun },
    MetaLogo: { type: 'svg', component: ToyBrick },
    MistralLogo: { type: 'svg', component: Wind },
    FalLogo: { type: 'png', imagePath: '/icons/fal.svg', preserveColor: true },
    KlingLogo: { type: 'png', imagePath: '/icons/kling.svg', preserveColor: true },
    SoraLogo: { type: 'png', imagePath: '/icons/sora.svg', preserveColor: true },
    ByteDanceLogo: { type: 'png', imagePath: '/icons/bytedance.svg', preserveColor: true },
    MiniMaxLogo: { type: 'png', imagePath: '/icons/minimax.svg', preserveColor: true },
    PixVerseLogo: { type: 'png', imagePath: '/icons/pixverse.svg', preserveColor: true },
    WanLogo: { type: 'png', imagePath: '/icons/wan.svg', preserveColor: true },
    LtxLogo: { type: 'png', imagePath: '/icons/ltx.svg', preserveColor: true },
};

// Hum LucideProps se 'name' ko hata rahe hain takay hum apni 'name' property define kar sakein.
interface IconProviderProps extends Omit<LucideProps, 'name'> {
    name: string | null | undefined;
    size?: number;
}

export const IconProvider = ({ name, size = 24, ...props }: IconProviderProps) => {

    const { theme } = useTheme();

    if (!name || !iconMap[name]) {
        return <Bot size={size} {...props} />; // Default Bot icon if not found
    }

    const iconConfig = iconMap[name];

    if (iconConfig.type === 'png') {
        const filter =
            iconConfig.filter ||
            (theme === "dark" ? iconConfig.darkFilter : iconConfig.lightFilter) ||
            "none";

        return (
            <div style={{ width: size, height: size, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Image
                    src={iconConfig.imagePath!}
                    alt={name}
                    width={size}
                    height={size}
                    style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        filter,
                    }}
                />
            </div>
        );
    }

    const IconComponent = iconConfig.component!;
    return <IconComponent size={size} {...props} />;
};
