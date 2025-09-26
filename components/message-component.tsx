"use client"

import * as React from "react"
import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
    Copy, Clipboard, Pencil, FileText, Check, Volume2, VolumeX,
    ThumbsUp, ThumbsDown, Share2, Play, Pause, Download,
    Loader2, Video, AlertCircle, CheckCircle, RefreshCw, Wand2, Video as VideoIcon,
    Sparkles
} from "lucide-react"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"
import { useVoiceControls } from './voice-controls';
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import { DownloadButtons } from './download-buttons';
// Enhanced Message Component with Video Support
const MessageComponent = ({ message, user, onRegenerate, updateMessageInChat }: {
    message: any;
    user: any;
    onRegenerate: () => void;
    updateMessageInChat: (messageId: string, newContent: string) => void
}) => {
    const [isCopied, setIsCopied] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
    const [audioProgress, setAudioProgress] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [showAudioPlayer, setShowAudioPlayer] = useState(false);
    const [isLoadingAudio, setIsLoadingAudio] = useState(false);
    const [feedbackSent, setFeedbackSent] = useState(message.feedback || null);
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(message.content);
    const [imageLoading, setImageLoading] = useState<{ [key: string]: boolean }>({});
    const [imageError, setImageError] = useState<{ [key: string]: boolean }>({});

    // Video-specific states
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(false);
    const [isVideoPlaying, setIsVideoPlaying] = useState(false);
    const [videoProgress, setVideoProgress] = useState(0);
    const [videoDuration, setVideoDuration] = useState(0);

    const videoRef = React.useRef<HTMLVideoElement>(null);
    const { handleTextToSpeech } = useVoiceControls();

    useEffect(() => {
        setEditedContent(message.content);
    }, [message.content]);

    // Cleanup audio when component unmounts
    useEffect(() => {
        return () => {
            if (currentAudio) {
                currentAudio.pause();
                setCurrentAudio(null);
            }
        };
    }, [currentAudio]);

    // Video event handlers
    const handleVideoPlay = () => {
        if (videoRef.current) {
            videoRef.current.play();
            setIsVideoPlaying(true);
        }
    };

    const handleVideoPause = () => {
        if (videoRef.current) {
            videoRef.current.pause();
            setIsVideoPlaying(false);
        }
    };

    const handleVideoTimeUpdate = () => {
        if (videoRef.current) {
            const progress = (videoRef.current.currentTime / videoRef.current.duration) * 100;
            setVideoProgress(progress);
        }
    };

    const handleVideoLoadedMetadata = () => {
        if (videoRef.current) {
            setVideoDuration(videoRef.current.duration);
        }
    };

    const downloadVideo = async () => {
        if (message.videoData?.filename) {
            try {
                setVideoLoading(true);
                // apiClient.downloadVideo returns a URL string, not a blob. We need to fetch the file as a blob.
                // const downloadUrl = apiClient.downloadVideo(message.videoData.filename);
                // const response = await fetch(downloadUrl);
                // if (!response.ok) throw new Error('Network response was not ok');
                // const blob = await response.blob();
                const blob = await apiClient.downloadVideo(message.videoData.filename);
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = message.videoData.filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                toast.success('Video downloaded successfully!');
            } catch (error) {
                console.error('Download failed:', error);
                toast.error('Failed to download video');
            } finally {
                setVideoLoading(false);
            }
        }
    };
    const ShimmerContent = () => {
        return (
            <div className="flex items-start gap-2 text-muted-foreground py-2 px-4">
                <Sparkles className="h-4 w-4 text-primary animate-bounce mt-0.5" />
                <p className="text-sm font-medium animate-pulse">Thinking...</p>
            </div>
        );
    };


    const isAssistant = message.role === "ASSISTANT";
    const isUser = message.role === "USER";

    // Ahem Condition: Kya yeh ek khali AI message hai?
    const isThinking = isAssistant && !message.content;
    // For Share Functioanlity
    const handleShare = async () => {
        try {
            const response = await apiClient.handleShare(message.chatId);
            const baseUrl = process.env.NEXT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
            let url = `${baseUrl}/${response.shareableLink}`;
            navigator.clipboard.writeText(url);
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

    const handleSpeak = async () => {
        if (isSpeaking && currentAudio) {
            currentAudio.pause();
            setIsSpeaking(false);
            setCurrentAudio(null);
            return;
        }

        const textToSpeak = message.content
            .replace(/```[\s\S]*?```/g, 'Code block')
            .replace(/`[^`]*`/g, 'Code')
            .replace(/([_*#`~]|\\[*#`~])/g, '')
            .replace(/\[(.*?)\]\(.*?\)/g, '$1');

        try {
            setIsLoadingAudio(true);
            setShowAudioPlayer(true);
            // Try ElevenLabs TTS first
            const audio = await handleTextToSpeech(textToSpeak);
            setIsLoadingAudio(false);
            if (audio) {
                setCurrentAudio(audio);

                // Set up audio event listeners
                audio.onloadedmetadata = () => {
                    setAudioDuration(audio.duration);
                };

                audio.ontimeupdate = () => {
                    setAudioProgress((audio.currentTime / audio.duration) * 100);
                };

                audio.onended = () => {
                    setIsSpeaking(false);
                    setAudioProgress(0);
                    setShowAudioPlayer(false);
                    setCurrentAudio(null);
                };

                audio.onerror = () => {
                    setIsSpeaking(false);
                    setAudioProgress(0);
                    setShowAudioPlayer(false);
                    setCurrentAudio(null);
                    setIsLoadingAudio(false);
                    toast.error("Audio playback failed");
                };

                audio.onpause = () => {
                    setIsSpeaking(false);
                };

                audio.onplay = () => {
                    setIsSpeaking(true);
                };
            }
        } catch (error) {
            // Fallback to browser TTS
            console.log('ElevenLabs TTS failed, using browser TTS:', error);
            setIsLoadingAudio(false);
            setShowAudioPlayer(false);
            const utterance = new SpeechSynthesisUtterance(textToSpeak);
            utterance.onend = () => {
                setIsSpeaking(false);
                setCurrentAudio(null);
            };
            window.speechSynthesis.speak(utterance);
        }
    };

    const toggleAudioPlayback = () => {
        if (currentAudio) {
            if (isSpeaking) {
                currentAudio.pause();
            } else {
                currentAudio.play();
            }
        }
    };

    const stopAudio = () => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        setIsSpeaking(false);
        setAudioProgress(0);
        setShowAudioPlayer(false);
        setCurrentAudio(null);
        setIsLoadingAudio(false);
    };

    const formatTime = (seconds: number) => {
        if (isNaN(seconds)) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const parsedFiles: any[] = useMemo(() => {
        if (!message.files) return []
        try {
            return typeof message.files === 'string' ? JSON.parse(message.files) : message.files
        } catch (e) {
            console.error("Failed to parse files:", e)
            return []
        }
    }, [message.files])

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
        if (isImageOnlyMessage() || isVideoMessage) {
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
                        table: ({ children }) => <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600">
                            <table className="border-collapse border border-muted mb-3 min-w-[1000px]">
                                {children}
                            </table>
                        </div>,
                        th: ({ children }) => <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium">{children}</th>,
                        td: ({ children }) => <td className="border border-muted px-3 py-2">{children}</td>,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>,
                        a: ({ href, children, ...props }) => (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sky-600 hover:text-sky-800 underline decoration-sky-400 hover:decoration-sky-600"
                                {...props}
                            >
                                {children}
                            </a>
                        )

                    }}
                >
                    {message.content}
                </ReactMarkdown>
            </div>
        );
    };

    const videoEntry = useMemo(
        () => parsedFiles.find((f: any) => f?.type === 'video'),
        [parsedFiles]
    )
    const isVideoMessage = !!videoEntry


    // Check if this is an image-only message
    const isImageOnlyMessage = () => {
        const hasImageFiles = parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image');
        const hasImageUrl = message.role === "ASSISTANT" && message.content.startsWith('http') &&
            (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/'));
        return hasImageFiles || hasImageUrl;
    };
    const getWatchUrl = (filename: string) => apiClient.getVideoFile(filename)
    const getDownloadUrl = (filename: string) => apiClient.downloadVideo(filename)

    const VideoDisplay = () => {
        if (!isVideoMessage) return null

        const status = String(videoEntry.status || '').toLowerCase()
        const filename = videoEntry.filename

        return (
            <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                <div className="flex items-center gap-2 text-sm">
                    <VideoIcon className="h-4 w-4" />
                    <span className="font-medium">AI Video</span>
                </div>

                {status === 'processing' || status === 'in_progress' ? (
                    <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Generating video… This may take 2–5 minutes.</span>
                    </div>
                ) : null}

                {status === 'failed' ? (
                    <div className="mt-2 text-red-500 text-sm">
                        Generation failed. Please try again with a shorter prompt.
                    </div>
                ) : null}

                {status === 'completed' && filename ? (
                    <div className="mt-3 space-y-2">
                        <video
                            key={filename}             // don’t remount unless the file changes
                            ref={videoRef}
                            className="w-full rounded-md"
                            controls
                            preload="auto"
                            playsInline
                            src={getWatchUrl(filename)}
                            // Removed onTimeUpdate/onLoadedMetadata to avoid frequent re-renders
                            onError={(e) => {
                                console.error('Video error', e)
                                toast.error('Failed to play video inline. Try “Open in new tab”.')
                            }}
                        />
                        <div className="flex gap-2">
                            <Button size="sm" variant="outline" asChild>
                                <a href={getDownloadUrl(filename)} download>
                                    <Download className="h-4 w-4 mr-1" />
                                    Download
                                </a>
                            </Button>
                            <Button size="sm" variant="outline" asChild>
                                <a href={getWatchUrl(filename)} target="_blank" rel="noopener noreferrer">
                                    Open in new tab
                                </a>
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        )
    }

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
            {parsedFiles && parsedFiles.length > 0 && message.role === "USER" && (
                <div className="mt-2 pt-2 border-t border-border/20 flex flex-wrap gap-2">
                    {parsedFiles.some((file: any) => file.type?.startsWith('image/')) ? (
                        // Only images, aligned right
                        <div className="flex flex-wrap gap-1 ml-auto">
                            {parsedFiles
                                .filter((file: any) => file.type?.startsWith("image/"))
                                .map((file: any, index: number) => {
                                    let imageUrl = file.url || file.base64;

                                    if (imageUrl?.includes("localhost:3000") || imageUrl?.startsWith("/uploads")) {
                                        imageUrl = `${process.env.NEXT_PUBLIC_IMAGE_URL}${imageUrl.replace("http://localhost:3000", "")}`;
                                    }

                                    return (
                                        <img
                                            key={index}
                                            src={imageUrl}
                                            alt={file.name || "Image"}
                                            className="max-w-full h-auto rounded-lg max-h-[350px] object-cover"
                                        />
                                    );
                                })}
                        </div>

                    ) : (
                        // Only non-image files, aligned left
                        <div className="flex flex-wrap gap-1">
                            {parsedFiles
                                .filter((file: any) => !file.type?.startsWith('image/'))
                                .map((file: any, index: number) => (
                                    <div key={index} className="flex items-center gap-1 px-2 py-1 border rounded">
                                        <FileText className="h-4 w-4" />
                                        <span className="text-xs">{file.originalName || file.name || 'File'}</span>
                                    </div>
                                ))}
                        </div>
                    )}
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
                                <div className="absolute bottom-1 right-1 hidden group-hover:flex items-center gap-1 bg-background/80 backdrop-blur-sm p-1 rounded-md border">
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { navigator.clipboard.writeText(message.content); toast.success("Copied!"); }} title="Copy">
                                        <Copy size={14} />
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsEditing(true)} title="Edit">
                                        <Pencil size={14} />
                                    </Button>
                                </div>
                                <FileDisplay />
                                <div className="mt-2" />
                                <MessageContent />

                            </>
                        )}
                    </Card>
                )}

                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[90%]">
                        {isThinking ? (
                            <ShimmerContent />
                        ) : (<>
                            <MessageContent />
                            <VideoDisplay />
                            <FileDisplay />
                        </>)}


                        {/* Action buttons for assistant messages */}
                        {!isVideoMessage && (
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
                                    title="Read aloud"
                                >
                                    <Volume2 size={16} />
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
                                {/* <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
                                    title="Edit/Customize"
                                >
                                    <Wand2 size={16} />
                                </Button> */}
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
                        )}
                    </div>
                )}
            </div>

            {message.role === "USER" && !isImageOnlyMessage() && !isVideoMessage && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-muted text-muted-foreground text-xs">
                        {user?.name?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                </Avatar>
            )}
        </div>
    );
};
const areMessagePropsEqual = (prev: any, next: any) => {
    const a = prev.message
    const b = next.message
    if (a.id !== b.id) return false
    if (a.content !== b.content) return false

    const af = typeof a.files === 'string' ? a.files : JSON.stringify(a.files || [])
    const bf = typeof b.files === 'string' ? b.files : JSON.stringify(b.files || [])
    if (af !== bf) return false

    // Ignore parent re-renders from user, callbacks (they’re stable from context)
    return true
}

export default React.memo(MessageComponent, areMessagePropsEqual)
