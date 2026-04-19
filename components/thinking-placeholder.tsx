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
import { ThinkingBarsIcon } from "@/components/icons/thinking-bars-icon"

// Localized to Spanish to match the default language policy. The
// rotating copy is intentionally short and product-neutral so it reads
// well even when the conversation is technical, casual, or RAG-driven.
const messages = [
    "Pensando…",
    "Analizando tu mensaje…",
    "Procesando información…",
    "Construyendo la respuesta…",
    "Refinando la respuesta…",
    "Revisando el contexto…",
    "Resumiendo puntos clave…",
    "Verificando precisión…",
    "Casi listo…",
]

export const ThinkingPlaceholder = () => {
    const [phase, setPhase] = useState<"dots" | "text">("dots")
    const [message, setMessage] = useState(messages[0])
    const [fade, setFade] = useState(false)

    // First ~3s show only the animated bars, then start rotating
    // contextual messages so the user knows the system is still working
    // on long generations.
    useEffect(() => {
        if (phase === "dots") {
            const timeout = setTimeout(() => {
                setPhase("text")
            }, 3000)
            return () => clearTimeout(timeout)
        }
    }, [phase])

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
        <div
            role="status"
            aria-live="polite"
            aria-label="Generando respuesta"
            className="flex items-center gap-2.5 my-4 text-muted-foreground"
        >
            <ThinkingBarsIcon className="h-5 w-5 shrink-0" />
            {phase === "text" && (
                <p
                    className={clsx(
                        "text-[13.5px] font-medium tracking-tight transition-all duration-300",
                        fade ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0",
                    )}
                >
                    {message}
                </p>
            )}
        </div>
    )
}
