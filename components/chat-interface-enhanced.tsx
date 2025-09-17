"use client"

import * as React from "react"
import {
  Send,
  Paperclip,
  Mic,
  Square,
  Loader2,
  FileText,
  ImageIcon,
  Video,
  Wand2,
  Globe,
  Sparkles,
  Bot,
  ChevronDown,
  X,
  Upload,
  Settings,
  Eye,
  Download,
  Palette,
  Camera,
  Plus,
  MessageSquare,
  Check,
  Music,
  Film,
  Bolt
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card } from "@/components/ui/card"
import { useChat } from "@/lib/chat-context-integrated"
import { useAuth } from "@/lib/auth-context-integrated"
import { Dialog, DialogContent, DialogTrigger, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiClient } from "@/lib/api"
import { aiService } from "@/lib/ai-service"
import { toast } from "sonner"
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import MessageComponent from "./message-component"
import VoiceControls from "./voice-controls"
import { Message } from "react-hook-form"
import ElevenLabsInterface from "./elevenlabs-interface"
import SpeechToTextComponent from "./speech-to-text-component"
import TextToSpeechComponent from "./text-to-speech-component"
import MusicGenerationComponent from "./MusicGenerationComponent"
import { webSearchService } from "@/lib/web-search-service"
import VideoGenerationComponent from "./VideoGenerationComponent"
import UpgradeModal from "./UpgradeModal"
import { IconProvider } from "./icon-provider"


