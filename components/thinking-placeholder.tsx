// // file: components/thinking-placeholder.tsx
// "use client"

// import { useEffect, useState } from "react"
// import clsx from "clsx"

// const messages = [
//     "Analyzing your input...",
//     "Analyzing information...",
//     "Processing data...",
//     "Generating response...",
//     "Refining answer...",
//     "Almost ready...",
//     "Double-checking context...",
//     "Summarizing key points...",
//     "Making sure everything’s accurate...",
//     "Finalizing response...",
//     "Done! Presenting your result..."
// ]

// export const ThinkingPlaceholder = () => {
//     const [message, setMessage] = useState(messages[0])
//     const [fade, setFade] = useState(false)

//     useEffect(() => {
//         let index = 0
//         const interval = setInterval(() => {
//             setFade(true)
//             setTimeout(() => {
//                 index = (index + 1) % messages.length
//                 setMessage(messages[index])
//                 setFade(false)
//             }, 3000)
//         }, 2500)
//         return () => clearInterval(interval)
//     }, [])

//     return (
//         <div className="flex items-center gap-3 my-4">
//             <img
//                 src="/icons/dot.png"
//                 alt="thinking icon"
//                 className="w-4 h-4 animate-heartbeat"
//             />
//             <p
//                 className={clsx(
//                     "text-sm text-muted-foreground transition-all duration-500 animate-subtle-pulse",
//                     fade ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
//                 )}
//             >
//                 {message}
//             </p>
//         </div>
//     )
// }


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
    const [phase, setPhase] = useState<"dots" | "text">("dots")
    const [message, setMessage] = useState(messages[0])
    const [fade, setFade] = useState(false)
    const [dotCount, setDotCount] = useState(1)

    // Handle dots animation for first 3 seconds
    useEffect(() => {
        if (phase === "dots") {
            const dotInterval = setInterval(() => {
                setDotCount(prev => (prev % 3) + 1)
            }, 400)

            const timeout = setTimeout(() => {
                setPhase("text")
            }, 3000)

            return () => {
                clearInterval(dotInterval)
                clearTimeout(timeout)
            }
        }
    }, [phase])

    // Handle rotating text messages after dots phase
    useEffect(() => {
        if (phase === "text") {
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
        }
    }, [phase])

    return (
        <div className="flex items-center gap-3 my-4">
            {phase === "dots" ? (
                <div className="flex space-x-1">
                    {/* {[...Array(3)].map((_, i) => (
                        <span
                            key={i}
                            className={clsx(
                                "w-2 h-2 bg-muted-foreground rounded-full",
                                i < dotCount ? "opacity-100" : "opacity-30",
                                "transition-opacity duration-300"
                            )}
                        />
                    ))} */}
                    <div className="relative  w-6 h-6  subtle-pulse">
                        <img
                            src="/icons/dot.png"
                            alt="thinking icon"
                            className="w-full h-full animate-heartbeat"
                        />

                    </div>
                </div>
            ) : (
                <p
                    className={clsx(
                        "text-sm text-muted-foreground transition-all duration-500",
                        fade ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"
                    )}
                >
                    {message}
                </p>
            )}
        </div>
    )
}
