// "use client"

// // Zaroori cheezein import karein
// import React, { useState } from 'react';
// import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'; // Ya koi aur theme chunein
// import ReactMarkdown from 'react-markdown';
// import remarkGfm from 'remark-gfm';
// import {
//     FileText,
//     ImageIcon,
//     Eye,
//     Download,
//     Clipboard,
//     Check
// } from "lucide-react";
// import { Button } from "@/components/ui/button";
// import { Card } from "@/components/ui/card";
// import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
// import { Badge } from "@/components/ui/badge";

// // Enhanced Message Component (Naya aur behtar version)
// const MessageComponent = ({ message, user }: { message: any; user: any }) => {
//     const [isCopied, setIsCopied] = useState(false);

//     // Poora message copy karne ke liye function
//     const handleGlobalCopy = () => {
//         navigator.clipboard.writeText(message.content).then(() => {
//             setIsCopied(true);
//             setTimeout(() => setIsCopied(false), 2000); // 2 second baad icon wapas change ho jayega
//         });
//     };

//     // Files parse karne ka logic (aapke original code se)
//     let parsedFiles = [];
//     if (message.files) {
//         try {
//             parsedFiles = typeof message.files === 'string' ? JSON.parse(message.files) : message.files;
//         } catch (e) {
//             parsedFiles = [];
//         }
//     }

//     // Markdown ke andar code blocks ko render karne ke liye custom component
//     const CodeBlock = ({ node, inline, className, children, ...props }: any) => {
//         const [isCodeCopied, setIsCodeCopied] = useState(false);
//         const match = /language-(\w+)/.exec(className || '');
//         const language = match ? match[1] : 'text';

//         const handleCodeCopy = () => {
//             const codeString = String(children).replace(/\n$/, '');
//             navigator.clipboard.writeText(codeString).then(() => {
//                 setIsCodeCopied(true);
//                 setTimeout(() => setIsCodeCopied(false), 2000);
//             });
//         };

//         return !inline && match ? (
//             <div className="my-4 rounded-md bg-gray-900/80 border border-gray-700 relative">
//                 <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 rounded-t-md border-b border-gray-700">
//                     <span className="text-xs font-sans text-gray-400">{language}</span>
//                     <button onClick={handleCodeCopy} className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1">
//                         {isCodeCopied ? <Check size={14} /> : <Clipboard size={14} />}
//                         {isCodeCopied ? 'Copied!' : 'Copy code'}
//                     </button>
//                 </div>
//                 <SyntaxHighlighter
//                     style={oneDark}
//                     language={language}
//                     PreTag="div"
//                     {...props}
//                     // Custom style to remove default padding/margin from highlighter
//                     customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
//                 >
//                     {String(children).replace(/\n$/, '')}
//                 </SyntaxHighlighter>
//             </div>
//         ) : (
//             <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props}>
//                 {children}
//             </code>
//         );
//     };

//     return (
//         <div className={`group flex gap-3 ${message.role === "USER" ? "justify-end" : "justify-start"}`}>
//             {message.role === "ASSISTANT" && (
//                 <Avatar className="h-8 w-8 flex-shrink-0">
//                     <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
//                 </Avatar>
//             )}

//             <div className="relative w-full max-w-[85%]">
//                 <Card className={`p-4 ${message.role === "USER" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"}`}>
//                     {/* Markdown Renderer */}
//                     <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
//                         <ReactMarkdown
//                             remarkPlugins={[remarkGfm]}
//                             components={{ code: CodeBlock }}
//                         >
//                             {message.content}
//                         </ReactMarkdown>
//                     </div>

//                     {/* Baaki file display ka logic... */}
//                     {((parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image')) ||
//                         (message.role === "ASSISTANT" && message.content.startsWith('http') && (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle')))) && (
//                             <div className="space-y-2">
//                                 {parsedFiles && parsedFiles.filter((f: any) => f.type === 'image').map((file: any, index: number) => (
//                                     <div key={index} className="relative">
//                                         <img
//                                             src={file.url}
//                                             alt="Generated image"
//                                             className="max-w-full h-auto rounded-lg"
//                                         />

//                                     </div>
//                                 ))}

//                                 {message.role === "ASSISTANT" && message.content.startsWith('http') &&
//                                     (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle')) && (
//                                         <div className="relative">
//                                             <img
//                                                 src={message.content}
//                                                 alt="Generated image"
//                                                 className="max-w-full h-auto rounded-lg"
//                                             />
//                                         </div>
//                                     )}
//                             </div>
//                         )}
//                     {parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type !== 'image') && (
//                         <div className="mt-2 pt-2 border-t border-border/20">
//                             <div className="flex flex-wrap gap-1">
//                                 {parsedFiles
//                                     .filter((f: any) => f.type !== 'image')
//                                     .map((file: any, index: number) => (
//                                         <div key={index} className="flex items-center gap-1">
//                                             <FileText className="h-4 w-4" />
//                                             <Badge className="text-xs">
//                                                 {file.name || 'File'}
//                                             </Badge>
//                                         </div>
//                                     ))}
//                             </div>
//                         </div>
//                     )}

//                     <p className="mt-3 text-xs opacity-70">
//                         {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
//                     </p>
//                 </Card>

//                 {/* Global Copy Button - Sirf AI messages ke liye */}
//                 {message.role === 'ASSISTANT' && (
//                     <div className="absolute -bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
//                         <Button
//                             variant="secondary"
//                             size="sm"
//                             className="h-7 w-7 p-1"
//                             onClick={handleGlobalCopy}
//                             title="Copy response"
//                         >
//                             {isCopied ? <Check size={16} /> : <Clipboard size={16} />}
//                         </Button>
//                     </div>
//                 )}
//             </div>

//             {message.role === "USER" && (
//                 <Avatar className="h-8 w-8 flex-shrink-0">
//                     <AvatarImage src={user?.avatar || "/placeholder.svg"} />
//                     <AvatarFallback className="text-xs">U</AvatarFallback>
//                 </Avatar>
//             )}
//         </div>
//     );
// };

// export default MessageComponent; // Ensure the component is exported if it's in its own file


"use client"

// Zaroori cheezein import karein
import React, { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    FileText,
    Clipboard,
    Check,
    Volume2,
    Square
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

// Enhanced Message Component (Naya aur behtar version)
const MessageComponent = ({ message, user }: { message: any; user: any }) => {
    const [isCopied, setIsCopied] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);

    // Poora message copy karne ke liye function
    const handleGlobalCopy = () => {
        navigator.clipboard.writeText(message.content).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000); // 2 second baad icon wapas change ho jayega
        });
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
                remarkPlugins={[remarkGfm]}
                components={{ code: CodeBlock }}
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
                {message.role === 'USER' && (
                    <Card className="p-3 w-auto max-w-[85%] bg-[#F4F4F4] text-primary ">
                        <MessageContent />
                        <FileDisplay />
                        {/* <p className="mt-3 text-xs opacity-70 text-right">
                            {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </p> */}
                    </Card>
                )}

                {/* ASSISTANT Message (clean text) */}
                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[85%]">
                        <MessageContent />
                        <FileDisplay />
                        {/* Global Copy Button - Sirf AI messages ke liye */}
                        <div className="mt-3">
                            <Button
                                variant="ghost" // 'ghost' ya 'secondary' try kar sakte hain
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