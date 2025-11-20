"use client";

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function SharedMessagePage() {
    const params = useParams();
    const router = useRouter();
    const shareId = params?.shareId;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const loadAndSaveSharedMessage = async () => {
            if (!shareId) {
                setError('Invalid share link');
                setLoading(false);
                return;
            }

            try {
                // Get shared message data
                const data = await apiClient.shareMessageIdLink(shareId as string);
                console.log('Shared message data:', data);
                
                // Automatically save to user's account
                const response = await apiClient.saveSharedContent('message', data, data.chatTitle || 'Shared Message');
                if (response.success) {
                    console.log('Shared message automatically saved to account');
                    toast.success('Shared message saved to your account!');
                    // Redirect to chat immediately
                    router.push('/chat');
                } else {
                    setError('Failed to save shared message');
                    setLoading(false);
                }
            } catch (err: any) {
                console.error('Error loading or saving shared message:', err);
                setError(err.message || 'Failed to load shared message');
                setLoading(false);
            }
        };

        loadAndSaveSharedMessage();
    }, [shareId, router]);



    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center space-y-4">
                    <Loader2 className="h-8 w-8 animate-spin mx-auto" />
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
                <Loader2 className="h-8 w-8 animate-spin mx-auto" />
                <p className="text-muted-foreground">Saving shared message to your account...</p>
            </div>
        </div>
    );
}