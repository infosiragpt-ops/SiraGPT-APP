"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, ListOrdered } from "lucide-react";
import { useShikiHighlight } from "@/lib/use-shiki-highlight";
import { DiffBlock } from "@/components/chat/diff-block";
import { cn } from "@/lib/utils";

// Lote E · #36 + #40 — line-numbers preference is global and
// persisted in localStorage so toggling on one block toggles the
// whole conversation (and survives reloads). One key for the whole
// app keeps it simple; users won't expect a per-block setting.
const LINE_NUMBERS_KEY = "sira:codeblock:line-numbers";

export const CustomCodeBlock = ({ className, children, canPreview, onPreview }: any) => {
    const [isCopied, setIsCopied] = useState(false);
    const [showLineNumbers, setShowLineNumbers] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';

    const codeString = String(children).replace(/\n$/, '');

    // Diff fences (```diff … ```) with a recognisable unified-diff
    // header get the Cursor-style side-by-side renderer instead of
    // generic syntax highlighting. The hook below still runs (rules
    // of hooks); its result is unused on this branch.
    const isDiff = language === 'diff' && /^(?:diff --git|---\s|\+\+\+\s|@@\s)/m.test(codeString);

    const highlighted = useShikiHighlight(codeString, language);

    // Hydrate line-numbers preference from localStorage on mount.
    useEffect(() => {
        try {
            if (window.localStorage.getItem(LINE_NUMBERS_KEY) === "1") {
                setShowLineNumbers(true);
            }
        } catch { /* ignore */ }
        const sync = (event: StorageEvent) => {
            if (event.key === LINE_NUMBERS_KEY) {
                setShowLineNumbers(event.newValue === "1");
            }
        };
        window.addEventListener("storage", sync);
        return () => window.removeEventListener("storage", sync);
    }, []);

    // Cross-block sync within the same tab: a custom event so toggling
    // one block immediately reflows the others without a reload.
    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ value: boolean }>).detail;
            if (detail && typeof detail.value === "boolean") {
                setShowLineNumbers(detail.value);
            }
        };
        window.addEventListener("sira:codeblock:line-numbers", handler as EventListener);
        return () => window.removeEventListener("sira:codeblock:line-numbers", handler as EventListener);
    }, []);

    const lineCount = useMemo(
        () => (codeString.length === 0 ? 1 : codeString.split(/\r\n|\r|\n/).length),
        [codeString],
    );

    if (isDiff) {
        return <DiffBlock diff={codeString} />;
    }

    const handleCopy = () => {
        navigator.clipboard.writeText(codeString).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        });
    };

    const toggleLineNumbers = () => {
        const next = !showLineNumbers;
        setShowLineNumbers(next);
        try {
            window.localStorage.setItem(LINE_NUMBERS_KEY, next ? "1" : "0");
        } catch { /* ignore */ }
        try {
            window.dispatchEvent(
                new CustomEvent("sira:codeblock:line-numbers", { detail: { value: next } }),
            );
        } catch { /* ignore */ }
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
                    {/* Lote E · #36 — line numbers toggle. */}
                    <button
                        type="button"
                        onClick={toggleLineNumbers}
                        aria-pressed={showLineNumbers}
                        className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium text-zinc-300",
                            "transition-[background-color,color] duration-fast ease-smooth",
                            "hover:bg-white/[0.08] hover:text-white",
                            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
                            showLineNumbers && "bg-white/[0.08] text-white",
                        )}
                        aria-label={showLineNumbers ? "Ocultar números de línea" : "Mostrar números de línea"}
                        title={showLineNumbers ? "Ocultar números de línea" : "Mostrar números de línea"}
                    >
                        <ListOrdered size={13} strokeWidth={1.85} />
                    </button>
                    {canPreview && (
                        <button
                            type="button"
                            onClick={onPreview}
                            className={cn(
                                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium text-zinc-300",
                                "transition-[background-color,color] duration-fast ease-smooth",
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
                            "transition-[background-color,color] duration-fast ease-smooth",
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
            {showLineNumbers ? (
                // Grid layout: gutter with line numbers + scrollable code.
                // The gutter is select:none so triple-click on a line and
                // Cmd+A only grab the actual source, never the numbers.
                <div className="overflow-x-auto">
                    <div className="grid min-w-max grid-cols-[auto_1fr]">
                        <pre
                            aria-hidden="true"
                            className="m-0 select-none border-r border-white/[0.08] bg-white/[0.02] px-3 py-4 text-right font-mono text-[14px] leading-[1.55] text-zinc-500"
                        >
                            {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
                        </pre>
                        {highlighted ? (
                            <div
                                className="shiki-host text-[14px] leading-[1.55] [&_pre]:m-0 [&_pre]:p-4 [&_pre]:bg-transparent [&_code]:bg-transparent [&_code]:font-mono"
                                dangerouslySetInnerHTML={{ __html: highlighted }}
                            />
                        ) : (
                            <pre className="m-0 p-4 text-[14px] leading-[1.55] text-zinc-100 whitespace-pre font-mono">
                                <code>{codeString}</code>
                            </pre>
                        )}
                    </div>
                </div>
            ) : highlighted ? (
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
