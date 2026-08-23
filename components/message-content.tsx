"use client"

import * as React from "react"
import { useMemo, useRef } from "react"
import ReactMarkdown from 'react-markdown'
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { markdownRehypePlugins, markdownRemarkPlugins } from '@/lib/markdown-sanitize'
import { normalizeMathDelimiters } from '@/lib/markdown/normalize-math'
import MemoMarkdownBlock from '@/components/markdown/memo-markdown-block'
import { splitStableHead } from '@/lib/markdown-block-split'
import { parseCodeFromContent } from '@/lib/code-detection'
import { CustomCodeBlock } from "./ui/custom-code-block"
import TableControls from './TableControls';
import { AgenticStepsRenderer } from "./agentic-steps"
import { PapersResultCard } from "./papers-result-card"
import { ArtifactCard, isExecutableArtifact } from "./chat/ArtifactCard"
import { shouldUnwrapInteractiveFence } from "@/lib/interactive-message-blocks"
import {
    createWordClipboardPayloadFromSelection,
    setClipboardDataForWord,
} from "@/lib/rich-clipboard"
import type { DocumentPreviewTarget } from "./document-preview"

// Adjusted truncateUrl function to ensure links are not overly shortened.
// Guards against non-string inputs — the renderer is fed citation/source
// objects from the backend whose `url` field is occasionally null,
// undefined or wrapped in an object during streaming. Without this
// guard the whole message bubble crashes with
// "url.split is not a function" and shows the red "no se pudo
// renderizar" error.
const truncateUrl = (url: unknown, maxLength: number = 30) => {
    if (typeof url !== 'string' || url.length === 0) return '';
    if (url.length <= maxLength) return url;
    const parts = url.split('/');
    const domain = parts[2] ?? url;
    const path = parts.slice(3).join('/');
    const truncatedPath = path.length > 25 ? `${path.slice(0, 25)}...` : path;
    return path ? `${domain}/${truncatedPath}` : domain;
};

const getNodeText = (node: any): string => {
    if (node.type === 'text') {
        return node.value;
    }
    if (node.children) {
        return node.children.map(getNodeText).join('');
    }
    return '';
};

// Tag-renderers that don't depend on streaming/final mode. Module-level
// constant: zero closures over props/state, so the object identity is
// stable for the lifetime of the app and MemoMarkdownBlock's comparator
// can rely on it forever.
const baseComponents = {
    pre: ({ children }: any) => {
        const child = React.Children.toArray(children)[0]
        const childProps = React.isValidElement(child) ? (child.props as any) : null
        if (shouldUnwrapInteractiveFence(childProps?.className)) {
            return <>{children}</>
        }
        return <pre>{children}</pre>
    },
    p: ({ children }: any) => <p className="mb-4 text-base leading-7">{children}</p>,
    ul: ({ children }: any) => <ul className="mb-4 pl-6 text-base leading-7">{children}</ul>,
    ol: ({ children }: any) => <ol className="mb-4 pl-6 text-base leading-7">{children}</ol>,
    li: ({ children }: any) => <li className="mb-1.5 text-base leading-7">{children}</li>,
    h1: ({ children }: any) => <h1 className="mb-4 text-2xl font-semibold leading-8">{children}</h1>,
    h2: ({ children }: any) => <h2 className="mb-3 text-xl font-semibold leading-7">{children}</h2>,
    h3: ({ children }: any) => <h3 className="mb-2 text-lg font-semibold leading-7">{children}</h3>,
    h4: ({ children }: any) => <h4 className="mb-2 text-base font-semibold leading-7">{children}</h4>,
    hr: () => <hr className="my-4 border-muted" />,
    blockquote: ({ children }: any) => <blockquote className="border-l-4 border-muted pl-4 mb-3 italic">{children}</blockquote>,
    th: ({ children }: any) => <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium text-sm whitespace-nowrap">{children}</th>,
    td: ({ children }: any) => <td className="border border-muted px-3 py-2 text-sm align-top" style={{ overflowWrap: 'break-word', maxWidth: '28rem' }}>{children}</td>,
    strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }: any) => <em className="italic">{children}</em>,
    a: ({ href, children, ...props }: any) => {
        // Only bare-URL link text goes through truncateUrl. Passing
        // React children blindly broke two cases: nested markdown in
        // the label ([**SiraGPT** docs](url) → children is an array →
        // typeof guard returned '' → INVISIBLE link) and long prose
        // labels with slashes got mangled by the domain/path logic.
        const single = Array.isArray(children) && children.length === 1 ? children[0] : children;
        const isBareUrl = typeof single === 'string' && /^(https?:\/\/|www\.)/i.test(single.trim());
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-600 hover:text-sky-800 underline decoration-sky-400 hover:decoration-sky-600"
                title={href}
                {...props}
            >
                {isBareUrl ? truncateUrl(single) : children}
            </a>
        );
    },
} as const;

