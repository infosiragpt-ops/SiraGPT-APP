"use client"

import * as React from "react"
import { X } from "lucide-react"

interface ImageModalProps {
    isOpen: boolean
    onClose: () => void
    imageUrl: string
    altText: string
}

export function ImageModal({ isOpen, onClose, imageUrl, altText }: ImageModalProps) {
    if (!isOpen) return null

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 md:p-8 transition-all animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                className="relative max-w-full max-h-full flex items-center justify-center outline-none"
                onClick={(e) => e.stopPropagation()}
            >
                {/* eslint-disable-next-line @next/next/no-img-element -- modal renders arbitrary upstream image URLs (uploads / mermaid.ink / data URIs); project uses images.unoptimized=true. */}
                <img
                    src={imageUrl}
                    alt={altText}
                    className="max-w-[95vw] max-h-[90vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
                />
                <button
                    onClick={onClose}
                    className="absolute -top-2 -right-2 md:-top-4 md:-right-4 text-white bg-black/50 hover:bg-black/70 rounded-full p-2 transition-colors border border-white/20 backdrop-blur-md z-10"
                >
                    <X className="h-5 w-5" />
                </button>
            </div>
        </div>
    )
}
