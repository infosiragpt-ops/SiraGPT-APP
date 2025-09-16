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

interface IconConfig {
    type: 'svg' | 'png';
    component?: React.ElementType<LucideProps>;
    imagePath?: string;
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
    Magic: { type: 'png', imagePath: 'icons/openai.png' },       // For GPT-4.1 if not using ChatGPTLogo

    ChatGPTLogo: { type: 'png', imagePath: '/icons/openai.png' },      // Official ChatGPT/OpenAI Logo
    DeepseekLogo: { type: 'png', imagePath: '/icons/deepseek.png' },    // Official Deepseek Logo
    GrokLogo: { type: 'png', imagePath: '/icons/grok.png' },            // Official Grok/xAI Logo
    OpenRouterLogo: { type: 'png', imagePath: '/icons/openrouter.png' }, // Official OpenRouter Logo
    GeminiLogo: { type: 'png', imagePath: '/icons/gemini.png' },        // Official Gemini/Google AI Logo
    ClaudeLogo: { type: 'png', imagePath: '/icons/claude.png' },        // Official Claude/Anthropic Logo (assuming you have this PNG)
};

// Hum LucideProps se 'name' ko hata rahe hain takay hum apni 'name' property define kar sakein.
interface IconProviderProps extends Omit<LucideProps, 'name'> {
    name: string | null | undefined;
    size?: number;
}

export const IconProvider = ({ name, size = 24, ...props }: IconProviderProps) => {
    if (!name || !iconMap[name]) {
        return <Bot size={size} {...props} />; // Default Bot icon if not found
    }

    const iconConfig = iconMap[name];

    if (iconConfig.type === 'png') {
        return (
            <div style={{ width: size, height: size, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Image
                    src={iconConfig.imagePath!}
                    alt={name}
                    width={size}
                    height={size}
                    style={{ objectFit: 'contain' }}
                />
            </div>
        );
    }

    const IconComponent = iconConfig.component!;
    return <IconComponent size={size} {...props} />;
};