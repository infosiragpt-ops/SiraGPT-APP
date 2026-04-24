// "use client";

// import React from 'react';
// import { motion } from 'framer-motion';
// import { ImageIcon, Loader2, Sparkles } from 'lucide-react';

// const ImageGenerationEffect = () => {
//     return (
//         <div className="relative w-[300px] h-20 bg-gray-200 dark:bg-gray-800 rounded-lg flex items-center justify-center p-5 overflow-hidden">
//             <motion.div
//                 className="absolute inset-0 bg-gray-300 dark:bg-gray-700"
//                 animate={{ opacity: [0.5, 1, 0.5] }}
//                 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
//             />
//             <div className="relative z-10 flex flex-col items-center text-gray-700 dark:text-gray-200">
//                 <Sparkles className="w-8 h-8 mb-2" />
//                 <p className="font-semibold text-sm">Generating Image...</p>
//             </div>
//         </div>
//     );
// };

// export default ImageGenerationEffect;
"use client";

import React from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

const floatingDots = [
    { top: "18%", left: "22%", delay: 0 },
    { top: "25%", left: "72%", delay: 0.35 },
    { top: "52%", left: "16%", delay: 0.7 },
    { top: "68%", left: "80%", delay: 1.05 },
    { top: "78%", left: "38%", delay: 1.4 },
];

const ImageGenerationEffect = () => {
    return (
        <div className="relative aspect-square w-full max-w-[520px] overflow-hidden rounded-2xl border border-white/60 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.95),transparent_34%),linear-gradient(135deg,#f7f8fb_0%,#dde2eb_100%)] p-6 shadow-[0_18px_50px_-30px_rgba(15,23,42,0.55)] dark:border-white/10 dark:bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.12),transparent_34%),linear-gradient(135deg,#171b24_0%,#2a3140_100%)]">
            <div className="absolute inset-0 opacity-[0.28] [background-image:radial-gradient(circle,rgba(15,23,42,0.22)_1px,transparent_1px)] [background-size:22px_22px] dark:opacity-[0.18] dark:[background-image:radial-gradient(circle,rgba(255,255,255,0.42)_1px,transparent_1px)]" />
            <motion.div
                className="absolute -left-1/3 top-0 h-full w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/65 to-transparent blur-sm dark:via-white/20"
                animate={{ x: ["-35%", "260%"] }}
                transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
                className="absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(70%_80%_at_50%_100%,rgba(56,189,248,0.26),transparent_72%)]"
                animate={{ y: [16, -10, 16], opacity: [0.45, 0.75, 0.45] }}
                transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
                className="absolute inset-x-[-20%] bottom-[18%] h-24 rounded-[999px] bg-white/35 blur-2xl dark:bg-sky-300/10"
                animate={{ x: ["-8%", "8%", "-8%"], scaleX: [0.9, 1.14, 0.9] }}
                transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
            />
            {floatingDots.map((dot, i) => (
                <motion.div
                    key={i}
                    className="absolute h-2 w-2 rounded-full bg-amber-400/80 shadow-[0_0_22px_rgba(251,191,36,0.75)]"
                    style={{ top: dot.top, left: dot.left }}
                    animate={{ y: [0, -14, 0], opacity: [0.25, 1, 0.25], scale: [0.75, 1.2, 0.75] }}
                    transition={{ duration: 2.7, repeat: Infinity, delay: dot.delay, ease: "easeInOut" }}
                />
            ))}
            <div className="relative z-10 flex h-full flex-col items-center justify-center text-center text-slate-700 dark:text-slate-100">
                <motion.div
                    className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/70 bg-white/65 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_14px_32px_-20px_rgba(15,23,42,0.8)] backdrop-blur-xl dark:border-white/10 dark:bg-white/10"
                    animate={{ scale: [1, 1.04, 1], rotate: [0, 1.5, 0] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                >
                    <Sparkles className="h-8 w-8 text-amber-500" />
                </motion.div>
                <p className="text-lg font-semibold tracking-[-0.02em]">Generando imagen</p>
                <p className="mt-2 max-w-[280px] text-sm leading-6 text-slate-500 dark:text-slate-300">
                    Preparando el lienzo cuadrado. Puedes detenerlo con el botón negro.
                </p>
                <div className="mt-6 flex items-center gap-2" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                        <motion.span
                            key={i}
                            className="h-2.5 w-2.5 rounded-full bg-slate-500/70 dark:bg-white/70"
                            animate={{ y: [0, -8, 0], opacity: [0.35, 1, 0.35] }}
                            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};

export default ImageGenerationEffect;
