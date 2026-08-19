"use client";

import React from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9";

const DESKTOP_IMAGE_MAX_HEIGHT = 400;
const MOBILE_IMAGE_MAX_HEIGHT = 250;

const imageFrameSizes: Record<ImageAspectRatio, { ratio: string; desktopWidth: number; mobileWidth: number }> = {
    "1:1": { ratio: "1 / 1", desktopWidth: 400, mobileWidth: 250 },
    "2:3": { ratio: "2 / 3", desktopWidth: 267, mobileWidth: 167 },
    "3:2": { ratio: "3 / 2", desktopWidth: 600, mobileWidth: 375 },
    "3:4": { ratio: "3 / 4", desktopWidth: 300, mobileWidth: 188 },
    "4:3": { ratio: "4 / 3", desktopWidth: 533, mobileWidth: 333 },
    "9:16": { ratio: "9 / 16", desktopWidth: 225, mobileWidth: 141 },
    "16:9": { ratio: "16 / 9", desktopWidth: 711, mobileWidth: 444 },
};

const ImageGenerationEffect = ({
    aspectRatio = "1:1",
    count = 1,
}: {
    aspectRatio?: ImageAspectRatio;
    count?: number;
}) => {
    const safeCount = Math.min(5, Math.max(1, Number(count) || 1));
    const frame = imageFrameSizes[aspectRatio] || imageFrameSizes["1:1"];

    return (
        <div className="mt-3 flex w-full flex-wrap items-start gap-3" aria-label="Generando imagen">
            {Array.from({ length: safeCount }).map((_, frameIndex) => (
                <div
                    key={frameIndex}
                    data-testid="image-generation-frame"
                    className="relative isolate w-[min(100%,var(--image-loader-width-mobile))] overflow-hidden rounded-xl border border-zinc-200/80 bg-zinc-50/80 shadow-sm dark:border-white/10 dark:bg-zinc-900/70 sm:w-[min(100%,var(--image-loader-width))]"
                    style={{
                        aspectRatio: frame.ratio,
                        "--image-loader-width": `${frame.desktopWidth}px`,
                        "--image-loader-width-mobile": `${frame.mobileWidth}px`,
                        "--image-loader-max-height": `${DESKTOP_IMAGE_MAX_HEIGHT}px`,
                        "--image-loader-max-height-mobile": `${MOBILE_IMAGE_MAX_HEIGHT}px`,
                    } as React.CSSProperties}
                >
                    <div
                        className="absolute inset-0 opacity-70"
                        style={{
                            backgroundImage:
                                "linear-gradient(135deg, rgba(250,250,250,0.92), rgba(244,244,245,0.74))",
                        }}
                        aria-hidden="true"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.76),transparent)] opacity-70 dark:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.16),transparent)]" aria-hidden="true" />
                    <motion.div
                        className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/80 to-transparent dark:via-white/10"
                        animate={{ x: ["0%", "300%"] }}
                        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                        aria-hidden="true"
                    />
                    <div className="relative z-10 flex h-full w-full items-center justify-center p-4 text-zinc-600 dark:text-zinc-200">
                        <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200/90 bg-white/78 px-3 py-1.5 text-xs font-medium shadow-[0_8px_24px_-18px_rgba(24,24,27,0.55)] backdrop-blur dark:border-white/10 dark:bg-white/10">
                            <motion.span
                                className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-white/10 dark:text-zinc-200"
                                animate={{ scale: [1, 1.08, 1], opacity: [0.72, 1, 0.72] }}
                                transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                                aria-hidden="true"
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                            </motion.span>
                            <span>Generando</span>
                            <span className="text-zinc-400 dark:text-zinc-500" aria-hidden="true">·</span>
                            <span className="text-zinc-500 dark:text-zinc-300">{aspectRatio}</span>
                        </div>
                    </div>
                    <span className="sr-only">
                        Generando imagen {frameIndex + 1} de {safeCount}, formato {aspectRatio}.
                    </span>
                </div>
            ))}
        </div>
    );
};

export default ImageGenerationEffect;
