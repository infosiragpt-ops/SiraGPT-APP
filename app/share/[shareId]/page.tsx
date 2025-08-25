// File: app/share/[shareId]/page.tsx

"use client";

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown'; // Markdown ke liye
import apiClient from '@/lib/api';
import { InlineMath, BlockMath } from 'react-katex';
import 'katex/dist/katex.min.css'; // KaTeX styles


// --- 👇 STEP 1: Types define karna ---
// Message ke liye type
interface SharedMessage {
    role: 'USER' | 'ASSISTANT';
    content: string;
}

// Poore Chat object ke liye type
interface SharedChat {
    title: string;
    messages: SharedMessage[];
}


// Utility to render LaTeX and Markdown content
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

// SimpleMessage component for rendering individual messages
const SimpleMessage = ({ role, content }: SharedMessage) => {
    const isUser = role === 'USER';
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
            <div
                className={`p-3 rounded-lg max-w-2xl prose dark:prose-invert ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            >
                {renderMathContent(content)}
            </div>
        </div>
    );
};

// --- 👇 STEP 2: Component ke props mein types add karna ---
// Ab 'role' aur 'content' 'any' type ke nahi hain
// const SimpleMessage = ({ role, content }: SharedMessage) => {
//     const isUser = role === 'USER';
//     return (
//         <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
//             <div className={`p-3 rounded-lg max-w-2xl prose dark:prose-invert ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
//                 <ReactMarkdown>{content}</ReactMarkdown>
//             </div>
//         </div>
//     );
// };

export default function SharedChatPage() {
    const params = useParams();
    const shareId = params?.shareId;

    // --- 👇 STEP 3: useState mein type define karna ---
    // Ab 'chat' 'never' type ka nahi, balke 'SharedChat' ya 'null' type ka hai
    const [chat, setChat] = useState<SharedChat | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (shareId) {
            // Humari public API ko call karein
            apiClient.shareChatIdLink(shareId as String)

                .then(data => {
                    // Yahan data.chat aayega jo 'SharedChat' type ka hoga
                    setChat(data.chat);
                })
                .catch(err => {
                    setError(err.message);
                })
                .finally(() => {
                    setLoading(false);
                });
        }
    }, [shareId]);

    if (loading) return (
        <div className="flex items-center justify-center min-h-screen">
            <p>Loading shared chat...</p>
        </div>
    );

    if (error) return (
        <div className="flex items-center justify-center min-h-screen">
            <p className="text-red-500">Error: {error}</p>
        </div>
    );

    if (!chat) return null; // Ab chat 'never' type ka nahi hai, isliye error nahi aayega

    return (
        <div className="max-w-4xl mx-auto p-4 md:p-8">
            <div className="border-b pb-4 mb-6">
                <h1 className="text-3xl font-bold">{chat.title}</h1>
                <p className="text-muted-foreground">This is a shared conversation.</p>
            </div>
            <div className="space-y-6">
                {/* --- 👇 STEP 4: map ke andar type define karna --- */}
                {/* Ab 'message' 'any' type ka nahi hai */}
                {chat.messages.map((message: SharedMessage, index: number) => (
                    <SimpleMessage key={index} role={message.role} content={message.content} />
                ))}
            </div>
        </div>
    );
}
// "use client";

// import { useEffect, useState } from 'react';
// import { useParams } from 'next/navigation';
// import { InlineMath, BlockMath } from 'react-katex';
// import 'katex/dist/katex.min.css'; // KaTeX styles
// import ReactMarkdown from 'react-markdown';
// import apiClient from '@/lib/api';

// // Define types for messages and chat
// interface SharedMessage {
//     role: 'USER' | 'ASSISTANT';
//     content: string;
// }

// interface SharedChat {
//     title: string;
//     messages: SharedMessage[];
// }

// // Utility to render LaTeX and Markdown content
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
//             return <ReactMarkdown key={index}>{part}</ReactMarkdown>;
//         }
//     });
// };

// // SimpleMessage component for rendering individual messages
// const SimpleMessage = ({ role, content }: SharedMessage) => {
//     const isUser = role === 'USER';
//     return (
//         <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
//             <div
//                 className={`p-4 rounded-xl max-w-2xl prose dark:prose-invert shadow-sm ${isUser
//                     ? 'bg-blue-600 text-white'
//                     : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
//                     }`}
//             >
//                 {renderMathContent(content)}
//             </div>
//         </div>
//     );
// };

// // Main SharedChatPage component
// export default function SharedChatPage() {
//     const params = useParams();
//     const shareId = params?.shareId;

//     const [chat, setChat] = useState<SharedChat | null>(null);
//     const [loading, setLoading] = useState(true);
//     const [error, setError] = useState<string | null>(null);

//     useEffect(() => {
//         if (shareId) {
//             apiClient
//                 .shareChatIdLink(shareId as string)
//                 .then((data) => {
//                     setChat(data.chat);
//                 })
//                 .catch((err) => {
//                     setError(err.message);
//                 })
//                 .finally(() => {
//                     setLoading(false);
//                 });
//         }
//     }, [shareId]);

//     if (loading) {
//         return (
//             <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
//                 <div className="flex items-center space-x-2">
//                     <svg
//                         className="animate-spin h-5 w-5 text-blue-600"
//                         xmlns="http://www.w3.org/2000/svg"
//                         fill="none"
//                         viewBox="0 0 24 24"
//                     >
//                         <circle
//                             className="opacity-25"
//                             cx="12"
//                             cy="12"
//                             r="10"
//                             stroke="currentColor"
//                             strokeWidth="4"
//                         />
//                         <path
//                             className="opacity-75"
//                             fill="currentColor"
//                             d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
//                         />
//                     </svg>
//                     <p className="text-gray-700 dark:text-gray-300">Loading shared chat...</p>
//                 </div>
//             </div>
//         );
//     }

//     if (error) {
//         return (
//             <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
//                 <div className="bg-red-100 text-red-700 p-4 rounded-lg shadow-sm">
//                     <p>Error: {error}</p>
//                 </div>
//             </div>
//         );
//     }

//     if (!chat) return null;

//     return (
//         <div className="max-w-3xl mx-auto p-4 md:p-8 bg-gray-100 dark:bg-gray-900 min-h-screen font-sans">
//             <div className="border-b pb-4 mb-6">
//                 <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
//                     {chat.title}
//                 </h1>
//                 <p className="text-gray-500 dark:text-gray-400">
//                     This is a shared conversation.
//                 </p>
//             </div>
//             <div className="space-y-6">
//                 {chat.messages.map((message: SharedMessage, index: number) => (
//                     <SimpleMessage key={index} role={message.role} content={message.content} />
//                 ))}
//             </div>
//         </div>
//     );
// }