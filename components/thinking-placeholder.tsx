// file: components/thinking-placeholder.tsx
"use client"

import { useEffect, useState } from "react"
import clsx from "clsx"

const messages = [
    "Analyzing your input...",
    "Analyzing information...",
    "Processing data...",
    "Generating response...",
    "Refining answer...",
    "Almost ready...",
    "Double-checking context...",
    "Summarizing key points...",
    "Making sure everything’s accurate...",
    "Finalizing response...",
    "Done! Presenting your result..."
]

export const ThinkingPlaceholder = () => {
    const [message, setMessage] = useState(messages[0])
    const [fade, setFade] = useState(false)

    useEffect(() => {
        let index = 0
        const interval = setInterval(() => {
            setFade(true)
            setTimeout(() => {
                index = (index + 1) % messages.length
                setMessage(messages[index])
                setFade(false)
            }, 800)
        }, 2500)
        return () => clearInterval(interval)
    }, [])

    return (
        <div className="flex items-center gap-3 my-4">
            <p
                className={clsx(
                    "text-sm text-muted-foreground transition-all duration-500 animate-subtle-pulse",
                    fade ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
                )}
            >
                {message}
            </p>
        </div>
    )
}
