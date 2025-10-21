"use client"

import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { Check, Clipboard, ExternalLink } from "lucide-react";

export const CustomCodeBlock = ({ className, children, canPreview, onPreview }: any) => {
    const [isCopied, setIsCopied] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';

    const codeString = String(children).replace(/\n$/, '');

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
            <SyntaxHighlighter
                style={oneDark}
                language={language}
                PreTag="div"
                customStyle={{ margin: 0, padding: '1rem', background: 'transparent', fontSize: "15px" }}
                wrapLongLines={true}
                codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }}
            >
                {codeString}
            </SyntaxHighlighter>
        </div>
    );
};
