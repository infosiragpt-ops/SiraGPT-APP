// file: components/thinking-placeholder.tsx
"use client"

import { Sparkles } from "lucide-react"
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
            }, 400)
        }, 2500)
        return () => clearInterval(interval)
    }, [])

    return (
        <div className="flex gap-4 my-6">
            <div className="flex flex-col w-full items-start max-w-[85%] relative">
                {/* background animated wave */}
                {/* <div className="absolute inset-0 animate-wave opacity-30 rounded-lg bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 blur-lg"></div> */}

                {/* main message bubble */}
                <div className="relative w-full rounded-lg px-5 py-4 bg-muted/80 backdrop-blur-md border border-muted-foreground/20 shadow-md transition-all duration-300">
                    <div className="flex items-center gap-3">
                        <Sparkles className="h-5 w-5 text-indigo-400 animate-pulse drop-shadow-sm" />
                        <p
                            className={clsx(
                                "text-sm text-muted-foreground transition-all duration-500",
                                fade ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
                            )}
                        >
                            {message}

                        </p>
                    </div>
                </div>
            </div>
        </div>
    )
}
