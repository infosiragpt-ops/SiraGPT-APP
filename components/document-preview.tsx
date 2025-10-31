"use client";

import React from 'react';

interface DocumentPreviewProps {
    url: string;
    onClose: () => void;
}

export function DocumentPreview({ url, onClose }: DocumentPreviewProps) {
    if (!url) {
        return null;
    }

    const officeUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;

    return (
        <div className="relative w-full h-full bg-background">
            <div className="absolute top-2 right-2 z-10">
                <button
                    onClick={onClose}
                    className="p-1 bg-background rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Close preview"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="w-5 h-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                        />
                    </svg>
                </button>
            </div>
            <iframe
                src={officeUrl}
                width="100%"
                height="100%"
                frameBorder="0"
                title="Document Preview"
                className="w-full h-full"
            ></iframe>
        </div>
    );
}
