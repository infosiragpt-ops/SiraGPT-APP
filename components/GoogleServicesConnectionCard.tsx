'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, FolderOpen, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface GoogleServicesConnectionCardProps {
    onConnectionChange?: (isConnected: boolean) => void;
}

export default function GoogleServicesConnectionCard({ onConnectionChange }: GoogleServicesConnectionCardProps) {
    const [isConnected, setIsConnected] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isConnecting, setIsConnecting] = useState(false);
    const { toast } = useToast();

    // Check connection status on mount
    useEffect(() => {
        checkConnectionStatus();
    }, []);

    const checkConnectionStatus = async () => {
        try {
            setIsLoading(true);
            const token = localStorage.getItem('auth-token');

            if (!token) {
                setIsConnected(false);
                setIsLoading(false);
                return;
            }

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/google-services/status`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                setIsConnected(data.isConnected);
                onConnectionChange?.(data.isConnected);
            }
        } catch (error) {
            console.error('Error checking Google Services status:', error);
            setIsConnected(false);
        } finally {
            setIsLoading(false);
        }
    };

    const handleConnect = async () => {
        try {
            setIsConnecting(true);
            const token = localStorage.getItem('auth-token');
            console.log('handleConnect', token);

            if (!token) {
                toast({
                    title: "Authentication Required",
                    description: "Please log in to connect Google Services",
                    variant: "destructive"
                });
                return;
            }

            // Get auth URL from backend
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/google-services`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to get auth URL');
            }

            const data = await response.json();

            // Open OAuth popup
            const popup = window.open(
                data.authUrl,
                'Google Services OAuth',
                'width=600,height=700,left=100,top=100'
            );

            // Listen for OAuth callback
            const handleMessage = (event: MessageEvent) => {
                if (event.data.status === 'success' && event.data.service === 'google_services') {
                    setIsConnected(true);
                    onConnectionChange?.(true);
                    toast({
                        title: "✅ Connected Successfully",
                        description: "Google Calendar & Drive connected! You can now manage your calendar and files with AI.",
                    });
                    checkConnectionStatus();
                } else if (event.data.status === 'error' && event.data.service === 'google_services') {
                    toast({
                        title: "Connection Failed",
                        description: "Failed to connect Google Services. Please try again.",
                        variant: "destructive"
                    });
                }
                window.removeEventListener('message', handleMessage);
                setIsConnecting(false);
            };

            window.addEventListener('message', handleMessage);

            // Check if popup was closed without completing auth
            const checkPopupClosed = setInterval(() => {
                if (popup?.closed) {
                    clearInterval(checkPopupClosed);
                    window.removeEventListener('message', handleMessage);
                    setIsConnecting(false);
                }
            }, 500);

        } catch (error) {
            console.error('Google Services connection error:', error);
            toast({
                title: "Connection Error",
                description: "An error occurred while connecting Google Services",
                variant: "destructive"
            });
            setIsConnecting(false);
        }
    };

    const handleDisconnect = async () => {
        try {
            const token = localStorage.getItem('auth-token');

            if (!token) {
                return;
            }

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/google-services/disconnect`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                setIsConnected(false);
                onConnectionChange?.(false);
                toast({
                    title: "Disconnected",
                    description: "Google Calendar & Drive disconnected successfully",
                });
            }
        } catch (error) {
            console.error('Google Services disconnection error:', error);
            toast({
                title: "Disconnection Error",
                description: "Failed to disconnect Google Services",
                variant: "destructive"
            });
        }
    };

    if (isLoading) {
        return (
            <Card className="w-full">
                <CardContent className="p-6 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="w-full border-2 hover:border-primary/50 transition-colors">
            <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                            <div className="flex gap-1">
                                <Calendar className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                <FolderOpen className="h-5 w-5 text-green-600 dark:text-green-400" />
                            </div>
                        </div>
                        <div>
                            <CardTitle className="text-lg font-semibold">
                                Google Calendar & Drive
                            </CardTitle>
                            <CardDescription className="text-sm mt-1">
                                {isConnected
                                    ? 'Connected - Manage your calendar and files with AI'
                                    : 'Connect to access your calendar and files'}
                            </CardDescription>
                        </div>
                    </div>
                    {isConnected ? (
                        <CheckCircle2 className="h-6 w-6 text-green-500 flex-shrink-0" />
                    ) : (
                        <XCircle className="h-6 w-6 text-gray-400 flex-shrink-0" />
                    )}
                </div>
            </CardHeader>

            <CardContent className="space-y-4">
                {/* Features List */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div className="flex items-start gap-2">
                        <Calendar className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                        <div>
                            <p className="font-medium">Calendar Management</p>
                            <p className="text-xs text-muted-foreground">View, create, and manage events</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-2">
                        <FolderOpen className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                        <div>
                            <p className="font-medium">File Access</p>
                            <p className="text-xs text-muted-foreground">Search and manage your documents</p>
                        </div>
                    </div>
                </div>

                {/* Example Prompts */}
                {isConnected && (
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                        <p className="text-sm font-medium flex items-center gap-2">
                            <AlertCircle className="h-4 w-4" />
                            Try asking:
                        </p>
                        <div className="space-y-1 text-xs text-muted-foreground">
                            <p>• "Show my meetings for tomorrow"</p>
                            <p>• "Create a meeting with team on Friday at 3 PM"</p>
                            <p>• "List my recent documents"</p>
                            <p>• "Find files about project Alpha"</p>
                        </div>
                    </div>
                )}

                {/* Action Button */}
                <div className="flex gap-2 pt-2">
                    {isConnected ? (
                        <Button
                            onClick={handleDisconnect}
                            variant="outline"
                            className="flex-1"
                            size="sm"
                        >
                            <XCircle className="h-4 w-4 mr-2" />
                            Disconnect
                        </Button>
                    ) : (
                        <Button
                            onClick={handleConnect}
                            disabled={isConnecting}
                            className="flex-1 bg-blue-600 hover:bg-blue-700"
                            size="sm"
                        >
                            {isConnecting ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Connecting...
                                </>
                            ) : (
                                <>
                                    <div className="flex gap-1 mr-2">
                                        <Calendar className="h-4 w-4" />
                                        <FolderOpen className="h-4 w-4" />
                                    </div>
                                    Connect Google Services
                                </>
                            )}
                        </Button>
                    )}
                </div>

                {/* Security Note */}
                <p className="text-xs text-muted-foreground text-center pt-2 border-t">
                    🔒 Your data is secure. We only access what you explicitly authorize.
                </p>
            </CardContent>
        </Card>
    );
}
