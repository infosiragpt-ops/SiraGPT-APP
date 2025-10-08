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
  Bolt,
  FileSpreadsheet,
  File,
  ArrowUp
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
  DropdownMenuSeparator,
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
import SearchSourceSelector, { SearchSources } from "./SearchSourceSelector"

// Enhanced Actions Dropdown Component
const ActionsDropdown = ({
  chatType,
  setChatType,
  currentPlan,
  isWebSearchActive,
  setIsWebSearchActive,
  isImageGenerationActive,
  setIsImageGenerationActive,
  isVideoGenerationActive,
  setIsVideoGenerationActive,
  setShowAudioPanel,
  setAudioTab,
  handleAndUploadFiles,
  isUploading,
  isWebSearching,
  isLoading,
  isGeneratingImage,
  isGeneratingVideo
}: any) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = React.useState(false);

  const handleFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleAndUploadFiles(e.target.files);
      // Clear the input to allow re-uploading the same file
      e.target.value = '';
      setIsOpen(false);
    }
  };

  // Function to handle single selection - deactivate others when one is selected
  const handleWebSearchToggle = () => {
    setChatType('text');
    if (!isWebSearchActive) {
      // Deactivate other options
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
    }
    setIsWebSearchActive(!isWebSearchActive);
  };

  const handleImageGenerationToggle = () => {
    const newState = !isImageGenerationActive;

    if (newState) {
      setIsWebSearchActive(false);
      setIsVideoGenerationActive(false);
      setChatType('image');
    } else {
      setChatType('text');
    }

    setIsImageGenerationActive(newState);
  };

  const handleVideoGenerationToggle = () => {
    const newState = !isVideoGenerationActive;

    if (newState) {
      setIsWebSearchActive(false);
      setIsImageGenerationActive(false);
      setChatType('video');
    } else {
      setChatType('text');
    }

    setIsVideoGenerationActive(newState);
  };

  const isDisabled = isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-muted/50 rounded-full flex items-center justify-center"
          disabled={isDisabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {/* File Upload - Only for text chats */}

        <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={handleFileUpload} disabled={isUploading}>
          <div className="flex items-center gap-3 w-full">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
              <Paperclip className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">Upload Files</div>
              <div className="text-xs text-muted-foreground">
                {isUploading ? 'Uploading...' : 'Images, PDFs, Documents'}
              </div>
            </div>
          </div>
        </DropdownMenuItem>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
          onChange={handleFilesSelected}
        />

        {/* Web Search */}
        <DropdownMenuItem
          onClick={handleWebSearchToggle}
          disabled={isWebSearching}
        >
          <div className="flex items-center gap-3 w-full">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isWebSearchActive
              ? 'bg-green-100 dark:bg-green-900/20'
              : 'bg-emerald-100 dark:bg-emerald-900/20'
              }`}>
              <Globe className={`h-4 w-4 ${isWebSearchActive
                ? 'text-green-600 dark:text-green-400'
                : 'text-emerald-600 dark:text-emerald-400'
                }`} />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">
                {isWebSearchActive ? 'Web Search Active' : 'Web Search'}
              </div>
              <div className="text-xs text-muted-foreground">
                {isWebSearching ? 'Searching...' : 'Search the internet for answers'}
              </div>
            </div>
            {isWebSearchActive && (
              <div className="w-2 h-2 bg-green-500 rounded-full" />
            )}
          </div>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Voice Studio - Opens panel directly */}
        <DropdownMenuItem
          onClick={() => { setShowAudioPanel(true); setAudioTab('tts'); }}
          disabled={currentPlan === "FREE" || isDisabled}
        >
          <div className="flex items-center gap-3 w-full">
            <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/20 flex items-center justify-center">
              <Mic className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">Voice Studio</div>
              <div className="text-xs text-muted-foreground">
                Text-to-Speech, Speech-to-Text, Music
              </div>
            </div>
            {currentPlan === "FREE" && (
              <Badge variant="secondary" className="text-xs">Pro</Badge>
            )}
          </div>
        </DropdownMenuItem>

        {/* Image Generation */}
        <DropdownMenuItem
          onClick={handleImageGenerationToggle}
          disabled={currentPlan === "FREE" || isDisabled}
        >
          <div className="flex items-center gap-3 w-full">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isImageGenerationActive
              ? 'bg-pink-100 dark:bg-pink-900/20'
              : 'bg-pink-100 dark:bg-pink-900/20'
              }`}>
              <Palette className={`h-4 w-4 ${isImageGenerationActive
                ? 'text-pink-600 dark:text-pink-400'
                : 'text-pink-600 dark:text-pink-400'
                }`} />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">
                {isImageGenerationActive ? 'Image Generation Active' : 'Image Generation'}
              </div>
              <div className="text-xs text-muted-foreground">
                Generate images with DALL-E 3
              </div>
            </div>
            {isImageGenerationActive && (
              <div className="w-2 h-2 bg-pink-500 rounded-full" />
            )}
            {currentPlan === "FREE" && (
              <Badge variant="secondary" className="text-xs">Pro</Badge>
            )}
          </div>
        </DropdownMenuItem>

        {/* Video Generation */}
        <DropdownMenuItem
          onClick={handleVideoGenerationToggle}
          disabled={currentPlan === "FREE" || isDisabled}
        >
          <div className="flex items-center gap-3 w-full">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isVideoGenerationActive
              ? 'bg-orange-100 dark:bg-orange-900/20'
              : 'bg-orange-100 dark:bg-orange-900/20'
              }`}>
              <Video className={`h-4 w-4 ${isVideoGenerationActive
                ? 'text-orange-600 dark:text-orange-400'
                : 'text-orange-600 dark:text-orange-400'
                }`} />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">
                {isVideoGenerationActive ? 'Video Generation Active' : 'Video Generation'}
              </div>
              <div className="text-xs text-muted-foreground">
                Create videos with Google Veo 3
              </div>
            </div>
            {isVideoGenerationActive && (
              <div className="w-2 h-2 bg-orange-500 rounded-full" />
            )}
            {currentPlan === "FREE" && (
              <Badge variant="secondary" className="text-xs">Pro</Badge>
            )}
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
const wrapIconInSmallSquare = (icon: JSX.Element, color: string) => (
  <div className={`h-8 w-8 flex items-center justify-center rounded-md overflow-hidden`} style={{ backgroundColor: color }}>
    {icon}
  </div>
);

const getFileIcon = (file: any) => {
  const isImage = file.type?.startsWith('image/');

  if (isImage && file.url) {
    const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || "";
    const imageUrl = baseUrl + file.url;

    return (
      <img
        src={imageUrl}
        alt={file.name}
        className="h-full w-full object-cover" // Yeh classes <img> ko apne parent container mein fit karengi
      />
    );
  }

  // Non-image files ke liye, purana logic use karein (wrapped icon)
  const extension = file.name?.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'pdf':
      return wrapIconInSmallSquare(<FileText className="h-5 w-5 text-white" />, "#ef4444"); // red
    case 'doc':
    case 'docx':
      return wrapIconInSmallSquare(<FileText className="h-5 w-5 text-white" />, "#2563eb"); // blue
    case 'xls':
    case 'xlsx':
    case 'csv':
      return wrapIconInSmallSquare(<FileSpreadsheet className="h-5 w-5 text-white" />, "#16a34a"); // green
    case 'ppt':
    case 'pptx':
      return wrapIconInSmallSquare(<File className="h-5 w-5 text-white" />, "#f97316"); // orange
    case 'txt':
      return wrapIconInSmallSquare(<FileText className="h-5 w-5 text-white" />, "#6b7280"); // grey
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'wmv':
      return wrapIconInSmallSquare(<Video className="h-5 w-5 text-white" />, "#9333ea"); // purple
    case 'mp3':
    case 'wav':
      return wrapIconInSmallSquare(<Music className="h-5 w-5 text-white" />, "#db2777"); // pink
    case 'zip':
    case 'rar':
    case '7z':
      return wrapIconInSmallSquare(<File className="h-5 w-5 text-white" />, "#eab308"); // yellow
    default:
      return wrapIconInSmallSquare(<File className="h-5 w-5 text-white" />, "#9ca3af"); // gray
  }
};
// Active Options Display Component - Renders above the textarea
const ActiveOptionsDisplay = ({
  uploadedFiles,
  removeFile
}: {
  uploadedFiles: any[];
  removeFile: (index: number) => void;
}) => {
  if (uploadedFiles.length === 0) return null;

  return (
    <div className="p-3  bg-background">
      <div className="flex flex-wrap items-center gap-2 max-h-40 overflow-y-auto">
        {/* Uploaded Files iterate karein */}
        {uploadedFiles.map((file, index) => {
          const isImage = file.type?.startsWith('image/');

          return (
            <div
              key={index}
              className={`
                relative // 'X' button ki absolute positioning ke liye
                border border-gray-200
                rounded-xl
                text-sm
                ${isImage ? 'h-32 w-32 p-0' : 'flex items-center gap-2 px-2 py-1'} // Conditional sizing aur padding
              `}
            >
              {isImage ? (
                <>
                  {/* Image files ke liye: badi image aur uske upar 'X' button */}
                  <div className="h-full w-full rounded-md overflow-hidden bg-gray-100 flex items-center justify-center">
                    {getFileIcon(file)} {/* Ab sirf <img> tag return ho raha hai */}
                  </div>


                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-1  right-1 h-6 w-6 p-0 bg-white rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                    onClick={() => removeFile(index)}
                  >
                    <X className="h-4 w-4 text-gray-600" />
                  </Button>
                </>
              ) : (
                <>
                  {/* Non-image files ke liye: purana structure (icon, naam, aur 'X' button side mein) */}
                  {getFileIcon(file)}
                  <span className="max-w-50 truncate font-medium text-[13px]">
                    {file.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 hover:bg-gray-200 rounded-full ml-1"
                    onClick={() => removeFile(index)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
// Active Tools Display Component - Shows INSIDE the textarea at the bottom
const ActiveToolsDisplay = ({
  isWebSearchActive,
  setIsWebSearchActive,
  isImageGenerationActive,
  setIsImageGenerationActive,
  isVideoGenerationActive,
  setIsVideoGenerationActive,
  setChatType,
}: {
  isWebSearchActive: boolean;
  setIsWebSearchActive: (value: boolean) => void;
  isImageGenerationActive: boolean;
  setIsImageGenerationActive: (value: boolean) => void;
  isVideoGenerationActive: boolean;
  setIsVideoGenerationActive: (value: boolean) => void;
  setChatType: (type: any) => void;
}) => {
  const hasActiveTools = isWebSearchActive || isImageGenerationActive || isVideoGenerationActive;

  if (!hasActiveTools) return null;

  const handleWebSearchClose = () => {
    setIsWebSearchActive(false);
    setChatType('text');
  };

  const handleImageGenerationClose = () => {
    setIsImageGenerationActive(false);
    setChatType('text');
  };

  const handleVideoGenerationClose = () => {
    setIsVideoGenerationActive(false);
    setChatType('text');
  };

  return (
    <div className="flex items-center gap-2">
      {isWebSearchActive && (
        <>
          <div className="flex items-center gap-1.5 bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-300 px-2 py-1 rounded-full text-xs border border-green-200 dark:border-green-800">
            <Globe className="h-3 w-3" />
            <span className="font-medium">Web Search</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-green-200 dark:hover:bg-green-800/30 rounded-full ml-1"
              onClick={handleWebSearchClose}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>

        </>
      )}
      {isImageGenerationActive && (
        <div className="flex items-center gap-1.5 bg-pink-100 dark:bg-pink-900/20 text-pink-700 dark:text-pink-300 px-2 py-1 rounded-full text-xs border border-pink-200 dark:border-pink-800">
          <Palette className="h-3 w-3" />
          <span className="font-medium">Image Generation</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-pink-200 dark:hover:bg-pink-800/30 rounded-full ml-1"
            onClick={handleImageGenerationClose}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {isVideoGenerationActive && (
        <div className="flex items-center gap-1.5 bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 px-2 py-1 rounded-full text-xs border border-orange-200 dark:border-orange-800">
          <Video className="h-3 w-3" />
          <span className="font-medium">Video Generation</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-orange-200 dark:hover:bg-orange-800/30 rounded-full ml-1"
            onClick={handleVideoGenerationClose}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
};

// Enhanced Model Selector
let selectedVideoModelData;
const NavbarModelSelector = ({
  selectedModel,
  setSelectedModel,
  availableModels,
  setSelectedProvider,
  chatTypes,
  currentChat
}: any) => {
  const selectedModelData = availableModels.find((m: any) => m.name === selectedModel);


  // If this is a video chat type, show video model
  if (chatTypes === "video") {
    const videoModels = [
      { name: 'veo-fast', displayName: 'Veo Fast (8s)' },
      { name: 'kling-1.6-pro', displayName: 'Kling 1.6 Pro (10s)' },
      { name: 'kling-2-master', displayName: 'Kling 2 Master (10s)' }
    ];
    selectedVideoModelData = videoModels.find(m => m.name === selectedModel);
    // setSelectedModel('veo-fast');
    return (
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
          <Video className="h-4 w-4" />
          <span className="text-sm font-medium">{selectedVideoModelData?.displayName || 'Select Video Model'}</span>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-500 rounded-full" title="API Key configured" />
            <ChevronDown className="h-4 w-4 opacity-70" />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {videoModels.map((model) => (
            <DropdownMenuItem
              key={model.name}
              onSelect={() => {
                setSelectedModel(model.name);
              }}
              className="flex items-center gap-2 py-2"
            >
              <Video className="h-5 w-5 flex-shrink-0" />
              <div className="flex flex-col flex-1">
                <span className="text-sm">{model.displayName}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }



  // If this chat is associated with a custom GPT, show GPT info instead of model selector
  if (currentChat?.customGptId || currentChat?.customGpt) {
    const customGptName = currentChat?.customGpt?.name || currentChat?.title || "Custom GPT";
    const customGptIcon = currentChat?.customGpt?.iconUrl;

    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background">
        {customGptIcon ? (
          customGptIcon.startsWith('http') || customGptIcon.startsWith('https') || customGptIcon.startsWith('data:') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={customGptIcon}
              alt="GPT icon"
              className="w-4 h-4 rounded-full object-cover"
            />
          ) : (
            <div className="w-4 h-4 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-xs">
              {customGptIcon}
            </div>
          )
        ) : (
          <Bot className="h-4 w-4 text-purple-600" />
        )}
        <span className="text-sm font-medium">{customGptName}</span>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-purple-500 rounded-full" title="Custom GPT" />
        </div>
      </div>
    );
  }

  // Default model selector for regular chats
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
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

      <DropdownMenuContent align="end" className="w-56">
        <ScrollArea style={{ height: '300px' }}>
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
    updateMessageInChat,
    isStreaming, // ✅ isStreaming ko yahan se fetch karein
    stopStreaming,

  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = React.useState(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);

  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);

  // Voice Studio panel state
  const [showAudioPanel, setShowAudioPanel] = React.useState(false);
  const [audioTab, setAudioTab] = React.useState<'tts' | 'stt' | 'music' | 'video'>("tts");

  // Speech-to-Text states 
  const [isSpeechSupported, setIsSpeechSupported] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);

  const [isWebSearching, setIsWebSearching] = React.useState(false)
  const [isWebSearchActive, setIsWebSearchActive] = React.useState(false);
  const [isImageGenerationActive, setIsImageGenerationActive] = React.useState(false);
  const [isVideoGenerationActive, setIsVideoGenerationActive] = React.useState(false);
  const [subscribeOpen, setSubscribeOpen] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);
  const [currentUserInfo, setCurrentUserInfo] = React.useState<any>(null);

  // Search sources state - all enabled by default

  // No longer need dynamic padding, handled by layout
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.style.height = 'auto'; // Reset height to recalculate
      const scrollHeight = textarea.scrollHeight;
      const maxHeight = 350; // As defined in style

      if (scrollHeight > maxHeight) {
        textarea.style.height = `${maxHeight}px`;
        textarea.style.overflowY = 'auto';
      } else {
        textarea.style.height = `${scrollHeight}px`;
        textarea.style.overflowY = 'hidden';
      }
    }
  }, [input]);



  // Instant upgrade function
  const instantUpgrade = async (plan: 'BASIC' | 'STANDARD' | 'ENTERPRISE') => {
    try {
      setIsSubscribing(true);
      const planMap: Record<string, { monthlyLimit: number; price?: number }> = {
        BASIC: { monthlyLimit: 10000, price: 5 },
        STANDARD: { monthlyLimit: 30000, price: 15 },
        ENTERPRISE: { monthlyLimit: 0, price: 99 },
      };

      const payload = {
        plan,
        monthlyLimit: planMap[plan].monthlyLimit,
        price: planMap[plan].price ?? 0,
      };

      const res = await fetch('/api/payments/instant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.warn('instantUpgrade backend failed:', body);
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

      toast.success('Subscription applied — plan updated');
      setSubscribeOpen(false);
    } catch (err: any) {
      console.error('instantUpgrade error', err);
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

  React.useEffect(() => {
    function handleOpenUpgrade(e: any) {
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
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setIsSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          setInput((prevInput: any) => prevInput.trim() + (prevInput ? ' ' : '') + finalTranscript);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error:", event.error);
        if (isRecording) {
          setIsRecording(false);
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  const handleMicClick = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (isRecording) {
      recognition.stop();
    } else {
      recognition.start();
      setIsRecording(true);
    }
  };

  // React.useEffect(() => {
  //   console.log(currentChat);

  //   if (currentChat && currentChat.messages.length > 0) {
  //     if (currentChat.messages[0].content !== "Hello! I'm gpt. How can I help you today?") {
  //       const hasImageMessages = currentChat.messages.some(msg =>
  //         msg.role === "ASSISTANT" && (
  //           (msg.content.startsWith('http') && (msg.content.includes('oaidalleapiprodscus') || msg.content.includes('dalle'))) ||
  //           (msg.files && JSON.parse(msg.files.toString() || '[]').some((f: any) => f.type === 'image'))
  //         )
  //       );

  //       const hasVideoMessages = currentChat.messages.some(msg =>
  //         msg.videoData && (msg.videoData.status === 'completed' || msg.videoData.status === 'processing' || msg.videoData.status === 'failed')
  //       );

  //       if (chatType === "video") {
  //         setChatType('video');
  //       } else if (hasImageMessages) {
  //         setChatType('image');
  //       } else {
  //         setChatType('text');
  //       }
  //     }
  //   }
  // }, [currentChat]);
  // Replace the commented useEffect and add a new one for chat switching
  React.useEffect(() => {
    // Reset generation modes when switching chats
    setIsWebSearchActive(false);
    setIsImageGenerationActive(false);
    setIsVideoGenerationActive(false);
    setChatType('text'); // Always default to text when switching chats
  }, []); // Only trigger when chat ID changes

  React.useEffect(() => {
    setShowAudioPanel(false);
  }, [currentChat?.id]);
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

  // File upload logic
  const handleAndUploadFiles = async (files: FileList) => {
    if (files.length === 0) return;
    if (chatType === 'video' || chatType === 'image') {
      const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));

      if (imageFiles.length === 0) {
        toast.error("Only image files are allowed in image/video mode.");
        return;
      }

      files = imageFiles as unknown as FileList;
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

  // Drag and Drop event handlers
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
    if (!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isStreaming) return

    const msg = input.trim()
    setInput("")

    try {
      if (chatType === 'image' || chatType === 'video') {
        const hasNonImageFiles = uploadedFiles.some(
          (file) => !file.type?.startsWith('image/')
        );

        if (hasNonImageFiles) {
          toast.error("Only image files are allowed in image/video mode.");
          return;
        }
      }
      if (isWebSearchActive) {
        await handleWebSearch(); // Changed to await
      } else if (isImageGenerationActive) {
        await handleImageGeneration(msg, uploadedFiles.map(f => f.id))



      } else if (isVideoGenerationActive) {
        await handleVideoGeneration(msg);
      } else {
        const filesToSend = [...uploadedFiles];
        setUploadedFiles([]); // Clear UI immediately

        if (!currentChat) {
          console.log("1s1");
          await createNewChat(chatType, msg, filesToSend);
        } else if (chatType === 'image') {
          await handleImageGeneration(msg, filesToSend.map(f => f.id));
        } else if (chatType === 'video') {
          await handleVideoGeneration(msg);
        } else {
          await addMessage(msg, filesToSend);
        }
      }
    } catch (err: any) {
      console.error('Send error', err);
      const message = (err && (err.message || '')) as string;
      const status = err?.status || err?.statusCode || (err?.response && err.response.status);
      if (status === 429 || message.toLowerCase().includes('monthly') || message.toLowerCase().includes('limit')) {
        setSubscribeOpen(true);
        toast.error('You reached your free quota — subscribe to continue.');
        return;
      }
      toast.error(err?.message || 'Send failed');

      // Add a message with an error state to the chat
      const errorMessage = {
        id: `msg-error-${Date.now()}`,
        chatId: currentChat?.id || 'unknown',
        role: 'ASSISTANT' as const,
        content: '', // No content, just the error
        timestamp: new Date().toISOString(),
        error: err.message || 'An unknown error occurred',
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), errorMessage];
        return { ...prevChat, messages: updatedMessages };
      });
    }
  }

  const handleImageGeneration = async (prompt: string, files?: string[]) => {
    setIsGeneratingImage(true)
    try {
      if (!currentChat) {
        // If no chat is active, create a new one with type 'image'
        const newChat = await createNewChat('image', prompt, files);

      } else {
        // If a chat is active, add the user's message optimistically
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: currentChat.id,
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: uploadedFiles,
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });

        // Then, generate the image
        const payload = {
          prompt,
          chatId: currentChat?.id,
          provider: selectProvider,
          model: selectedModel,
        };

        if (files && files[0]) {
          (payload as any).fileId = files[0];
        }
        setUploadedFiles([]);
        const response = await apiClient.generateImage(payload)
        await selectChat(currentChat?.id ?? "") // Re-select the chat to update messages
        toast.success('Image generated successfully!')
      }
    } catch (error) {
      console.error('Image generation failed:', error)
      toast.error('Image generation failed. Please try again.')
    } finally {
      setIsGeneratingImage(false)
    }
  }

  const handleVideoGeneration = async (prompt: string) => {
    setIsGeneratingVideo(true)
    try {
      if (!currentChat) {
        await createNewChat('video', prompt)
      } else {
        await addVideoMessage(prompt)
      }
      toast.success('Video generation started! This may take 2-5 minutes.')
    } catch (error: any) {
      console.error('Video generation failed:', error)
      const errorMessage = error.message || 'Video generation failed. Please try again.';
      toast.error(errorMessage)
    } finally {
      setIsGeneratingVideo(false)
      // Don't auto-reset - user must manually remove
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const removeFile = (index: number) => {
    setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
  }

  const isInitial = !currentChat && !showAudioPanel

  const handleWebSearch = async () => {
    if (!input.trim()) {
      toast.error('Please enter a search query');
      return;
    }

    let activeChatId = currentChat?.id;

    if (!activeChatId) {
      try {
        const newChat = createNewChat('text', `🔍 Web Search: ${input.trim()}`) as any;
        activeChatId = newChat?.id;
        if (!activeChatId) {
          toast.error('Failed to create chat for web search');
          return;
        }
        // Delay to ensure chat is fully initialized and selected
        await new Promise(resolve => setTimeout(resolve, 500));
        selectChat(activeChatId); // Ensure the newly created chat is selected
      } catch (error) {
        toast.error('Failed to create chat for web search');
        console.error("Error creating chat for web search:", error);
        return;
      }
    }

    setIsWebSearching(true);
    const searchQuery = input.trim();
    setInput(''); // Clear input immediately after starting search

    try {
      // Add a placeholder user message for the web search
      const userMessage = {
        id: `msg-user-${Date.now()}`,
        chatId: activeChatId,
        role: 'USER' as const,
        content: `🔍 Web Search: ${searchQuery}`,
        timestamp: new Date().toISOString(),
      };

      // Add a placeholder AI message for the search results
      const aiMessage = {
        id: `msg-ai-${Date.now() + 1}`, // Ensure unique ID
        chatId: activeChatId,
        role: 'ASSISTANT' as const,
        content: 'Searching the web...', // Initial loading state
        timestamp: new Date().toISOString(),
      };

      // Update the chat with the new messages
      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat; // Should not happen if activeChatId is set
        const updatedMessages = [...(prevChat.messages || []), userMessage, aiMessage];
        return { ...prevChat, messages: updatedMessages };
      });

      let accumulatedContent = '';

      await webSearchService.searchStream(
        searchQuery,
        activeChatId,
        selectedModel,
        selectProvider,
        (content: string) => {
          accumulatedContent += content;
          setCurrentChat(prev => {
            if (!prev) return prev;
            const newMessages = prev.messages.map(msg =>
              msg.id === aiMessage.id
                ? { ...msg, content: accumulatedContent }
                : msg
            );
            return { ...prev, messages: newMessages };
          });
        },
        () => {
          // Final update to ensure UI reflects completion
          selectChat(activeChatId || ''); // Re-fetch to ensure all state is consistent
          setIsWebSearching(false);
          toast.success('Web search completed');
        },
        (error: Error) => {
          console.error('Web search failed:', error);
          toast.error(error.message || 'Web search failed');
          setIsWebSearching(false);
          // If search fails, update the AI message to reflect the error
          setCurrentChat(prev => {
            if (!prev) return prev;
            const newMessages = prev.messages.map(msg =>
              msg.id === aiMessage.id
                ? { ...msg, content: `Web search failed: ${error.message}` }
                : msg
            );
            return { ...prev, messages: newMessages };
          });
        },

      );

    } catch (error: any) {
      console.error('Web search failed:', error);
      toast.error(error.message || 'Web search failed');
      setIsWebSearching(false);
    }
  };

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
    <div
      className="flex h-full flex-col relative"
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-lg border-2 border-dashed border-primary p-12">
            <Upload className="h-12 w-12 text-primary" />
            <p className="text-lg font-medium">Drop files to upload</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className=" border-border/40 p-4">
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
                  currentChat={currentChat}
                />
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
          </div>
        </div>
      </div>

      {isInitial ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-4xl space-y-6">
            {/* <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold">Welcome to Sira GPT</h1>
              <p className="text-muted-foreground">Ask anything, generate images, or create videos with AI.</p>
            </div> */}

            {/* Example prompts */}
            {/* {chatType === 'text' && (
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
            )} */}

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
              <div className="border-wrapper">
                <div className="relative rounded-3xl   focus-within:ring-1 focus-within:ring-ring overflow-hidden  ">
                  <ActiveOptionsDisplay
                    uploadedFiles={uploadedFiles}
                    removeFile={removeFile}
                  />
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                    }}
                    onKeyPress={handleKeyPress}
                    placeholder={
                      isImageGenerationActive
                        ? "Describe the image you want to generate..."
                        : isVideoGenerationActive
                          ? "Describe the video you want to create..."
                          : isWebSearchActive
                            ? "Enter your search query..."
                            : "Type your message here..."
                    }
                    className={`resize-none w-full border-none outline-none ring-0 focus:outline-none focus:ring-0  py-4 pb-14 transition-all duration-200 rounded-none`}
                    style={{
                      minHeight: "60px",
                      maxHeight: "350px",
                      overflowY: "auto",
                      border: "none",           // Inline style border remove
                      outline: "none",          // Inline style outline remove
                      boxShadow: "none",        // Remove focus shadow if any
                    }}
                    rows={1}
                    disabled={
                      isLoading ||
                      isGeneratingImage ||
                      isGeneratingVideo ||
                      isUploading ||
                      isWebSearching
                    }
                  />
                  <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2  bg-background/95 p-2 backdrop-blur-sm">
                    <ActionsDropdown
                      chatType={chatType}
                      setChatType={setChatType}
                      currentPlan={currentPlan}
                      isWebSearchActive={isWebSearchActive}
                      setIsWebSearchActive={setIsWebSearchActive}
                      isImageGenerationActive={isImageGenerationActive}
                      setIsImageGenerationActive={setIsImageGenerationActive}
                      isVideoGenerationActive={isVideoGenerationActive}
                      setIsVideoGenerationActive={setIsVideoGenerationActive}
                      setShowAudioPanel={setShowAudioPanel}
                      setAudioTab={setAudioTab}
                      handleAndUploadFiles={handleAndUploadFiles}
                      isUploading={isUploading}
                      isWebSearching={isWebSearching}
                      isLoading={isLoading}
                      isGeneratingImage={isGeneratingImage}
                      isGeneratingVideo={isGeneratingVideo}
                    />
                    <ActiveToolsDisplay
                      isWebSearchActive={isWebSearchActive}
                      setIsWebSearchActive={setIsWebSearchActive}
                      isImageGenerationActive={isImageGenerationActive}
                      setIsImageGenerationActive={setIsImageGenerationActive}
                      isVideoGenerationActive={isVideoGenerationActive}
                      setIsVideoGenerationActive={setIsVideoGenerationActive}
                      setChatType={setChatType}
                    />
                    <div className="flex-grow" />
                    {!(isLoading && isStreaming) && (
                      <>
                        <VoiceControls
                          onTranscription={(text) => setInput(prev => prev + (prev ? ' ' : '') + text)}
                          className="flex items-center gap-1"
                        />
                        <Button
                          onClick={handleSend}
                          disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching}
                          size="sm"
                          className="h-8 w-8 p-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
                        >
                          {isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ArrowUp className="h-4 w-4" />
                          )}
                        </Button>
                      </>
                    )}

                    {/* Stop Button when streaming */}
                    {/* {isLoading && isStreaming && (
                    <Button
                      onClick={stopStreaming}
                      size="icon"
                      // variant="ghost" 
                      className="h-8 w-8  rounded-full text-muted-foreground "
                      title="Stop Generating"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  )} */}

                    {isLoading && isStreaming && (
                      <Button
                        onClick={stopStreaming}
                        size="icon"
                        // className={cn(
                        //   "h-8 w-8 rounded-full",
                        //   "text-gray-800 hover:text-black",            // Always dark icon
                        //   "hover:bg-gray-200 dark:hover:bg-gray-300", // Optional hover bg
                        //   "transition-colors"
                        // )}
                        title="Stop Generating"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    )}

                  </div>
                </div></div>

              {/* <p className="text-center text-xs text-muted-foreground">
                {isImageGenerationActive
                  ? 'Press Enter to generate image, Shift+Enter for new line'
                  : isVideoGenerationActive
                    ? 'Press Enter to generate video, Shift+Enter for new line'
                    : isWebSearchActive
                      ? 'Press Enter to search the web, Shift+Enter for new line'
                      : 'Press Enter to send, Shift+Enter for new line'
                }
              </p> */}
            </div>
          </div>
        </div>
      ) : (
        <>
          {showAudioPanel ? (
            // Voice Studio inline view
            <div className="flex flex-1">
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
                  </div>
                </div>
              </div>
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
              <ScrollArea className="flex-1 p-4 mb-6" ref={scrollAreaRef}>
                <div className="space-y-4 max-w-4xl mx-auto">
                  {currentChat?.messages.map((message) => (
                    <MessageComponent
                      key={message.id}
                      message={message}
                      user={user}
                      onRegenerate={regenerateLastMessage}
                      updateMessageInChat={editAndRegenerate}
                    />
                  ))}
                </div>
              </ScrollArea>

              {/* Input & Actions */}

              <div className="">
                <div className="max-w-4xl mx-auto space-y-3">
                  {/* Input Area */}

                  {/* <div className="relative rounded-3xl border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden"> */}
                  <div className="border-wrapper">
                    <div className="relative  rounded-3xl .card border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden ">
                      <ActiveOptionsDisplay
                        uploadedFiles={uploadedFiles}
                        removeFile={removeFile}
                      />
                      <Textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => {
                          setInput(e.target.value);
                        }}
                        onKeyPress={handleKeyPress}
                        placeholder={
                          isImageGenerationActive
                            ? "Describe the image you want to generate..."
                            : isVideoGenerationActive
                              ? "Describe the video you want to create..."
                              : isWebSearchActive
                                ? "Enter your search query..."
                                : "Type your message here..."
                        }
                        className={`resize-none w-full bg-transparent border-none outline-none ring-0 focus:outline-none focus:ring-0  py-4 pb-14 transition-all duration-200 textarea-scrollbar`}
                        style={{
                          minHeight: "60px",
                          maxHeight: "350px",
                          overflowY: "auto",
                          border: "none",           // Inline style border remove
                          outline: "none",          // Inline style outline remove
                          boxShadow: "none",        // Remove focus shadow if any
                        }}
                        rows={1}
                        disabled={
                          // isLoading ||
                          isGeneratingVideo ||
                          isUploading ||
                          isWebSearching
                        }
                      />
                      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 rounded-b-xl bg-background/95 p-2 backdrop-blur-sm">
                        <ActionsDropdown
                          chatType={chatType}
                          setChatType={setChatType}
                          currentPlan={currentPlan}
                          isWebSearchActive={isWebSearchActive}
                          setIsWebSearchActive={setIsWebSearchActive}
                          isImageGenerationActive={isImageGenerationActive}
                          setIsImageGenerationActive={setIsImageGenerationActive}
                          isVideoGenerationActive={isVideoGenerationActive}
                          setIsVideoGenerationActive={setIsVideoGenerationActive}
                          setShowAudioPanel={setShowAudioPanel}
                          setAudioTab={setAudioTab}
                          handleAndUploadFiles={handleAndUploadFiles}
                          isUploading={isUploading}
                          isWebSearching={isWebSearching}
                          isLoading={isLoading}
                          isGeneratingImage={isGeneratingImage}
                          isGeneratingVideo={isGeneratingVideo}
                        />
                        <ActiveToolsDisplay
                          isWebSearchActive={isWebSearchActive}

                          setIsWebSearchActive={setIsWebSearchActive}
                          isImageGenerationActive={isImageGenerationActive}
                          setIsImageGenerationActive={setIsImageGenerationActive}
                          isVideoGenerationActive={isVideoGenerationActive}
                          setIsVideoGenerationActive={setIsVideoGenerationActive}
                          setChatType={setChatType}
                        />
                        <div className="flex-grow" />
                        {!(isLoading && isStreaming) && (
                          <>
                            <VoiceControls
                              onTranscription={(text) => setInput(prev => prev + (prev ? ' ' : '') + text)}
                              className="flex items-center gap-1"
                            />
                            <Button
                              onClick={handleSend}
                              disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching}
                              size="sm"
                              className="h-8 w-8 p-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
                            >
                              {isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <ArrowUp className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        )}

                        {/* Stop Button when streaming */}
                        {isLoading && isStreaming && (
                          <Button
                            onClick={stopStreaming}
                            size="icon"
                            // variant="ghost" 
                            className="h-8 w-8  rounded-full text-muted-foreground hover:text-foreground"
                            title="Stop Generating"
                          >
                            <Square className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>

                  <p className="text-center text-xs text-muted-foreground">
                    {isImageGenerationActive
                      ? 'Press Enter to generate image, Shift+Enter for new line'
                      : isVideoGenerationActive
                        ? 'Press Enter to generate video, Shift+Enter for new line'
                        : isWebSearchActive
                          ? 'Press Enter to search the web, Shift+Enter for new line'
                          : 'Press Enter to send, Shift+Enter for new line'
                    }
                  </p>
                </div>
              </div>
            </>
          )}
        </>
      )
      }
    </div >
  )
}
