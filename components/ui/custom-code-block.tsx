"use client";

import { useState } from "react";
import { Check, Clipboard, ExternalLink } from "lucide-react";
import { useShikiHighlight } from "@/lib/use-shiki-highlight";

export const CustomCodeBlock = ({ className, children, canPreview, onPreview }: any) => {
    const [isCopied, setIsCopied] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';

    const codeString = String(children).replace(/\n$/, '');
    const highlighted = useShikiHighlight(codeString, language);

    const handleCopy = () => {
        navigator.clipboard.writeText(codeString).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        });
    };

    return (
        <div className="rounded-md bg-gray-900/80 border border-gray-700 relative my-4">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 rounded-t-md border-b border-gray-700">
                <span className="text-xs font-sans text-gray-400">
                    {language}
                </span>
                <div className="flex items-center gap-2">
                    {canPreview && (
                        <button
                            onClick={onPreview}
                            className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1"
                            title="Open preview in split view"
                        >
                            <ExternalLink size={14} className="opacity-80" />
                            Preview
                        </button>
                    )}
                    <button onClick={handleCopy} className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1">
                        {isCopied ? <Check size={14} /> : <Clipboard size={14} />}
                        {isCopied ? 'Copied!' : 'Copy code'}
                    </button>
                </div>
            </div>
            {highlighted ? (
                // Shiki has already escaped the source. The wrapper class lets
                // Tailwind reset the default <pre> margin/padding so the panel
                // bevel sits flush against the toolbar.
                <div
                    className="shiki-host text-[15px] leading-snug overflow-x-auto [&_pre]:m-0 [&_pre]:p-4 [&_pre]:bg-transparent [&_code]:bg-transparent [&_code]:font-mono"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                />
            ) : (
                // Pre-hydration / first paint / unsupported language: keep the
                // code visible without color rather than blinking blank.
                <pre className="m-0 p-4 text-[15px] text-gray-100 whitespace-pre-wrap break-all font-mono">
                    <code>{codeString}</code>
                </pre>
            )}
        </div>
    );
};
