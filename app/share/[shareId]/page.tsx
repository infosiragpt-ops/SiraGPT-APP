// File: app/share/[shareId]/page.tsx

"use client";

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown'; // Markdown ke liye
import apiClient from '@/lib/api';
import { InlineMath, BlockMath } from 'react-katex';
import 'katex/dist/katex.min.css'; // KaTeX styles
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';


// --- 👇 STEP 1: Types define karna ---
// Message ke liye type
interface SharedMessage {
    role: 'USER' | 'ASSISTANT';
    content: string;
}

// Poore Chat object ke liye type
interface SharedChat {
    title: string;
    messages: SharedMessage[];
}


// Utility to render LaTeX and Markdown content
const renderMathContent = (content: string) => {
    // Split content to handle inline ($...$) and display ($$...$$) LaTeX
    // const parts = content.split(/(\$\$[\s\S]+?\$\$|\$[\s\S]+?\$)/g);
    //   parts.map((part, index) => {
    //     if (part.startsWith('$$') && part.endsWith('$$')) {
    //         // Display math (block)
    //         return <BlockMath key={index} math={part.slice(2, -2)} />;
    //     } else if (part.startsWith('$') && part.endsWith('$')) {
    //         // Inline math
    //         return <InlineMath key={index} math={part.slice(1, -1)} />;
    //     } else {
    //         // Regular Markdown content
    //         return <ReactMarkdown key={index}>{part}</ReactMarkdown>;
    //     }
    // });

    return <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
        >
            {content}
        </ReactMarkdown>
    </div>
};

// SimpleMessage component for rendering individual messages
const SimpleMessage = ({ role, content }: SharedMessage) => {
    const isUser = role === 'USER';
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
            <div
                className={`p-3 rounded-lg max-w-2xl prose dark:prose-invert ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            >
                {renderMathContent(content)}
            </div>
        </div>
    );
};


export default function SharedChatPage() {
    const params = useParams();
    const shareId = params?.shareId;

    // --- 👇 STEP 3: useState mein type define karna ---
    // Ab 'chat' 'never' type ka nahi, balke 'SharedChat' ya 'null' type ka hai
    const [chat, setChat] = useState<SharedChat | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (shareId) {
            // Humari public API ko call karein
            apiClient.shareChatIdLink(shareId as String)

                .then(data => {
                    console.log("data ", data);

                    setChat(data.chat);
                })
                .catch(err => {
                    console.log("error  ", error);

                    setError(err.message);
                })
                .finally(() => {
                    setLoading(false);
                });
        }
    }, [shareId]);

    if (loading) return (
        <div className="flex items-center justify-center min-h-screen">
            <p>Loading shared chat...</p>
        </div>
    );

    if (error) return (
        <div className="flex items-center justify-center min-h-screen">
            <p className="text-red-500">Error: {error}</p>
        </div>
    );

    if (!chat) return null; // Ab chat 'never' type ka nahi hai, isliye error nahi aayega

    return (
        <div className="max-w-4xl mx-auto p-4 md:p-8">
            <div className="border-b pb-4 mb-6">
                <h1 className="text-3xl font-bold">{chat.title}</h1>
                <p className="text-muted-foreground">This is a shared conversation.</p>
            </div>
            <div className="space-y-6">
                {/* --- 👇 STEP 4: map ke andar type define karna --- */}
                {/* Ab 'message' 'any' type ka nahi hai */}
                {chat.messages.map((message: SharedMessage, index: number) => (
                    <SimpleMessage key={index} role={message.role} content={message.content} />
                ))}
            </div>
        </div>
    );
} 