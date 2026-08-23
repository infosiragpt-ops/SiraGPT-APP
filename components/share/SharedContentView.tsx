"use client";

/**
 * Visor público de contenido compartido (chat completo o mensaje individual).
 *
 * Antes las páginas /share/* no mostraban NADA: pedían login, guardaban el
 * chat en la cuenta del visitante y redirigían a /chat — un "enlace público"
 * que exigía cuenta. Este componente muestra el contenido real con formato
 * fiel (markdown, código con resaltado y botón de copiar, tablas desplazables)
 * usando el mismo pipeline saneado del chat. Guardar en la cuenta pasa a ser
 * una acción opcional para visitantes con sesión; sin sesión, el botón lleva
 * a /auth/login?next=<esta página>.
 */

import React, { Children, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslations } from "next-intl";

import MemoMarkdownBlock from "@/components/markdown/memo-markdown-block";
import { CustomCodeBlock } from "@/components/ui/custom-code-block";
import { shouldUnwrapInteractiveFence } from "@/lib/interactive-message-blocks";
import { normalizeMathDelimiters } from "@/lib/markdown/normalize-math";
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-sanitize";
import {
    stripNonCopyableArtifactBlocks,
} from "@/lib/rich-clipboard";

export type SharedMessageView = {
    id?: string;
    role?: string;
    content?: string;
    timestamp?: string | Date;
};

type Props = {
    title: string;
    subtitle?: string;
    messages: SharedMessageView[];
};

function formatTimestamp(value: string | Date | undefined): string {
    if (!value) return "";
    const date = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

export function SharedContentView({ title, subtitle, messages }: Props) {
    const tCommon = useTranslations("common");
    const tMessageActions = useTranslations("messageActions");

    const visible = useMemo(
        () =>
            messages.filter(
                (m) => stripNonCopyableArtifactBlocks(String(m.content || "")).trim() !== "",
            ),
        [messages],
    );

    const components = useMemo(
        () => ({
            pre: ({ children }: any) => {
                const child = Children.toArray(children)[0];
                const childProps = React.isValidElement(child)
                    ? (child.props as any)
                    : null;
                if (shouldUnwrapInteractiveFence(childProps?.className)) {
                    return <>{children}</>;
                }
                return <pre>{children}</pre>;
            },
            p: ({ children }: any) => (
                <p className="mb-4 text-base leading-7">{children}</p>
            ),
            ul: ({ children }: any) => (
                <ul className="mb-4 pl-6 text-base leading-7">{children}</ul>
            ),
            ol: ({ children }: any) => (
                <ol className="mb-4 pl-6 text-base leading-7">{children}</ol>
            ),
            li: ({ children }: any) => (
                <li className="mb-1.5 text-base leading-7">{children}</li>
            ),
            h1: ({ children }: any) => (
                <h1 className="mb-4 text-2xl font-semibold leading-8">{children}</h1>
            ),
            h2: ({ children }: any) => (
                <h2 className="mb-3 text-xl font-semibold leading-7">{children}</h2>
            ),
            h3: ({ children }: any) => (
                <h3 className="mb-2 text-lg font-semibold leading-7">{children}</h3>
            ),
            h4: ({ children }: any) => (
                <h4 className="mb-2 text-base font-semibold leading-7">{children}</h4>
            ),
            hr: () => <hr className="my-4 border-muted" />,
            blockquote: ({ children }: any) => (
                <blockquote className="border-l-4 border-muted pl-4 mb-3 italic">
                    {children}
                </blockquote>
            ),
            th: ({ children }: any) => (
                <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium text-sm whitespace-nowrap">
                    {children}
                </th>
            ),
            td: ({ children }: any) => (
                <td
                    className="border border-muted px-3 py-2 text-sm align-top"
                    style={{ overflowWrap: "break-word", maxWidth: "28rem" }}
                >
                    {children}
                </td>
            ),
            strong: ({ children }: any) => (
                <strong className="font-semibold">{children}</strong>
            ),
            em: ({ children }: any) => <em className="italic">{children}</em>,
            a: ({ href, children, ...props }: any) => (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:text-sky-800 underline decoration-sky-400 hover:decoration-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
                    {...props}
                >
                    {children}
                </a>
            ),
            table: ({ children }: any) => (
                <div
                    className="overflow-x-auto w-full min-w-0 scrollbar-thin"
                    style={{ WebkitOverflowScrolling: "touch", maxWidth: "100vw" }}
                >
                    <table
                        className="border-collapse border border-muted mb-3 w-full"
                        style={{ minWidth: 520 }}
                    >
                        {children}
                    </table>
                </div>
            ),
            code: ({ className, children }: any) => {
                const match = /language-([\w-]+)/.exec(className || "");
                if (!match) {
                    return (
                        <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm">
                            {children}
                        </code>
                    );
                }
                return (
                    <CustomCodeBlock className={className}>
                        {children}
                    </CustomCodeBlock>
                );
            },
        }),
        [],
    );

    const renderMarkdown = (raw: string) => {
        const content = normalizeMathDelimiters(raw);
        // Un solo bloque → el memo evita re-parsear; varios bloques por
        // párrafos dobles mantienen el render incremental barato.
        const blocks = content.split(/\n{3,}/);
        if (blocks.length <= 1) {
            return (
                <MemoMarkdownBlock content={content} components={components} />
            );
        }
        return blocks.map((block, i) => (
            <MemoMarkdownBlock
                key={`${i}:${block.slice(0, 24)}`}
                content={block}
                components={components}
            />
        ));
    };

    return (
        <div className="min-h-screen bg-background text-foreground">
            <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
                <header className="mb-8 border-b border-border pb-6">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        SiraGPT · {tMessageActions("share")}
                    </p>
                    <h1 className="mt-2 text-2xl font-bold tracking-tight break-words">
                        {title}
                    </h1>
                    {subtitle ? (
                        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
                    ) : null}
                </header>

                <main role="main" aria-label={tMessageActions("share")} className="space-y-6">
                    {visible.map((message, index) => {
                        const isUser =
                            String(message.role || "").toUpperCase() === "USER";
                        const ts = formatTimestamp(message.timestamp);
                        return (
                            <section
                                key={message.id || `${isUser}-${index}`}
                                aria-label={
                                    isUser
                                        ? tMessageActions("userMessage")
                                        : tMessageActions("assistantResponse")
                                }
                                className={
                                    isUser
                                        ? "rounded-2xl border bg-muted/40 px-4 py-3 sm:px-5 sm:py-4"
                                        : "px-0 py-1"
                                }
                            >
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {isUser
                                        ? tMessageActions("userMessage")
                                        : tMessageActions("assistantResponse")}
                                    {ts ? ` · ${ts}` : ""}
                                </p>
                                <div className="prose prose-sm dark:prose-invert max-w-none">
                                    {renderMarkdown(String(message.content || ""))}
                                </div>
                            </section>
                        );
                    })}
                    {visible.length === 0 ? (
                        <p className="py-16 text-center text-muted-foreground">
                            {tCommon("loading")}
                        </p>
                    ) : null}
                </main>
            </div>
        </div>
    );
}

export default SharedContentView;
