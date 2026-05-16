"use client";

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { devLog } from '@/lib/dev-log';
import { toast } from 'sonner';

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function SharedMessagePage() {
    const params = useParams();
    const router = useRouter();
    const shareId = params?.shareId;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const saveInProgress = useRef(false);

    useEffect(() => {
        const loadAndSaveSharedMessage = async () => {
            devLog('SharedMessagePage useEffect triggered, shareId:', shareId);

            if (!shareId) {
                devLog('No shareId provided');
                setError('Invalid share link');
                setLoading(false);
                return;
            }

            // Prevent duplicate save operations
            if (saveInProgress.current || saved) {
                devLog('Save operation already in progress or completed', {
                    saveInProgress: saveInProgress.current,
                    saved: saved
                });
                return;
            }

            devLog('Starting save operation...');
            saveInProgress.current = true;

            try {
                devLog('Starting shared message save process for shareId:', shareId);
                // Get shared message data
                const data = await apiClient.shareMessageIdLink(shareId as string);
                devLog('Shared message data received:', data);

                // Automatically save to user's account
                devLog('Calling saveSharedContent...');
                const response = await apiClient.saveSharedContent('message', data, data.chatTitle || 'Shared Message');
                devLog('saveSharedContent response:', response);

                if (response.success) {
                    devLog('Shared message automatically saved to account, chatId:', response.chatId);
                    setSaved(true);
                    toast.success('Shared message saved to your account!');
                    // Small delay to ensure toast is shown before redirect
                    setTimeout(() => {
                        devLog('Redirecting to /chat...');
                        router.push('/chat');
                        localStorage.setItem('currentChatId', response.chatId);
                    }, 500);
                } else {
                    console.error('Failed to save shared message:', response);
                    setError('Failed to save shared message');
                    setLoading(false);
                    saveInProgress.current = false;
                }
            } catch (err: any) {
                console.error('Error loading or saving shared message:', err);
                setError(err.message || 'Failed to load shared message');
                setLoading(false);
                saveInProgress.current = false;
            }
        };

        loadAndSaveSharedMessage();
        // Run once on mount only — re-running on shareId / router /
        // saved changes would re-execute the save flow (duplicates
        // the saved message on the user's account).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);



    if (loading && !saved) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center space-y-4">
                    <ThinkingIndicator size="lg" className="mx-auto" />
                    <p className="text-muted-foreground">Loading shared message...</p>
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
                <p className="text-muted-foreground">Saving shared message to your account...</p>
            </div>
        </div>
    );
}