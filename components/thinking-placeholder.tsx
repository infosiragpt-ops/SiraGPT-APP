// file: components/thinking-placeholder.tsx

"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Bot, Sparkles } from "lucide-react"

export const ThinkingPlaceholder = () => {
    return (
        <div className="flex gap-4 my-4">
            {/* AI ka Avatar */}
            <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    <Bot size={20} />
                </AvatarFallback>
            </Avatar>

            <div className="flex flex-col w-full items-start max-w-[85%]">
                <div className="w-full rounded-lg px-4 py-3 bg-muted">
                    {/* Shimmer Effect wala Container */}
                    <div className="animate-pulse">
                        {/* Pehli line: "Thinking..." */}
                        <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="h-4 w-4 text-muted-foreground" />
                            <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-1/4"></div>
                        </div>
                        {/* Baqi lines (placeholders) */}
                        <div className="space-y-2">
                            <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-full"></div>
                            <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-5/6"></div>
                            <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-3/4"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}