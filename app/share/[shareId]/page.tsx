"use client";

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { devLog } from '@/lib/dev-log';
import { toast } from 'sonner';

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function SharedChatPage() {
    const params = useParams();
    const router = useRouter();
    const shareId = params?.shareId;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const saveInProgress = useRef(false);

    useEffect(() => {
        const loadAndSaveSharedChat = async () => {
            if (!shareId) {
                setError('Invalid share link');
                setLoading(false);
                return;
            }

            // Prevent duplicate save operations
            if (saveInProgress.current || saved) {
                devLog('Save operation already in progress or completed');
                return;
            }

            saveInProgress.current = true;

            try {
                devLog('Starting shared chat save process...');
                // Get shared chat data
                const data = await apiClient.shareChatIdLink(shareId as string);
                devLog('Shared chat data:', data);

                // Automatically save to user's account
                const response = await apiClient.saveSharedContent('complete', data, data.chat?.title);
                if (response.success) {
                    devLog('Shared conversation automatically saved to account, chatId:', response.chatId);
                    setSaved(true);
                    toast.success('Shared conversation saved to your account!');
                    // Small delay to ensure toast is shown before redirect
                    setTimeout(() => {
                        devLog('Redirecting to /chat...');
                        router.push('/chat');
                        localStorage.setItem('currentChatId', String(response.chatId));
                    }, 500);
                } else {
                    setError('Failed to save shared conversation');
                    setLoading(false);
                    saveInProgress.current = false;
                }
            } catch (err: any) {
                console.error('Error loading or saving shared chat:', err);
                setError(err.message || 'Failed to load shared chat');
                setLoading(false);
                saveInProgress.current = false;
            }
        };

        loadAndSaveSharedChat();
        // Run once on mount only — re-running on shareId / router /
        // saved changes would re-execute the save flow (which mutates
        // the user's chat list) and possibly duplicate the chat.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);



    if (loading && !saved) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center space-y-4">
                    <ThinkingIndicator size="lg" className="mx-auto" />
                    <p className="text-muted-foreground">Loading shared conversation...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center space-y-4">
                    <p className="text-red-500 text-lg">Error: {error}</p>
                    <button
                        onClick={() => router.push('/chat')}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90"
                    >
                        Go to Chat
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center min-h-screen">
            <div className="text-center space-y-4">
                <ThinkingIndicator size="lg" className="mx-auto" />
                <p className="text-muted-foreground">Saving shared conversation to your account...</p>
            </div>
        </div>
    );
} 