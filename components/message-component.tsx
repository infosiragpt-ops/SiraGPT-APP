"use client"

import * as React from "react"
import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import GmailConnectionCard from "./GmailConnectionCard"
import GoogleServicesConnectionCard from "./GoogleServicesConnectionCard"
import {
    Copy, Clipboard, Pencil, FileText, Check, Volume2, VolumeX,
    ThumbsUp, ThumbsDown, Share2, Play, Pause, Download,
    Loader2, Video, AlertCircle, CheckCircle, RefreshCw, Wand2, Video as VideoIcon,
    Sparkles, Eye,
    ExternalLink, Mail
} from "lucide-react"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
    DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"
import { useVoiceControls } from './voice-controls';
import ReactMarkdown from 'react-markdown'
import { PerformanceOptimizer } from "@/lib/performance-optimizer"
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import { DownloadButtons } from './download-buttons';
import TableControls from './TableControls';
import ImageGenerationEffect from './ImageGenerationEffect';
// import CodePreview from './code-preview';
import { parseCodeFromContent, hasWebDevelopmentCode, combineWebCode, detectCodeType } from '@/lib/code-detection';
import ChartComponent from './chart-component';
import { PresentationView } from './presentation-view';
import { CustomCodeBlock } from "./ui/custom-code-block"
import ProcessingGmailCard from "./ProcessingGmailCard"
import ProcessingGoogleServicesCard from "./ProcessingGoogleServicesCard"
import SpotifyConnectionCard from "./SpotifyConnectionCard"
import SpotifyResults from "./spotify-results"

// Adjusted truncateUrl function to ensure links are not overly shortened
const truncateUrl = (url: string, maxLength: number = 30) => {
    if (url.length <= maxLength) return url;
    const domain = url.split('/')[2]; // Extract domain
    const path = url.split('/').slice(3).join('/'); // Extract path
    const truncatedPath = path.length > 25 ? `${path.slice(0, 25)}...` : path;
    return `${domain}/${truncatedPath}`;
};

// Chart Display Component
const ChartDisplay = ({ files, fullResponse }: { files: any[], fullResponse?: any[] }) => {
    const chartFile = files.find(f => f.type === 'chart');
    if (!chartFile) return null;

    const { imageUrl, pythonCode } = chartFile;

    // If there's an image, show the chart.
    if (imageUrl) {
        return (
            <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                <div className="flex items-center gap-2 text-sm mb-2">
                    <Wand2 className="h-4 w-4" />
                    <span className="font-medium">Generated Chart</span>
                </div>
                <img
                    src={imageUrl}
                    alt="Generated chart"
                    className="max-w-full h-auto rounded-lg mb-2"
                />
                {pythonCode && (
                    <details>
                        <summary className="text-xs text-muted-foreground cursor-pointer">View Python Code</summary>
                        <pre className="text-xs bg-gray-800 text-white p-2 rounded-md mt-1 overflow-x-auto">
                            <code>{pythonCode}</code>
                        </pre>
                    </details>
                )}
            </div>
        );
    }

    // If no image, but there is a fullResponse, show the message from it.
    const responseText = fullResponse?.[0]?.content?.[0]?.text;
    if (responseText) {
        return (
            <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
                    <p>{responseText}</p>
                </div>
            </div>
        );
    }

    // Fallback if there's no image and no valid fullResponse.
    return null;
};


