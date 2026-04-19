"use client"

import * as React from "react"
import {
  Send,
  Paperclip,
  Mic,
  Square,
  Loader2,
  FileText,
  Video,
  Globe,
  Bot,
  ChevronDown,
  ChevronRight,
  X,
  Upload,
  Menu,
  Palette,
  Plus,
  Music,
  FileSpreadsheet,
  File,
  ArrowUp,
  Mail,
  Calendar,
  FolderOpen,
  NetworkIcon,
  Network,
  Monitor,
  Share,
  Search,
  BookOpen,
  Download,
  Sparkles,
  AudioLines,
  RefreshCw,
  Check,
  Zap,
  Brain,
  Crown,
  PanelLeftOpen,
  GripVertical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { useChat } from "@/lib/chat-context-integrated"
import { useAuth } from "@/lib/auth-context-integrated"
import { ThemeToggle } from "@/components/theme-toggle"
import WhatsAppButton from "@/components/WhatsAppButton"
import { PremiumCardIcon } from "@/components/icons/premium-card-icon"
import UnifiedDocumentViewer, { type AttachmentLike } from "@/components/viewers/UnifiedDocumentViewer"
import {
  extractFilesFromDataTransfer,
  extractFromClipboardEvent,
  validateBatch,
  filesToFileList,
  logIngest,
} from "@/lib/attachment-ingest"
import { Badge } from "@/components/ui/badge"
import { apiClient } from "@/lib/api"
import { aiService } from "@/lib/ai-service"
import { toast } from "sonner"
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import MessageComponent from "./message-component"
import VoiceControls from "./voice-controls"
import SpeechToTextComponent from "./speech-to-text-component"
import TextToSpeechComponent from "./text-to-speech-component"
import MusicGenerationComponent from "./MusicGenerationComponent"
import { webSearchService } from "@/lib/web-search-service"
import VideoGenerationComponent from "./VideoGenerationComponent"
import UpgradeModal from "./UpgradeModal"
import { IconProvider } from "./icon-provider"
import { AppSidebar } from "./app-sidebar"
import GoogleServicesConnectionCard from "./GoogleServicesConnectionCard"
import {
  SidebarProvider,
  Sidebar,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { useTranslations } from "next-intl"
import { DocumentPreview } from "./document-preview"
import { CodePreview } from "./code-preview"
import SpotifyResults from "./spotify-results"
import ComputerUseInterface from "./ComputerUseInterface"
import ComputerUseReasoning from "./ComputerUseReasoning"
import ExtractedDataDownload from "./ExtractedDataDownload"
import { useComputerUse } from "@/hooks/use-computer-use"
import { WordConnector } from "./WordConnector"
import { ExcelConnector, type ExcelConnectorRef } from "./ExcelConnector"

// Selected Text Display Component
const SelectedTextDisplay = ({ text, onClear }: { text: string | null; onClear: () => void; }) => {
  if (!text) return null;
  return (
    <div className="px-3 pt-3">
      <div className="relative rounded-lg border bg-muted/30 p-3">
        <div className="text-xs font-semibold mb-1 text-muted-foreground">AI Rewrite</div>
        <p className="text-sm pr-8 max-h-24 overflow-y-auto">{text}</p>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-1 right-1 h-6 w-6 p-0 rounded-full"
          onClick={onClear}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};


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
  isComputerUseActive,
  setIsComputerUseActive,
  computerUseStatus,
  isGmailActive,
  setIsGmailActive,
  isGoogleCalendarActive,
  setIsGoogleCalendarActive,
  isGoogleDriveActive,
  setIsGoogleDriveActive,
  isSpotifyActive,
  setIsSpotifyActive,
  isWordConnectorActive,
  setIsWordConnectorActive,
  isExcelConnectorActive,
  setIsExcelConnectorActive,
  setShowAudioPanel,
  setAudioTab,
  handleAndUploadFiles,
  isUploading,
  isWebSearching,
  isLoading,
  isGeneratingImage,
  isGeneratingVideo,
  isGeneratingPPT,
  isProcessingGmail,
  isProcessingGoogleServices,
  isProcessingSpotify,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle,
  handleWordConnectorToggle,
  handleExcelConnectorToggle,
  closeAllToolsAndConnectors,

}: any) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [justClosed, setJustClosed] = React.useState(false);
  const closeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

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
      closeAllToolsAndConnectors();
    }
    setIsWebSearchActive(!isWebSearchActive);
  };

  const handleImageGenerationToggle = () => {
    const newState = !isImageGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('image');
    } else {
      setChatType('text');
    }

    setIsImageGenerationActive(newState);
  };

  const handleVideoGenerationToggle = () => {
    const newState = !isVideoGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('video');
    } else {
      setChatType('text');
    }

    setIsVideoGenerationActive(newState);
  };


  const isDisabled = isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices;

  const handleDropdownOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // Prevent tooltip from showing immediately after dropdown closes
      setJustClosed(true);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
      closeTimeoutRef.current = setTimeout(() => {
        setJustClosed(false);
      }, 300); // Wait 300ms before allowing tooltip to show again
    } else {
      setJustClosed(false);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    }
  };

  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  return (
    <TooltipProvider>
      <DropdownMenu open={isOpen} onOpenChange={handleDropdownOpenChange}>
        <Tooltip open={!isOpen && !justClosed ? undefined : false} delayDuration={300}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 hover:bg-muted/50 rounded-full flex items-center justify-center"
                disabled={isDisabled}
              >
                <Plus className="h-8 w-8" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Attach files & tools</p>
          </TooltipContent>
        </Tooltip>
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
              </div>
              {isWebSearchActive && (
                <div className="w-2 h-2 bg-green-500 rounded-full" />
              )}
            </div>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <div className="flex items-center gap-3 w-full">
                <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-900/20 flex items-center justify-center">
                  {/* <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12.5 7.5C12.5 9.98528 10.4853 12 8 12C5.51472 12 3.5 9.98528 3.5 7.5C3.5 5.01472 5.51472 3 8 3C10.4853 3 12.5 5.01472 12.5 7.5Z" stroke="currentColor" stroke-width="1.5" />
                  <path d="M16.5 12.5C16.5 14.9853 14.4853 17 12 17C9.51472 17 7.5 14.9853 7.5 12.5C7.5 10.0147 9.51472 8 12 8C14.4853 8 16.5 10.0147 16.5 12.5Z" stroke="currentColor" stroke-width="1.5" />
                  <path d="M12.5 7.5C12.5 9.98528 10.4853 12 8 12C5.51472 12 3.5 9.98528 3.5 7.5C3.5 5.01472 5.51472 3 8 3C10.4853 3 12.5 5.01472 12.5 7.5Z" stroke="currentColor" stroke-width="1.5" />

                </svg> */}

                  <Network width="13" height="13" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-sm flex items-center">
                    Connectors
                  </div>
                </div>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>

              {/* Gmail */}
              <DropdownMenuItem
                onClick={handleGmailToggle}
                disabled={isProcessingGmail}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isGmailActive
                    ? 'bg-red-100 dark:bg-red-900/20'
                    : 'bg-red-100 dark:bg-red-900/20'
                    }`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isGmailActive ? 'Gmail Active' : 'Gmail'}
                    </div>
                  </div>
                  {isGmailActive && (
                    <div className="w-2 h-2 bg-red-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>

              {/* Google Calendar */}
              <DropdownMenuItem
                onClick={handleGoogleCalendarToggle}
                disabled={isProcessingGoogleServices}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isGoogleCalendarActive
                    ? 'bg-blue-100 dark:bg-blue-900/20'
                    : 'bg-blue-100 dark:bg-blue-900/20'
                    }`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isGoogleCalendarActive ? 'Calendar Active' : 'Google Calendar'}
                    </div>
                  </div>
                  {isGoogleCalendarActive && (
                    <div className="w-2 h-2 bg-blue-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>

              {/* Google Drive */}
              <DropdownMenuItem
                onClick={handleGoogleDriveToggle}
                disabled={isProcessingGoogleServices}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isGoogleDriveActive
                    ? 'bg-green-100 dark:bg-green-900/20'
                    : 'bg-green-100 dark:bg-green-900/20'
                    }`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isGoogleDriveActive ? 'Drive Active' : 'Google Drive'}
                    </div>
                  </div>
                  {isGoogleDriveActive && (
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>

              {/* Spotify */}
              <DropdownMenuItem
                onClick={handleSpotifyToggle}
                disabled={isProcessingSpotify}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isSpotifyActive
                    ? 'bg-green-100 dark:bg-green-900/20'
                    : 'bg-green-100 dark:bg-green-900/20'
                    }`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isSpotifyActive ? 'Spotify Active' : 'Spotify'}
                    </div>
                  </div>
                  {isSpotifyActive && (
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>

              {/* Word Connector */}
              <DropdownMenuItem
                onClick={() => {
                  if (handleWordConnectorToggle) {
                    handleWordConnectorToggle();
                  }
                  setIsOpen(false);
                }}
                disabled={isDisabled}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isWordConnectorActive
                    ? 'bg-blue-100 dark:bg-blue-900/20'
                    : 'bg-blue-100 dark:bg-blue-900/20'
                    }`}>
                    <img src="/icons/Word.png" alt="Word Connector" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isWordConnectorActive ? 'Word Connector Active' : 'Word Connector'}
                    </div>
                  </div>
                  {isWordConnectorActive && (
                    <div className="w-2 h-2 bg-blue-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>

              {/* Excel Connector */}
              <DropdownMenuItem
                onClick={() => {
                  if (handleExcelConnectorToggle) {
                    handleExcelConnectorToggle();
                  }
                  setIsOpen(false);
                }}
                disabled={isDisabled}
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isExcelConnectorActive
                    ? 'bg-blue-100 dark:bg-blue-900/20'
                    : 'bg-blue-100 dark:bg-blue-900/20'
                    }`}>
                    <img src="/icons/Excel.png" alt="Excel Connector" className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {isExcelConnectorActive ? 'Excel Connector Active' : 'Excel Connector'}
                    </div>
                  </div>
                  {isExcelConnectorActive && (
                    <div className="w-2 h-2 bg-blue-500 rounded-full" />
                  )}
                </div>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

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

          {/* Computer Use Agent - Temporarily disabled */}
          {/*
        <DropdownMenuItem
          onClick={handleComputerUseToggle}
          disabled={currentPlan === "FREE" || isDisabled}
        >
          <div className="flex items-center gap-3 w-full">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isComputerUseActive
              ? 'bg-indigo-100 dark:bg-indigo-900/20'
              : 'bg-indigo-100 dark:bg-indigo-900/20'
              }`}>
              <Monitor className={`h-4 w-4 ${isComputerUseActive
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-indigo-600 dark:text-indigo-400'
                }`} />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">
                {isComputerUseActive ? 'Computer Use Active' : 'Computer Use Agent'}
              </div>
              <div className="text-xs text-muted-foreground">
                AI that can control browsers and perform tasks
              </div>
            </div>
            {isComputerUseActive && (
              <div className="w-2 h-2 bg-indigo-500 rounded-full" />
            )}
            {currentPlan === "FREE" && (
              <Badge variant="secondary" className="text-xs">Pro</Badge>
            )}
          </div>
        </DropdownMenuItem>
        */}

          {/* Thesis Generation */}
          <DropdownMenuItem
            onClick={() => {
              setChatType('thesis');
              setIsOpen(false);
            }}
            disabled={currentPlan === "FREE" || isDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${chatType === 'thesis'
                ? 'bg-purple-100 dark:bg-purple-900/20'
                : 'bg-purple-100 dark:bg-purple-900/20'
                }`}>
                <BookOpen className={`h-4 w-4 ${chatType === 'thesis'
                  ? 'text-purple-600 dark:text-purple-400'
                  : 'text-purple-600 dark:text-purple-400'
                  }`} />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">
                  {chatType === 'thesis' ? 'Thesis Generator Active' : 'Thesis Generator'}
                </div>
                <div className="text-xs text-muted-foreground">
                  Generate comprehensive academic theses
                </div>
              </div>
              {chatType === 'thesis' && (
                <div className="w-2 h-2 bg-purple-500 rounded-full" />
              )}
              {currentPlan === "FREE" && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>      </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
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
      return <img src="/icons/pdf.png" alt="PDF" className="h-8 w-8" />;
    case 'doc':
    case 'docx':
      return <img src="/icons/Word.png" alt="Word" className="h-8 w-8" />;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return <img src="/icons/Excel.png" alt="Excel" className="h-8 w-8" />;
    case 'ppt':
    case 'pptx':
      return <img src="/icons/Bigger P powerpoint.png" alt="PowerPoint" className="h-8 w-8" />;
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
  removeFile,
  uploadProgress,
  retryUpload,
}: {
  uploadedFiles: any[];
  removeFile: (index: number) => void;
  uploadProgress: { [key: string]: number };
  retryUpload?: (file: any) => void;
}) => {
  // Viewer state — same reusable viewer used by sent-message chips, so
  // the user gets identical high-fidelity preview in both contexts.
  const [viewingIndex, setViewingIndex] = React.useState<number | null>(null);
  const viewingAttachment: AttachmentLike | null = React.useMemo(() => {
    if (viewingIndex === null) return null;
    const f = uploadedFiles[viewingIndex];
    if (!f) return null;
    return {
      id: f.id || f.tempId,
      name: f.name,
      mimeType: f.type,
      size: f.size,
      file: f.file instanceof globalThis.File ? f.file : null,
      url: f.url || null,
      extractedText: f.extractedText || null,
    };
  }, [viewingIndex, uploadedFiles]);
  const viewerSiblings: AttachmentLike[] = React.useMemo(
    () => uploadedFiles.map((f: any) => ({
      id: f.id || f.tempId,
      name: f.name,
      mimeType: f.type,
      size: f.size,
      file: f.file instanceof globalThis.File ? f.file : null,
      url: f.url || null,
      extractedText: f.extractedText || null,
    })),
    [uploadedFiles]
  );

  if (uploadedFiles.length === 0) return null;

  return (
    <div className="p-3  bg-background">
      <div className="flex flex-wrap items-center gap-2 max-h-40 overflow-y-auto">
        {uploadedFiles.map((file, index) => {
          const isImage = file.type?.startsWith('image/');
          const fileId = file.id || file.tempId;
          const progress = uploadProgress[fileId] || 0;
          const isUploading = progress > 0 && progress < 100;
          const isFailed = file.status === 'failed';
          const imageSizeClass = uploadedFiles.length > 1 ? 'h-20 w-20' : 'h-32 w-32';

          return (
            <div
              key={index}
              className={cn(
                "relative text-sm rounded-xl",
                "border",
                isFailed ? "border-red-300 dark:border-red-700/50" : "border-gray-200 dark:border-border/60",
                isImage ? `${imageSizeClass} p-0` : "flex items-center gap-2 px-2 py-1",
                // Clickable chip — opens the unified high-fidelity viewer.
                !isUploading && !isFailed && "cursor-pointer hover:border-foreground/40 hover:shadow-sm transition-all",
              )}
              title={isFailed ? `Subida fallida: ${file.uploadError || 'error'}` : 'Ver documento'}
              onClick={() => {
                if (isUploading || isFailed) return;
                setViewingIndex(index);
              }}
              role={!isUploading && !isFailed ? 'button' : undefined}
              tabIndex={!isUploading && !isFailed ? 0 : undefined}
              onKeyDown={(e) => {
                if (isUploading || isFailed) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingIndex(index); }
              }}
            >
              {isImage ? (
                <>
                  <div className="h-full w-full rounded-md overflow-hidden bg-gray-100 dark:bg-muted/40 flex items-center justify-center relative">
                    {file.preview ? (
                      <img src={file.preview} alt={file.name} className="h-full w-full object-cover" />
                    ) : file.url ? (
                      <img
                        src={`${process.env.NEXT_PUBLIC_IMAGE_URL || ""}${file.url}`}
                        alt={file.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      getFileIcon(file)
                    )}

                    {isUploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="h-6 w-6 animate-spin text-white mx-auto mb-1" />
                          <span className="text-white text-xs font-medium">{Math.round(progress)}%</span>
                        </div>
                      </div>
                    )}

                    {/* Failed overlay — retry CTA over the thumbnail */}
                    {isFailed && retryUpload && (
                      <div className="absolute inset-0 bg-red-900/55 flex flex-col items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 rounded-full bg-white/95 hover:bg-white text-red-600"
                          onClick={(e) => { e.stopPropagation(); retryUpload(file); }}
                          title="Reintentar subida"
                          aria-label="Reintentar subida"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-[9.5px] text-white font-medium">Reintentar</span>
                      </div>
                    )}
                  </div>

                  {!isUploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-1 right-1 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                      onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                      title="Quitar"
                      aria-label="Quitar archivo"
                    >
                      <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {getFileIcon(file)}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={`truncate font-medium text-[13px] ${isFailed ? 'text-red-600 dark:text-red-400' : ''}`}>
                      {file.name}
                    </span>
                    {isUploading && (
                      <div className="flex items-center gap-1 mt-1">
                        <div className="flex-1 h-1 bg-gray-200 dark:bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{Math.round(progress)}%</span>
                      </div>
                    )}
                    {isFailed && (
                      <span className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 truncate">
                        {file.uploadError || 'Error de subida'}
                      </span>
                    )}
                  </div>
                  {!isUploading && (
                    <div className="flex items-center gap-0.5 ml-1">
                      {isFailed && retryUpload && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 hover:bg-red-500/10 rounded-full text-red-600 dark:text-red-400"
                          onClick={(e) => { e.stopPropagation(); retryUpload(file); }}
                          title="Reintentar subida"
                          aria-label="Reintentar subida"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 hover:bg-gray-200 dark:hover:bg-muted rounded-full"
                        onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                        title="Quitar"
                        aria-label="Quitar archivo"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <UnifiedDocumentViewer
        open={viewingIndex !== null}
        onClose={() => setViewingIndex(null)}
        attachment={viewingAttachment}
        siblings={viewerSiblings}
        onNavigate={(next) => {
          const newIdx = viewerSiblings.findIndex(s => s === next);
          if (newIdx >= 0) setViewingIndex(newIdx);
        }}
      />
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
  isComputerUseActive,
  setIsComputerUseActive,
  computerUseStatus,
  isGmailActive,
  setIsGmailActive,
  isGoogleCalendarActive,
  setIsGoogleCalendarActive,
  isGoogleDriveActive,
  setIsGoogleDriveActive,
  isSpotifyActive,
  setIsSpotifyActive,
  isWordConnectorActive,
  setIsWordConnectorActive,
  isExcelConnectorActive,
  setIsExcelConnectorActive,
  chatType,
  setChatType,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle,
  handleWordConnectorToggle,
  handleExcelConnectorToggle
}: {
  isWebSearchActive: boolean;
  setIsWebSearchActive: (value: boolean) => void;
  isImageGenerationActive: boolean;
  setIsImageGenerationActive: (value: boolean) => void;
  isVideoGenerationActive: boolean;
  setIsVideoGenerationActive: (value: boolean) => void;
  isComputerUseActive: boolean;
  setIsComputerUseActive: (value: boolean) => void;
  computerUseStatus: 'idle' | 'running' | 'completed' | 'error';
  isGmailActive: boolean;
  setIsGmailActive: (value: boolean) => void;
  isGoogleCalendarActive: boolean;
  setIsGoogleCalendarActive: (value: boolean) => void;
  isGoogleDriveActive: boolean;
  setIsGoogleDriveActive: (value: boolean) => void;
  isSpotifyActive: boolean;
  setIsSpotifyActive: (value: boolean) => void;
  isWordConnectorActive: boolean;
  setIsWordConnectorActive: (value: boolean) => void;
  isExcelConnectorActive: boolean;
  setIsExcelConnectorActive: (value: boolean) => void;
  chatType: string;
  setChatType: (type: any) => void;

  handleComputerUseToggle: () => void;
  handleGmailToggle: () => void;
  handleGoogleCalendarToggle: () => void;
  handleGoogleDriveToggle: () => void;
  handleSpotifyToggle: () => void;
  handleWordConnectorToggle: () => void;
  handleExcelConnectorToggle: () => void;
}) => {
  const activeConnectors = [
    isGmailActive && { id: 'gmail', icon: <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" /> },
    isGoogleCalendarActive && { id: 'calendar', icon: <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" /> },
    isGoogleDriveActive && { id: 'drive', icon: <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" /> },
    isSpotifyActive && { id: 'spotify', icon: <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" /> },
    isWordConnectorActive && { id: 'word', icon: <img src="/icons/Word.png" alt="Word Connector" className="h-4 w-4" /> },
    isExcelConnectorActive && { id: 'excel', icon: <img src="/icons/Excel.png" alt="Excel Connector" className="h-4 w-4" /> },
  ].filter(Boolean) as { id: string; icon: JSX.Element }[];

  const hasConnectors = activeConnectors.length > 0;
  const hasOtherTools = isImageGenerationActive || isVideoGenerationActive || isWebSearchActive || isComputerUseActive;
  const hasThesis = chatType === 'thesis';

  if (!hasConnectors && !hasOtherTools && !hasThesis) return null;

  const handleCloseAllConnectors = () => {
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
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

  const handleWebSearchClose = () => {
    setIsWebSearchActive(false);
    setChatType('text');
  };

  const handleComputerUseClose = () => {
    setIsComputerUseActive(false);
    setChatType('text');
  };

  const handleThesisClose = () => {
    setChatType('text');
  };

  return (
    <div className="flex items-center gap-2">
      {hasConnectors && (
        <>
          <div className="flex items-center gap-1.5 bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-full text-xs border border-blue-200 dark:border-blue-800">
            {/* <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 7.5C12.5 9.98528 10.4853 12 8 12C5.51472 12 3.5 9.98528 3.5 7.5C3.5 5.01472 5.51472 3 8 3C10.4853 3 12.5 5.01472 12.5 7.5Z" stroke="currentColor" stroke-width="1.5" />
              <path d="M16.5 12.5C16.5 14.9853 14.4853 17 12 17C9.51472 17 7.5 14.9853 7.5 12.5C7.5 10.0147 9.51472 8 12 8C14.4853 8 16.5 10.0147 16.5 12.5Z" stroke="currentColor" stroke-width="1.5" />

            </svg> */}
            <Network width="13" height="13" />
            <span className="font-medium">Connectors</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-blue-200 dark:hover:bg-blue-800/30 rounded-full ml-1"
              onClick={handleCloseAllConnectors}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className="flex items-center gap-1.5 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full text-xs cursor-pointer">
                <div className="flex items-center gap-1">
                  {activeConnectors.map(c => <React.Fragment key={c.id}>{c.icon}</React.Fragment>)}
                </div>
                {/* <Badge variant="secondary" className="rounded-full h-5 w-5 flex items-center justify-center p-0">{activeConnectors.length}</Badge> */}
                <ChevronDown className="h-4 w-4" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">

              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" />
                    <span>Gmail</span>
                  </div>
                  <Switch
                    checked={isGmailActive}
                    onCheckedChange={handleGmailToggle}
                  />
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" />
                    <span>Google Calendar</span>
                  </div>
                  <Switch
                    checked={isGoogleCalendarActive}
                    onCheckedChange={handleGoogleCalendarToggle}
                  />
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" />
                    <span>Google Drive</span>
                  </div>
                  <Switch
                    checked={isGoogleDriveActive}
                    onCheckedChange={handleGoogleDriveToggle}
                  />
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" />
                    <span>Spotify</span>
                  </div>
                  <Switch
                    checked={isSpotifyActive}
                    onCheckedChange={handleSpotifyToggle}
                  />
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <img src="/icons/Word.png" alt="Word Connector" className="h-4 w-4" />
                    <span>Word Connector</span>
                  </div>
                  <Switch
                    checked={isWordConnectorActive}
                    onCheckedChange={() => {
                      if (handleWordConnectorToggle) {
                        handleWordConnectorToggle();
                      }
                    }}
                  />
                </div>
              </DropdownMenuItem>

              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <img src="/icons/Excel.png" alt="Excel Connector" className="h-4 w-4" />
                    <span>Excel Connector</span>
                  </div>
                  <Switch
                    checked={isExcelConnectorActive}
                    onCheckedChange={() => {
                      if (handleExcelConnectorToggle) {
                        handleExcelConnectorToggle();
                      }
                    }}
                  />
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
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

      {isComputerUseActive && (
        <div className="flex items-center gap-1.5 bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 px-2 py-1 rounded-full text-xs border border-indigo-200 dark:border-indigo-800">
          <Monitor className="h-3 w-3" />
          <span className="font-medium">Computer Use</span>
          <div className={`h-2 w-2 rounded-full ml-1 ${computerUseStatus === 'running' ? 'bg-green-500 animate-pulse' :
            computerUseStatus === 'completed' ? 'bg-blue-500' :
              computerUseStatus === 'error' ? 'bg-red-500' : 'bg-gray-400'
            }`} />
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-indigo-200 dark:hover:bg-indigo-800/30 rounded-full ml-1"
            onClick={handleComputerUseClose}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {chatType === 'thesis' && (
        <div className="flex items-center gap-1.5 bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 px-2 py-1 rounded-full text-xs border border-purple-200 dark:border-purple-800">
          <BookOpen className="h-3 w-3" />
          <span className="font-medium">Thesis Generator</span>
          <div className="w-2 h-2 bg-purple-500 rounded-full ml-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-purple-200 dark:hover:bg-purple-800/30 rounded-full ml-1"
            onClick={handleThesisClose}
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
  const [searchQuery, setSearchQuery] = React.useState("");


  // If this is a video chat type, show video model
  if (chatTypes === "video") {
    const videoModels = [
      { name: 'veo-fast', displayName: 'Veo Fast (8s)' },
      { name: 'kling-1.6-pro', displayName: 'Kling 1.6 Pro (10s)' },
      { name: 'kling-2-master', displayName: 'Kling 2 Master (10s)' }
    ];
    selectedVideoModelData = videoModels.find(m => m.name === selectedModel);

    // Filter video models based on search
    const filteredVideoModels = videoModels.filter((model) =>
      model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
      <DropdownMenu onOpenChange={(open) => {
        if (!open) setSearchQuery("");
      }}>
        <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md bg-background hover:bg-muted transition">
          <Video className="h-4 w-4" />
          <span className="text-sm font-medium">{selectedVideoModelData?.displayName || 'Select Video Model'}</span>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-500 rounded-full" title="API Key configured" />
            <ChevronDown className="h-4 w-4 opacity-70" />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 p-0">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search models..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          <ScrollArea className="h-[250px]">
            <div className="p-1">
              {filteredVideoModels.length > 0 ? (
                filteredVideoModels.map((model) => (
                  <DropdownMenuItem
                    key={model.name}
                    onSelect={() => {
                      setSelectedModel(model.name);
                      setSearchQuery("");
                    }}
                    className="flex items-center gap-2 py-2"
                  >
                    <Video className="h-5 w-5 flex-shrink-0" />
                    <div className="flex flex-col flex-1">
                      <span className="text-sm">{model.displayName}</span>
                    </div>
                  </DropdownMenuItem>
                ))
              ) : (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No models found
                </div>
              )}
            </div>
          </ScrollArea>
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

  // Recents — last 3 selected models, persisted in localStorage so the
  // user's preferred picks float to the top across sessions.
  const RECENTS_KEY = "sira:model-recents";
  const [recents, setRecents] = React.useState<string[]>([]);
  const refreshRecents = React.useCallback(() => {
    if (typeof window === "undefined") return;
    try { setRecents(JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]")); } catch { setRecents([]); }
  }, []);
  React.useEffect(() => { refreshRecents(); }, [refreshRecents]);
  const recordRecent = (modelName: string) => {
    if (typeof window === "undefined") return;
    try {
      const cur: string[] = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
      const next = [modelName, ...cur.filter(n => n !== modelName)].slice(0, 3);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      setRecents(next);
    } catch {}
  };

  // Tier inference — derives a one-glance capability tag + ES subtitle
  // from the model name, so the picker reads like ChatGPT's tiered
  // selector (Instant / Thinking / Pro) instead of an opaque flat list.
  const inferTier = (model: any): { label: string; hint: string; icon: typeof Zap } => {
    const n = String(model?.name || model?.displayName || "").toLowerCase();
    if (/(opus|o1\b|o3\b|o4\b|\br1\b|reason|think|deepseek-r)/.test(n)) {
      return { label: "Thinking", hint: "Para razonamiento profundo", icon: Brain };
    }
    if (/(mini|fast|flash|haiku|lite|nano|8b|7b|turbo|gemma)/.test(n)) {
      return { label: "Instant", hint: "Rápido para chats cotidianos", icon: Zap };
    }
    if (/(\bpro\b|ultra|max|405b|70b|sonnet)/.test(n)) {
      return { label: "Pro", hint: "Máxima capacidad", icon: Crown };
    }
    return { label: "", hint: "Equilibrado", icon: Bot };
  };

  // Stable provider order. Unknown providers fall to the end alphabetically.
  const providerOrder = ["OpenAI", "Anthropic", "Google", "Gemini", "xAI", "Groq", "OpenRouter"];
  const groupByProvider = (models: any[]): Array<[string, any[]]> => {
    const groups: Record<string, any[]> = {};
    for (const m of models) {
      const p = m.provider || "Otros";
      (groups[p] ||= []).push(m);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const ia = providerOrder.indexOf(a); const ib = providerOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  };

  // Filter models based on search query
  const filteredModels = availableModels.filter((model: any) =>
    model.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.provider?.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const grouped = groupByProvider(filteredModels);
  const recentModels = !searchQuery
    ? recents
        .map(n => filteredModels.find((m: any) => m.name === n))
        .filter(Boolean) as any[]
    : [];

  const onPick = (model: any) => {
    setSelectedModel(model.name);
    setSelectedProvider(model.provider);
    recordRecent(model.name);
    setSearchQuery("");
  };

  // ModelRow — single picker entry. Active state = subtle bg + Check on
  // the right; tier chip on the right of the name when not "Balanced".
  const ModelRow = ({ model }: { model: any }) => {
    const tier = inferTier(model);
    const isSelected = model.name === selectedModel;
    const TierIcon = tier.icon;
    return (
      <DropdownMenuItem
        onSelect={() => onPick(model)}
        className={cn(
          "group/row flex items-center gap-2.5 rounded-md px-2 py-1.5 cursor-pointer",
          "focus:bg-muted/60 data-[highlighted]:bg-muted/60",
          isSelected && "bg-muted/40",
        )}
      >
        <IconProvider name={model.icon} className="h-5 w-5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-tight">
              {model.displayName || model.name}
            </span>
            {tier.label && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/50 bg-muted/40 px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/85">
                <TierIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                {tier.label}
              </span>
            )}
          </div>
          <span className="truncate text-[11px] leading-tight text-muted-foreground/85">
            {tier.hint}
          </span>
        </div>
        {isSelected && (
          <Check className="h-4 w-4 shrink-0 text-foreground/85" strokeWidth={2.5} />
        )}
      </DropdownMenuItem>
    );
  };

  // Default model selector for regular chats
  return (
    <DropdownMenu onOpenChange={(open) => {
      if (!open) setSearchQuery("");
      if (open) refreshRecents();
    }}>
      {/* Model selector trigger — h-10, medium weight, subtle surface.
          The always-on red dot was removed: it was a dead indicator
          (every model showed "API Key required" regardless of state),
          which is visual noise and contradicts the premium target. */}
      <DropdownMenuTrigger
        className={cn(
          "group/model inline-flex h-10 items-center gap-2 rounded-xl px-3",
          "bg-muted/40 text-foreground",
          "border border-transparent",
          "text-[13.5px] font-semibold tracking-tight",
          "transition-[background-color,border-color] duration-200",
          "hover:bg-muted/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          "data-[state=open]:bg-muted/70",
        )}
      >
        {selectedModelData && <IconProvider name={selectedModelData.icon} className="h-4 w-4 shrink-0" />}
        <span className="max-w-[180px] truncate">{selectedModelData?.displayName || selectedModel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]/model:rotate-180" strokeWidth={2} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[340px] p-0 overflow-hidden rounded-xl border-border/60 shadow-lg">
        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              placeholder="Buscar modelos…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 border-border/50 bg-background pl-8 text-[13px]"
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>

        <ScrollArea className="max-h-[440px]">
          {/* Recents — only shown when no search query is active. */}
          {recentModels.length > 0 && (
            <div className="px-1.5 pt-2">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Recientes
              </div>
              <div className="flex flex-col gap-0.5">
                {recentModels.map((m: any) => (
                  <ModelRow key={`recent-${m.name}`} model={m} />
                ))}
              </div>
              <div className="mx-2 my-2 border-t border-border/40" />
            </div>
          )}

          {/* Provider-grouped sections. */}
          {grouped.length > 0 ? (
            <div className="px-1.5 pb-2">
              {grouped.map(([provider, models]) => (
                <div key={provider} className="mt-2 first:mt-0">
                  <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <span>{provider}</span>
                    <span className="text-muted-foreground/40">· {models.length}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {models.map((m: any) => (
                      <ModelRow key={m.name} model={m} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
              {searchQuery ? "Sin coincidencias" : "Sin modelos disponibles"}
            </div>
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default function ChatInterface() {
  return (
    <SidebarProvider>
      <ChatInterfaceContent />
    </SidebarProvider>
  )
}

function ChatInterfaceContent() {
  const tComposer = useTranslations("composer")
  const { user } = useAuth()

  const {
    currentChat,
    setCurrentChat,
    addMessage,
    addVideoMessage,
    addThesisMessage,
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
    availableModels, regenerateLastMessage, regenerateMessage,
    editAndRegenerate,
    updateMessageInChat,
    isStreaming, // ✅ isStreaming ko yahan se fetch karein
    pendingStop, // Add pendingStop state
    stopStreaming,

  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = React.useState(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = React.useState(false)
  const [isGeneratingPPT, setIsGeneratingPPT] = React.useState(false)
  const [isGeneratingWebDev, setIsGeneratingWebDev] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);
  const prevChatIdRef = React.useRef<string | undefined>();
  // Mirror of `uploadedFiles` for use inside async/event handlers that
  // outlive the render closure (paste listener, drop handler, etc.) —
  // reading from state directly would capture stale values.
  const uploadedFilesRef = React.useRef<any[]>([]);
  React.useEffect(() => { uploadedFilesRef.current = uploadedFiles; }, [uploadedFiles]);

  // "Reuse-in-prompt" bridge — UnifiedDocumentViewer dispatches a
  // CustomEvent on the window when the user clicks the Reply icon in
  // the viewer header. We re-attach the file metadata to the composer's
  // upload list (without re-uploading the binary; the backend `id` is
  // already permanent), and surface a toast so the action is visible.
  // Idempotent: if the same file id is already in the list, we no-op.
  React.useEffect(() => {
    const onReuse = (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      if (!detail.id) return;
      const already = uploadedFilesRef.current.some((f: any) => (f.id || f.tempId) === detail.id);
      if (already) {
        toast(`"${detail.name}" ya está adjunto al prompt`);
        return;
      }
      const reused = {
        id: detail.id,
        tempId: detail.id,
        name: detail.name,
        type: detail.mimeType,
        size: detail.size ?? 0,
        url: detail.url,
        extractedText: detail.extractedText,
        status: 'completed',
      };
      setUploadedFiles((cur: any[]) => [...cur, reused]);
      toast.success(`Adjuntado "${detail.name}" al prompt`);
    };
    window.addEventListener('sira:reuse-attachment', onReuse);
    return () => window.removeEventListener('sira:reuse-attachment', onReuse);
  }, [setUploadedFiles]);
  // True while the IME is composing a multi-keystroke character (CJK,
  // Spanish accents, dead keys). Paste handler must NOT intercept paste
  // during composition or it scrambles the in-flight character.
  const isComposingRef = React.useRef(false);

  // Auto-scroll to bottom function
  const scrollToBottom = React.useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        // Use setTimeout to ensure the DOM has updated before scrolling
        setTimeout(() => {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }, 0);
      }
    }
  }, []);

  // Scroll to bottom only when the chat is changed
  React.useEffect(() => {
    scrollToBottom();
  }, [currentChat?.id]);

  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<{ [key: string]: number }>({});

  // Local sending / intent state so Stop button appears immediately on Enter
  const [isSending, setIsSending] = React.useState(false);
  const intentAbortControllerRef = React.useRef<AbortController | null>(null);

  // Voice Studio panel state
  const [showAudioPanel, setShowAudioPanel] = React.useState(false);
  const [audioTab, setAudioTab] = React.useState<'tts' | 'stt' | 'music' | 'video'>("tts");

  // Speech-to-Text states 
  const [isSpeechSupported, setIsSpeechSupported] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);

  const [isWebSearching, setIsWebSearching] = React.useState(false)
  const [isWebSearchActive, setIsWebSearchActive] = React.useState(false);
  const [isGmailActive, setIsGmailActive] = React.useState(false);
  const [isProcessingGmail, setIsProcessingGmail] = React.useState(false);
  const [isGoogleCalendarActive, setIsGoogleCalendarActive] = React.useState(false);
  const [isGoogleDriveActive, setIsGoogleDriveActive] = React.useState(false);
  const [isProcessingGoogleServices, setIsProcessingGoogleServices] = React.useState(false);
  const [isSpotifyActive, setIsSpotifyActive] = React.useState(false);
  const [isProcessingSpotify, setIsProcessingSpotify] = React.useState(false);
  const [isImageGenerationActive, setIsImageGenerationActive] = React.useState(false);
  const [isComputerUseActive, setIsComputerUseActive] = React.useState(false);
  const [computerUseStatus, setComputerUseStatus] = React.useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [computerUseScreenshot, setComputerUseScreenshot] = React.useState<string | null>(null);
  const [isWordConnectorActive, setIsWordConnectorActive] = React.useState(false);
  const [isGeneratingWord, setIsGeneratingWord] = React.useState(false);
  const wordConnectorRef = React.useRef<{ updateContent: (content: string) => void; replaceSelection: (content: string) => void; getHTML: () => string; } | null>(null);
  const [selectedWordText, setSelectedWordText] = React.useState<string | null>(null);
  const [isRewriting, setIsRewriting] = React.useState(false);

  const [isExcelConnectorActive, setIsExcelConnectorActive] = React.useState(false);
  const [isGeneratingExcel, setIsGeneratingExcel] = React.useState(false);
  const excelConnectorRef = React.useRef<ExcelConnectorRef | null>(null);

  // Computer Use hook
  const {
    status: computerUseHookStatus,
    screenshot: computerUseHookScreenshot,
    reasoning: computerUseReasoning,
    extractedData: computerUseExtractedData,
    finalUrl: computerUseFinalUrl,
    startComputerUse,
    stopComputerUse,
    addReasoningStep,
    clearReasoning
  } = useComputerUse();

  // Sync hook state with local state
  React.useEffect(() => {
    setComputerUseStatus(computerUseHookStatus);
    setComputerUseScreenshot(computerUseHookScreenshot);
  }, [computerUseHookStatus, computerUseHookScreenshot]);

  // ============================================
  // CENTRALIZED FUNCTIONS FOR TOOLS & CONNECTORS
  // ============================================

  /**
   * Closes all tools and connectors - used when activating a new tool/connector
   * This ensures only one tool/connector is active at a time
   */
  const closeAllToolsAndConnectors = React.useCallback(() => {
    setIsWebSearchActive(false);
    setIsImageGenerationActive(false);
    setIsVideoGenerationActive(false);
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsComputerUseActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
  }, []);

  /**
   * Resets all tools, connectors, and UI states - used when switching chats or clicking "New Chat"
   */
  const resetAllToolsAndConnectors = React.useCallback(() => {
    // Close all tools and connectors
    closeAllToolsAndConnectors();

    // Reset chat type
    setChatType('text');

    // Reset other UI states
    setShowAudioPanel(false);
    setDocumentPreviewUrl(null);
    setSplitViewContent(null);
    setSelectedWordText(null);
    setUploadedFiles([]);
    setInput('');

    // Clear Computer Use state
    if (clearReasoning) clearReasoning();
    setComputerUseStatus('idle');
    setComputerUseScreenshot(null);
  }, [closeAllToolsAndConnectors, setChatType, clearReasoning]);

  // Add reasoning steps to chat messages as they come in
  React.useEffect(() => {
    if (computerUseReasoning.length > 0 && currentChat && isComputerUseActive) {
      // Find the latest reasoning step
      const latestStep = computerUseReasoning[computerUseReasoning.length - 1];

      // Add reasoning step as a chat message
      const reasoningMessage = {
        id: `msg-reasoning-${latestStep.timestamp}`,
        chatId: currentChat.id,
        role: 'ASSISTANT' as const,
        content: latestStep.text,
        timestamp: new Date(latestStep.timestamp).toISOString(),
        metadata: JSON.stringify({
          type: 'computer_use_reasoning',
          stepNumber: computerUseReasoning.length,
          action: latestStep.action
        })
      };

      // Only add if this reasoning step isn't already in the chat
      const existingMessage = currentChat.messages?.find(msg =>
        msg.id === reasoningMessage.id
      );

      if (!existingMessage) {
        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), reasoningMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }
    }
  }, [computerUseReasoning, currentChat, isComputerUseActive]);


  const handleGmailToggle = () => {
    const newState = !isGmailActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGmailActive(true);
    } else {
      setIsGmailActive(false);
    }
  };

  const handleGoogleCalendarToggle = () => {
    const newState = !isGoogleCalendarActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGoogleCalendarActive(true);
    } else {
      setIsGoogleCalendarActive(false);
    }
  };

  const handleGoogleDriveToggle = () => {
    const newState = !isGoogleDriveActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGoogleDriveActive(true);
    } else {
      setIsGoogleDriveActive(false);
    }
  };

  const handleSpotifyToggle = () => {
    const newState = !isSpotifyActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsSpotifyActive(true);
    } else {
      setIsSpotifyActive(false);
    }
  };

  const handleComputerUseToggle = () => {
    const newState = !isComputerUseActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsComputerUseActive(true);
      setChatType('computer-use');
    } else {
      setIsComputerUseActive(false);
      setChatType('text');
    }
  };

  const handleWordConnectorToggle = async () => {
    console.log("Toggling Word Connector");
    const newState = !isWordConnectorActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsWordConnectorActive(true);
      setChatType('text');

      // If toggling on while a chat is already selected, create/select
      // a dedicated chat for the Word Connector so we don't reuse
      // the existing conversation.
      if (currentChat) {
        try {
          const newChat = await createNewChat('text', undefined, undefined, {
            skipInitialProcessing: true,
            isWordConnectorChat: true
          });
          if (newChat?.id) {
            await selectChat(newChat.id);
          }
        } catch (err) {
          console.error('Failed to create/select Word Connector chat', err);
        }
      }
    } else {
      setIsWordConnectorActive(false);
      setChatType('text');
    }
  };

  const handleExcelConnectorToggle = async () => {
    console.log("Toggling Excel Connector");
    const newState = !isExcelConnectorActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsExcelConnectorActive(true);
      setChatType('text');

      // Create/select a dedicated chat for the Excel Connector
      if (currentChat) {
        try {
          const newChat = await createNewChat('text', undefined, undefined, {
            skipInitialProcessing: true,
            isExcelConnectorChat: true,
          } as any);
          if (newChat?.id) {
            await selectChat(newChat.id);
          }
        } catch (err) {
          console.error('Failed to create/select Excel Connector chat', err);
        }
      }
    } else {
      setIsExcelConnectorActive(false);
      setChatType('text');
    }
  };

  const handleSpotifyCommand = async (prompt: string) => {
    setIsProcessingSpotify(true);
    try {
      if (!currentChat) {
        await createNewChat('spotify', prompt);
      } else {
        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: '[PROCESSING_SPOTIFY]',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        const payload = {
          prompt,
          chatId: currentChat?.id,
        };

        const response = await apiClient.processSpotifyCommand(payload);

        if (response.requiresConnection) {
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_SPOTIFY]') {
                return {
                  ...msg,
                  content: `**Spotify Connection Required**

I can help you with Spotify tasks like:
- Searching for songs
- Managing your playlists

But first, you need to connect your Spotify account securely using the button below.`,
                  metadata: JSON.stringify({
                    type: 'spotify_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Spotify connection required');
        } else {
          const updateChatWithSpotifyResults = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_SPOTIFY]') {
                return {
                  ...msg,
                  content: response.generalResponse || "Here are your Spotify results:",
                  metadata: JSON.stringify({
                    type: 'spotify_results',
                    data: response
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithSpotifyResults);
          toast.success('Spotify response generated!');
        }
      }
    } catch (error: any) {
      console.error('Spotify error:', error);
      const errorMessage = error.message || 'Spotify request failed. Please try again.';

      // Check for monthly API limit exceeded error
      if (isMonthlyLimitError(errorMessage)) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_SPOTIFY]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Spotify features.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_SPOTIFY]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingSpotify(false);
    }
  }
  const [isVideoGenerationActive, setIsVideoGenerationActive] = React.useState(false);
  const [subscribeOpen, setSubscribeOpen] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);
  const [currentUserInfo, setCurrentUserInfo] = React.useState<any>(null);
  const [splitViewContent, setSplitViewContent] = React.useState<any>(null)
  const [documentPreviewUrl, setDocumentPreviewUrl] = React.useState<string | null>(null);
  const [shareModalOpen, setShareModalOpen] = React.useState(false);
  const [shareUrl, setShareUrl] = React.useState<string | null>(null);

  // Helper function to check if error is related to monthly API limit
  const isMonthlyLimitError = (errorMessage: string) => {
    const lowerMessage = errorMessage.toLowerCase();
    return lowerMessage.includes('monthly api limit exceeded') ||
      lowerMessage.includes('monthly limit exceeded') ||
      lowerMessage.includes('monthly video generation limit exceeded') ||
      lowerMessage.includes('free monthly queries exhausted') ||
      (lowerMessage.includes('monthly') && lowerMessage.includes('limit'));
  };


  // Search sources state - all enabled by default

  // No longer need dynamic padding, handled by layout
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Handle textarea input change with smooth scrolling
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);

    // Use requestAnimationFrame to ensure DOM is updated before scrolling
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const textarea = textareaRef.current;
        const maxHeight = 350;

        // Reset height to recalculate
        textarea.style.height = 'auto';
        const scrollHeight = textarea.scrollHeight;

        if (scrollHeight > maxHeight) {
          textarea.style.height = `${maxHeight}px`;
          textarea.style.overflowY = 'auto';
          // Auto-scroll to bottom to keep cursor visible when typing
          setTimeout(() => {
            textarea.scrollTop = textarea.scrollHeight;
          }, 0);
        } else {
          textarea.style.height = `${scrollHeight}px`;
          textarea.style.overflowY = 'hidden';
        }
      }
    });
  };

  React.useEffect(() => {
    if (textareaRef.current) {
      const textarea = textareaRef.current;
      const maxHeight = 350;

      // Reset height to recalculate
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;

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

    // Global error handler for API limit exceeded errors
    function handleApiLimitError(e: Event) {
      const customEvent = e as CustomEvent;
      const errorMessage = customEvent.detail?.message || customEvent.detail?.error || '';
      if (isMonthlyLimitError(errorMessage)) {
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('open-upgrade-modal', handleOpenUpgrade);
      window.addEventListener('api-limit-error', handleApiLimitError);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('open-upgrade-modal', handleOpenUpgrade);
        window.removeEventListener('api-limit-error', handleApiLimitError);
      }
    };
  }, [setSubscribeOpen, isMonthlyLimitError]);

  const handleToggleSplitView = (content: any) => {
    setDocumentPreviewUrl(null)
    setSplitViewContent(content)
  }

  const handleDocumentPreview = (url: string) => {
    setSplitViewContent(null)
    setDocumentPreviewUrl(url);
  };

  // Complete chat share functionality
  const handleCompleteShare = async () => {
    if (!currentChat?.id) {
      toast.error("No chat to share");
      return;
    }

    try {
      const response = await apiClient.handleShare(currentChat.id);
      const baseUrl = process.env.NEXT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
      let url = `${baseUrl}/share/${response.shareableLink}`;
      navigator.clipboard.writeText(url);
      toast.success("Shareable chat link copied!");
      setShareUrl(url);
      setShareModalOpen(true);
    } catch (error) {
      toast.error(`Failed to create chat share link. ${error}`);
    }
  };

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
    if (prevChatIdRef.current && prevChatIdRef.current !== currentChat?.id) {
      // Reset generation modes when switching chats
      closeAllToolsAndConnectors();
      setChatType('text'); // Always default to text when switching chats

      // Clear Computer Use reasoning when switching chats
      clearReasoning();
    }
    prevChatIdRef.current = currentChat?.id;
  }, [currentChat?.id, clearReasoning, closeAllToolsAndConnectors]); // Only trigger when chat ID changes


  React.useEffect(() => {
    setShowAudioPanel(false);
    setDocumentPreviewUrl(null)
    setSplitViewContent(null)
    setSelectedWordText(null);

    // Close all connectors first when switching chats
    closeAllToolsAndConnectors();

    // Use a small delay to ensure previous connector UI is fully closed
    const timer = setTimeout(() => {
      if (currentChat && (currentChat as any).isWordConnectorChat) {
        console.log('📄 Word Connector chat detected:', currentChat.id);
        console.log('📄 Has wordContent:', !!(currentChat as any).wordContent);
        console.log('📄 wordContent length:', (currentChat as any).wordContent?.length);

        setIsWordConnectorActive(true);

        // Load existing Word content if available
        if ((currentChat as any).wordContent) {
          console.log('📄 Attempting to load Word content into editor...');
          // Wait longer for editor to be ready
          setTimeout(() => {
            if (wordConnectorRef.current) {
              console.log('📄 Ref is ready, updating content...');
              wordConnectorRef.current?.updateContent((currentChat as any).wordContent);
            } else {
              console.warn('📄 WordConnector ref not ready yet');
            }
          }, 500);
        }
      } else if (currentChat && (currentChat as any).isExcelConnectorChat) {
        setIsExcelConnectorActive(true);

        if ((currentChat as any).excelContent) {
          setTimeout(() => {
            excelConnectorRef.current?.loadWorkbook((currentChat as any).excelContent);
          }, 500);
        }
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [currentChat?.id, closeAllToolsAndConnectors]);


  // Listen for "New Chat" button click to reset all states
  React.useEffect(() => {
    const handleResetChatState = () => {
      console.log('🔄 Resetting all chat states (New Chat clicked)');
      resetAllToolsAndConnectors();
      setComputerUseStatus('idle');
      setComputerUseScreenshot(null);
    };

    window.addEventListener('resetChatState', handleResetChatState);

    return () => {
      window.removeEventListener('resetChatState', handleResetChatState);
    };
  }, [resetAllToolsAndConnectors]);



  // Additional effect: Load content when Word Connector becomes active and ref is ready
  React.useEffect(() => {
    if (isWordConnectorActive && currentChat && (currentChat as any).isWordConnectorChat && (currentChat as any).wordContent) {
      console.log('📄 Word Connector active, checking if ref is ready...');
      // Try loading content when panel becomes active
      const loadContent = () => {
        if (wordConnectorRef.current) {
          console.log('📄 Loading content into active Word Connector...');
          wordConnectorRef.current?.updateContent((currentChat as any).wordContent);
          return true;
        }
        return false;
      };

      // Try immediately
      if (!loadContent()) {
        // If not ready, try again after a short delay
        const timer = setTimeout(loadContent, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [isWordConnectorActive, currentChat?.id]);

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

  // Note: Legacy shared chat handling has been removed.
  // Shared content is now handled exclusively by the /share pages which
  // automatically save content and redirect to /chat. This prevents
  // duplicate chat creation that was occurring with the old dual-system approach.
  // Listen for Computer Use extraction completion to refresh chat
  React.useEffect(() => {

    const handleExtractionComplete = (event: Event) => {
      const customEvent = event as CustomEvent;
      console.log('Computer Use extraction completed, refreshing chat...');
      // Refresh the current chat to show new messages
      if (currentChat?.id) {
        setTimeout(() => {
          selectChat(currentChat.id);
        }, 500);
      }
    };

    const handleWebSocketExtractionComplete = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'extraction-completed' && data.data.chatId === currentChat?.id) {
          console.log('WebSocket: Computer Use extraction completed, refreshing chat...');
          setTimeout(() => {
            if (currentChat?.id) {
              selectChat(currentChat.id);
            }
          }, 1000);
        }
      } catch (error) {
        // Ignore parse errors for non-JSON WebSocket messages
      }
    };

    window.addEventListener('computer-use-extraction-complete', handleExtractionComplete);

    // Also listen for WebSocket events if available
    if (typeof window !== 'undefined' && (window as any).computerUseWebSocket) {
      (window as any).computerUseWebSocket.addEventListener('message', handleWebSocketExtractionComplete);
    }

    return () => {
      window.removeEventListener('computer-use-extraction-complete', handleExtractionComplete);
      if (typeof window !== 'undefined' && (window as any).computerUseWebSocket) {
        (window as any).computerUseWebSocket.removeEventListener('message', handleWebSocketExtractionComplete);
      }
    };
  }, [currentChat?.id, selectChat]);

  // File upload logic with instant preview, REAL progress, retry, and
  // source-channel telemetry. All state writes use functional updates
  // so concurrent drops/pastes can't clobber each other.
  const handleAndUploadFiles = async (
    files: FileList,
    sourceChannel: string = 'picker',
  ) => {
    if (files.length === 0) return;

    let filesToUpload = Array.from(files);

    if (chatType === 'video' || chatType === 'image') {
      const imageFiles = filesToUpload.filter(file => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        toast.error("Solo se permiten imágenes en este modo.");
        return;
      }
      filesToUpload = imageFiles;
    }

    // Idempotency key — backend dedupes retries of the SAME batch attempt.
    const idempotencyKey = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Build temp objects with stable IDs we can map to per-file progress.
    const tempFiles = filesToUpload.map((file) => {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      return {
        tempId,
        name: file.name,
        type: file.type,
        size: file.size,
        preview,
        file,
        sourceChannel,
        status: 'uploading' as 'uploading' | 'ready' | 'failed',
      };
    });

    setUploadedFiles((cur: any[]) => [...cur, ...tempFiles]);

    // Initialize per-temp progress at 0.
    setUploadProgress(prev => {
      const next = { ...prev };
      tempFiles.forEach(tf => { next[tf.tempId] = 0; });
      return next;
    });

    setIsUploading(true);

    try {
      const dt = new DataTransfer();
      filesToUpload.forEach(file => dt.items.add(file));

      // Real upload progress via XHR (see lib/api.ts uploadFiles).
      // The total covers all files in this batch — we apply the same
      // percent to every temp chip in the batch (multipart form makes
      // per-file progress impossible without a chunked endpoint).
      const response: any = await apiClient.uploadFiles(dt.files, {
        sourceChannel,
        idempotencyKey,
        onProgress: (pct) => {
          setUploadProgress(prev => {
            const next = { ...prev };
            tempFiles.forEach(tf => { next[tf.tempId] = pct; });
            return next;
          });
        },
      });

      if (response.files) {
        // Snap to 100% and swap temps for server entries — preserve the
        // original File blob and preview so the chip thumbnail doesn't
        // flash off during the swap.
        setUploadProgress(prev => {
          const next = { ...prev };
          tempFiles.forEach(tf => { next[tf.tempId] = 100; });
          return next;
        });
        const merged = response.files.map((f: any, idx: number) => ({
          ...f,
          file: tempFiles[idx]?.file ?? f.file,
          preview: tempFiles[idx]?.preview ?? f.preview,
          sourceChannel,
          status: 'ready' as const,
        }));
        const tempIds = new Set(tempFiles.map(tf => tf.tempId));
        setUploadedFiles((cur: any[]) => [
          ...cur.filter((f: any) => !tempIds.has(f.tempId)),
          ...merged,
        ]);

        setTimeout(() => {
          setUploadProgress(prev => {
            const next = { ...prev };
            tempFiles.forEach(tf => { delete next[tf.tempId]; });
            return next;
          });
        }, 500);

        // Quiet on success — the chip itself is the confirmation.
        // (Toast was noisy after every drag-drop.)
      } else {
        // Mark temps as failed so the chip shows a retry button.
        const tempIds = new Set(tempFiles.map(tf => tf.tempId));
        setUploadedFiles((cur: any[]) =>
          cur.map(f => tempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: 'Respuesta sin archivos' } : f)
        );
        toast.error('La subida falló. Toca el ícono de reintento en el archivo.');
      }
    } catch (error: any) {
      console.error('File upload failed:', error);
      const reason = error?.message || 'Error de subida';
      toast.error(reason);
      // Mark as failed (don't remove) so the user can retry without
      // re-dragging the file.
      const tempIds = new Set(tempFiles.map(tf => tf.tempId));
      setUploadedFiles((cur: any[]) =>
        cur.map(f => tempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: reason } : f)
      );
      // Previews are intentionally KEPT alive on failure so the chip
      // can render its thumbnail next to the retry button.
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Retry an upload that previously failed. Reuses the in-memory File
   * object stored on the chip — no need for the user to re-drop.
   */
  const retryUpload = React.useCallback((failedFile: any) => {
    if (!failedFile?.file || !(failedFile.file instanceof globalThis.File)) {
      toast.error('No se puede reintentar — el archivo se perdió. Vuelve a arrastrarlo.');
      return;
    }
    setUploadedFiles((cur: any[]) =>
      cur.filter(f => f.tempId !== failedFile.tempId && f.id !== failedFile.id)
    );
    const dt = new DataTransfer();
    dt.items.add(failedFile.file);
    handleAndUploadFiles(dt.files, failedFile.sourceChannel || 'retry');
  }, []);

  // Drag and Drop event handlers with drag counter to prevent flickering
  const dragCounter = React.useRef(0);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragIn = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragOut = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    // Use the unified extractor — pulls from BOTH .files and .items so
    // we catch files dragged from sources where one is empty (Linux
    // Firefox + Edge legacy expose only via .items; Safari often only
    // via .files). Then run the validate-batch gate for clean errors.
    const all = extractFilesFromDataTransfer(e.dataTransfer);
    if (all.length === 0) return;
    const { accepted, rejected } = validateBatch(all, {
      existingCount: uploadedFilesRef.current.length,
    });
    if (rejected.length > 0) {
      // Group identical reasons into a single toast so 8 rejected files
      // don't spam 8 toasts.
      const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(grouped).forEach(([reason, n]) => {
        toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
      });
    }
    if (accepted.length > 0) {
      logIngest({
        source: 'drop',
        count: accepted.length,
        total_bytes: accepted.reduce((s, f) => s + f.size, 0),
        rejected_count: rejected.length,
        rejected_codes: rejected.map(r => r.code),
      });
      handleAndUploadFiles(filesToFileList(accepted), 'drop');
    }
  };

  /**
   * Clipboard paste handler — wired to BOTH the textarea (so it fires
   * even when text is pasted) AND a document-level listener (so paste
   * works when the input isn't focused, matching Slack/Discord UX).
   *
   * Behavior matrix:
   *   pure text         → default (browser inserts into textarea)
   *   pure files        → ingest, prevent default
   *   text + files      → ingest files AND let text insert (combined send)
   *   image blob only   → ingest as a synthesized "pasted-<ts>.png" file
   *   pure HTML         → strip to plain text, prevent default
   */
  const handleClipboardPaste = React.useCallback((e: ClipboardEvent | React.ClipboardEvent) => {
    // CRITICAL: never intercept paste while the IME is composing — would
    // scramble the in-flight character (Spanish accent, CJK, etc.).
    if (isComposingRef.current) return;

    const native = ('nativeEvent' in e ? e.nativeEvent : e) as ClipboardEvent;
    const cd = native.clipboardData;
    if (!cd) return;

    const { files, text, html } = extractFromClipboardEvent(native, { includeHtml: true });

    // ─── No files ───────────────────────────────────────────────────
    if (files.length === 0) {
      // text/uri-list — user copied a link from the address bar or a
      // browser tab tab strip. Insert the URL(s) as plain text instead
      // of letting Chrome paste the HTML <a> wrapper.
      const uriList = cd.getData('text/uri-list');
      if (uriList && !text) {
        const urls = uriList.split('\n').map(s => s.trim()).filter(Boolean).filter(u => !u.startsWith('#'));
        if (urls.length > 0) {
          e.preventDefault();
          setInput(prev => prev + (prev ? ' ' : '') + urls.join(' '));
          return;
        }
      }
      // HTML-only paste (rare — usually browsers attach text/plain too).
      // Strip to text via DOM parsing so we don't lose the content.
      if (!text && html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const fallbackText = (tmp.textContent || tmp.innerText || '').trim();
        if (fallbackText) {
          e.preventDefault();
          setInput(prev => prev + fallbackText);
        }
      }
      // Otherwise let the browser do its native plain-text paste.
      return;
    }

    // ─── Files present — ingest ─────────────────────────────────────
    const { accepted, rejected } = validateBatch(files, {
      existingCount: uploadedFilesRef.current.length,
    });
    if (rejected.length > 0) {
      const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(grouped).forEach(([reason, n]) => {
        toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
      });
    }
    if (accepted.length > 0) {
      // Source-channel taxonomy: synthesized "pasted-…" filename means
      // an image blob arrived without a name (clipboard image, screenshot).
      const isImageOnly = accepted.every(f =>
        f.type.startsWith('image/') && /^pasted-/.test(f.name),
      );
      const channel = isImageOnly ? 'paste-image' : 'paste-files';
      logIngest({
        source: channel,
        count: accepted.length,
        total_bytes: accepted.reduce((s, f) => s + f.size, 0),
        rejected_count: rejected.length,
        rejected_codes: rejected.map(r => r.code),
        had_text: !!text,
      });
      // Prevent default so the OS file path string doesn't get pasted
      // as text next to the file. Then handle text ourselves if present.
      if ('preventDefault' in e) e.preventDefault();
      if (text) setInput(prev => prev + text);
      handleAndUploadFiles(filesToFileList(accepted), channel);
    }
  }, []);

  // Document-level paste listener — catches pastes when the textarea
  // isn't focused (e.g., user paste into the canvas while reading a
  // previous message). Matches Slack/Discord UX.
  React.useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      // CRITICAL: skip if the React onPaste handler on the textarea
      // already handled this event — `defaultPrevented` is set by the
      // React handler when it ingests files. Without this guard the
      // same screenshot ends up duplicated (React handler + document
      // handler both ingest it).
      if (e.defaultPrevented) return;
      // Also skip when the focused element is one of OUR textareas —
      // even if the React handler decided not to preventDefault (pure
      // text paste), we don't want the doc-level handler stealing it.
      const target = e.target as HTMLElement | null;
      if (target && (target as HTMLTextAreaElement) === textareaRef.current) return;

      const cd = e.clipboardData;
      if (!cd) return;
      const hasFile =
        (cd.files && cd.files.length > 0) ||
        (cd.items && Array.from(cd.items).some(i => i.kind === 'file'));
      if (!hasFile) return;
      handleClipboardPaste(e);
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [handleClipboardPaste]);

  // Soft rate-limit queue — instead of dropping a message when the
  // composer is busy streaming a prior turn, we park it in this ref and
  // flush it automatically when the pipeline goes idle. This keeps the
  // "user types 3 things quickly" flow working without losing text.
  const pendingMsgQueueRef = React.useRef<Array<{ msg: string; files: any[] }>>([]);
  const queueBurstTimestampsRef = React.useRef<number[]>([]);
  const handleSendRef = React.useRef<() => void>(() => {});

  // ────────────────────────────────────────────────────────────
  // Sidebar auto-collapse — when the user enters a "big-canvas"
  // tool (Word / Excel / image-gen / video-gen) the left sidebar
  // steals too much horizontal space. We collapse it on entry and
  // never auto-reopen — the user pops it back manually via the
  // floating PanelLeftOpen button pinned to the viewport edge.
  // ────────────────────────────────────────────────────────────
  const { open: sidebarOpen, setOpen: setSidebarOpen, isMobile: isSidebarMobile } = useSidebar();

  // ────────────────────────────────────────────────────────────
  // Resizable split — chat ↔ right panel (Word/Excel/preview).
  // Ratio is the LEFT pane's width as a percentage. Persisted in
  // localStorage across sessions, defaults to 50/50, clamped to
  // [25, 75] on drag, resets to 50 on double-click.
  // ────────────────────────────────────────────────────────────
  const SPLIT_STORAGE_KEY = 'siraGPT-split-ratio';
  const [splitRatio, setSplitRatio] = React.useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = React.useState(false);
  const splitContainerRef = React.useRef<HTMLDivElement | null>(null);

  // Hydrate from localStorage after mount to avoid SSR/CSR mismatch.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
      const n = raw ? parseFloat(raw) : NaN;
      if (!Number.isNaN(n) && n >= 25 && n <= 75) setSplitRatio(n);
    } catch { /* storage unavailable — stick with default */ }
  }, []);

  const startSplitDrag = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSplit(true);
    const onMove = (ev: MouseEvent) => {
      const el = splitContainerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(25, Math.min(75, pct));
      setSplitRatio(clamped);
    };
    const onUp = () => {
      setIsDraggingSplit(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRatioRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const resetSplitRatio = React.useCallback(() => {
    setSplitRatio(50);
    try { localStorage.setItem(SPLIT_STORAGE_KEY, '50'); } catch { /* ignore */ }
  }, []);

  // Mirror ratio into a ref so the mouseup handler closure (set up
  // at drag-start) can read the latest value without restarting the
  // effect on every ratio change.
  const splitRatioRef = React.useRef(splitRatio);
  React.useEffect(() => { splitRatioRef.current = splitRatio; }, [splitRatio]);

  // Auto-collapse sidebar when a big-canvas tool activates. Intent:
  // give Word/Excel/image/video the horizontal real estate they need.
  // We only react to OFF → ON transitions; reverting all flags back
  // to OFF does NOT auto-reopen (spec: "user decides when to reopen").
  // Skip on mobile — the sidebar there is already an overlay that
  // doesn't squeeze the main content.
  React.useEffect(() => {
    if (isSidebarMobile) return;
    if (isWordConnectorActive || isExcelConnectorActive || isImageGenerationActive || isVideoGenerationActive) {
      setSidebarOpen(false);
    }
  }, [isWordConnectorActive, isExcelConnectorActive, isImageGenerationActive, isVideoGenerationActive, isSidebarMobile, setSidebarOpen]);

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg) return;

    const isBusy = isLoading || isGeneratingImage || isGeneratingVideo || isGeneratingWebDev || isStreaming || isProcessingGmail || isProcessingGoogleServices || isProcessingSpotify || isGeneratingWord || isGeneratingExcel || isRewriting;

    if (isBusy) {
      // Park the message — we'll drain the queue once the busy flags
      // flip back to idle (see the useEffect watching busy state).
      pendingMsgQueueRef.current.push({ msg, files: [...uploadedFiles] });
      setInput("");
      setUploadedFiles([]);
      const now = Date.now();
      queueBurstTimestampsRef.current = queueBurstTimestampsRef.current.filter(t => now - t < 5000);
      queueBurstTimestampsRef.current.push(now);
      // Only surface the toast when the user actually triggers the
      // "3+ in 5s" burst condition — otherwise a single queued message
      // during a long stream would nag them.
      if (queueBurstTimestampsRef.current.length >= 3 && pendingMsgQueueRef.current.length === 1) {
        toast.info("Procesando tus mensajes…", { duration: 2500 });
      }
      return;
    }

    // Handle rewrite request
    if (selectedWordText) {
      setIsRewriting(true);
      setInput("");

      // Get full document context
      const fullDocumentContent = wordConnectorRef.current?.getHTML() || '';

      // Construct prompt with full context but focus on selected text
      const rewritePrompt = `You are editing a specific part of a document.
      
CONTEXT:
The user has selected the following text to edit:
"${selectedWordText}"

FULL DOCUMENT CONTEXT (for reference only):
${fullDocumentContent}

USER COMMAND:
${msg}

INSTRUCTIONS:
1. Apply the user's command ONLY to the selected text.
2. Use the full document context to ensure consistency in tone, style, and content, but DO NOT rewrite the whole document.
3. Return ONLY the rewritten version of the selected text.
4. Do NOT include any explanations, quotes, or conversational filler.
5. If the user asks to "summarize", summarize only the selected text.
6. If the user asks to "fix grammar", fix it only for the selected text.

REWRITTEN TEXT:`;

      let accumulatedContent = '';
      const streamId = crypto.randomUUID();

      await apiClient.generateWordStream(
        {
          provider: selectProvider,
          model: selectedModel,
          prompt: msg,
          chatId: currentChat?.id,
          streamId,
          mode: 'rewrite',
          selectedText: selectedWordText,
        },
        (chunk) => {
          accumulatedContent += chunk;
        },
        () => {
          // Stream is complete, clean up the response and replace the text
          if (wordConnectorRef.current) {
            // Remove surrounding quotes if AI added them
            let cleanedContent = accumulatedContent.trim();
            if ((cleanedContent.startsWith('"') && cleanedContent.endsWith('"')) ||
              (cleanedContent.startsWith("'") && cleanedContent.endsWith("'"))) {
              cleanedContent = cleanedContent.slice(1, -1);
            }
            wordConnectorRef.current.replaceSelection(cleanedContent);
          }
          setIsRewriting(false);
          setSelectedWordText(null); // Clear the selection display
          toast.success('Text has been rewritten.');
        },
        (error) => {
          console.error('Rewrite error:', error);
          toast.error(error.message || 'Failed to rewrite text.');
          setIsRewriting(false);
        }
      );
      return; // Stop further execution
    }
    const filesToSend = [...uploadedFiles];
    setInput("");
    setUploadedFiles([]);

    let isNewChat = !currentChat;
    let chatToUpdate = currentChat;
    let duumychatId = `temp-chat-${Date.now()}`

    // Handle Word Connector - generate content directly to editor
    if (isWordConnectorActive) {
      try {
        setIsGeneratingWord(true);

        // Create or get chat (IMPORTANT: do NOT trigger generic AI generation here)
        let activeChat = currentChat;
        if (!activeChat) {
          const newChat = await createNewChat('text', msg, undefined, {
            skipInitialProcessing: true,
            isWordConnectorChat: true
          });
          activeChat = (newChat as any) || currentChat;

          if (activeChat?.id) {
            await selectChat(activeChat.id);
          }
        }

        // Add user message to chat for display
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat?.id || '',
          role: 'USER' as const,
          content: msg,
          timestamp: new Date().toISOString(),
          files: filesToSend,
        };

        // Update chat with user message
        setCurrentChat(prevChat => {
          if (!prevChat && activeChat) {
            return { ...activeChat, messages: [userMessage] };
          }
          if (prevChat) {
            const updatedMessages = [...(prevChat.messages || []), userMessage];
            return { ...prevChat, messages: updatedMessages };
          }
          return prevChat;
        });

        const streamId = crypto.randomUUID();
        let accumulatedContent = '';

        // Stream AI response for Word document using dedicated endpoint
        await apiClient.generateWordStream(
          {
            provider: selectProvider,
            model: selectedModel,
            prompt: msg,
            chatId: activeChat?.id,
            files: filesToSend?.map(f => f.id) || [],
            streamId,
          },
          (chunk) => {
            accumulatedContent += chunk;
            // Update Word editor in real-time
            if (wordConnectorRef.current) {
              wordConnectorRef.current.updateContent(accumulatedContent);
            }
          },
          () => {
            setIsGeneratingWord(false);
            toast.success('Documento generado exitosamente');
            // Final update
            if (wordConnectorRef.current && accumulatedContent) {
              wordConnectorRef.current.updateContent(accumulatedContent);
            }
            // Add AI response message to chat for display
            const aiMessage = {
              id: `msg-ai-${Date.now()}`,
              chatId: activeChat?.id || '',
              role: 'ASSISTANT' as const,
              content: 'Documento generado en el editor de Word',
              timestamp: new Date().toISOString(),
            };
            setCurrentChat(prevChat => {
              if (!prevChat) return prevChat;
              const updatedMessages = [...(prevChat.messages || []), aiMessage];
              return { ...prevChat, messages: updatedMessages };
            });
            // Refresh chat to get updated messages from database
            if (activeChat?.id) {
              setTimeout(() => {
                selectChat(activeChat.id);
              }, 500);
            }
          },
          (error) => {
            setIsGeneratingWord(false);
            console.error('Word generation error:', error);
            toast.error(error.message || 'Error al generar documento');
          }
        );
      } catch (error: any) {
        setIsGeneratingWord(false);
        console.error('Word Connector error:', error);
        toast.error(error?.message || 'Error al generar documento');
      }
      return; // IMPORTANT: Stop execution here - no other API calls should be made
    }

    // Handle Excel Connector - generate content directly into the Syncfusion Spreadsheet
    if (isExcelConnectorActive) {
      try {
        setIsGeneratingExcel(true);

        // Create or get chat (IMPORTANT: do NOT trigger generic AI generation here)
        let activeChat = currentChat;
        if (!activeChat) {
          const newChat = await createNewChat('text', msg, undefined, {
            skipInitialProcessing: true,
            isExcelConnectorChat: true
          } as any);
          activeChat = (newChat as any) || currentChat;

          if (activeChat?.id) {
            await selectChat(activeChat.id);
          }
        }

        // Add user message to chat for display
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat?.id || '',
          role: 'USER' as const,
          content: msg,
          timestamp: new Date().toISOString(),
          files: filesToSend,
        };

        setCurrentChat(prevChat => {
          if (!prevChat && activeChat) {
            return { ...activeChat, messages: [userMessage] };
          }
          if (prevChat) {
            const updatedMessages = [...(prevChat.messages || []), userMessage];
            return { ...prevChat, messages: updatedMessages };
          }
          return prevChat;
        });

        // Generate Excel using simple POST request (no streaming)
        const response = await apiClient.generateExcel({
          provider: selectProvider,
          model: selectedModel,
          prompt: msg,
          chatId: activeChat?.id,
          files: filesToSend?.map(f => f.id) || [],
        });

        setIsGeneratingExcel(false);

        try {
          const parsedResponse = response.data;
          console.log('Parsed Excel response:', parsedResponse);

          // Check if response has both workbook and actions (chart support)
          let workbookData = parsedResponse;
          let chartActions = [];

          if (parsedResponse.workbook && parsedResponse.actions) {
            // New format with chart actions
            workbookData = parsedResponse.workbook;
            chartActions = parsedResponse.actions;
            console.log('Chart actions detected:', chartActions);
          }

          if (excelConnectorRef.current) {
            excelConnectorRef.current.loadWorkbook(workbookData, chartActions);

            if (chartActions.length > 0) {
              toast.success(`Excel generated with ${chartActions.length} chart(s)!`);
            } else {
              toast.success('Excel generated successfully');
            }
          } else {
            console.error('Excel connector ref is not available');
            toast.error('Excel connector not ready');
          }

          // Add AI response message to chat for display
          const aiMessage = {
            id: `msg-ai-${Date.now()}`,
            chatId: activeChat?.id || '',
            role: 'ASSISTANT' as const,
            content: 'Excel generated in spreadsheet editor',
            timestamp: new Date().toISOString(),
          };
          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            const updatedMessages = [...(prevChat.messages || []), aiMessage];
            return { ...prevChat, messages: updatedMessages };
          });

          if (activeChat?.id) {
            setTimeout(() => {
              selectChat(activeChat.id);
            }, 500);
          }
        } catch (e) {
          console.error('Failed to process Excel response', e);
          toast.error('Failed to load generated Excel');
        }
      } catch (error: any) {
        setIsGeneratingExcel(false);
        console.error('Excel Connector error:', error);
        toast.error(error?.message || 'Failed to generate Excel');
      }

      return;
    }

    // Handle thesis type early - before adding optimistic messages
    // This ensures proper chat creation and message sync for new thesis chats
    if (chatType === 'thesis' && isNewChat) {
      try {
        const topics = msg.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length >= 1) {
          // For new thesis chats, create directly without optimistic messages
          // createNewChat will handle chat creation and message setup properly
          const newChat = await createNewChat('thesis', msg);
          if (newChat?.id) {
            // Select the newly created chat to show messages properly
            setTimeout(async () => {
              await selectChat(newChat.id);
            }, 300);
          }
        } else {
          toast.error('Please provide at least 1 research topic for thesis generation.\n\nExample: "Artificial Intelligence in Healthcare" or "AI in Healthcare, ML Ethics"');
        }
        return;
      } catch (error: any) {
        console.error('Thesis generation error:', error);
        toast.error(error?.message || 'Thesis generation failed. Please try again.');
        return;
      }
    }

    // Optimistically add the user message to the UI immediately.
    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'USER' as const,
      content: msg,
      timestamp: new Date().toISOString(),
      files: filesToSend,
    };
    const assistantPlaceholder = {
      id: `msg-assistant-processing-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'ASSISTANT' as const,
      content: '',
      timestamp: new Date().toISOString(),
    };

    if (isNewChat) {
      const tempChat = {
        id: userMessage.chatId,
        title: msg.substring(0, 30),
        messages: [userMessage, assistantPlaceholder],
        customGptId: null,
        customGpt: null,
      };
      setCurrentChat(tempChat as any);
      chatToUpdate = tempChat as any;
    } else {
      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), userMessage];
        return { ...prevChat, messages: updatedMessages };
      });
    }


    try {
      // After optimistic update, run the logic.
      // For existing chats, we pass `true` to `addMessage` to skip re-adding the user message.
      // For new chats, `createNewChat` will handle creating the chat, and the context will replace the temp chat.

      if (isWebSearchActive) {
        await handleWebSearch(msg);
        return;
      }
      if (isGmailActive) {
        await handleGmailCommand(msg);
        return;
      }
      if (isGoogleCalendarActive || isGoogleDriveActive) {
        await handleGoogleServicesCommand(msg);
        return;
      }
      if (isSpotifyActive) {
        await handleSpotifyCommand(msg);
        return;
      }
      if (isImageGenerationActive || chatType === 'image') {
        await handleImageGeneration(msg, filesToSend.map(f => f.id));
        return;
      }
      if (isVideoGenerationActive || chatType === 'video') {
        await handleVideoGeneration(msg);
        return;
      }
      if (chatType === 'thesis' && !isNewChat) {
        // Handle thesis generation for existing chats only
        // New thesis chats are handled earlier in the function
        const topics = msg.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length >= 1) {
          await addThesisMessage(topics);
        } else {
          // Remove the optimistic messages since validation failed
          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            return {
              ...prevChat,
              messages: prevChat.messages.filter(msg =>
                msg.id !== userMessage.id && msg.id !== assistantPlaceholder.id
              )
            };
          });
          toast.error('Please provide at least 1 research topic for thesis generation.\n\nExample: "Artificial Intelligence in Healthcare" or "AI in Healthcare, Machine Learning Ethics"');
        }
        return;
      }
      if (isComputerUseActive || chatType === 'computer-use') {
        // Handle Computer Use with the hook
        let chatId = currentChat?.id;

        // If no current chat, create a new one first
        if (!chatId) {
          console.log('Creating new chat for computer use...');
          const newChat = await createNewChat('computer-use', msg);
          chatId = newChat.id;

          // Immediately select the new chat to show it in UI and wait for it to load
          console.log('Selecting newly created chat:', chatId);
          await selectChat(chatId ?? '');

          // Wait longer for UI to fully update and messages to load
          await new Promise(resolve => setTimeout(resolve, 1200));

          // Force a second selection to ensure it's properly displayed
          setTimeout(() => {
            selectChat(chatId!);
          }, 100);
        }

        console.log('Starting computer use with:', {
          task: msg,
          chatId: chatId,
          userId: user?.id
        });

        // Set up listener for extraction completion
        const handleExtractionComplete = (event: Event) => {
          const customEvent = event as CustomEvent;
          console.log('Computer Use extraction completed, refreshing chat...', customEvent.detail);

          // Force refresh the chat to show new extracted data
          if (chatId) {
            console.log('Refreshing chat with ID:', chatId);

            // Multiple refresh attempts to ensure UI updates
            selectChat(chatId);

            setTimeout(() => {
              selectChat(chatId);
            }, 500);

            setTimeout(() => {
              selectChat(chatId);
              window.dispatchEvent(new CustomEvent('chat-messages-refresh', {
                detail: { chatId: chatId }
              }));
            }, 1000);

            // Show success message
            toast.success('Computer Use completed - Chat updated!');
          }
        };

        window.addEventListener('computer-use-extraction-complete', handleExtractionComplete);

        await startComputerUse(msg, chatId, user?.id);

        // Clean up listener
        setTimeout(() => {
          window.removeEventListener('computer-use-extraction-complete', handleExtractionComplete);
        }, 30000); // Remove after 30 seconds

        // Add reasoning steps to chat as they come in
        if (computerUseReasoning.length > 0) {
          const reasoningMessage = {
            id: `msg-computer-use-${Date.now()}`,
            chatId: currentChat?.id || duumychatId,
            role: 'ASSISTANT' as const,
            content: 'Computer Use Agent is working...',
            timestamp: new Date().toISOString(),
            metadata: JSON.stringify({
              type: 'computer_use_reasoning',
              reasoning: computerUseReasoning
            })
          };

          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            const updatedMessages = [...(prevChat.messages || []), reasoningMessage];
            return { ...prevChat, messages: updatedMessages };
          });
        }
        return;
      }



      // Mark that we started handling the message so Stop button can appear immediately
      setIsSending(true);
      // Classify intent (can be aborted via Stop button)
      const intentController = new AbortController();
      intentAbortControllerRef.current = intentController;

      const intent = await aiService.classifyIntent(
        msg,
        chatToUpdate?.messages || [],
        intentController.signal
      );

      // Clear controller once done
      intentAbortControllerRef.current = null;

      if (intent === 'image' || intent === 'video') {
        const hasNonImageFiles = filesToSend.some(
          (file) => !file.type?.startsWith('image/')
        );
        if (hasNonImageFiles) {
          toast.error("Only image files are allowed for this task.");
          // Note: The optimistic message is already shown. This is a trade-off.
          // A more complex implementation could remove the optimistic message on validation failure.
          return;
        }
      }

      // Check for vector PPT keywords (Gamma-style)
      const msgLower = msg.toLowerCase();
      const isVectorPPT = (
        msgLower.includes('vector ppt') ||
        msgLower.includes('vector presentation') ||
        msgLower.includes('gamma style') ||
        msgLower.includes('gamma-style') ||
        msgLower.includes('gamma ppt') ||
        (msgLower.includes('ppt') && msgLower.includes('no images')) ||
        (msgLower.includes('ppt') && msgLower.includes('no photos')) ||
        (msgLower.includes('presentation') && msgLower.includes('vector'))
      );

      switch (intent) {
        case 'image':
          await handleImageGeneration(msg, filesToSend.map(f => f.id));
          break;
        case 'ppt':
          // Check if user wants vector PPT
          if (isVectorPPT) {
            await handleVectorPPTGeneration(msg, filesToSend);
          } else {
            await handlePPTGeneration(msg, filesToSend);
          }
          break;
        case 'webdev':
          await handleWebDevGeneration(msg);
          break;
        case 'figma':
          // Figma flowchart generation is handled in addMessage function
          if (isNewChat) {
            await createNewChat('text', msg, filesToSend);
          } else {
            await addMessage(msg, filesToSend, chatToUpdate, true);
          }
          break;
        default:
          if (isNewChat) {
            await createNewChat('text', msg, filesToSend);
          } else {
            await addMessage(msg, filesToSend, chatToUpdate, true); // skipUserMessage is true
          }
          break;
      }
    } catch (err: any) {
      console.error('Send error', err);
      console.log('Error details:', {
        message: err?.message,
        status: err?.status,
        statusCode: err?.statusCode,
        errorData: err?.errorData,
        fullError: err
      });

      // If intent / send was aborted by user (via Stop), just exit silently.
      if (err?.name === 'AbortError') {
        return;
      }

      const message = (err && (err.message || '')) as string;
      const status = err?.status || err?.statusCode || (err?.response && err.response.status);
      const errorData = err?.errorData;

      console.log('Checking error conditions:', {
        status,
        message,
        errorData,
        is429: status === 429,
        isMonthlyLimit: isMonthlyLimitError(message),
        isErrorDataMonthlyLimit: errorData && isMonthlyLimitError(errorData.error || '')
      });

      // Check for monthly API limit exceeded error - handle specific API format
      if (status === 429 ||
        isMonthlyLimitError(message) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        console.log('API limit error detected, opening upgrade modal', { status, message, errorData });

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);

        // Extract usage information if available
        let usageInfo = '';
        if (errorData && errorData.usage) {
          const { current, limit } = errorData.usage;
          usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
        }

        // Show proper error message in UI
        const errorMessage = {
          id: `msg-error-${Date.now()}`,
          chatId: chatToUpdate?.id || 'unknown',
          role: 'ASSISTANT' as const,
          content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
          timestamp: new Date().toISOString(),
          error: 'Monthly API limit exceeded',
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), errorMessage];
          return { ...prevChat, messages: updatedMessages };
        });

        toast.error(`Monthly API limit exceeded.${usageInfo ? ' ' + usageInfo : ''} Please upgrade to continue.`);
        return;
      }

      // For other errors, show generic error message
      toast.error(err?.message || 'An error occurred. Please try again.');

      // Add error message to chat
      const errorMessage = {
        id: `msg-error-${Date.now()}`,
        chatId: chatToUpdate?.id || 'unknown',
        role: 'ASSISTANT' as const,
        content: '',
        timestamp: new Date().toISOString(),
        error: err.message || 'An error occurred. Please try again.',
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), errorMessage];
        return { ...prevChat, messages: updatedMessages };
      });
    } finally {
      setIsSending(false);
      intentAbortControllerRef.current = null;
    }
  }
  const handleGmailCommand = async (prompt: string) => {
    setIsProcessingGmail(true);

    try {
      if (!currentChat) {
        // Create a new Gmail chat like other modes
        await createNewChat('gmail', prompt);
      } else {
        // // Add user message immediately
        // const userMessage = {
        //   id: `msg-user-${Date.now()}`,
        //   chatId: currentChat.id,
        //   role: 'USER' as const,
        //   content: prompt,
        //   timestamp: new Date().toISOString(),
        // };

        // Add processing placeholder
        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: '[PROCESSING_GMAIL]',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        // Process with AI like regular chat
        const payload = {
          prompt,
          chatId: currentChat?.id,
          model: selectedModel,
          type: 'gmail',
        };

        const response = await apiClient.generateGmailResponse(payload);

        if (response.requiresConnection) {
          // Handle Gmail connection required
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_GMAIL]') {
                return {
                  ...msg,
                  content: `📧 **Gmail Connection Required**

I can help you with Gmail tasks like:
- Reading your emails
- Sending emails  
- Searching for specific emails
- Managing your inbox

But first, you need to connect your Gmail account securely using the button below.`,
                  metadata: JSON.stringify({
                    type: 'gmail_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Gmail connection required');
        } else {
          // Refresh chat to show AI response
          await selectChat(currentChat?.id ?? "");
          toast.success('Gmail response generated!');
        }
      }
    } catch (error: any) {
      console.error('Gmail error:', error);
      const errorMessage = error.message || 'Gmail request failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        // Update placeholder with limit error
        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_GMAIL]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Gmail features.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      // Update placeholder with error
      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_GMAIL]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingGmail(false);
    }
  }

  const handleGoogleServicesCommand = async (prompt: string) => {
    setIsProcessingGoogleServices(true);

    try {
      if (!currentChat) {
        await createNewChat('google_services', prompt);
      } else {
        const isCalendarAction = prompt.toLowerCase().includes('event') || prompt.toLowerCase().includes('meeting') || prompt.toLowerCase().includes('calendar');
        const loadingContent = isCalendarAction ? '[PROCESSING_CALENDAR_ACTION]' : '[PROCESSING_DRIVE_ACTION]';

        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: loadingContent,
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        const payload = {
          prompt,
          chatId: currentChat?.id,
          model: selectedModel,
        };

        const response = await apiClient.generateGoogleServicesResponse(payload);

        if (response.requiresConnection) {
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
                return {
                  ...msg,
                  content: `**Google Services Connection Required**

I can help you with Google Calendar and Drive tasks. But first, you need to connect your Google account securely.`,
                  metadata: JSON.stringify({
                    type: 'google_services_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Google Services connection required');
        } else {
          await selectChat(currentChat?.id ?? "");
          toast.success('Google Services response generated!');
        }
      }
    } catch (error: any) {
      console.error('Google Services error:', error);
      const errorMessage = error.message || 'Google Services request failed. Please try again.';

      // Check for monthly API limit exceeded error
      if (isMonthlyLimitError(errorMessage)) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Google Services.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingGoogleServices(false);
    }
  }

  const handleImageGeneration = async (prompt: string, files?: string[]) => {
    setIsGeneratingImage(true)
    try {
      if (!currentChat) {
        // If no chat is active, create a new one with type 'image'
        const newChat = await createNewChat('image', prompt, files);

      } else {
        // User message already shown in handleSend, just add AI placeholder
        const assistantPlaceholder = {
          id: `msg-assistant-generating-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: '[GENERATING_IMAGE]',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
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
    } catch (error: any) {
      console.error('Image generation failed:', error)
      const errorMessage = error.message || 'Image generation failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[GENERATING_IMAGE]') {
              return {
                ...msg,
                content: 'Monthly API limit exceeded. Please upgrade your plan to continue using image generation.',
                error: 'Monthly API limit exceeded'
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        // Find the placeholder and update it with the error
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[GENERATING_IMAGE]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
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
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');
        return;
      }

      toast.error(errorMessage)
    } finally {
      setIsGeneratingVideo(false)
      // Don't auto-reset - user must manually remove
    }
  }

  const handleWebDevGeneration = async (prompt: string) => {
    // Use dedicated webdev streaming API endpoint
    const filesToSend = [...uploadedFiles];
    setUploadedFiles([]); // Clear UI immediately

    try {
      let newChat = currentChat;
      let aiMessagePlaceholder: any;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "New Web Dev Chat",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: filesToSend?.length ? filesToSend.map(f => f.id) : undefined,
        };
        // Add placeholder for AI response
        aiMessagePlaceholder = {
          id: `msg-ai-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'ASSISTANT' as const,
          content: '',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage, aiMessagePlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      else {
        // Add user message to UI immediately


        // Add placeholder for AI response
        aiMessagePlaceholder = {
          id: `msg-ai-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'ASSISTANT' as const,
          content: '',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), aiMessagePlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      // Call dedicated webdev streaming endpoint
      const streamId = crypto.randomUUID();
      const payload = {
        prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: filesToSend?.map(f => f.id) || [],
        streamId: streamId
      };

      // Use streaming webdev API
      await apiClient.generateWebDevStream(
        payload,
        (chunk) => {
          // Update AI message content with streaming chunks
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: msg.content + chunk };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          });
        },
        () => {
          // Stream completed
          console.log('Web development generation completed');
        },
        (error) => {
          console.error('Web development generation error:', error);
          toast.error(error.message || 'Web development generation failed');
        }
      );

    } catch (error: any) {
      console.error('Web development generation error:', error);
      toast.error(error.message || 'Web development generation failed');
    }
  };

  const handlePPTGeneration = async (prompt: string, files?: any[]) => {
    setIsGeneratingPPT(true);
    try {
      let newChat = currentChat;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "New Chat",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        // Only add user message for new chat (existing chat already has it from handleSend)
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: files,
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }
      // If currentChat exists, user message already added in handleSend
      const assistantPlaceholder = {
        id: `msg-assistant-generating-ppt-${Date.now()}`,
        chatId: newChat?.id || '',
        role: 'ASSISTANT' as const,
        content: '[GENERATING_PPT]',
        timestamp: new Date().toISOString(),
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
        return { ...prevChat, messages: updatedMessages };
      });

      const payload = {
        prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: files?.map(f => f.id)
      };

      const response = await apiClient.generatePPT(payload);
      await selectChat(newChat?.id ?? "");

      toast.success(`Presentation created with ${response.slideCount} slides!`);
    } catch (error: any) {
      console.error('PPT generation failed:', error);
      toast.error(error.message || 'PPT generation failed');
    } finally {
      setIsGeneratingPPT(false);
    }
  };

  // Vector PPT Generation (Gamma-style, pure vector graphics)
  const handleVectorPPTGeneration = async (prompt: string, files?: any[]) => {
    setIsGeneratingPPT(true);
    try {
      let newChat = currentChat;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "New Vector PPT",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: files,
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      const assistantPlaceholder = {
        id: `msg-assistant-generating-vector-ppt-${Date.now()}`,
        chatId: newChat?.id || '',
        role: 'ASSISTANT' as const,
        content: '[GENERATING_VECTOR_PPT]',
        timestamp: new Date().toISOString(),
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
        return { ...prevChat, messages: updatedMessages };
      });

      const payload = {
        prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: files?.map(f => f.id) || []
      };

      const response = await apiClient.generateVectorPPT(payload);

      await selectChat(newChat?.id ?? "");

      toast.success(`🎨 Vector presentation created with ${response.slideCount} slides! (${response.colorScheme} theme)`);
    } catch (error: any) {
      console.error('Vector PPT generation failed:', error);
      toast.error(error.message || 'Vector PPT generation failed');
    } finally {
      setIsGeneratingPPT(false);
    }
  };

  // Keep a ref to the latest handleSend so the queue-drain effect below
  // can invoke the closure that sees current state — React declarations
  // would otherwise freeze the version from initial render.
  React.useEffect(() => { handleSendRef.current = handleSend; });

  // Drain queued messages when the pipeline goes idle. Each drain
  // re-populates the composer from the queue and fires handleSend on the
  // next tick so React has a chance to commit the setInput/setFiles
  // updates before the send guard reads them.
  React.useEffect(() => {
    const isBusy = isLoading || isGeneratingImage || isGeneratingVideo || isGeneratingWebDev || isStreaming || isProcessingGmail || isProcessingGoogleServices || isProcessingSpotify || isGeneratingWord || isGeneratingExcel || isRewriting;
    if (isBusy) return;
    if (pendingMsgQueueRef.current.length === 0) return;
    const next = pendingMsgQueueRef.current.shift();
    if (!next) return;
    setInput(next.msg);
    setUploadedFiles(next.files || []);
    const t = setTimeout(() => { handleSendRef.current(); }, 0);
    return () => clearTimeout(t);
  }, [isLoading, isGeneratingImage, isGeneratingVideo, isGeneratingWebDev, isStreaming, isProcessingGmail, isProcessingGoogleServices, isProcessingSpotify, isGeneratingWord, isGeneratingExcel, isRewriting]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Prevent Enter key from adding new line when not holding Shift
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const removeFile = (index: number) => {
    setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
  }

  const isInitial = !currentChat && !showAudioPanel && !isWordConnectorActive && !isExcelConnectorActive

  // Any active tool/connector/thesis mode? Used to conditionally render
  // the "tool pills" row below the input — if nothing is active, we
  // hide the entire bar so the composer stays a clean pill.
  const hasActiveTools = (
    isWebSearchActive || isImageGenerationActive || isVideoGenerationActive || isComputerUseActive
    || isGmailActive || isGoogleCalendarActive || isGoogleDriveActive
    || isSpotifyActive || isWordConnectorActive || isExcelConnectorActive
    || chatType === 'thesis'
  );

  // Shared props bundle for <ActiveToolsDisplay /> — the component is
  // now rendered in a different spot (below the input instead of above)
  // but the prop contract is identical, so centralising it avoids
  // drift between the two composer instances (initial vs in-chat).
  const activeToolsProps = {
    isWebSearchActive, setIsWebSearchActive,
    isImageGenerationActive, setIsImageGenerationActive,
    isVideoGenerationActive, setIsVideoGenerationActive,
    isComputerUseActive, setIsComputerUseActive,
    computerUseStatus,
    isGmailActive, setIsGmailActive,
    isGoogleCalendarActive, setIsGoogleCalendarActive,
    isGoogleDriveActive, setIsGoogleDriveActive,
    isSpotifyActive, setIsSpotifyActive,
    isWordConnectorActive, setIsWordConnectorActive,
    isExcelConnectorActive, setIsExcelConnectorActive,
    chatType, setChatType,
    handleComputerUseToggle, handleGmailToggle, handleGoogleCalendarToggle,
    handleGoogleDriveToggle, handleSpotifyToggle, handleWordConnectorToggle,
    handleExcelConnectorToggle,
  };

  const handleWebSearch = async (searchQuery: string) => {
    if (!searchQuery) {
      toast.error('Please enter a search query');
      return;
    }

    let activeChat = currentChat;
    const isNewChat = !activeChat;

    if (!activeChat) {
      try {
        const response = await apiClient.createChat({
          title: `🔍 Web Search: ${searchQuery.substring(0, 30)}`,
          model: selectedModel,
        });
        activeChat = response.chat;
        await selectChat(activeChat?.id ?? "");
        if (!activeChat?.id) {
          toast.error('Failed to create chat for web search');
          return;
        }
      } catch (error) {
        toast.error('Failed to create chat for web search');
        console.error("Error creating chat for web search:", error);
        return;
      }
    }

    setIsWebSearching(true);

    try {
      // Only add user message for new chat (existing chat already has it from handleSend)
      if (isNewChat) {
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER' as const,
          content: `🔍 Web Search: ${searchQuery}`,
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      // Add a placeholder AI message for the search results
      const aiMessage = {
        id: `msg-ai-${Date.now() + 1}`, // Ensure unique ID
        chatId: activeChat.id,
        role: 'ASSISTANT' as const,
        content: 'Searching the web...', // Initial loading state
        timestamp: new Date().toISOString(),
      };

      // Add AI message to chat
      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), aiMessage];
        return { ...prevChat, messages: updatedMessages };
      });

      let accumulatedContent = '';

      await webSearchService.searchStream(
        searchQuery,
        activeChat.id,
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
        (data: any) => {
          // Final update to ensure UI reflects completion
          if (data.dbMessage) {
            setCurrentChat(prev => {
              if (!prev) return prev;
              // Replace the temporary message with the final one from the database
              const newMessages = prev.messages.map(msg =>
                msg.id === aiMessage.id ? data.dbMessage : msg
              );
              return { ...prev, messages: newMessages };
            });
          } else if (!data.results || data.results.length === 0) {
            // If there are no results, the content is already updated to "No Results Found"
            // We just need to stop the loading state.
          } else {
            // Fallback to re-fetch if dbMessage is not available but results are
            selectChat(activeChat.id || '');
          }
          setIsWebSearching(false);
          toast.success('Web search completed');
        },
        (error: Error) => {
          console.error('Web search failed:', error);

          const errorMessage = error.message || 'Web search failed';

          // Check for monthly API limit exceeded error
          if (isMonthlyLimitError(errorMessage)) {

            // Show upgrade modal for API limit errors
            setSubscribeOpen(true);
            toast.error('Monthly API limit exceeded. Please upgrade to continue.');

            // Update the AI message to reflect the limit error
            setCurrentChat(prev => {
              if (!prev) return prev;
              const newMessages = prev.messages.map(msg =>
                msg.id === aiMessage.id
                  ? { ...msg, content: `Monthly API limit exceeded. Please upgrade your plan to continue using web search.` }
                  : msg
              );
              return { ...prev, messages: newMessages };
            });
            setIsWebSearching(false);
            return;
          }

          toast.error(errorMessage);
          setIsWebSearching(false);
          // If search fails, update the AI message to reflect the error
          setCurrentChat(prev => {
            if (!prev) return prev;
            const newMessages = prev.messages.map(msg =>
              msg.id === aiMessage.id
                ? { ...msg, content: `Web search failed: ${errorMessage}` }
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
      className="flex h-screen flex-col relative overflow-hidden"
      onDragEnter={handleDragIn}
      onDragOver={handleDrag}
      onDragLeave={handleDragOut}
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

      {/* Floating "reopen sidebar" button — appears when the sidebar
          is collapsed (we auto-collapse on Word/Excel/image/video to
          reclaim horizontal real estate). Pinned to the viewport edge
          so the user can always pop the sidebar back with one click. */}
      {!sidebarOpen && !isSidebarMobile && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          title="Mostrar sidebar"
          aria-label="Mostrar sidebar"
          className="fixed left-0 top-1/2 -translate-y-1/2 z-50 flex h-10 w-6 items-center justify-center rounded-r-md border border-l-0 border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-all duration-200 hover:w-8 hover:bg-background hover:text-foreground"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      <div ref={splitContainerRef} className="flex flex-1 overflow-hidden w-full relative">
        {/* Left pane — chat. When a right-side tool panel is active we
            share width with it via the resizable divider; otherwise we
            take the full container. min-w-0 so children can shrink. */}
        <div
          style={(documentPreviewUrl || isWordConnectorActive || isExcelConnectorActive)
            ? { width: `${splitRatio}%`, transition: isDraggingSplit ? undefined : 'width 300ms ease' }
            : undefined}
          className={`relative flex flex-col h-full min-w-0 overflow-hidden ${(documentPreviewUrl || isWordConnectorActive || isExcelConnectorActive) ? 'shrink-0' : 'w-full'}`}
        >
          {/* Header */}
          <div className="absolute top-0 left-0 right-0 z-10 px-4 pt-4  backdrop-blur-sm ">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="md:hidden">
                  <Sidebar>
                    <AppSidebar />
                  </Sidebar>
                  <SidebarTrigger>
                    <Menu className="h-6 w-6" />
                  </SidebarTrigger>
                </div>
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
              <div className="flex items-center gap-0.5">
                {/* Complete Chat Share Button - only show if there's a chat with messages */}
                {currentChat?.id && currentChat?.messages && currentChat.messages.length > 0 && !showAudioPanel && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCompleteShare}
                    title="Share complete chat"
                    className="h-11 w-11 rounded-full"
                  >
                    <Share className="h-5 w-5" />
                  </Button>
                )}
                <WhatsAppButton message="Hi 👋, I'm interested in SiraGPT. Could you share more about its features and pricing?" />
                <ThemeToggle />
                {/* Plan / Upgrade button — unified icon-system:
                    Free plan → text CTA "Subir de plan"
                    Paid + near-quota → text CTA "Upgrade Now" + warning border
                    Paid + healthy → compact icon button with Sparkles glyph
                    The 💰 emoji was replaced with Lucide Sparkles (same stroke
                    family as the rest of the header icons). */}
                {(() => {
                  const usageRatio =
                    currentUserInfo?.apiUsage && currentUserInfo?.monthlyLimit
                      ? currentUserInfo.apiUsage / currentUserInfo.monthlyLimit
                      : 0
                  const isFree = currentPlan === 'FREE'
                  const showTextCta = isFree || usageRatio >= 0.7
                  const warn = !isFree && usageRatio >= 0.9
                  const caution = !isFree && usageRatio >= 0.7 && usageRatio < 0.9
                  return (
                    <Button
                      variant={showTextCta ? 'outline' : 'ghost'}
                      size={showTextCta ? 'sm' : 'icon'}
                      onClick={() => setSubscribeOpen(true)}
                      aria-label={isFree ? 'Subir de plan' : 'Gestionar plan'}
                      title={isFree ? 'Subir de plan' : 'Gestionar plan'}
                      className={cn(
                        !showTextCta && 'h-11 w-11 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]',
                        showTextCta && 'h-11 gap-1.5 rounded-full px-3 text-[13px] font-semibold',
                        warn && 'border-red-500/70 text-red-600 hover:bg-red-500/10 hover:text-red-600',
                        caution && 'border-amber-500/70 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600',
                        'transition-all duration-200',
                      )}
                    >
                      {showTextCta ? (
                        <>
                          <PremiumCardIcon className="h-[18px] w-[24px] shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />
                          <span>{isFree ? 'Subir de plan' : 'Upgrade Now'}</span>
                        </>
                      ) : (
                        <PremiumCardIcon className="h-[18px] w-[24px] drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />
                      )}
                    </Button>
                  )
                })()}
                <UpgradeModal
                  open={subscribeOpen}
                  onOpenChange={setSubscribeOpen}
                  user={currentUserInfo || user}
                />
                {/* Share conversation modal (ChatGPT-style) */}
                <Dialog open={shareModalOpen} onOpenChange={setShareModalOpen}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>Share conversation</DialogTitle>
                      <DialogDescription>
                        Anyone with this link can view the conversation. You can copy or open it to share wherever you like.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="mt-4 space-y-3">
                      <div className="text-xs font-medium text-muted-foreground">Shareable link</div>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={shareUrl || ''}
                          className="flex-1 px-2 py-1 rounded-md border bg-muted text-xs overflow-hidden text-ellipsis"
                          onFocus={(e) => e.target.select()}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (!shareUrl) return;
                            navigator.clipboard.writeText(shareUrl);
                            toast.success('Link copied to clipboard');
                          }}
                        >
                          Copy link
                        </Button>
                      </div>
                    </div>
                    <DialogFooter className="mt-4 flex justify-end gap-2">
                      {shareUrl && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (shareUrl && typeof window !== 'undefined') {
                              window.open(shareUrl, '_blank', 'noopener,noreferrer');
                            }
                          }}
                        >
                          Open link
                        </Button>
                      )}
                      <DialogClose asChild>
                        <Button size="sm" variant="default">
                          Done
                        </Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>




          {isInitial ? (
            <div className="canvas-ambient flex flex-1 items-center justify-center p-4">
              <div className="w-full max-w-[860px]">
                <div className="space-y-3">
                  {/*
                    Composer — premium production UI.
                    In DARK mode, inherits `composer-surface` from globals.css
                    which applies the design-spec tokens (#0B1118 bg, #1C2430
                    border, 0 12px 32px rgba(0,0,0,0.28) shadow) with a
                    violet-tinted focus ring. In LIGHT mode it uses the Tailwind
                    classes below (soft white surface with layered shadow).
                    The focus state is the ONLY place accent color appears —
                    idle never glows.
                  */}
                  {/*
                    Composer — pill-styled card. rounded-3xl gives the
                    single-row state a pill feel AND looks balanced when
                    chips/tools push it taller. All ingestion artifacts
                    (file chips, selected-text, active tools) live INSIDE
                    the same surface so the user sees one coherent input
                    area, not stacked floating elements above the bar.
                  */}
                  <div
                    className={cn(
                      "composer-surface group/composer relative overflow-hidden rounded-3xl",
                      "bg-background",
                      "ring-1 ring-black/[0.08] dark:ring-0",
                      "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_-4px_rgba(15,23,42,0.06)] dark:shadow-none",
                      "transition-[border-color,background-color,box-shadow,ring-color] duration-200 ease-out",
                      "hover:ring-black/[0.12] dark:hover:ring-0",
                      "focus-within:ring-2 focus-within:ring-foreground/[0.14] dark:focus-within:ring-0",
                    )}
                  >
                    {/* Chips zone — rendered ABOVE the input row, INSIDE
                        the same rounded card. Hidden entirely when there
                        are no files / selected text / active tools, so
                        empty composer stays as a clean single line. */}
                    <ActiveOptionsDisplay
                      uploadedFiles={uploadedFiles}
                      removeFile={removeFile}
                      uploadProgress={uploadProgress}
                      retryUpload={retryUpload}
                    />
                    <SelectedTextDisplay text={selectedWordText} onClear={() => setSelectedWordText(null)} />
                    {/* Tool pills used to live ABOVE the input; moved to
                        a secondary row BELOW the input (see after the
                        TooltipProvider) so the top surface is dedicated
                        to drag-and-drop of files / audio / images. */}
                    <TooltipProvider>
                      <div className="flex items-center gap-2 pl-2 pr-2 py-1.5">
                        {/* LEFT — Plus / attach + tool selector */}
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
                          isComputerUseActive={isComputerUseActive}
                          setIsComputerUseActive={setIsComputerUseActive}
                          computerUseStatus={computerUseStatus}
                          isGmailActive={isGmailActive}
                          setIsGmailActive={setIsGmailActive}
                          isGoogleCalendarActive={isGoogleCalendarActive}
                          setIsGoogleCalendarActive={setIsGoogleCalendarActive}
                          isGoogleDriveActive={isGoogleDriveActive}
                          setIsGoogleDriveActive={setIsGoogleDriveActive}
                          isSpotifyActive={isSpotifyActive}
                          setIsSpotifyActive={setIsSpotifyActive}
                          isWordConnectorActive={isWordConnectorActive}
                          setIsWordConnectorActive={setIsWordConnectorActive}
                          isExcelConnectorActive={isExcelConnectorActive}
                          setIsExcelConnectorActive={setIsExcelConnectorActive}
                          setShowAudioPanel={setShowAudioPanel}
                          handleComputerUseToggle={handleComputerUseToggle}
                          handleGmailToggle={handleGmailToggle}
                          handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                          handleGoogleDriveToggle={handleGoogleDriveToggle}
                          handleSpotifyToggle={handleSpotifyToggle}
                          handleWordConnectorToggle={handleWordConnectorToggle}
                          handleExcelConnectorToggle={handleExcelConnectorToggle}
                          closeAllToolsAndConnectors={closeAllToolsAndConnectors}
                          setAudioTab={setAudioTab}
                          handleAndUploadFiles={handleAndUploadFiles}
                          isUploading={isUploading}
                          isWebSearching={isWebSearching}
                          isLoading={isLoading}
                          isGeneratingImage={isGeneratingImage}
                          isGeneratingVideo={isGeneratingVideo}
                          isGeneratingPPT={isGeneratingPPT}
                          isProcessingGmail={isProcessingGmail}
                        />

                        {/* CENTER — single-line textarea, expands vertically up to 200px */}
                        <Textarea
                          ref={textareaRef}
                          value={input}
                          onChange={handleTextareaChange}
                          onKeyDown={handleKeyDown}
                          onKeyPress={handleKeyPress}
                          onPaste={handleClipboardPaste}
                          onCompositionStart={() => { isComposingRef.current = true }}
                          onCompositionEnd={() => { isComposingRef.current = false }}
                          placeholder={
                            isImageGenerationActive
                              ? tComposer("placeholderImage")
                              : isVideoGenerationActive
                                ? tComposer("placeholderVideo")
                                : isWebSearchActive
                                  ? tComposer("placeholderWebSearch")
                                  : isGmailActive
                                    ? tComposer("placeholderGmail")
                                    : (isGoogleCalendarActive || isGoogleDriveActive)
                                      ? tComposer("placeholderGoogle")
                                      : isSpotifyActive
                                        ? tComposer("placeholderSpotify")
                                        : isWordConnectorActive
                                          ? tComposer("placeholderWord")
                                          : tComposer("placeholderDefault")
                          }
                          className={cn(
                            "min-h-[24px] min-w-0 flex-1 resize-none border-none bg-transparent",
                            "py-1.5 px-1",
                            "text-[15px] leading-[1.45] tracking-[-0.01em] text-foreground",
                            "placeholder:text-muted-foreground/65 placeholder:font-normal",
                            "dark:placeholder:text-[hsl(var(--text-tertiary))]",
                            "outline-none ring-0 focus:outline-none focus:ring-0",
                            "rounded-none transition-colors duration-200",
                          )}
                          style={{
                            minHeight: "24px",
                            maxHeight: "200px",
                            overflowY: "auto",
                            overflowX: "hidden",
                            wordWrap: "break-word",
                            border: "none",
                            outline: "none",
                            boxShadow: "none",
                          }}
                          rows={1}
                          disabled={isLoading || isGeneratingImage || isGeneratingVideo || isWebSearching}
                        />

                        {/* RIGHT — VoiceControls (mic, ghost) + primary action.
                            Primary swaps glyph based on state — never a
                            decorative button. */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          {!(isLoading || isStreaming || pendingStop || isSending) && (
                            <VoiceControls
                              onTranscription={(text) => setInput(prev => prev + (prev ? ' ' : '') + text)}
                              className="flex items-center"
                            />
                          )}

                          {!(isLoading || isStreaming || pendingStop || isSending) && (() => {
                            const hasText = input.trim().length > 0
                            const busy = isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices
                            // When the user has typed → Send. When idle → open Voice Studio.
                            const action = hasText
                              ? handleSend
                              : () => { setShowAudioPanel(true); setAudioTab('stt') }
                            const label = hasText ? 'Enviar (⏎)' : 'Modo de voz'
                            const Icon = hasText ? ArrowUp : AudioLines
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    onClick={action}
                                    disabled={hasText && (isLoading || busy || isGeneratingWord || isGeneratingExcel || isRewriting)}
                                    size="icon"
                                    aria-label={label}
                                    title={label}
                                    className={cn(
                                      "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                      "bg-foreground text-background",
                                      "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                      "hover:bg-foreground/90 hover:shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_10px_-3px_rgba(0,0,0,0.18)]",
                                      "active:scale-[0.96]",
                                      "disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100",
                                    )}
                                  >
                                    {busy ? (
                                      <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={2.25} />
                                    ) : (
                                      <Icon className="h-[16px] w-[16px]" strokeWidth={hasText ? 2.25 : 1.75} />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p>{label}</p>
                                </TooltipContent>
                              </Tooltip>
                            )
                          })()}

                          {(isLoading || isStreaming || pendingStop || isSending) && (
                            <Button
                              onClick={() => {
                                if (intentAbortControllerRef.current) {
                                  intentAbortControllerRef.current.abort();
                                  intentAbortControllerRef.current = null;
                                }
                                stopStreaming();
                                setIsSending(false);
                              }}
                              size="icon"
                              aria-label="Detener generación"
                              title="Detener"
                              disabled={pendingStop}
                              className={cn(
                                "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                "bg-foreground text-background",
                                "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                "hover:bg-foreground/90 active:scale-[0.96]",
                                "disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100",
                              )}
                            >
                              {pendingStop ? (
                                <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={2.25} />
                              ) : (
                                <Square className="h-[12px] w-[12px] fill-current" strokeWidth={0} />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </TooltipProvider>

                    {/* Secondary row — active tool / connector pills.
                        Only rendered when something is active, so the
                        composer stays a clean pill in the idle state. */}
                    {hasActiveTools && (
                      <div className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-2 py-1">
                        <ActiveToolsDisplay {...activeToolsProps} />
                      </div>
                    )}
                  </div>

                  {/* <p className="text-center text-xs text-muted-foreground">
                {isWebSearchActive
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
                // Voice Studio responsive view
                <div className="flex flex-1 flex-col lg:flex-row">
                  {/* Navigation - Mobile: horizontal tabs, Desktop: vertical sidebar */}
                  <div className="lg:w-56 lg:border-r border-border/40 p-3 sm:p-4">
                    <div className="text-sm font-medium mb-2 hidden lg:block">Voice Studio</div>

                    {/* Mobile: Horizontal scrollable tabs */}
                    <div className="flex lg:hidden overflow-x-auto gap-2 pb-2">
                      <Button
                        variant={audioTab === 'tts' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('tts')}
                      >
                        <Square className="h-4 w-4 mr-1" />
                        <span className="text-xs">TTS</span>
                      </Button>
                      <Button
                        variant={audioTab === 'stt' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('stt')}
                      >
                        <Mic className="h-4 w-4 mr-1" />
                        <span className="text-xs">STT</span>
                      </Button>
                      <Button
                        variant={audioTab === 'music' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('music')}
                      >
                        <Music className="h-4 w-4 mr-1" />
                        <span className="text-xs">Music</span>
                      </Button>

                    </div>

                    {/* Desktop: Vertical buttons */}
                    <div className="hidden lg:block space-y-2">
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

                  {/* Content area */}
                  <div className="flex-1 p-3 sm:p-4">
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
                  <ScrollArea className="flex-1 px-0 md:px-4 pb-2 mb-6" ref={scrollAreaRef}>
                    <div className="space-y-2 max-w-3xl mx-auto w-full px-4 md:px-0 pt-24 pb-40">
                      {(() => {
                        const messages = currentChat?.messages || [];
                        const stableMessages = isStreaming ? messages.slice(0, -1) : messages;
                        const streamingMessage = isStreaming ? messages[messages.length - 1] : null;

                        return (
                          <>

                            {stableMessages.map((message) => (
                              <MessageComponent
                                key={message.id}
                                message={message}
                                user={user}
                                onRegenerate={regenerateMessage}
                                updateMessageInChat={editAndRegenerate}
                                isStreaming={false}
                                onToggleSplitView={handleToggleSplitView}
                                onDocumentPreview={handleDocumentPreview}
                              />
                            ))}
                            {streamingMessage && (
                              <MessageComponent
                                key={streamingMessage.id}
                                message={streamingMessage}
                                user={user}
                                onRegenerate={regenerateMessage}
                                updateMessageInChat={editAndRegenerate}
                                isStreaming={true}
                                onToggleSplitView={handleToggleSplitView}
                                onDocumentPreview={handleDocumentPreview}
                              />
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </ScrollArea>

                  {/* Input & Actions */}

                  <div className="absolute bottom-0 left-0 right-0 z-10 px-2 md:px-4 py-4">
                    <div className="max-w-3xl mx-auto space-y-2 bg-background">
                      {/* Input Area */}

                      {/* Same composer as the initial state — chips
                          render INSIDE the same rounded card. */}
                      <div
                        className={cn(
                          "composer-surface group/composer relative overflow-hidden rounded-3xl",
                          "bg-background",
                          "ring-1 ring-black/[0.08] dark:ring-0",
                          "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_-4px_rgba(15,23,42,0.06)] dark:shadow-none",
                          "transition-[border-color,background-color,box-shadow,ring-color] duration-200 ease-out",
                          "hover:ring-black/[0.12] dark:hover:ring-0",
                          "focus-within:ring-2 focus-within:ring-foreground/[0.14] dark:focus-within:ring-0",
                        )}
                      >
                        <ActiveOptionsDisplay
                          uploadedFiles={uploadedFiles}
                          removeFile={removeFile}
                          uploadProgress={uploadProgress}
                          retryUpload={retryUpload}
                        />
                        <SelectedTextDisplay text={selectedWordText} onClear={() => setSelectedWordText(null)} />
                        {/* Tool pills relocated below the input — see
                            the matching block after the TooltipProvider
                            closes. Top surface is reserved for drop-zone. */}
                        <TooltipProvider>
                          <div className="flex items-center gap-2 pl-2 pr-2 py-1.5">
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
                              isComputerUseActive={isComputerUseActive}
                              setIsComputerUseActive={setIsComputerUseActive}
                              computerUseStatus={computerUseStatus}
                              isGmailActive={isGmailActive}
                              setIsGmailActive={setIsGmailActive}
                              isGoogleCalendarActive={isGoogleCalendarActive}
                              setIsGoogleCalendarActive={setIsGoogleCalendarActive}
                              isGoogleDriveActive={isGoogleDriveActive}
                              setIsGoogleDriveActive={setIsGoogleDriveActive}
                              isSpotifyActive={isSpotifyActive}
                              setIsSpotifyActive={setIsSpotifyActive}
                              isWordConnectorActive={isWordConnectorActive}
                              setIsWordConnectorActive={setIsWordConnectorActive}
                              isExcelConnectorActive={isExcelConnectorActive}
                              setIsExcelConnectorActive={setIsExcelConnectorActive}
                              setShowAudioPanel={setShowAudioPanel}
                              handleComputerUseToggle={handleComputerUseToggle}
                              handleGmailToggle={handleGmailToggle}
                              handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                              handleGoogleDriveToggle={handleGoogleDriveToggle}
                              handleSpotifyToggle={handleSpotifyToggle}
                              handleWordConnectorToggle={handleWordConnectorToggle}
                              handleExcelConnectorToggle={handleExcelConnectorToggle}
                              closeAllToolsAndConnectors={closeAllToolsAndConnectors}
                              setAudioTab={setAudioTab}
                              handleAndUploadFiles={handleAndUploadFiles}
                              isUploading={isUploading}
                              isWebSearching={isWebSearching}
                              isLoading={isLoading}
                              isGeneratingImage={isGeneratingImage}
                              isGeneratingVideo={isGeneratingVideo}
                              isGeneratingPPT={isGeneratingPPT}
                              isProcessingGmail={isProcessingGmail}
                            />
                            <Textarea
                              ref={textareaRef}
                              value={input}
                              onChange={handleTextareaChange}
                              onKeyDown={handleKeyDown}
                              onKeyPress={handleKeyPress}
                              onPaste={handleClipboardPaste}
                              placeholder={
                                isImageGenerationActive
                                  ? tComposer("placeholderImage")
                                  : isVideoGenerationActive
                                    ? tComposer("placeholderVideo")
                                    : isWebSearchActive
                                      ? tComposer("placeholderWebSearch")
                                      : isGmailActive
                                        ? tComposer("placeholderGmail")
                                        : (isGoogleCalendarActive || isGoogleDriveActive)
                                          ? tComposer("placeholderGoogle")
                                          : isSpotifyActive
                                            ? tComposer("placeholderSpotify")
                                            : isWordConnectorActive
                                              ? tComposer("placeholderWord")
                                              : tComposer("placeholderDefault")
                              }
                              className={cn(
                                "textarea-scrollbar min-h-[24px] min-w-0 flex-1 resize-none border-none bg-transparent",
                                "py-1.5 px-1",
                                "text-[15px] leading-[1.45] tracking-[-0.01em] text-foreground",
                                "placeholder:text-muted-foreground/65 placeholder:font-normal",
                                "dark:placeholder:text-[hsl(var(--text-tertiary))]",
                                "outline-none ring-0 focus:outline-none focus:ring-0",
                                "rounded-none transition-colors duration-200",
                              )}
                              style={{
                                minHeight: "24px",
                                maxHeight: "200px",
                                overflowY: "auto",
                                overflowX: "hidden",
                                wordWrap: "break-word",
                                border: "none",
                                outline: "none",
                                boxShadow: "none",
                              }}
                              rows={1}
                              disabled={isLoading || isGeneratingVideo || isGeneratingWord || isGeneratingExcel || isWebSearching}
                            />
                            <div className="flex shrink-0 items-center gap-1.5">
                              {!(isLoading || isStreaming || pendingStop || isSending) && (
                                <VoiceControls
                                  onTranscription={(text) => setInput(prev => prev + (prev ? ' ' : '') + text)}
                                  className="flex items-center"
                                />
                              )}

                              {!(isLoading || isStreaming || pendingStop || isSending) && (() => {
                                const hasText = input.trim().length > 0
                                const busy = isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices
                                const action = hasText
                                  ? handleSend
                                  : () => { setShowAudioPanel(true); setAudioTab('stt') }
                                const label = hasText ? 'Enviar (⏎)' : 'Modo de voz'
                                const Icon = hasText ? ArrowUp : AudioLines
                                return (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        onClick={action}
                                        disabled={hasText && (isLoading || busy || isGeneratingWord || isGeneratingExcel || isRewriting)}
                                        size="icon"
                                        aria-label={label}
                                        title={label}
                                        className={cn(
                                          "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                          "bg-foreground text-background",
                                          "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                          "hover:bg-foreground/90 hover:shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_10px_-3px_rgba(0,0,0,0.18)]",
                                          "active:scale-[0.96]",
                                          "disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100",
                                        )}
                                      >
                                        {busy ? (
                                          <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={2.25} />
                                        ) : (
                                          <Icon className="h-[16px] w-[16px]" strokeWidth={hasText ? 2.25 : 1.75} />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <p>{label}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )
                              })()}

                              {(isLoading || isStreaming || pendingStop || isSending) && (
                                <Button
                                  onClick={() => {
                                    if (intentAbortControllerRef.current) {
                                      intentAbortControllerRef.current.abort();
                                      intentAbortControllerRef.current = null;
                                    }
                                    stopStreaming();
                                    setIsSending(false);
                                  }}
                                  size="icon"
                                  aria-label="Detener generación"
                                  title="Detener"
                                  disabled={pendingStop}
                                  className={cn(
                                    "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                    "bg-foreground text-background",
                                    "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                    "hover:bg-foreground/90 active:scale-[0.96]",
                                    "disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100",
                                  )}
                                >
                                  {pendingStop ? (
                                    <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={2.25} />
                                  ) : (
                                    <Square className="h-[12px] w-[12px] fill-current" strokeWidth={0} />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        </TooltipProvider>

                        {/* Secondary row — active tool / connector pills.
                            Mirrors the in-chat composer above so both
                            states feel identical to the user. */}
                        {hasActiveTools && (
                          <div className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 px-2 py-1">
                            <ActiveToolsDisplay {...activeToolsProps} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )
          }
        </div>
        {/* Split view alternatives that take the remaining space
            without the resizable divider (code preview / computer use).
            These already use w-full internally. */}
        {splitViewContent && (
          <div className="w-full border-l border-border/40">
            <CodePreview {...splitViewContent} onClose={() => setSplitViewContent(null)} />
          </div>
        )}
        {isComputerUseActive && (
          <div className="w-full border-l border-border/40">
            <ComputerUseInterface
              screenshot={computerUseScreenshot}
              status={computerUseStatus}
              onClose={() => setIsComputerUseActive(false)}
            />
          </div>
        )}

        {/* Resizable right panel — Word / Excel / Document preview.
            Rendered together with the 6px col-resize divider so the
            user can drag the split from 25% to 75% and double-click
            to reset to 50/50. Persisted in localStorage. */}
        {(isWordConnectorActive || isExcelConnectorActive || documentPreviewUrl) && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar paneles"
              onMouseDown={startSplitDrag}
              onDoubleClick={resetSplitRatio}
              className={cn(
                'group relative flex w-[6px] cursor-col-resize select-none items-center justify-center shrink-0 transition-colors',
                isDraggingSplit ? 'bg-border/60' : 'bg-transparent hover:bg-border/60',
              )}
            >
              {/* Three dots centered — visual hint for the grab handle.
                  pointer-events-none so the whole 6px strip stays the
                  mouse-hit target. */}
              <div className="pointer-events-none flex flex-col gap-[3px]">
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
              </div>
            </div>
            <div
              style={{ width: `${100 - splitRatio}%`, transition: isDraggingSplit ? undefined : 'width 300ms ease' }}
              className="h-full min-w-0 overflow-hidden shrink-0"
            >
              {documentPreviewUrl && (
                <DocumentPreview
                  url={documentPreviewUrl}
                  onClose={() => setDocumentPreviewUrl(null)}
                />
              )}
              {isWordConnectorActive && (
                <WordConnector
                  ref={wordConnectorRef}
                  onClose={() => setIsWordConnectorActive(false)}
                  selectedModel={selectedModel}
                  selectProvider={selectProvider}
                  isGeneratingExternal={isGeneratingWord}
                  isFullPage={true}
                  onTextSelected={(text) => {
                    setSelectedWordText(text);
                  }}
                />
              )}
              {isExcelConnectorActive && (
                <ExcelConnector
                  ref={excelConnectorRef}
                  onClose={() => setIsExcelConnectorActive(false)}
                  isGeneratingExternal={isGeneratingExcel}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div >
  )
}