// Enhanced Model Selector
const NavbarModelSelector = ({ selectedModel, setSelectedModel, availableModels, setSelectedProvider, chatTypes, }: any) => {
  const selectedModelData = availableModels.find((m: any) => m.name === selectedModel);
  if (chatTypes === "video") {
    // 👇 Just return static model name without dropdown
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
        <Bot className="h-4 w-4" />
        <span className="text-sm font-medium">Google Veo 3</span>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-green-500 rounded-full" title="API Key configured" />
        </div>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
        {/* <Bot className="h-4 w-4" /> */}
        {selectedModelData && <IconProvider name={selectedModelData.icon} className="h-4 w-4" />}
        <span className="text-sm font-medium">{selectedModelData?.displayName || selectedModel}</span>
        <div className="flex items-center gap-1">
          {aiService.hasApiKey(selectedModel) ? (
            <div className="w-2 h-2 bg-green-500 rounded-full" title="API Key configured" />
          ) : (
            <div className="w-2 h-2 bg-red-500 rounded-full" title="API Key required" />
          )}
          <ChevronDown className="h-4 w-4 opacity-70" />
        </div>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end"
        className="w-56" >
        <ScrollArea
          style={{ height: '300px' }}
        >
          {availableModels.map((model: any) => (
            <DropdownMenuItem
              key={model.name}
              onSelect={() => {
                setSelectedModel(model.name);
                console.log("model", model);


                setSelectedProvider(model.provider)

              }}
              className="flex items-center gap-2 py-2"
            >
              {/* <Bot className="h-4 w-4 flex-shrink-0" /> */}
              <IconProvider name={model.icon} className="h-5 w-5 flex-shrink-0" />
              <div className="flex flex-col flex-1">
                <span className="text-sm">{model.displayName}</span>
                <span className="text-xs text-muted-foreground">{model.name}</span>
              </div>
              {aiService.hasApiKey(model.name) ? (
                <div className="w-2 h-2 bg-green-500 rounded-full" />
              ) : (
                <div className="w-2 h-2 bg-red-500 rounded-full" />
              )}
            </DropdownMenuItem>
          ))}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};


// MODIFICATION: FileUploadDialog ko saral banaya gaya hai. Ab yeh logic parent se leta hai.
const FileUploadDialog = ({ onFileUpload, isUploading }: { onFileUpload: (files: FileList) => void; isUploading: boolean }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList) => {
    if (files.length === 0) return;
    onFileUpload(files);
    setIsOpen(false);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFiles(e.dataTransfer.files);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="flex items-center gap-2">
          <Paperclip className="h-4 w-4" />
          Upload Files
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
              }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <Upload className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-sm text-muted-foreground mb-2">
              Drag and drop files here, or click to select
            </p>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                'Select Files'
              )}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Supported: Images, PDF, Word, Excel, PowerPoint, Text files (Max 10MB each)
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Enhanced File Display Component
const FileDisplay = ({ files, onRemove }: { files: any[]; onRemove: (index: number) => void }) => {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {files.map((file, index) => (
        <div key={index} className="flex items-center gap-2 bg-muted rounded-md px-3 py-2 text-sm">
          {file.type?.startsWith('image/') ? (
            <div className="flex items-center gap-2">
              <img src={"http://localhost:5000" + file.url} alt={file.name} className="w-10 h-10 object-cover rounded" />
              {/* <ImageIcon className="h-4 w-4" /> */}
            </div>
          ) : (
            <FileText className="h-4 w-4" />
          )}
          <span className="truncate max-w-[150px]">{file.name}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0"
            onClick={() => onRemove(index)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}


export default function ChatInterface() {
  const { user } = useAuth()
  const {
    currentChat,
    setCurrentChat,
    addMessage,
    addVideoMessage,
    clearCurrentChat,
    selectedModel,
    createNewChat,
    isLoading,
    setSelectedModel,
    setSelectedProivder,
    selectProvider,
    uploadedFiles,
    selectChat,
    setUploadedFiles,
    chatType, setChatType,
    availableModels, regenerateLastMessage,
    editAndRegenerate,
    updateMessageInChat

  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = React.useState(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);

  // MODIFICATION: State ko parent component (ChatInterface) mein move kiya gaya hai
  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);

  // Voice Studio panel state
  const [showAudioPanel, setShowAudioPanel] = React.useState(false);
  const [audioTab, setAudioTab] = React.useState<'tts' | 'stt' | 'music' | 'video'>("tts");


  // Speech-to-Text ke liye naye states 
  const [isSpeechSupported, setIsSpeechSupported] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);


  // In the ChatInterface component, add this state variable with other states:
  const [isWebSearching, setIsWebSearching] = React.useState(false)
  const [isWebSearchActive, setIsWebSearchActive] = React.useState(false);
  const [subscribeOpen, setSubscribeOpen] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);
  const [currentUserInfo, setCurrentUserInfo] = React.useState<any>(null);


  // Instant (demo) upgrade call
  const instantUpgrade = async (plan: 'BASIC' | 'STANDARD' | 'ENTERPRISE') => {
    try {
      setIsSubscribing(true);

      // plan -> monthlyLimit mapping
      const planMap: Record<string, { monthlyLimit: number; price?: number }> = {
        BASIC: { monthlyLimit: 10000, price: 5 },
        STANDARD: { monthlyLimit: 30000, price: 15 },
        ENTERPRISE: { monthlyLimit: 0, price: 99 }, // 0 => treated as "unlimited" on server
      };

      const payload = {
        plan,
        monthlyLimit: planMap[plan].monthlyLimit,
        price: planMap[plan].price ?? 0,
      };

      // Try to call backend instant endpoint (recommended)
      const res = await fetch('/api/payments/instant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // backend not available or returned error -> fallback to client-only update
        const body = await res.json().catch(() => ({}));
        console.warn('instantUpgrade backend failed:', body);
        // FALLBACK: simulate success only in UI (DB not updated)
        const simulatedUser = {
          ...(currentUserInfo || user || {}),
          plan,
          monthlyLimit: payload.monthlyLimit,
        };
        setCurrentUserInfo(simulatedUser);
        toast.success('Subscribed (UI only). Backend update not available — implement /api/payments/instant to persist.');
        setSubscribeOpen(false);
        return;
      }

      // Success: refresh user info from server
      toast.success('Subscription applied — plan updated');
      setSubscribeOpen(false);
    } catch (err: any) {
      console.error('instantUpgrade error', err);
      // Network or unexpected error -> fallback to UI-only simulation
      const planMap: Record<string, { monthlyLimit: number }> = {
        BASIC: { monthlyLimit: 10000 },
        STANDARD: { monthlyLimit: 30000 },
        ENTERPRISE: { monthlyLimit: 0 },
      };
      const simulatedUser = {
        ...(currentUserInfo || user || {}),
        plan,
        monthlyLimit: planMap[plan].monthlyLimit,
      };
      setCurrentUserInfo(simulatedUser);
      toast.success('Subscribed (UI only). Backend update not available.');
    } finally {
      setIsSubscribing(false);
    }
  };
  // ...inside ChatInterface component, after you declare subscribeOpen and setSubscribeOpen...

  React.useEffect(() => {
    function handleOpenUpgrade(e: any) {
      // Optionally inspect e.detail.message if you want to customize UX
      setSubscribeOpen(true);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('open-upgrade-modal', handleOpenUpgrade);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('open-upgrade-modal', handleOpenUpgrade);
      }
    };
  }, [setSubscribeOpen]);
  React.useEffect(() => {
    // Check if the browser supports Speech Recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setIsSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      // Ab yeh event type aaram se resolve ho jayega
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          setInput(prevInput => prevInput.trim() + (prevInput ? ' ' : '') + finalTranscript);
        }
      };

      // Error event bhi resolve ho jayega
      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error:", event.error);
        if (isRecording) {
          setIsRecording(false);
        }
      };

      recognition.onend = () => {
        // Jab recording ruk jaye (chahe manually ya automatically), state ko false kar dein
        setIsRecording(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []); // Empty dependency array means this runs only once on mount

  const handleMicClick = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (isRecording) {
      recognition.stop();
      // onend event state ko handle kar lega
    } else {
      recognition.start();
      setIsRecording(true); // Recording shuru hote hi state ko true karein
    }
  };


  React.useEffect(() => {
    console.log(currentChat);

    if (currentChat && currentChat.messages.length > 0) {
      if (currentChat.messages[0].content !== "Hello! I'm gpt. How can I help you today?") {
        const hasImageMessages = currentChat.messages.some(msg =>
          msg.role === "ASSISTANT" && (
            (msg.content.startsWith('http') && (msg.content.includes('oaidalleapiprodscus') || msg.content.includes('dalle'))) ||
            (msg.files && JSON.parse(msg.files.toString() || '[]').some((f: any) => f.type === 'image'))
          )
        );
        console.log(hasImageMessages);

        const hasVideoMessages = currentChat.messages.some(msg =>
          msg.videoData && (msg.videoData.status === 'completed' || msg.videoData.status === 'processing' || msg.videoData.status === 'failed')
        );

        if (chatType === "video") {
          setChatType('video');
        } else if (hasImageMessages) {
          setChatType('image');
        } else {
          setChatType('text');
        }
      }

    }
  }, [currentChat]);

  // Hide audio panel when chat changes or a new chat is created/selected
  React.useEffect(() => {
    setShowAudioPanel(false);
  }, [currentChat?.id]);

  React.useEffect(() => {
    if (currentChat || chatCreationInitiated.current) {
      return;
    }

    const savedChatId = localStorage.getItem('currentChatId');
    if (savedChatId) {
      selectChat(savedChatId)
      return;
    }

  }, [currentChat, createNewChat, availableModels, selectedModel, selectChat]);

  // MODIFICATION: File upload logic ab ChatInterface mein hai
  const handleAndUploadFiles = async (files: FileList) => {
    if (files.length === 0) return;
    if (chatType === 'image' || chatType === 'video') {
      toast.error("You cannot upload files in image/video generation mode.");
      return;
    }

    setIsUploading(true);
    try {
      const response = await apiClient.uploadFiles(files);
      if (response.files) {
        setUploadedFiles([...uploadedFiles, ...response.files]);
        toast.success(`${response.files.length} file(s) uploaded successfully`);
        console.log("response ", response);

      } else {
        toast.error('File upload failed');
      }
    } catch (error) {
      console.error('File upload failed:', error);
      toast.error('File upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  // MODIFICATION: Drag and Drop event handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragging(true);
    } else if (e.type === "dragleave") {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleAndUploadFiles(e.dataTransfer.files);
    }
  };


  const handleSend = async () => {
    if (!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo) return

    const msg = input.trim()
    setInput("")
    try {
      if (isWebSearchActive) {
        handleWebSearch();
      } else {
        if (!currentChat) {
          await createNewChat(chatType, msg)
        } else if (chatType === 'image') {
          await handleImageGeneration(msg)
        } else if (chatType === 'video') {
          await handleVideoGeneration(msg)
        } else {
          await addMessage(msg, uploadedFiles.map(f => f.id))
        }
      }
    } catch (err: any) {
      console.error('Send error', err);
      // If backend returned a quota error (429) open subscribe modal
      const message = (err && (err.message || '')) as string;
      const status = err?.status || err?.statusCode || (err?.response && err.response.status);
      if (status === 429 || message.toLowerCase().includes('monthly') || message.toLowerCase().includes('limit')) {
        setSubscribeOpen(true);
        toast.error('You reached your free quota — subscribe to continue.');
        return;
      }
      toast.error(err?.message || 'Send failed');
    }
  }


  const handleImageGeneration = async (prompt: string) => {
    setIsGeneratingImage(true)
    try {
      const response = await apiClient.generateImage({
        prompt,
        chatId: currentChat?.id,
        provider: selectProvider,
        model: selectedModel
      })
      await selectChat(currentChat?.id ?? "")
      toast.success('Image generated successfully!')
    } catch (error) {
      console.error('Image generation failed:', error)
      toast.error('Image generation failed. Please try again.')
    } finally {
      setIsGeneratingImage(false)
    }
  }

  // Update the handleVideoGeneration function:

  const handleVideoGeneration = async (prompt: string) => {
    setIsGeneratingVideo(true)
    try {
      if (!currentChat) {
        await createNewChat('video', prompt)
      } else {
        await addVideoMessage(prompt)
      }
      // Only show success toast if no error occurred
      toast.success('Video generation started! This may take 2-5 minutes.')
    } catch (error: any) {
      console.error('Video generation failed:', error)
      // Show specific error message
      const errorMessage = error.message || 'Video generation failed. Please try again.';
      toast.error(errorMessage)
    } finally {
      setIsGeneratingVideo(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const startNewImageChat = () => {
    setChatType('image')
    createNewChat('image')
  }

  const startNewVideoChat = () => {
    setChatType('video')
    createNewChat('video')
  }

  const removeFile = (index: number) => {
    setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
  }

  // React.useEffect(() => {
  //   scrollAreaRef.current?.scrollTo({
  //     top: scrollAreaRef.current.scrollHeight,
  //   })
  // }, [currentChat?.messages, isLoading])

  const isInitial = !currentChat && !showAudioPanel

  // Replace the existing handleWebSearch function with this corrected version:

  // const handleWebSearch = async () => {
  //   if (!input.trim()) {
  //     toast.error('Please enter a search query');
  //     return;
  //   }

  //   // Create new chat if none exists
  //   if (!currentChat?.id) {
  //     try {
  //       await createNewChat();
  //       // Wait a bit for the chat to be created
  //       await new Promise(resolve => setTimeout(resolve, 500));
  //     } catch (error) {
  //       toast.error('Failed to create chat');
  //       return;
  //     }
  //   }

  //   setIsWebSearching(true);

  //   try {
  //     const searchQuery = input.trim();

  //     // Perform web search (this will also save messages to backend)
  //     const response = await webSearchService.search(searchQuery, currentChat?.id);

  //     // Reload the current chat to get the updated messages from backend
  //     if (currentChat?.id) {
  //       await selectChat(currentChat.id);
  //     }

  //     // Clear input
  //     setInput('');

  //     // Scroll to bottom
  //     setTimeout(() => {
  //       if (scrollAreaRef.current) {
  //         const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
  //         if (scrollContainer) {
  //           scrollContainer.scrollTop = scrollContainer.scrollHeight;
  //         }
  //       }
  //     }, 100);

  //     toast.success(`Found ${response.results.length} search results`);
  //   } catch (error: any) {
  //     console.error('Web search failed:', error);
  //     toast.error(error.message || 'Web search failed');
  //   } finally {
  //     setIsWebSearching(false);
  //   }
  // };
  // Replace the handleWebSearch function:

  const handleWebSearch = async () => {
    if (!input.trim()) {
      toast.error('Please enter a search query');
      return;
    }

    if (!currentChat?.id) {
      try {
        createNewChat();
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        toast.error('Failed to create chat');
        return;
      }
    }

    setIsWebSearching(true);

    try {
      const searchQuery = input.trim();

      // Add user message immediately
      const userMessage = {
        id: `msg-user-${Date.now()}`,
        chatId: currentChat?.id,
        role: 'USER',
        content: `🔍 Web Search: ${searchQuery}`,
        timestamp: new Date().toISOString(),
      };

      // Add AI placeholder for streaming
      const aiMessage = {
        id: `msg-ai-${Date.now()}`,
        chatId: currentChat?.id,
        role: 'ASSISTANT',
        content: '',
        timestamp: new Date().toISOString(),
      };

      // Update UI immediately
      const updatedMessages = [...(currentChat?.messages || []), userMessage, aiMessage];
      const updatedChat = { ...currentChat, messages: updatedMessages };
      setCurrentChat(updatedChat);

      let accumulatedContent = '';

      // Start streaming search
      await webSearchService.searchStream(
        searchQuery,
        currentChat?.id,
        (content: string) => {
          // Accumulate content for streaming effect
          accumulatedContent += content;

          // Update the AI message with accumulated content
          const newMessages = updatedMessages.map(msg =>
            msg.id === aiMessage.id
              ? { ...msg, content: accumulatedContent }
              : msg
          );

          setCurrentChat(prev => prev ? { ...prev, messages: newMessages } : prev);
        },
        () => {
          // On complete, reload chat to get saved version
          selectChat(currentChat?.id || '');
          setIsWebSearching(false);
          toast.success('Web search completed');
        },
        (error: Error) => {
          console.error('Web search failed:', error);
          toast.error(error.message || 'Web search failed');
          setIsWebSearching(false);
        }
      );

      // Clear input
      setInput('');

    } catch (error: any) {
      console.error('Web search failed:', error);
      toast.error(error.message || 'Web search failed');
      setIsWebSearching(false);
    }
  };
  // Minimal FeatureRow component — paste near top of file once
  function FeatureRow({ icon, title, desc, included = true }: { icon: React.ReactNode; title: string; desc: string; included?: boolean }) {
    return (
      <div className={`flex items-start gap-3 ${included ? '' : 'opacity-60'}`}>
        <div className="w-8 h-8 rounded-md bg-muted/20 flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
        <div>
          <div className="font-medium text-sm">{title}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
    );
  }
  const currentPlan = user?.plan || user?.plan || 'FREE';

  return (
    // MODIFICATION: Event handlers ko main div mein lagaya gaya hai
    <div
      className="flex h-full flex-col relative" // 'relative' class zaroori hai overlay ke liye
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
    >
      {/* MODIFICATION: Yeh overlay tab dikhega jab file drag ho rahi ho */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-lg border-2 border-dashed border-primary p-12">
            <Upload className="h-12 w-12 text-primary" />
            <p className="text-lg font-medium">Drop files to upload</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-border/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            {!showAudioPanel ? (
              <>
                <NavbarModelSelector
                  selectedModel={selectedModel}
                  setSelectedModel={setSelectedModel}
                  availableModels={availableModels}
                  setSelectedProvider={setSelectedProivder}
                  chatTypes={chatType}
                />
                <div className="flex items-center gap-2 mt-2">
                  {/* <Badge variant={chatType === 'text' ? 'default' : 'outline'}>
                    <MessageSquare className="h-3 w-3 mr-1" />
                    {chatType === 'text' && 'Text Chat'}
                    {chatType === 'image' && 'Image Generation'}
                    {chatType === 'video' && 'Video Generation'}
                  </Badge>
                  {chatType === 'image' && (
                    <Badge variant="secondary" className="text-xs">
                      <Palette className="h-3 w-3 mr-1" />
                      DALL-E 3
                    </Badge>
                  )}
                  {chatType === 'video' && (
                    <Badge variant="secondary" className="text-xs">
                      <Film className="h-3 w-3 mr-1" />
                      Veo-3
                    </Badge>
                  )} */}
                </div>
              </>
            ) : (
              <div className="flex flex-col">
                <div className="text-lg font-semibold">Voice Studio</div>
                <div className="text-xs text-muted-foreground">Text-to-Speech, Speech-to-Text, Music & Video</div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">

            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={() => setSubscribeOpen(true)}>
              {currentPlan === 'FREE' ? 'Upgrade' : 'Manage'} Plan
            </Button>
            <UpgradeModal
              open={subscribeOpen}
              onOpenChange={setSubscribeOpen}
              user={currentUserInfo || user}
            />


            {/* {!showAudioPanel && (
              <Button variant="outline" size="sm" onClick={clearCurrentChat}>
                Clear Chat
              </Button>
            )} */}
          </div>
        </div>
      </div>

      {isInitial ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-4xl space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold">Welcome to AI Chat</h1>
              <p className="text-muted-foreground">Ask anything, generate images, or create videos with AI.</p>
            </div>

            {/* Example prompts */}
            {chatType === 'text' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-w-5xl mx-auto">
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("Create a table of the top 10 countries by population with their capitals, population, and GDP")}
                >
                  <div>
                    <div className="font-medium">Population Data</div>
                    <div className="text-xs text-muted-foreground">Get downloadable country statistics</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("List the Fortune 500 top 20 companies with their revenue, employees, and industry")}
                >
                  <div>
                    <div className="font-medium">Company Rankings</div>
                    <div className="text-xs text-muted-foreground">Generate business data tables</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("Create a comparison table of programming languages with their features, performance, and use cases")}
                >
                  <div>
                    <div className="font-medium">Tech Comparison</div>
                    <div className="text-xs text-muted-foreground">Compare technologies in table format</div>
                  </div>
                </Button>
              </div>
            )}

            {/* Video generation prompts */}
            {chatType === 'video' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-w-5xl mx-auto">
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("A majestic eagle soaring through mountain peaks at sunset")}
                >
                  <div>
                    <div className="font-medium">Nature Scene</div>
                    <div className="text-xs text-muted-foreground">Beautiful wildlife and landscapes</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("A futuristic cityscape with flying cars and neon lights")}
                >
                  <div>
                    <div className="font-medium">Sci-Fi Scene</div>
                    <div className="text-xs text-muted-foreground">Futuristic and technology themes</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="p-4 h-auto text-left justify-start"
                  onClick={() => setInput("A peaceful beach with gentle waves and palm trees swaying")}
                >
                  <div>
                    <div className="font-medium">Relaxing Scene</div>
                    <div className="text-xs text-muted-foreground">Calm and peaceful environments</div>
                  </div>
                </Button>
              </div>
            )}

            <div className="space-y-3">
              {chatType === 'text' && (
                <FileDisplay files={uploadedFiles} onRemove={removeFile} />
              )}
              <div className="bg-background">
                <div className="flex-1 relative">

                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={
                      chatType === 'image'
                        ? "Describe the image you want to generate..."
                        : chatType === 'video'
                          ? "Describe the video you want to create..."
                          : "Type your message here..."
                    }
                    className="min-h-[60px] max-h-[350px] resize-none pr-20 py-4 transition-all duration-200"
                    style={{
                      overflowY: input.split('\n').length > 2 ? 'auto' : 'hidden',
                      minHeight: '60px',
                      maxHeight: '350px',
                      height: 'auto',
                      padding: '1rem',
                    }}
                    rows={Math.min(Math.max(input.split('\n').length, 2), 12)}
                    disabled={isLoading || isGeneratingImage || isGeneratingVideo}
                  />

                  <div className="absolute bottom-3 right-3 flex items-center gap-2">

                    <Button
                      onClick={handleSend}
                      disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo}
                      size="sm"
                      className="h-8 w-8 p-0"
                    >
                      {isGeneratingImage || isGeneratingVideo || isUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {chatType === 'text' && (
                  <FileUploadDialog onFileUpload={handleAndUploadFiles} isUploading={isUploading} />
                )}
                {chatType === 'text' && (
                  <Button
                    variant={isWebSearchActive ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setIsWebSearchActive(!isWebSearchActive)}
                    className="flex items-center gap-2"
                  >
                    <Globe className="h-4 w-4" />
                    {isWebSearching ? 'Searching...' : 'Web Search'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPlan === "FREE"}

                  onClick={() => { setShowAudioPanel(true); setAudioTab('tts'); }}
                  className="flex items-center gap-2"
                >
                  <Mic className="h-4 w-4" />
                  Voice Studio
                </Button>
                <Button
                  disabled={currentPlan === "FREE"}
                  variant="outline"
                  size="sm"
                  onClick={startNewImageChat}
                  className="flex items-center gap-2"
                >
                  <Palette className="h-4 w-4" />
                  {chatType === 'image' ? 'Image Generation' : 'New Image Chat'}
                </Button>
                <Button
                  variant="outline"
                  disabled={currentPlan === "FREE"}
                  size="sm"
                  onClick={startNewVideoChat}
                  className="flex items-center gap-2"
                >
                  <Video className="h-4 w-4" />
                  {chatType === 'video' ? 'Video Generation' : 'New Video Chat'}
                </Button>
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {chatType === 'image'
                  ? 'Press Enter to generate image, Shift+Enter for new line'
                  : chatType === 'video'
                    ? 'Press Enter to generate video, Shift+Enter for new line'
                    : 'Press Enter to send, Shift+Enter for new line'
                }
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {showAudioPanel ? (
            // Voice Studio inline view
            <div className="flex flex-1">
              {/* Inline sidebar */}
              <div className="w-56 border-r border-border/40 p-4 space-y-4">
                <div>
                  <div className="text-sm font-medium mb-2">Voice Studio</div>
                  <div className="space-y-2">
                    <Button
                      variant={audioTab === 'tts' ? 'default' : 'outline'}
                      className="w-full justify-start"
                      onClick={() => setAudioTab('tts')}
                    >
                      <Square className="h-4 w-4 mr-2" />
                      Text-to-Speech
                    </Button>
                    <Button
                      variant={audioTab === 'stt' ? 'default' : 'outline'}
                      className="w-full justify-start"
                      onClick={() => setAudioTab('stt')}
                    >
                      <Mic className="h-4 w-4 mr-2" />
                      Speech-to-Text
                    </Button>
                    <Button
                      variant={audioTab === 'music' ? 'default' : 'outline'}
                      className="w-full justify-start"
                      onClick={() => setAudioTab('music')}
                    >
                      <Music className="h-4 w-4 mr-2" />
                      Music
                    </Button>
                    {/* <Button
                      variant={audioTab === 'video' ? 'default' : 'outline'}
                      className="w-full justify-start"
                      onClick={() => setAudioTab('video')}
                    >
                      <Video className="h-4 w-4 mr-2" />
                      Video
                    </Button> */}
                  </div>
                </div>
              </div>
              {/* Content area */}
              <div className="flex-1 p-4">
                {audioTab === 'tts' && (
                  <TextToSpeechComponent />
                )}
                {audioTab === 'stt' && (
                  <SpeechToTextComponent />
                )}
                {audioTab === 'music' && (
                  <MusicGenerationComponent />
                )}
                {audioTab === 'video' && (
                  <VideoGenerationComponent />
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Messages */}
              <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
                <div className="space-y-4 max-w-4xl mx-auto">
                  {currentChat?.messages.map((message) => (
                    <MessageComponent
                      key={message.id}
                      message={message}
                      user={user}
                      onRegenerate={regenerateLastMessage}
                      updateMessageInChat={updateMessageInChat}
                    />
                  ))}
                </div>
              </ScrollArea>

              {/* Input & Actions */}
              <div className="border-t border-border/40 p-4">
                <div className="max-w-4xl mx-auto space-y-3">
                  {/* File Display */}
                  {chatType === 'text' && (
                    <FileDisplay files={uploadedFiles} onRemove={removeFile} />
                  )}

                  {/* Input Area */}
                  <div className="bg-background">
                    <div className="flex-1 relative">
                      <Textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder={
                          chatType === 'image'
                            ? "Describe the image you want to generate..."
                            : chatType === 'video'
                              ? "Describe the video you want to create..."
                              : "Type your message here..."
                        }
                        className="min-h-[60px] max-h-[350px] resize-none pr-20 py-4 transition-all duration-200"
                        style={{
                          overflowY: input.split('\n').length > 2 ? 'auto' : 'hidden',
                          minHeight: '60px',
                          maxHeight: '350px',
                          height: 'auto',
                          padding: '1rem',
                        }}
                        rows={Math.min(Math.max(input.split('\n').length, 2), 12)}
                        disabled={isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching}
                      />


                      <div className="absolute bottom-3 right-3 flex items-center gap-2">
                        <VoiceControls
                          onTranscription={(text) => setInput(prev => prev + (prev ? ' ' : '') + text)}
                          className="flex items-center gap-1"
                        />
                        <Button
                          onClick={handleSend}
                          disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching}
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          {isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Function buttons row */}

                  <div className="flex flex-wrap items-center justify-start gap-2">
                    {chatType === 'text' && (
                      <FileUploadDialog onFileUpload={handleAndUploadFiles} isUploading={isUploading} />
                    )}
                    {chatType === 'text' && (
                      <Button
                        variant={isWebSearchActive ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setIsWebSearchActive(!isWebSearchActive)}
                        className="flex items-center gap-2"
                      >
                        <Globe className="h-4 w-4" />
                        {isWebSearching ? 'Searching...' : 'Web Search'}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPlan === "FREE"}
                      onClick={() => { setShowAudioPanel(true); setAudioTab('tts'); }}
                      className="flex items-center gap-2"
                    >
                      <Mic className="h-4 w-4" />
                      Voice Studio
                    </Button>

                    <Button
                      variant="outline"
                      disabled={currentPlan === "FREE"}

                      size="sm"
                      onClick={startNewImageChat}
                      className="flex items-center gap-2"
                    >
                      <Palette className="h-4 w-4" />
                      {chatType === 'image' ? 'Image Generation' : 'New Image Chat'}
                    </Button>

                    <Button
                      disabled={currentPlan === "FREE"}

                      variant="outline"
                      size="sm"
                      onClick={startNewVideoChat}
                      className="flex items-center gap-2"
                    >
                      <Video className="h-4 w-4" />
                      {chatType === 'video' ? 'Video Generation' : 'New Video Chat'}
                    </Button>
                  </div>

                  <p className="text-center text-xs text-muted-foreground">
                    {chatType === 'image'
                      ? 'Press Enter to generate image, Shift+Enter for new line'
                      : chatType === 'video'
                        ? 'Press Enter to generate video, Shift+Enter for new line'
                        : 'Press Enter to send, Shift+Enter for new line'
                    }
                  </p>

                  {/* {isAnon && anonBlocked && (
  <div className="absolute inset-0 z-50 backdrop-blur-sm bg-background/80 flex flex-col items-center justify-center gap-6 p-6">
    <div className="max-w-sm text-center space-y-3">
      <h3 className="text-xl font-semibold">Free trial limit reached</h3>
      <p className="text-sm text-muted-foreground">
        You used all {anonLimit} free messages. Create an account to unlock unlimited chats, history, file attachments and more.
      </p>
      <div className="flex gap-3 justify-center">
        <Button onClick={() => router.push('/auth/register')}>Create Account</Button>
        <Button variant="outline" onClick={() => router.push('/auth/login')}>Login</Button>
      </div>
    </div>
  </div>
)} */}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}