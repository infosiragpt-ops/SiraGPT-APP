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
import { BlockMath, InlineMath } from 'react-katex';

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

    useEffect(() => {
        setEditedContent(message.content);
    }, [message.content]);


    //For Share Functioanlity
    const handleShare = async () => {
        try {
            // Backend API jo humne banayi thi
            const response = await apiClient.handleShare(message.chatId);
            console.log('response',
                response.shareableLink
            );

            navigator.clipboard.writeText(process.env.NEXT_PUBLIC_API_URL + response.shareableLink);
            toast.success("Shareable link copied to clipboard!");
        } catch (error) {
            toast.error(`Failed to create share link. ${error}`);
        }
    };


    // const renderMathContent = (content: string) => {
    //     // Split content to handle inline ($...$) and display ($$...$$) LaTeX
    //     const parts = content.split(/(\$\$[\s\S]+?\$\$|\$[\s\S]+?\$)/g);
    //     return parts.map((part, index) => {
    //         if (part.startsWith('$$') && part.endsWith('$$')) {
    //             // Display math (block)
    //             return <BlockMath key={index} math={part.slice(2, -2)} />;
    //         } else if (part.startsWith('$') && part.endsWith('$')) {
    //             // Inline math
    //             return <InlineMath key={index} math={part.slice(1, -1)} />;
    //         } else {
    //             // Regular Markdown content
    //             return <ReactMarkdown key={index}
    //                 remarkPlugins={[remarkGfm]}
    //                 components={{ code: CodeBlock }}
    //             >{part}</ReactMarkdown>;
    //         }
    //     });
    // };


    const renderMathContent = (content: string) => {
        // Split content to handle inline ($...$) and display ($$...$$) LaTeX
        const parts = content.split(/(\$\$[\s\S]+?\$\$|\$[\s\S]+?\$)/g);
        return parts.map((part, index) => {
            if (part.startsWith('$$') && part.endsWith('$$')) {
                // Display math (block)
                return <BlockMath key={index} math={part.slice(2, -2)} />;
            } else if (part.startsWith('$') && part.endsWith('$')) {
                // Inline math
                return <InlineMath key={index} math={part.slice(1, -1)} />;
            } else {
                // Regular Markdown content
                return <ReactMarkdown key={index}>{part}</ReactMarkdown>;
            }
        });
    };

    const handleEditSave = async () => {
        if (editedContent.trim() === message.content || editedContent.trim() === "") {
            setIsEditing(false);
            return;
        }
        try {
            // Backend API jo humne banayi thi
            await apiClient.editUserMessage(message.id, { content: editedContent });
            // Context function se UI foran update karein
            updateMessageInChat(message.id, editedContent);
            toast.success("Message updated!");
            setIsEditing(false);
        } catch (error) {
            toast.error("Failed to update message.");
        }
    };

    // Poora message copy karne ke liye function
    const handleGlobalCopy = () => {
        navigator.clipboard.writeText(message.content).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000); // 2 second baad icon wapas change ho jayega
        });
    };

    const handleFeedback = async (feedbackType: 'liked' | 'disliked') => {
        if (feedbackSent) return; // Agar pehle se feedback de diya hai to kuch na karein

        try {
            // Backend API ko call karein jo humne Step 1.2 mein banayi thi
            await apiClient.handleFeedbackLikeDislike(message.id, feedbackType);
            setFeedbackSent(feedbackType); // State update karein taake button ka color change ho
            toast.success("Feedback submitted!");
        } catch (error) {
            toast.error("Could not submit feedback.");
        }
    };

    const handleSpeak = () => {
        if (isSpeaking) {
            window.speechSynthesis.cancel(); // Speech ko rokein
            setIsSpeaking(false);
            return;
        }

        // Markdown ko saaf karein taaki raw text bola jaye
        const textToSpeak = message.content
            .replace(/```[\s\S]*?```/g, 'Code block') // Code blocks ko "Code block" se replace karein
            .replace(/`[^`]*`/g, 'Code') // Inline code ko "Code" se
            .replace(/([_*#`~]|\\[*#`~])/g, '') // Markdown characters hata dein
            .replace(/\[(.*?)\]\(.*?\)/g, '$1'); // Links se sirf text nikalein

        const utterance = new SpeechSynthesisUtterance(textToSpeak);

        // Jab bolna khatam ho jaye to state update karein
        utterance.onend = () => {
            setIsSpeaking(false);
        };

        // Speech shuru karein
        window.speechSynthesis.speak(utterance);
        setIsSpeaking(true);
    };


    // Files parse karne ka logic (aapke original code se)
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
    const MessageContent = () => (
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

    // File display logic (aapke original code se)
    const FileDisplay = () => (
        <>
            {((parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image')) ||
                (message.role === "ASSISTANT" && message.content.startsWith('http') && (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle')))) && (
                    <div className="space-y-2 mt-4">
                        {parsedFiles && parsedFiles.filter((f: any) => f.type === 'image').map((file: any, index: number) => (
                            <div key={index} className="relative">
                                <img
                                    src={file.url}
                                    alt="Generated image"
                                    className="max-w-full h-auto rounded-lg"
                                />
                            </div>
                        ))}
                        {/* {message.role === "ASSISTANT" && message.content.startsWith('http') &&
                            (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle')) && (
                                <div className="relative">
                                    <img
                                        src={message.content}
                                        alt="Generated image"
                                        className="max-w-full h-auto rounded-lg"
                                    />
                                </div>
                            )} */}
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
            {/* Avatar for Assistant */}
            {message.role === "ASSISTANT" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
            )}

            {/* Main content area */}
            <div className={`flex flex-col w-full ${message.role === 'USER' ? 'items-end' : 'items-start'}`}>

                {/* USER Message in a Card */}

                {/* NEw Code */}
                {message.role === 'USER' && (
                    <Card className="group relative p-3 w-auto max-w-[85%] bg-[#F4F4F4] text-primary dark:bg-[#1E1E1E] dark:text-white ">
                        {isEditing ? (
                            // --- Edit Mode ka UI ---
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
                            // --- Normal Display Mode ka UI ---
                            <>
                                {/* Hover par dikhne wale buttons */}
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
                {/* ASSISTANT Message (clean text) */}
                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[85%]">
                        <MessageContent />
                        <FileDisplay />
                        {/* Global Copy Button - Sirf AI messages ke liye */}
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
                                // className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                title="Dislike"
                                className={`h-7 w-7 p-1  ${feedbackSent === 'disliked'
                                    ? 'bg-muted text-foreground text-red-500'
                                    : 'text-muted-foreground hover:text-foreground '
                                    }`}
                                //  className={`h-7 w-7 p-1 ${feedbackSent === 'disliked' ? 'text-red-500' : ''}`} 
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
                                // onClick={handleEdit}
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
                            {/* <DownloadButtons
                                content={message.content}
                                messageId={message.id}
                            /> */}
                        </div>
                    </div>
                )}
            </div>

            {/* Avatar for User */}
            {message.role === "USER" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                    <AvatarFallback className="text-xs">U</AvatarFallback>
                </Avatar>
            )}
        </div>
    );
};

export default MessageComponent;
