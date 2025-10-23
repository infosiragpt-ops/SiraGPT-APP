"use client"

import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Calendar, FolderSearch } from "lucide-react";

interface ProcessingGoogleServicesCardProps {
    action: 'calendar' | 'drive';
}

const ProcessingGoogleServicesCard: React.FC<ProcessingGoogleServicesCardProps> = ({ action }) => {
    const isCalendar = action === 'calendar';

    const messages = {
        calendar: [
            "Accessing your calendar...",
            "Checking your schedule...",
            "Syncing with Google Calendar...",
        ],
        drive: [
            "Searching your Google Drive...",
            "Looking for files...",
            "Querying your documents...",
        ]
    };

    const [message, setMessage] = React.useState(messages[action][0]);

    React.useEffect(() => {
        const interval = setInterval(() => {
            setMessage(prev => {
                const currentIndex = messages[action].indexOf(prev);
                const nextIndex = (currentIndex + 1) % messages[action].length;
                return messages[action][nextIndex];
            });
        }, 2500);
        return () => clearInterval(interval);
    }, [action]);

    return (
        <Card className="w-full max-w-md mx-auto border-border/30 shadow-sm">
            <CardContent className="p-4">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-muted rounded-full">
                        {isCalendar ? (
                            <Calendar className="h-6 w-6 text-primary animate-pulse" />
                        ) : (
                            <FolderSearch className="h-6 w-6 text-primary animate-pulse" />
                        )}
                    </div>
                    <div className="flex-1">
                        <div className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            <p className="text-sm font-medium text-foreground transition-all duration-300">{message}</p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                            Please wait while we connect to your Google account.
                        </p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
};

export default ProcessingGoogleServicesCard;