// Enhanced Message Component with Video Support
const MessageComponent = ({ message, user, onRegenerate, updateMessageInChat, isStreaming, onToggleSplitView, isGeneratingImage, children }: {
    message: any;
    user: any;
    onRegenerate: () => void;
    updateMessageInChat: (messageId: string, newContent: string) => void;
    isStreaming?: boolean;
    onToggleSplitView?: (content: any) => void;
    isGeneratingImage?: boolean;
    children?: React.ReactNode;
}) => {
    // Performance monitoring disabled to prevent overhead
    // const renderStartTime = performance.now()
    // const performanceOptimizer = PerformanceOptimizer.getInstance()
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
    const [selectedFile, setSelectedFile] = useState<any>(null);
    const [fileContent, setFileContent] = useState<string>("");
    const [isContentLoading, setIsContentLoading] = useState(false);
    const [isTableExpanded, setIsTableExpanded] = useState(false);
    const [tableData, setTableData] = useState<string[][]>([]);
    const [tableHeaders, setTableHeaders] = useState<string[]>([]);

    const [tableTitle, setTableTitle] = useState<string>('');

    // Code preview states (now memoized for performance)

    const getNodeText = (node: any): string => {
        if (node.type === 'text') {
            return node.value;
        }
        if (node.children) {
            return node.children.map(getNodeText).join('');
        }
        return '';
    };



    // Video-specific states
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(false);
    const [isVideoPlaying, setIsVideoPlaying] = useState(false);
    const [videoProgress, setVideoProgress] = useState(0);
    const [videoDuration, setVideoDuration] = useState(0);

    const videoRef = React.useRef<HTMLVideoElement>(null);
    const { handleTextToSpeech } = useVoiceControls();

    const handleViewFile = async (file: any) => {
        if (!file.id) {
            toast.error("File ID is missing. Cannot fetch content.");
            return;
        }
        setSelectedFile(file);
        setIsContentLoading(true);
        setFileContent("");
        try {
            // This function will need to be created in lib/api.ts
            const content = await apiClient.getFileContent(file.id);
            setFileContent(content);
        } catch (error) {
            console.error("Failed to fetch file content:", error);
            toast.error("Failed to load file content.");
            setFileContent("Error: Could not load file content.");
        } finally {
            setIsContentLoading(false);
        }
    };

    useEffect(() => {
        setEditedContent(message.content);
    }, [message.content]);

    // Optimized code detection with memoization to prevent repeated parsing
    const parsedCode = useMemo(() => {
        if (message.content && (message.role === 'assistant' || message.role === 'ASSISTANT')) {
            return parseCodeFromContent(message.content);
        }
        return null;
    }, [message.content, message.role]);

    const canPreviewMessage = useMemo(() => {
        if (!parsedCode) return false;
        if (!parsedCode.hasWebCode) return false;
        if (parsedCode.hasNonWebCode && !parsedCode.combinedCode) return false;
        return !!(parsedCode.combinedCode || parsedCode.html);
    }, [parsedCode]);

    const handlePreview = () => {
        if (!parsedCode || !onToggleSplitView) return;

        const content = {
            htmlCode: parsedCode.html || '',
            cssCode: parsedCode.css || '',
            jsCode: parsedCode.js || '',
            combinedCode: parsedCode.combinedCode || '',
            title: 'Code Preview'
        };

        onToggleSplitView(content);
    };

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

    const ErrorMessage = ({ onRegenerate }: { onRegenerate: () => void }) => (
        <div className="flex items-center gap-2 text-red-500 py-2 px-4 bg-red-500/10 rounded-md">
            <AlertCircle className="h-4 w-4" />
            <p className="text-sm font-medium">An error occurred.</p>
            <Button onClick={onRegenerate} variant="ghost" size="sm" className="ml-auto">
                <RefreshCw className="h-4 w-4 mr-1" />
                Try again
            </Button>
        </div>
    );


    const isAssistant = message.role === "ASSISTANT";
    const isUser = message.role === "USER";

    // Ahem Condition: Kya yeh ek khali AI message hai?
    const isThinking = isAssistant && !message.content && !message.error;
    // const isThinking = isAssistant && message.content === null;

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
            const parsed = typeof message.files === 'string' ? JSON.parse(message.files) : message.files
            // Ensure we always return an array
            return Array.isArray(parsed) ? parsed : []
        } catch (e) {
            console.error("Failed to parse files:", e)
            return []
        }
    }, [message.files])

    const hasFiles = parsedFiles && parsedFiles.length > 0;
    const hasContent = message.content && message.content.trim() !== "";

    // Detect if this assistant message includes a structured Gmail payload to avoid duplicate markdown
    const hasGmailEntry = useMemo(() => {
        return Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
    }, [parsedFiles])

    // Optimized CodeBlock component with performance improvements
    const CodeBlock = ({ node, inline, className, children, ...props }: any) => {
        const match = /language-(\w+)/.exec(className || '');
        return !inline && match ? (
            <CustomCodeBlock className={className} {...props} canPreview={canPreviewMessage} onPreview={handlePreview}>
                {children}
            </CustomCodeBlock>
        ) : (
            <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {children}
            </code>
        );
    };

    // Optimized message content rendering with performance safeguards
    const MessageContent = ({ content }: { content: string }) => {
        if (message.role === 'ASSISTANT' && (content === '[GENERATING_IMAGE]' || content === '[PROCESSING_GMAIL]' || content === '[PROCESSING_CALENDAR_ACTION]' || content === '[PROCESSING_DRIVE_ACTION]')) {
            return null;
        }
        // Don't render markdown for image-only messages to improve performance
        if (isImageOnlyMessage() || isVideoMessage) {
            return null;
        }

        // ✅ PERFORMANCE FIX: Use simple rendering for streaming messages
        // if (isStreaming) {
        //     return (
        //         <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
        //             <p className="mb-3 text-base whitespace-pre-wrap">{message.content}</p>
        //         </div>
        //     );
        // }


        // Memoize ReactMarkdown components to prevent unnecessary re-renders
        const components = useMemo(() => {
            const commonProps = {
                p: ({ children }: any) => <p className="mb-3 text-base">{children}</p>,
                ul: ({ children }: any) => <ul className="mb-3 pl-6 text-base">{children}</ul>,
                ol: ({ children }: any) => <ol className="mb-3 pl-6 text-base">{children}</ol>,
                li: ({ children }: any) => <li className="mb-1 text-base">{children}</li>,
                h1: ({ children }: any) => <h1 className="mb-4 text-xl font-bold">{children}</h1>,
                h2: ({ children }: any) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>,
                h3: ({ children }: any) => <h3 className="mb-2 text-base font-medium">{children}</h3>,
                blockquote: ({ children }: any) => <blockquote className="border-l-4 border-muted pl-4 mb-3 italic">{children}</blockquote>,
                table: ({ node, children, ...props }: any) => {
                    const tHead = node.children.find((child: any) => child.tagName === 'thead');
                    const tBody = node.children.find((child: any) => child.tagName === 'tbody');
                    const headers = tHead?.children?.[1]?.children?.map(getNodeText).filter((e: string) => e != "\n") ?? [];
                    const data = tBody?.children?.map((tr: any) => tr.children?.map(getNodeText).filter((e: string) => e != "\n") ?? []) ?? [];
                    const handleExpand = () => {
                        setTableHeaders(headers);
                        setTableData(data);
                        setTableTitle(title);
                        setIsTableExpanded(true);
                    };
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
                    return (
                        <div className="relative mt-3">
                            <TableControls content={message.content} messageId={message.id} onExpand={handleExpand} title={title} />
                            <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600" style={{ WebkitOverflowScrolling: 'touch', maxWidth: '100vw' }}>
                                <table className="border-collapse border border-muted mb-3 w-full" style={{ minWidth: "520px" }}>{children}</table>
                            </div>
                            <div className="block md:hidden mt-1 text-xs text-muted-foreground text-center select-none">Swipe left/right to view the table</div>
                        </div>
                    );
                },
                th: ({ children }: any) => <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium text-sm whitespace-nowrap">{children}</th>,
                td: ({ children }: any) => <td className="border border-muted px-3 py-2 text-sm whitespace-nowrap">{children}</td>,
                strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }: any) => <em className="italic">{children}</em>,
                a: ({ href, children, ...props }: any) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-600 hover:text-sky-800 underline decoration-sky-400 hover:decoration-sky-600"
                        title={href} // Tooltip for full URL
                        {...props}
                    >
                        {truncateUrl(children)}
                    </a>
                )
            };

            if (isStreaming) {
                return {
                    ...commonProps,
                    code: ({ node, inline, className, children, ...props }: any) => {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                            <pre className="text-sm whitespace-pre-wrap p-4 my-4 bg-gray-900/80 rounded-md font-mono text-white"><code>{String(children)}</code></pre>
                        ) : (
                            <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props}>{children}</code>
                        );
                    },
                };
            }

            return {
                ...commonProps,
                code: CodeBlock,
            };
        }, [isStreaming, CodeBlock]);


        return (
            <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex, rehypeRaw]}

                    // rehypePlugins={[rehypeKatex, rehypeRaw]} //for advacne show website in our app
                    components={components}
                >
                    {content}
                </ReactMarkdown>
            </div>
        );
    };

    const videoEntry = useMemo(
        () => Array.isArray(parsedFiles) ? parsedFiles.find((f: any) => f?.type === 'video') : null,
        [parsedFiles]
    )
    const isVideoMessage = !!videoEntry

    const pptEntry = useMemo(
        () => Array.isArray(parsedFiles) ? parsedFiles.find((f: any) => f?.type === 'presentation' || f?.type === 'ppt') : null,
        [parsedFiles]
    )
    const isPPTMessage = !!pptEntry

    const displayedContent = useMemo(() => {
        if (isPPTMessage && pptEntry.structure?.slides?.length > 0) {
            const presentationContent = pptEntry.structure.slides.map((slide: any, index: number) => {
                const title = slide.title || `Slide ${index + 1}`;
                const contentInput = slide.content;
                let content = '';

                // Ensure content is a string before processing
                if (typeof contentInput === 'string') {
                    content = contentInput;
                } else if (Array.isArray(contentInput)) {
                    content = contentInput.join('\n');
                }

                // Check if content is already a list to avoid double-bulleting
                const isAlreadyList = content.trim().startsWith('* ') || content.trim().startsWith('- ') || /^\d+\.\s/.test(content.trim());

                if (content && !isAlreadyList) {
                    content = content
                        .split('\n')
                        .filter((line: string) => line.trim() !== '')
                        .map((line: string) => `* ${line.trim()}`)
                        .join('\n');
                }

                return `### ${title}\n${content}`;
            }).join('\n\n');

            // Replace the placeholder text with the formatted presentation content
            if (message.content && typeof message.content === 'string') {
                const placeholderRegex = /generated presentation.*$/i;
                if (placeholderRegex.test(message.content)) {
                    return message.content.replace(placeholderRegex, presentationContent);
                }
            }

            // Fallback: append if no placeholder is found
            return `${message.content}\n\n${presentationContent}`;
        }
        return message.content;
    }, [message.content, isPPTMessage, pptEntry]);

    // Check for Gmail connection requirement
    const isGmailConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'gmail_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    // Check for Google Services connection requirement
    const isGoogleServicesConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'google_services_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    const isSpotifyConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'spotify_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    // Gmail Connection Component
    const GmailConnectionDisplay = () => {
        if (!isGmailConnectionRequired) return null;

        return (
            <div className="mt-4">
                <GmailConnectionCard
                    onConnect={() => {
                        // Optional: Add any additional handling after connection
                        console.log('Gmail connection initiated');
                    }}
                />
            </div>
        );
    };

    // Google Services Connection Component
    const GoogleServicesConnectionDisplay = () => {
        if (!isGoogleServicesConnectionRequired) return null;

        return (
            <div className="mt-4">
                <GoogleServicesConnectionCard
                    onConnectionChange={(isConnected) => {
                        if (isConnected) {
                            console.log('Google Services connected successfully');
                        }
                    }}
                />
            </div>
        );
    };

    const SpotifyConnectionDisplay = () => {
        if (!isSpotifyConnectionRequired) return null;

        return (
            <div className="mt-4">
                <SpotifyConnectionCard />
            </div>
        );
    };

    const SpotifyResultsDisplay = () => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                if (metadata?.type === 'spotify_results') {
                    return <SpotifyResults data={metadata.data} />;
                }
            }
            return null;
        } catch {
            return null;
        }
    };

    // Check if this is an image-only message
    const isImageOnlyMessage = () => {
        const hasImageFiles = Array.isArray(parsedFiles) && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image');
        const hasImageUrl = message.role === "ASSISTANT" && message.content.startsWith('http') &&
            (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/'));
        return hasImageFiles || hasImageUrl;
    };
    const getWatchUrl = (filename: string) => apiClient.getVideoFile(filename)

    const PPTDisplay = () => {
        if (!isPPTMessage) return null;

        const presentationData = {
            title: pptEntry.title || 'AI Presentation',
            slides: pptEntry.structure?.slides || [],
            filename: pptEntry.filename || pptEntry.path,
        };

        const getPPTUrl = () => {
            const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || 'http://localhost:5000';
            return `${baseUrl}/uploads/presentations/${presentationData.filename}`;
        };

        const downloadPPT = async () => {
            try {
                const url = getPPTUrl();
                const a = document.createElement('a');
                a.href = url;
                a.download = presentationData.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                toast.success('Presentation downloaded successfully!');
            } catch (error) {
                console.error('Download failed:', error);
                toast.error('Failed to download presentation');
            }
        };

        return (
            <div className="flex gap-2 mt-4">
                <Button size="sm" variant="default" onClick={() => {
                    const event = new CustomEvent('preview-presentation', { detail: { presentation: presentationData } });
                    window.dispatchEvent(event);
                }} className="bg-blue-600 hover:bg-blue-700">
                    <Eye className="h-4 w-4 mr-2" />
                    Preview
                </Button>
                <Button size="sm" variant="outline" onClick={downloadPPT}>
                    <Download className="h-4 w-4 mr-2" />
                    Download
                </Button>
            </div>
        );
    };

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
                            <Button size="sm" variant="outline" onClick={downloadVideo}>
                                <Download className="h-4 w-4 mr-1" />
                                Download
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
    const GmailSummary = ({ message }: { message: any }) => {
        try {
            const rawContent: string = typeof message.content === 'string' ? message.content : '';
            // Remove the embedded JSON block
            const withoutJson = rawContent.replace(/<EMAILS_JSON>[\s\S]*?<\/EMAILS_JSON>/g, '').trim();

            if (!withoutJson) return null;

            // If we also have a structured emails payload, trim out detailed per-email bullets/links
            const hasStructuredEmails = Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
                || /https:\/\/mail\.google\.com\/mail\//i.test(rawContent);

            let cleaned = withoutJson;
            if (hasStructuredEmails) {
                // Strategy: keep narrative paragraphs and totals; drop paragraphs that look like
                // per-email bullets or contain direct Gmail links (to avoid duplication with the list below)
                const paras = withoutJson.split(/\n\n+/);
                const keep: string[] = [];
                for (const p of paras) {
                    const pTrim = p.trim();
                    const hasGmailLink = /https:\/\/mail\.google\.com\/mail\//i.test(pTrim) || /\bOpen in Gmail\b/i.test(pTrim) || /\bView:\b/i.test(pTrim);
                    const looksLikeEmailBullet = /^[-•]/.test(pTrim) && (/(From:|To:|Ref:|Consumer:|Amount|PKR|USD|View:)/i.test(pTrim));
                    const isNumberedList = /^\d+\s*[\.)]/.test(pTrim);
                    if (hasGmailLink || looksLikeEmailBullet || isNumberedList) {
                        continue; // drop
                    }
                    keep.push(pTrim);
                }
                // Ensure we don't return empty; if everything was dropped, fall back to the first few lines
                cleaned = keep.join('\n\n').trim() || withoutJson.split('\n').slice(0, 6).join('\n');
            }

            return (
                <div className="mb-2 text-md text-foreground/90 prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeRaw]}>
                        {cleaned}
                    </ReactMarkdown>
                </div>
            );
        } catch {
            return null;
        }
    };

    // Gmail emails/search display with inline actions
    const GmailEmailsDisplay = () => {
        // Find gmail emails or search results payload
        const gmailEntry = Array.isArray(parsedFiles)
            ? parsedFiles.find((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
            : null;
        if (!gmailEntry) return null;

        const extractEmailsJsonBlock = (text: string) => {
            const m = text.match(/<EMAILS_JSON>([\s\S]*?)<\/EMAILS_JSON>/);
            if (!m) return { jsonText: null as string | null, start: -1, end: -1 };
            return { jsonText: m[1], start: m.index ?? -1, end: (m.index ?? 0) + m[0].length };
        };

        const { jsonText } = extractEmailsJsonBlock(typeof message.content === 'string' ? message.content : '');

        const updateLabelIds = (labelIds: any, label: string, present: boolean) => {
            const base: string[] = Array.isArray(labelIds) ? labelIds : [];
            if (present) {
                return base.includes(label) ? base : [...base, label];
            }
            return base.filter((l) => l !== label);
        };

        const initialEmails: any[] = gmailEntry.emails || [];
        const [emails, setEmails] = useState<any[]>(initialEmails);
        const [replyForId, setReplyForId] = useState<string | null>(null);
        const [replyBody, setReplyBody] = useState<string>("");
        const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});

        // Sync local state when payload changes
        useEffect(() => {
            setEmails(initialEmails);
        }, [gmailEntry, gmailEntry?.emails?.length]);

        const title = gmailEntry.type === 'gmail_search_results' && gmailEntry.query
            ? `Search: ${gmailEntry.query}`
            : (gmailEntry.filters?.unreadOnly ? 'Unread emails' : (gmailEntry.filters?.readOnly ? 'Read emails' : 'Latest emails'));

        const toggleRead = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                // markGmailEmail(messageId, read: boolean)
                await apiClient.markGmailEmail(id, em.isUnread ? true : false);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, isUnread: !em.isUnread } : e));
                toast.success(em.isUnread ? 'Marked as read' : 'Marked as unread');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update read state');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const toggleStar = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            const isStarred = !!(em.isStarred ?? (em.labelIds?.includes?.('STARRED')));
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.starGmailEmail(id, !isStarred);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, isStarred: !isStarred, labelIds: updateLabelIds(e.labelIds, 'STARRED', !isStarred) } : e));
                toast.success(!isStarred ? 'Starred' : 'Unstarred');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update star');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const toggleArchive = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            const inInbox = !!(em.labelIds?.includes?.('INBOX'));
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                // archive = true removes INBOX
                await apiClient.archiveGmailEmail(id, inInbox);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, labelIds: updateLabelIds(e.labelIds, 'INBOX', !inInbox) } : e));
                toast.success(inInbox ? 'Archived' : 'Moved to inbox');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update archive state');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const deleteEmail = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.deleteGmailEmail(id);
                setEmails((prev) => prev.filter((e) => (e.id || e.messageId) !== id));
                toast.success('Deleted');
            } catch (e) {
                console.error(e);
                toast.error('Failed to delete');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const openReply = (em: any) => {
            setReplyForId(em.id || em.messageId);
            setReplyBody("");
        };

        const sendReply = async () => {
            const id = replyForId;
            if (!id) return;
            const em = emails.find((e) => (e.id || e.messageId) === id);
            if (!em) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.replyGmail({ threadId: em.threadId, messageId: id, body: replyBody });
                toast.success('Reply sent');
                setReplyForId(null);
                setReplyBody("");
            } catch (e) {
                console.error(e);
                toast.error('Failed to send reply');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        // Detect a Gmail compose link in assistant content
        const rawContent: string = typeof message.content === 'string' ? message.content : '';
        const composeMatch = rawContent.match(/https:\/\/mail\.google\.com\/mail\/?[^\s)]+view=cm[^\s)]+/i);
        const composeUrl = composeMatch ? composeMatch[0] : null;

        return (
            <div className="mt-3 p-4 rounded-lg border border-border/40 bg-muted/10">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Mail className="h-4 w-4" />
                        <span>Gmail • {title} ({emails.length})</span>
                    </div>
                    {/* {composeUrl && (
                        <a
                            href={composeUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90"
                        >
                            Compose in Gmail
                        </a>
                    )} */}
                </div>

                <div className="space-y-3">
                    {emails.map((em, idx) => {
                        const dt = em.date ? new Date(em.date) : null;
                        const dateStr = dt ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}` : '';
                        const threadLink = em.threadId ? `https://mail.google.com/mail/u/0/#inbox/${em.threadId}` : em.link;
                        const preview = em.body?.trim()?.slice(0, 220) || em.snippet || '';
                        const id = em.id || em.messageId;
                        const busy = !!busyMap[id];
                        const isUnread = (typeof em.isUnread === 'boolean')
                            ? em.isUnread
                            : (Array.isArray(em.labelIds) ? em.labelIds.includes('UNREAD') : false);
                        const isStarred = (typeof em.isStarred === 'boolean') ? em.isStarred : (Array.isArray(em.labelIds) ? em.labelIds.includes('STARRED') : false);
                        const inInbox = Array.isArray(em.labelIds) ? em.labelIds.includes('INBOX') : true;
                        const senderInitial = (em.from || '?').trim().charAt(0).toUpperCase();
                        return (
                            <div key={`${id}-${idx}`} className="p-3 rounded-md border border-border/30 bg-background/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <Avatar className="h-6 w-6">
                                                <AvatarFallback className="text-[10px]">{senderInitial || 'S'}</AvatarFallback>
                                            </Avatar>
                                            <div className="font-semibold text-sm line-clamp-1">{em.subject || '(No subject)'}</div>
                                            {isUnread && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Unread</span>}
                                            {isStarred && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">Starred</span>}
                                        </div>
                                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{em.from || 'Unknown sender'} • {dateStr}</div>
                                        {preview && <div className="text-sm mt-1 text-foreground/80 line-clamp-2">{preview}</div>}
                                        <div className="mt-2 flex items-center gap-3 flex-wrap">
                                            {threadLink && (
                                                <a
                                                    className="text-xs underline text-primary hover:opacity-80"
                                                    href={threadLink}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                                                        if (isMobile) {
                                                            window.location.href = `mailto:?body=${encodeURIComponent(threadLink)}`;
                                                        } else {
                                                            window.open(threadLink, '_blank');
                                                        }
                                                    }}
                                                >
                                                    Open in Gmail
                                                </a>
                                            )}
                                            <button
                                                disabled={busy}
                                                onClick={() => toggleRead({ ...em, isUnread })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {isUnread ? 'Mark as read' : 'Mark as unread'}
                                            </button>
                                            {/* <button
                                                disabled={busy}
                                                onClick={() => toggleStar({ ...em, isStarred })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {isStarred ? 'Unstar' : 'Star'}
                                            </button>
                                            <button
                                                disabled={busy}
                                                onClick={() => toggleArchive({ ...em })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {inInbox ? 'Archive' : 'Move to inbox'}
                                            </button>
                                            <button
                                                disabled={busy}
                                                onClick={() => deleteEmail({ ...em })}
                                                className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                                            >
                                                Delete
                                            </button> */}
                                            {/* <button
                                                disabled={busy}
                                                onClick={() => openReply(em)}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                Reply
                                            </button> */}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <Dialog open={!!replyForId} onOpenChange={(isOpen) => { if (!isOpen) setReplyForId(null) }}>
                    <DialogContent className="max-w-lg">
                        <DialogHeader>
                            <DialogTitle>Reply to email</DialogTitle>
                        </DialogHeader>
                        <Textarea
                            value={replyBody}
                            onChange={(e) => setReplyBody(e.target.value)}
                            placeholder="Write your reply..."
                            className="min-h-[120px]"
                        />
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button variant="outline">Cancel</Button>
                            </DialogClose>
                            <Button onClick={sendReply} disabled={!replyBody.trim()}>Send reply</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }
    // File display logic - optimized for images
    const FileDisplay = () => {
        if (message.role === 'ASSISTANT' && message.content === '[GENERATING_IMAGE]') {
            return <ImageGenerationEffect />;
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_GMAIL]") {
            return <ProcessingGmailCard />;
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_CALENDAR_ACTION]") {
            return <ProcessingGoogleServicesCard action="calendar" />;
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_DRIVE_ACTION]") {
            return <ProcessingGoogleServicesCard action="drive" />;
        }


        return (
            <>
                {((Array.isArray(parsedFiles) && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image')) ||
                    (message.role === "ASSISTANT" && message.content.startsWith('http') &&
                        (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/')))) && (
                        <div className="space-y-2 mt-4">
                            {Array.isArray(parsedFiles) && parsedFiles.filter((f: any) => f.type === 'image').map((file: any, index: number) => (
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
                                            className="max-w-full h-auto rounded-lg max-h-[250px] sm:max-h-[400px] object-contain"
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
                {Array.isArray(parsedFiles) && parsedFiles.length > 0 && message.role === "USER" && (
                    <div className=" border-t border-border/20 flex flex-wrap gap-2">
                        {Array.isArray(parsedFiles) && parsedFiles.some((file: any) => file.type?.startsWith('image/') || file.mimeType?.startsWith('image/')) ? (
                            // Only images, aligned right
                            <div className="flex flex-wrap gap-1 ml-auto">
                                {parsedFiles
                                    .filter((file: any) => file.type?.startsWith("image/") || file.mimeType?.startsWith("image/"))
                                    .map((file: any, index: number) => {
                                        let imageUrl = file.url || file.base64;
                                        {
                                            console.log(!imageUrl && file.path);
                                        }


                                        if (!imageUrl && file.path) {
                                            console.log("file.path.", file.path);

                                            // Extract the part of the path after 'uploads/'
                                            const normalizedPath = file.path.replace(/\\/g, '/');
                                            console.log("normalizedPath:", normalizedPath);

                                            // Extract the part after 'uploads/'
                                            const relativePath = normalizedPath.split('uploads/')[1];
                                            console.log("relativePath:", relativePath);

                                            if (relativePath) {
                                                const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || 'http://localhost:5000';
                                                imageUrl = `${baseUrl}/uploads/${relativePath}`;
                                                console.log("imageUrl", imageUrl);

                                            }
                                        }

                                        if (imageUrl?.includes("localhost:3000") || imageUrl?.startsWith("/uploads")) {
                                            imageUrl = `${process.env.NEXT_PUBLIC_IMAGE_URL}${imageUrl.replace("http://localhost:5000", "")}`;

                                        }

                                        return (
                                            <img
                                                key={index}
                                                src={imageUrl}
                                                alt={file.name || file.originalName || "Image"}
                                                className="max-w-full h-auto rounded-lg max-h-[350px] object-cover"
                                            />
                                        );
                                    })}
                            </div>

                        ) : (
                            // Only non-image files, aligned left
                            <div className="flex flex-wrap gap-1">
                                {parsedFiles
                                    .filter((file: any) => !file.type?.startsWith('image/') && !file.mimeType?.startsWith('image/'))
                                    .map((file: any, index: number) => {
                                        const extension = file.originalName?.split('.').pop()?.toLowerCase() || file.name?.split('.').pop()?.toLowerCase();
                                        let icon;
                                        switch (extension) {
                                            case 'pdf':
                                                icon = <img src="/icons/pdf.png" alt="PDF" className="h-6 w-6" />;
                                                break;
                                            case 'doc':
                                            case 'docx':
                                                icon = <img src="/icons/Word.png" alt="Word" className="h-6 w-6" />;
                                                break;
                                            case 'xls':
                                            case 'xlsx':
                                            case 'csv':
                                                icon = <img src="/icons/Excel.png" alt="Excel" className="h-6 w-6" />;
                                                break;
                                            case 'ppt':
                                            case 'pptx':
                                                icon = <img src="/icons/Bigger P powerpoint.png" alt="PowerPoint" className="h-6 w-6" />;
                                                break;
                                            default:
                                                icon = <FileText className="h-4 w-4" />;
                                        }
                                        return (
                                            <button key={index} onClick={() => handleViewFile(file)} className="flex items-center gap-2 px-2 py-1 border rounded hover:bg-muted transition-colors">
                                                {icon}
                                                <span className="text-xs">{file.originalName || file.name || 'File'}</span>
                                            </button>
                                        );
                                    })}
                            </div>
                        )}
                    </div>
                )}

            </>
        )
    };


    return (
        <div className="flex gap-4 my-2">
            {/* {message.role === "ASSISTANT" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
            )} */}

            <div className={`flex flex-col w-full ${message.role === 'USER' ? 'items-end' : 'items-start'}`}>
                {message.role === 'USER' && (
                    <>
                        {hasFiles && (
                            <Card className="group relative p-3 w-auto max-w-[85%] md:max-w-2xl bg-[#F4F4F4] text-primary dark:bg-[#1E1E1E] dark:text-white ">
                                <FileDisplay />
                            </Card>
                        )}
                        {hasContent && (
                            <Card className={`group relative pt-3 pl-3 pr-3 w-auto max-w-[85%] md:max-w-2xl bg-[#F4F4F4] text-primary dark:bg-[#1E1E1E] dark:text-white ${hasFiles ? 'mt-1' : ''} `}>
                                {isEditing ? (
                                    <div className="space-y-2 w-full min-w-[300px] md:min-w-[500px]">
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
                                        <MessageContent content={message.content} />
                                    </>
                                )}
                            </Card>
                        )}
                    </>
                )}

                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[90%] md:max-w-3xl">
                        {message.error ? (
                            <ErrorMessage onRegenerate={onRegenerate} />
                        ) : isThinking ? (
                            <ShimmerContent />
                        ) : (
                            <>
                                {hasGmailEntry ? (
                                    <>
                                        <GmailSummary message={message} />
                                        <GmailEmailsDisplay />
                                    </>
                                ) : (
                                    <MessageContent content={displayedContent} />
                                )}
                                <PPTDisplay />
                                <VideoDisplay />
                                <FileDisplay />
                                <ChartDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} fullResponse={message.fullResponse} />
                                <GmailConnectionDisplay />
                                <GoogleServicesConnectionDisplay />
                                <SpotifyConnectionDisplay />
                                <SpotifyResultsDisplay />
                                {children}
                            </>
                        )}


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

            {/* {message.role === "USER" && !isImageOnlyMessage() && !isVideoMessage && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-muted text-muted-foreground text-xs">
                        {user?.name?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                </Avatar>
            )} */}

            <Dialog open={!!selectedFile} onOpenChange={(isOpen) => { if (!isOpen) setSelectedFile(null) }}>
                <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle>{selectedFile?.originalName || 'File Content'}</DialogTitle>
                    </DialogHeader>
                    <div className="flex-grow overflow-y-auto p-1">
                        {isContentLoading ? (
                            <div className="flex items-center justify-center h-full">
                                <Loader2 className="h-8 w-8 animate-spin" />
                            </div>
                        ) : (
                            <pre className="text-sm whitespace-pre-wrap bg-muted p-4 rounded-md"><code>{fileContent}</code></pre>
                        )}
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!selectedFile} onOpenChange={(isOpen) => { if (!isOpen) setSelectedFile(null) }}>
                <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle>{selectedFile?.originalName || 'File Content'}</DialogTitle>
                    </DialogHeader>
                    <div className="flex-grow overflow-y-auto p-1">
                        {isContentLoading ? (
                            <div className="flex items-center justify-center h-full">
                                <Loader2 className="h-8 w-8 animate-spin" />
                            </div>
                        ) : (
                            <pre className="text-sm whitespace-pre-wrap bg-muted p-4 rounded-md"><code>{fileContent}</code></pre>
                        )}
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {isTableExpanded && (
                <div className="fixed inset-0 bg-background z-50 p-4 flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-bold">{tableTitle || 'Expanded Table View'}</h2>
                        <Button variant="outline" onClick={() => setIsTableExpanded(false)}>Close</Button>
                    </div>
                    <div className="flex-grow overflow-auto border rounded-md">
                        <div className="overflow-x-auto overflow-y-auto h-full">
                            <table className="w-full border-collapse border border-muted" style={{ minWidth: 'max-content' }}>
                                <thead className="sticky top-0 bg-background">
                                    <tr>
                                        {tableHeaders.map((header, index) => (
                                            <th key={index} className="border border-muted px-4 py-3 bg-muted/50 text-left font-medium text-sm whitespace-nowrap min-w-[120px]">{header}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {tableData.map((row, rowIndex) => (
                                        <tr key={rowIndex} className="hover:bg-muted/20">
                                            {row.map((cell, cellIndex) => (
                                                <td key={cellIndex} className="border border-muted px-4 py-3 text-sm whitespace-nowrap min-w-[120px]">{cell}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
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
