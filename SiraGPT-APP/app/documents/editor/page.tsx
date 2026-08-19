"use client";

import React from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';

// WordConnector pulls in @tiptap/* + docx, both >100KB minified and
// only needed once the user opens the full-page editor. Loading it
// dynamically keeps the route shell light (no Tiptap on first paint).
const WordConnector = dynamic(
  () => import('@/components/WordConnector').then((m) => m.WordConnector),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full flex-col gap-3 p-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    ),
  }
);

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
                onGenerateContent={() => undefined}
                isFullPage={true}
            />
        </div>
    );
}
