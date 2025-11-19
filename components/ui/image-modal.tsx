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
            className="fixed inset-0 z-50 flex justify-center bg-black bg-opacity-75 overflow-y-auto"
            onClick={onClose}
        >
            <div
                className="relative max-w-4xl w-full p-4"
                onClick={(e) => e.stopPropagation()} // Prevent closing when clicking on the image
            >
                <img
                    src={imageUrl}
                    alt={altText}
                    className="w-full h-auto object-contain"
                />
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-white bg-gray-800 rounded-full p-2 hover:bg-gray-700"
                >
                    <X className="h-6 w-6" />
                </button>
            </div>
        </div>
    )
}
