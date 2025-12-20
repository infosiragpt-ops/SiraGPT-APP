"use client";

import React from 'react';
import { WordConnector } from '@/components/WordConnector';
import { useRouter } from 'next/navigation';

export default function EditorPage() {
    const router = useRouter();

    const handleClose = () => {
        router.back();
    };

    return (
        <div className="h-screen w-full overflow-hidden">
            <WordConnector
                onClose={handleClose}
                selectedModel="gpt-4" // Default/Placeholder
                selectProvider="openai" // Default/Placeholder
                onGenerateContent={(content) => console.log('Generate:', content)}
                isFullPage={true}
            />
        </div>
    );
}