export type ExpandedTablePayload = {
    headers: string[]
    rows: string[][]
    title: string
}

type MessageContentProps = {
    /** Raw (un-normalized) markdown/content shown in the bubble. */
    content: string
    role?: string
    messageId: string
    isStreaming?: boolean
    hasAgentTrace?: boolean
    /** Image-only / video messages render no markdown at all. */
    suppressRender?: boolean
    onDocumentPreview?: (target: DocumentPreviewTarget) => void
    onToggleSplitView?: (content: any) => void
    /** Expand a rendered table into the fullscreen overlay owned by the parent. */
    onExpandTable?: (payload: ExpandedTablePayload) => void
}

// MessageContent previously lived INSIDE MessageComponent's render body,
// so its function type changed identity on every render and React
// remounted the whole markdown tree on every streamed token — discarding
// layout, scroll anchoring and every MemoMarkdownBlock cache. Declared at
// module level + React.memo, the subtree is now preserved across tokens:
// only the live tail re-renders, the stable head skips reconciliation
// entirely.
const MessageContent = ({
    content: rawContent,
    role,
    messageId,
    isStreaming = false,
    hasAgentTrace = false,
    suppressRender = false,
    onDocumentPreview,
    onToggleSplitView,
    onExpandTable,
}: MessageContentProps) => {
    // Normalize `\( \)` / `\[ \]` TeX bracket delimiters (commonly emitted
    // by LLMs) to `$ $` / `$$ $$` once, up front, so every downstream
    // branch — direct ReactMarkdown, the streaming head/tail split, and the
    // memoized block — renders math via KaTeX. Code spans/blocks are left
    // untouched and the helper is a no-op when no brackets are present.
    const content = useMemo(() => normalizeMathDelimiters(rawContent), [rawContent]);

    // Messages always render at full height — the old "Ver más / Ver
    // menos" clamp was removed by user request (having to expand every
    // long answer was friction, not comfort).
    const contentRef = useRef<HTMLDivElement>(null);

    // Code extraction feeds the split-view preview, which only exists in
    // final mode (streaming code renders through the lightweight map below).
    // Skipping the full-content scan while tokens stream removes an
    // O(n)-per-token regex pass over the growing answer.
    const parsedCode = useMemo(
        () => (isStreaming ? null : parseCodeFromContent(content)),
        [content, isStreaming],
    );

    const canPreviewMessage = useMemo(() => {
        if (!parsedCode) return false;
        if (!parsedCode.hasWebCode) return false;
        if (parsedCode.hasNonWebCode && !parsedCode.combinedCode) return false;
        return !!(parsedCode.combinedCode || parsedCode.html);
    }, [parsedCode]);

    const handlePreview = () => {
        if (!parsedCode || !onToggleSplitView) return;

        const splitContent = {
            htmlCode: parsedCode.html || '',
            cssCode: parsedCode.css || '',
            jsCode: parsedCode.js || '',
            combinedCode: parsedCode.combinedCode || '',
            title: 'Code Preview'
        };

        onToggleSplitView(splitContent);
    };

    // Streaming-only map: stable as long as the streaming flags/callbacks
    // don't change. Crucially does NOT close over `content`, so it survives
    // every token without invalidating MemoMarkdownBlock.
    const streamingComponents = useMemo(() => ({
        ...baseComponents,
        table: ({ children }: any) => (
            <div className="group relative mt-3">
                <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600" style={{ WebkitOverflowScrolling: 'touch', maxWidth: '100vw' }}>
                    <table className="border-collapse border border-muted mb-3 w-full" style={{ minWidth: "520px" }}>{children}</table>
                </div>
                <div className="block md:hidden mt-1 text-xs text-muted-foreground text-center select-none">Desliza para ver la tabla completa</div>
            </div>
        ),
        code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-([\w-]+)/.exec(className || '');
            if (!inline && match) {
                const lang = (match[1] || '').toLowerCase();
                const codeString = String(children).replace(/\n$/, '');
                if (lang === 'agent-task-state') {
                    try {
                        const state = JSON.parse(codeString);
                        return <AgenticStepsRenderer state={state} hideSteps={hasAgentTrace} onDocumentPreview={onDocumentPreview} />;
                    } catch {
                        return null;
                    }
                }
                if (lang === 'scientific-papers') {
                    try {
                        return <PapersResultCard data={JSON.parse(codeString)} />;
                    } catch {
                        return null;
                    }
                }
                const willBeArtifact = isExecutableArtifact(lang, codeString)
                    || (lang === 'html' && /<!doctype|<html[\s>]/i.test(codeString.slice(0, 200)))
                    || (lang === 'mermaid')
                    || (lang === 'svg');
                if (willBeArtifact) {
                    return (
                        <div className="my-4 overflow-hidden rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-zinc-950/70">
                            <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-white/[0.04]">
                                <span className="text-[11px] font-sans tracking-wide text-zinc-500">{lang}</span>
                                <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400/90">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    Generando artefacto…
                                </span>
                            </div>
                            <div className="relative">
                                <pre className="text-[12.5px] leading-[1.55] whitespace-pre-wrap p-3.5 font-mono text-zinc-200 max-h-[280px] overflow-auto"><code>{codeString}</code></pre>
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-950/90 to-transparent" />
                            </div>
                        </div>
                    );
                }
                return (
                    <div className="my-4 overflow-hidden rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-zinc-950/60">
                        <div className="px-3.5 py-1.5 border-b border-white/[0.04] text-[11px] font-sans tracking-wide text-zinc-500">{lang}</div>
                        <pre className="text-[12.5px] leading-[1.55] whitespace-pre-wrap p-3.5 font-mono text-zinc-100 max-h-[280px] overflow-auto"><code>{codeString}</code></pre>
                    </div>
                );
            }
            return (
                <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props}>{children}</code>
            );
        },
    }), [hasAgentTrace, onDocumentPreview]);

    // Final (post-streaming) map: enriches the table with controls
    // tied to the now-stable content. Recomputed only when streaming
    // ends or the preview inputs change.
    const finalComponents = useMemo(() => ({
        ...baseComponents,
        table: ({ node, children, ...props }: any) => {
            let title = '';
            const parent = node.parent;
            if (parent) {
                const tableIndex = parent.children.indexOf(node);
                for (let i = tableIndex - 1; i >= 0; i--) {
                    const sibling = parent.children[i];
                    if (sibling.tagName === 'h1' || sibling.tagName === 'h2' || sibling.tagName === 'h3') {
                        title = getNodeText(sibling);
                        break;
                    }
                    if (sibling.type !== 'text' || sibling.value.trim() !== '') {
                        break;
                    }
                }
            }

            const handleExpand = () => {
                const tHead = node.children.find((child: any) => child.tagName === 'thead');
                const tBody = node.children.find((child: any) => child.tagName === 'tbody');
                const headers = tHead?.children?.[0]?.children?.map(getNodeText).filter((e: string) => e != "\n") ?? [];
                const data = tBody?.children?.map((tr: any) => tr.children?.map(getNodeText).filter((e: string) => e !== "\n") ?? []) ?? [];
                onExpandTable?.({ headers, rows: data, title });
            };
            const tHead = node.children.find((child: any) => child.tagName === 'thead');
            const tBody = node.children.find((child: any) => child.tagName === 'tbody');
            const headers = tHead?.children?.[0]?.children?.map(getNodeText).filter((e: string) => e !== "\n") ?? [];
            const rows = tBody?.children?.map((tr: any) => tr.children?.map(getNodeText).filter((e: string) => e !== "\n") ?? []) ?? [];
            const selectedTableData = headers.length > 0
                ? { headers, rows }
                : null;

            return (
                <div className="group relative mt-3">
                    <TableControls
                        content={rawContent}
                        messageId={messageId}
                        tableData={selectedTableData}
                        onExpand={handleExpand}
                        title={title}
                    />
                    <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600" style={{ WebkitOverflowScrolling: 'touch', maxWidth: '100vw' }}>
                        <table className="border-collapse border border-muted mb-3 w-full" style={{ minWidth: "520px" }}>{children}</table>
                    </div>
                    <div className="block md:hidden mt-1 text-xs text-muted-foreground text-center select-none">Desliza para ver la tabla completa</div>
                </div>
            );
        },
        code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-([\w-]+)/.exec(className || '');
            if (!inline && match) {
                const language = match[1];
                const codeString = String(children).replace(/\n$/, '');
                if (language === 'agent-task-state') {
                    try {
                        const state = JSON.parse(codeString);
                        // When the typed AgentTrace timeline is active for this
                        // message, the sentinel contributes only its artifacts —
                        // one timeline, not two.
                        return <AgenticStepsRenderer state={state} hideSteps={hasAgentTrace} onDocumentPreview={onDocumentPreview} />;
                    } catch {
                        return null;
                    }
                }
                if (language === 'scientific-papers') {
                    try {
                        return <PapersResultCard data={JSON.parse(codeString)} />;
                    } catch {
                        return null;
                    }
                }
                if (isExecutableArtifact(language, codeString)) {
                    return <ArtifactCard code={codeString} language={language} />;
                }
                return (
                    <CustomCodeBlock className={className} {...props} canPreview={canPreviewMessage} onPreview={handlePreview}>
                        {children}
                    </CustomCodeBlock>
                );
            }
            return (
                <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {children}
                </code>
            );
        },
    }), [rawContent, messageId, hasAgentTrace, onDocumentPreview, canPreviewMessage, handlePreview, onExpandTable]);

    const components = isStreaming ? streamingComponents : finalComponents;

    if (suppressRender) {
        return null;
    }

    if (role === 'ASSISTANT' && (content === '[GENERATING_IMAGE]' || content === '[PROCESSING_GMAIL]' || content === '[PROCESSING_CALENDAR_ACTION]' || content === '[PROCESSING_DRIVE_ACTION]' || content === '[GENERATING_PPT]' || content === '[GENERATING_VECTOR_PPT]' || content === '[THESIS_GENERATING]' || content.startsWith('[THESIS_GENERATING]'))) {
        return null;
    }

    const handleRenderedCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
        const payload = createWordClipboardPayloadFromSelection(event.currentTarget, content);
        if (!payload) return;

        setClipboardDataForWord(event.clipboardData, payload);
        event.preventDefault();
        toast.success("Selección copiada con formato para Word");
    };

    return (
        // [&_p:last-child]:!mb-0 trims the trailing 1em margin that
        // `prose-sm` adds to the final paragraph — that margin was
        // pushing the action rail visually too far from the message.
        // We keep all other prose typography intact. (The class name is a
        // stable DOM hook; the expand/collapse it once hosted was removed.)
        <div className="sgpt-message-collapsible">
          <div className="relative">
            <div
                ref={contentRef}
                className={cn(
                    "prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed",
                    "[&_p:last-child]:!mb-0 [&_p:first-child]:!mt-0",
                    "[&_ul:last-child]:!mb-0 [&_ol:last-child]:!mb-0 [&_pre:last-child]:!mb-0",
                )}
                data-sgpt-rich-copy-root=""
                onCopyCapture={handleRenderedCopy}
            >
            {(() => {
                // While streaming, split the assistant content into a
                // stable "head" (closed blocks) and a "live tail" so
                // closed paragraphs/code/lists don't get re-parsed and
                // re-rendered on every incoming token. The head is
                // wrapped in a React.memo'd block that compares the
                // content string and the components reference; both
                // are stable across token deltas thanks to the
                // streamingComponents useMemo above.
                const isStreamingAssistant = isStreaming && role === 'ASSISTANT';
                if (!isStreamingAssistant) {
                    return (
                        <ReactMarkdown
                            remarkPlugins={markdownRemarkPlugins}
                            rehypePlugins={markdownRehypePlugins}
                            components={components}
                        >
                            {content}
                        </ReactMarkdown>
                    );
                }
                const { head, tail } = splitStableHead(content);
                if (!head) {
                    return (
                        <ReactMarkdown
                            remarkPlugins={markdownRemarkPlugins}
                            rehypePlugins={markdownRehypePlugins}
                            components={components}
                        >
                            {content}
                        </ReactMarkdown>
                    );
                }
                return (
                    <>
                        <MemoMarkdownBlock content={head} components={components} />
                        {tail ? (
                            <ReactMarkdown
                                remarkPlugins={markdownRemarkPlugins}
                                rehypePlugins={markdownRehypePlugins}
                                components={components}
                            >
                                {tail}
                            </ReactMarkdown>
                        ) : null}
                    </>
                );
            })()}
            {isStreaming && role === 'ASSISTANT' ? (
                <span
                    aria-hidden="true"
                    className="premium-caret ml-0.5 inline-block w-[0.5ch] h-[1em] -mb-[0.15em] bg-current align-baseline rounded-[1px]"
                />
            ) : null}
            </div>
          </div>
        </div>
    );
};

export default React.memo(MessageContent)
