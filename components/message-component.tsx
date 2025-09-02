"use client"

// Zaroori cheezein import karein
import React, { useEffect, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex'; // Import rehype-katex
import 'katex/dist/katex.min.css'; // Import KaTeX CSS

import {
    FileText,
    Clipboard,
    Check,
    Volume2,
    Square,
    ThumbsUp,
    ThumbsDown,
    RefreshCw,
    Wand2,
    Share2,
    Pencil
} from "lucide-react";
import { DownloadButtons } from './download-buttons';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import apiClient from '@/lib/api';
import { toast } from 'sonner';
import { Textarea } from './ui/textarea';


// Enhanced Message Component (Naya aur behtar version)
const MessageComponent = ({ message, user, onRegenerate, updateMessageInChat }: {
    message: any;
    user: any;
    onRegenerate: () => void;
    updateMessageInChat: (messageId: string, newContent: string) => void
}) => {
    const [isCopied, setIsCopied] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [feedbackSent, setFeedbackSent] = useState(message.feedback || null);
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(message.content);
    const [imageLoading, setImageLoading] = useState<{ [key: string]: boolean }>({});
    const [imageError, setImageError] = useState<{ [key: string]: boolean }>({});

    useEffect(() => {
        setEditedContent(message.content);
    }, [message.content]);


    //For Share Functioanlity
    const handleShare = async () => {
        try {
            const response = await apiClient.handleShare(message.chatId);
            navigator.clipboard.writeText(process.env.NEXT_PUBLIC_API_URL + response.shareableLink);
            toast.success("Shareable link copied to clipboard!");
        } catch (error) {
            toast.error(`Failed to create share link. ${error}`);
        }
    };



    const handleEditSave = async () => {
        if (editedContent.trim() === message.content || editedContent.trim() === "") {
            setIsEditing(false);
            return;
        }
        try {
            await apiClient.editUserMessage(message.id, { content: editedContent });
            updateMessageInChat(message.id, editedContent);
            toast.success("Message updated!");
            setIsEditing(false);
        } catch (error) {
            toast.error("Failed to update message.");
        }
    };

    const handleGlobalCopy = () => {
        navigator.clipboard.writeText(message.content).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        });
    };

    const handleFeedback = async (feedbackType: 'liked' | 'disliked') => {
        if (feedbackSent) return;

        try {
            await apiClient.handleFeedbackLikeDislike(message.id, feedbackType);
            setFeedbackSent(feedbackType);
            toast.success("Feedback submitted!");
        } catch (error) {
            toast.error("Could not submit feedback.");
        }
    };

    const handleSpeak = () => {
        if (isSpeaking) {
            window.speechSynthesis.cancel();
            setIsSpeaking(false);
            return;
        }

        const textToSpeak = message.content
            .replace(/```[\s\S]*?```/g, 'Code block')
            .replace(/`[^`]*`/g, 'Code')
            .replace(/([_*#`~]|\\[*#`~])/g, '')
            .replace(/\[(.*?)\]\(.*?\)/g, '$1');

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.onend = () => {
            setIsSpeaking(false);
        };

        window.speechSynthesis.speak(utterance);
        setIsSpeaking(true);
    };

    let parsedFiles = [];
    if (message.files) {
        try {
            parsedFiles = typeof message.files === 'string' ? JSON.parse(message.files) : message.files;
        } catch (e) {
            console.error("Failed to parse files:", e);
            parsedFiles = [];
        }
    }



    // Markdown ke andar code blocks ko render karne ke liye custom component
    const CodeBlock = ({ node, inline, className, children, ...props }: any) => {
        const [isCodeCopied, setIsCodeCopied] = useState(false);
        const match = /language-(\w+)/.exec(className || '');
        const language = match ? match[1] : 'text';

        const handleCodeCopy = () => {
            const codeString = String(children).replace(/\n$/, '');
            navigator.clipboard.writeText(codeString).then(() => {
                setIsCodeCopied(true);
                setTimeout(() => setIsCodeCopied(false), 2000);
            });
        };

        return !inline && match ? (
            <div className="my-4 rounded-md bg-gray-900/80 border border-gray-700 relative">
                <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 rounded-t-md border-b border-gray-700">
                    <span className="text-xs font-sans text-gray-400">{language}</span>
                    <button onClick={handleCodeCopy} className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1">
                        {isCodeCopied ? <Check size={14} /> : <Clipboard size={14} />}
                        {isCodeCopied ? 'Copied!' : 'Copy code'}
                    </button>
                </div>
                <SyntaxHighlighter
                    style={oneDark}
                    language={language}
                    PreTag="div"
                    {...props}
                    customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
                >
                    {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
            </div>
        ) : (
            <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props}>
                {children}
            </code>
        );
    };

    // Message content ko render karne ke liye alag se component banaya taaki code saaf rahe
    const MessageContent = () => {
        // Don't render markdown for image-only messages to improve performance
        if (isImageOnlyMessage()) {
            return null;
        }

        return (
            <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                        code: CodeBlock,
                        p: ({ children }) => <p className="mb-3">{children}</p>,
                        ul: ({ children }) => <ul className="mb-3 pl-6">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-3 pl-6">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        h1: ({ children }) => <h1 className="mb-4 text-xl font-bold">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>,
                        h3: ({ children }) => <h3 className="mb-2 text-base font-medium">{children}</h3>,
                        blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 mb-3 italic">{children}</blockquote>,
                        table: ({ children }) => <table className="border-collapse border border-muted mb-3 w-full">{children}</table>,
                        th: ({ children }) => <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium">{children}</th>,
                        td: ({ children }) => <td className="border border-muted px-3 py-2">{children}</td>,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>
                    }}
                >
                    {message.content}
                </ReactMarkdown>
            </div>
        );
    };

    // Check if this is an image-only message
    const isImageOnlyMessage = () => {
        const hasImageFiles = parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image');
        const hasImageUrl = message.role === "ASSISTANT" && message.content.startsWith('http') &&
            (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/'));
        return hasImageFiles || hasImageUrl;
    };

    // File display logic - optimized for images
    const FileDisplay = () => (
        <>
            {((parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image')) ||
                (message.role === "ASSISTANT" && message.content.startsWith('http') &&
                    (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/')))) && (
                    <div className="space-y-2 mt-4">
                        {parsedFiles && parsedFiles.filter((f: any) => f.type === 'image').map((file: any, index: number) => (
                            <div key={index} className="relative">
                                {imageLoading[`file-${index}`] && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                                    </div>
                                )}
                                {imageError[`file-${index}`] ? (
                                    <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 text-center">
                                        <p className="text-sm text-gray-500">Failed to load image</p>
                                    </div>
                                ) : (
                                    <img
                                        src={
                                            file.url.startsWith('data:image') || file.url.startsWith('http')
                                                ? file.url
                                                : `data:image/jpeg;base64,${file.url}`
                                        }
                                        alt="Generated image"
                                        className="max-w-full h-auto rounded-lg max-h-[400px] object-contain"
                                        loading="lazy"
                                        onLoad={() => {
                                            setImageLoading(prev => ({ ...prev, [`file-${index}`]: false }));
                                        }}
                                        onError={() => {
                                            setImageLoading(prev => ({ ...prev, [`file-${index}`]: false }));
                                            setImageError(prev => ({ ...prev, [`file-${index}`]: true }));
                                        }}
                                    />
                                )}
                            </div>
                        ))}
                        {/* Handle direct image URLs in content - don't show base64 or long URLs */}
                        {message.role === "ASSISTANT" && message.content.startsWith('http') &&
                            (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/')) && (
                                <div className="relative">
                                    {imageLoading['content-image'] && (
                                        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                                        </div>
                                    )}
                                    {imageError['content-image'] ? (
                                        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 text-center">
                                            <p className="text-sm text-gray-500">Failed to load image</p>
                                        </div>
                                    ) : (
                                        <></>
                                    )}
                                </div>
                            )}
                    </div>
                )}
            {parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type !== 'image') && (
                <div className="mt-2 pt-2 border-t border-border/20">
                    <div className="flex flex-wrap gap-1">
                        {parsedFiles
                            .filter((f: any) => f.type !== 'image')
                            .map((file: any, index: number) => (
                                <div key={index} className="flex items-center gap-1">
                                    <FileText className="h-4 w-4" />
                                    <Badge className="text-xs">
                                        {file.name || 'File'}
                                    </Badge>
                                </div>
                            ))}
                    </div>
                </div>
            )}
        </>
    );


    return (
        <div className="flex gap-4 my-4">
            {message.role === "ASSISTANT" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
            )}

            <div className={`flex flex-col w-full ${message.role === 'USER' ? 'items-end' : 'items-start'}`}>
                {message.role === 'USER' && (
                    <Card className="group relative p-3 w-auto max-w-[85%] bg-[#F4F4F4] text-primary dark:bg-[#1E1E1E] dark:text-white ">
                        {isEditing ? (
                            <div className="space-y-2 w-full min-w-[400px]">
                                <Textarea
                                    value={editedContent}
                                    onChange={(e) => setEditedContent(e.target.value)}
                                    className="min-h-[80px]"
                                />
                                <div className="flex gap-2 justify-end">
                                    <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
                                    <Button size="sm" onClick={handleEditSave}>Save</Button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-1 bg-background/80 backdrop-blur-sm p-1 rounded-md border">
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { navigator.clipboard.writeText(message.content); toast.success("Copied!"); }} title="Copy">
                                        <Clipboard size={14} />
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsEditing(true)} title="Edit">
                                        <Pencil size={14} />
                                    </Button>
                                </div>
                                <MessageContent />
                                <FileDisplay />
                            </>
                        )}
                    </Card>
                )}

                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[85%]">
                        <MessageContent />
                        <FileDisplay />
                        <div className="mt-3 flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                onClick={handleGlobalCopy}
                                title="Copy response"
                            >
                                {isCopied ? <Check size={16} /> : <Clipboard size={16} />}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                onClick={handleSpeak}
                                title={isSpeaking ? "Stop speaking" : "Read aloud"}
                            >
                                {isSpeaking ? <Square size={16} /> : <Volume2 size={16} />}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                title="Like"
                                onClick={() => handleFeedback('liked')}
                                className={`h-7 w-7 p-1  ${feedbackSent === 'liked'
                                    ? 'bg-muted text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                    }`}
                            >
                                <ThumbsUp size={16} />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                title="Dislike"
                                className={`h-7 w-7 p-1  ${feedbackSent === 'disliked'
                                    ? 'bg-muted text-foreground text-red-500'
                                    : 'text-muted-foreground hover:text-foreground '
                                    }`}
                                onClick={() => handleFeedback('disliked')}
                            >
                                <ThumbsDown size={16} />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                title="Regenerate"
                                onClick={onRegenerate}
                            >
                                <RefreshCw size={16} />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                title="Edit/Customize"
                            >
                                <Wand2 size={16} />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                onClick={handleShare}
                                title="Share"
                            >
                                <Share2 size={16} />
                            </Button>
                            <DownloadButtons
                                content={message.content}
                                messageId={message.id}
                            />
                        </div>
                    </div>
                )}
            </div>

            {message.role === "USER" && !isImageOnlyMessage() && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="text-xs">U</AvatarFallback>
                </Avatar>
            )}
        </div>
    );
};

export default MessageComponent;