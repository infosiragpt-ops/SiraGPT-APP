"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useShikiHighlight } from "@/lib/use-shiki-highlight";
import { DiffBlock } from "@/components/chat/diff-block";
import { cn } from "@/lib/utils";

export const CustomCodeBlock = ({ className, children, canPreview, onPreview }: any) => {
    const [isCopied, setIsCopied] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';

    const codeString = String(children).replace(/\n$/, '');

    // Diff fences (```diff … ```) with a recognisable unified-diff
    // header get the Cursor-style side-by-side renderer instead of
    // generic syntax highlighting. The hook below still runs (rules
    // of hooks); its result is unused on this branch.
    const isDiff = language === 'diff' && /^(?:diff --git|---\s|\+\+\+\s|@@\s)/m.test(codeString);

    const highlighted = useShikiHighlight(codeString, language);

    if (isDiff) {
        return <DiffBlock diff={codeString} />;
    }

    const handleCopy = () => {
        navigator.clipboard.writeText(codeString).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        });
    };

    return (
        <div className="group/code my-4 overflow-hidden rounded-xl border border-border/55 bg-[#0d1117] shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:bg-[#0a0e15] dark:shadow-[0_12px_28px_-18px_rgba(0,0,0,0.55)]">
            {/* Header — uppercase language eyebrow + tools. Sits above
                the code panel as a quiet command bar; tools fade in on
                hover so the chrome doesn't distract from the source. */}
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-400 font-sans">
                    {language}
                </span>
                <div className="flex items-center gap-1.5 opacity-70 transition-opacity duration-200 group-hover/code:opacity-100">
                    {canPreview && (
                        <button
                            type="button"
                            onClick={onPreview}
                            className={cn(
                                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium text-zinc-300",
                                "transition-[background-color,color] duration-[var(--duration-fast,150ms)] ease-[var(--ease-out-smooth,cubic-bezier(0.22,1,0.36,1))]",
                                "hover:bg-white/[0.08] hover:text-white",
                                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
                            )}
                            aria-label="Abrir vista previa"
                        >
                            <ExternalLink size={13} strokeWidth={1.85} />
                            <span className="hidden sm:inline">Preview</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={handleCopy}
                        className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium text-zinc-300",
                            "transition-[background-color,color] duration-[var(--duration-fast,150ms)] ease-[var(--ease-out-smooth,cubic-bezier(0.22,1,0.36,1))]",
                            "hover:bg-white/[0.08] hover:text-white",
                            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
                            isCopied && "text-emerald-400 hover:text-emerald-300",
                        )}
                        aria-label={isCopied ? "Código copiado" : "Copiar código"}
                    >
                        {isCopied ? (
                            <Check size={13} strokeWidth={2.25} />
                        ) : (
                            <Copy size={13} strokeWidth={1.85} />
                        )}
                        <span className="hidden sm:inline">
                            {isCopied ? "Copiado" : "Copiar"}
                        </span>
                    </button>
                </div>
            </div>
            {highlighted ? (
                <div
                    className="shiki-host overflow-x-auto text-[14px] leading-[1.55] [&_pre]:m-0 [&_pre]:p-4 [&_pre]:bg-transparent [&_code]:bg-transparent [&_code]:font-mono"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                />
            ) : (
                <pre className="m-0 overflow-x-auto p-4 text-[14px] leading-[1.55] text-zinc-100 whitespace-pre-wrap break-words font-mono">
                    <code>{codeString}</code>
                </pre>
            )}
        </div>
    );
};
