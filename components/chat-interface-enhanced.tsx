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
  Monitor
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useChat } from "@/lib/chat-context-integrated"
import { useAuth } from "@/lib/auth-context-integrated"
import { ThemeToggle } from "@/components/theme-toggle"
import WhatsAppButton from "@/components/WhatsAppButton"
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
import { Switch } from "@/components/ui/switch"
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
} from "@/components/ui/sidebar"
import { DocumentPreview } from "./document-preview"
import { CodePreview } from "./code-preview"
import SpotifyResults from "./spotify-results"
import ComputerUseInterface from "./ComputerUseInterface"
import ComputerUseReasoning from "./ComputerUseReasoning"
import ExtractedDataDownload from "./ExtractedDataDownload"
import { useComputerUse } from "@/hooks/use-computer-use"


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
  isGoogleCalendarActive,
  isGoogleDriveActive,
  isSpotifyActive,
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
      //setIsWebSearchActive(false);
      setIsImageGenerationActive(false);


      setChatType('video');
    } else {
      setChatType('text');
    }

    setIsVideoGenerationActive(newState);
  };


  const isDisabled = isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
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

        {/* Computer Use Agent */}
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
        </DropdownMenuItem>      </DropdownMenuContent>
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
  uploadProgress
}: {
  uploadedFiles: any[];
  removeFile: (index: number) => void;
  uploadProgress: { [key: string]: number };
}) => {
  if (uploadedFiles.length === 0) return null;

  return (
    <div className="p-3  bg-background">
      <div className="flex flex-wrap items-center gap-2 max-h-40 overflow-y-auto">
        {/* Uploaded Files iterate karein */}
        {uploadedFiles.map((file, index) => {
          const isImage = file.type?.startsWith('image/');
          const fileId = file.id || file.tempId;
          const progress = uploadProgress[fileId] || 0;
          const isUploading = progress > 0 && progress < 100;
          const isComplete = progress === 100 || file.url;
          const imageSizeClass = uploadedFiles.length > 1 ? 'h-20 w-20' : 'h-32 w-32';

          return (
            <div
              key={index}
              className={`
                relative // 'X' button ki absolute positioning ke liye
                border border-gray-200
                rounded-xl
                text-sm
                ${isImage ? `${imageSizeClass} p-0` : 'flex items-center gap-2 px-2 py-1'} // Conditional sizing aur padding
              `}
            >
              {isImage ? (
                <>
                  {/* Image files ke liye: badi image aur uske upar progress/X button */}
                  <div className="h-full w-full rounded-md overflow-hidden bg-gray-100 flex items-center justify-center relative">
                    {file.preview ? (
                      <img
                        src={file.preview}
                        alt={file.name}
                        className="h-full w-full object-cover"
                      />
                    ) : file.url ? (
                      <img
                        src={`${process.env.NEXT_PUBLIC_IMAGE_URL || ""}${file.url}`}
                        alt={file.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      getFileIcon(file)
                    )}

                    {/* Upload Progress Overlay */}
                    {isUploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="h-6 w-6 animate-spin text-white mx-auto mb-1" />
                          <span className="text-white text-xs font-medium">{Math.round(progress)}%</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {!isUploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-1 right-1 h-6 w-6 p-0 bg-white rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                      onClick={() => removeFile(index)}
                    >
                      <X className="h-4 w-4 text-gray-600" />
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {/* Non-image files ke liye: purana structure (icon, naam, progress aur 'X' button) */}
                  {getFileIcon(file)}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate font-medium text-[13px]">
                      {file.name}
                    </span>
                    {isUploading && (
                      <div className="flex items-center gap-1 mt-1">
                        <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{Math.round(progress)}%</span>
                      </div>
                    )}
                  </div>
                  {!isUploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 hover:bg-gray-200 rounded-full ml-1"
                      onClick={() => removeFile(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
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
  setChatType,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle
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
  setChatType: (type: any) => void;

  handleComputerUseToggle: () => void;
  handleGmailToggle: () => void;
  handleGoogleCalendarToggle: () => void;
  handleGoogleDriveToggle: () => void;
  handleSpotifyToggle: () => void;
}) => {
  const activeConnectors = [
    isGmailActive && { id: 'gmail', icon: <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" /> },
    isGoogleCalendarActive && { id: 'calendar', icon: <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" /> },
    isGoogleDriveActive && { id: 'drive', icon: <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" /> },
    isSpotifyActive && { id: 'spotify', icon: <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" /> },
  ].filter(Boolean) as { id: string; icon: JSX.Element }[];

  const hasConnectors = activeConnectors.length > 0;
  const hasOtherTools = isImageGenerationActive || isVideoGenerationActive || isWebSearchActive || isComputerUseActive;

  if (!hasConnectors && !hasOtherTools) return null;

  const handleCloseAllConnectors = () => {
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
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
          <div className={`h-2 w-2 rounded-full ml-1 ${
            computerUseStatus === 'running' ? 'bg-green-500 animate-pulse' :
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
        <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md bg-background hover:bg-muted transition">
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
      <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md bg-background hover:bg-muted transition">
        {selectedModelData && <IconProvider name={selectedModelData.icon} className="h-4 w-4" />}
        <span className="text-sm font-medium">{selectedModelData?.displayName || selectedModel}</span>
        <div className="flex items-center gap-1">
          {(
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
                {/* <span className="text-xs text-muted-foreground">{model.name}</span> */}
              </div>
              {(
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
  return (
    <SidebarProvider>
      <ChatInterfaceContent />
    </SidebarProvider>
  )
}

function ChatInterfaceContent() {
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
  const [isGeneratingPPT, setIsGeneratingPPT] = React.useState(false)
  const [isGeneratingWebDev, setIsGeneratingWebDev] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);
  const prevChatIdRef = React.useRef<string | undefined>();

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
    setIsGmailActive(newState);
    if (newState) {
      setIsWebSearchActive(false);
      setIsGoogleCalendarActive(false);
      setIsGoogleDriveActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
    }
  };

  const handleGoogleCalendarToggle = () => {
    const newState = !isGoogleCalendarActive;
    setChatType('text');
    setIsGoogleCalendarActive(newState);
    if (newState) {
      setIsWebSearchActive(false);
      setIsGmailActive(false);
      setIsGoogleDriveActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
    }
  };

  const handleGoogleDriveToggle = () => {
    const newState = !isGoogleDriveActive;
    setChatType('text');
    setIsGoogleDriveActive(newState);
    if (newState) {
      setIsWebSearchActive(false);
      setIsGmailActive(false);
      setIsGoogleCalendarActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
    }
  };

  const handleSpotifyToggle = () => {
    const newState = !isSpotifyActive;
    setChatType('text');
    setIsSpotifyActive(newState);
    if (newState) {
      setIsWebSearchActive(false);
      setIsGmailActive(false);
      setIsGoogleCalendarActive(false);
      setIsGoogleDriveActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
      setIsComputerUseActive(false);
    }
  };

  const handleComputerUseToggle = () => {
    const newState = !isComputerUseActive;
    
    if (newState) {
      // Disable other modes
      setIsWebSearchActive(false);
      setIsGmailActive(false);
      setIsGoogleCalendarActive(false);
      setIsGoogleDriveActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
      setIsSpotifyActive(false);
      setChatType('computer-use');
    } else {
      setChatType('text');
    }
    
    setIsComputerUseActive(newState);
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

  const handleToggleSplitView = (content: any) => {
    setDocumentPreviewUrl(null)
    setSplitViewContent(content)
  }

  const handleDocumentPreview = (url: string) => {
    setSplitViewContent(null)
    setDocumentPreviewUrl(url);
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
      setIsWebSearchActive(false);
      setIsGmailActive(false);
      setIsGoogleCalendarActive(false);
      setIsGoogleDriveActive(false);
      setIsImageGenerationActive(false);
      setIsVideoGenerationActive(false);
      setIsComputerUseActive(false);
      setChatType('text'); // Always default to text when switching chats
      
      // Clear Computer Use reasoning when switching chats
      clearReasoning();
    }
    prevChatIdRef.current = currentChat?.id;
  }, [currentChat?.id, clearReasoning]); // Only trigger when chat ID changes

  React.useEffect(() => {
    setShowAudioPanel(false);
    setDocumentPreviewUrl(null)
    setSplitViewContent(null)
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

  // Listen for Computer Use extraction completion to refresh chat
  React.useEffect(() => {
    const handleExtractionComplete = (event: CustomEvent) => {
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

  // File upload logic with instant preview and progress
  const handleAndUploadFiles = async (files: FileList) => {
    if (files.length === 0) return;

    let filesToUpload = Array.from(files);

    if (chatType === 'video' || chatType === 'image') {
      const imageFiles = filesToUpload.filter(file => file.type.startsWith('image/'));

      if (imageFiles.length === 0) {
        toast.error("Only image files are allowed in image/video mode.");
        return;
      }

      filesToUpload = imageFiles;
    }

    // Create temporary file objects with previews immediately
    const tempFiles = await Promise.all(
      filesToUpload.map(async (file) => {
        const tempId = `temp-${Date.now()}-${Math.random()}`;
        let preview = null;

        // Create preview for images
        if (file.type.startsWith('image/')) {
          preview = URL.createObjectURL(file);
        }

        return {
          tempId,
          name: file.name,
          type: file.type,
          size: file.size,
          preview,
          file, // Keep reference to original file
        };
      })
    );

    // Add temp files to UI immediately
    setUploadedFiles([...uploadedFiles, ...tempFiles]);

    // Initialize progress for each file
    const initialProgress: { [key: string]: number } = {};
    tempFiles.forEach(tf => {
      initialProgress[tf.tempId] = 0;
    });
    setUploadProgress(prev => ({ ...prev, ...initialProgress }));

    setIsUploading(true);

    try {
      // Simulate upload progress (since we don't have real progress from API)
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          const newProgress = { ...prev };
          tempFiles.forEach(tf => {
            if (newProgress[tf.tempId] < 90) {
              newProgress[tf.tempId] = Math.min(90, newProgress[tf.tempId] + 10);
            }
          });
          return newProgress;
        });
      }, 200);

      // Create a new FileList-like object from the actual File objects
      const dataTransfer = new DataTransfer();
      filesToUpload.forEach(file => {
        dataTransfer.items.add(file);
      });

      // Actual upload with proper FileList
      const response = await apiClient.uploadFiles(dataTransfer.files);

      clearInterval(progressInterval);

      if (response.files) {
        // Update progress to 100%
        const finalProgress: { [key: string]: number } = {};
        tempFiles.forEach(tf => {
          finalProgress[tf.tempId] = 100;
        });
        setUploadProgress(prev => ({ ...prev, ...finalProgress }));

        // Replace temp files with actual uploaded files
        const withoutTemp = uploadedFiles.filter((f: any) => !tempFiles.find(tf => tf.tempId === f.tempId));
        setUploadedFiles([...withoutTemp, ...response.files]);

        // Clean up previews
        tempFiles.forEach(tf => {
          if (tf.preview) {
            URL.revokeObjectURL(tf.preview);
          }
        });

        // Clear progress after a short delay
        setTimeout(() => {
          setUploadProgress(prev => {
            const newProgress = { ...prev };
            tempFiles.forEach(tf => {
              delete newProgress[tf.tempId];
            });
            return newProgress;
          });
        }, 500);

        toast.success(`${response.files.length} file(s) uploaded successfully`);
      } else {
        toast.error('File upload failed');
        // Remove temp files on failure
        const filteredFiles = uploadedFiles.filter((f: any) => !tempFiles.find(tf => tf.tempId === f.tempId));
        setUploadedFiles(filteredFiles);
      }
    } catch (error) {
      console.error('File upload failed:', error);
      toast.error('File upload failed');

      // Remove temp files on error
      const filteredFiles = uploadedFiles.filter((f: any) => !tempFiles.find(tf => tf.tempId === f.tempId));
      setUploadedFiles(filteredFiles);

      // Clean up previews
      tempFiles.forEach(tf => {
        if (tf.preview) {
          URL.revokeObjectURL(tf.preview);
        }
      });
    } finally {
      setIsUploading(false);
    }
  };

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
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleAndUploadFiles(e.dataTransfer.files);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isGeneratingWebDev || isStreaming || isProcessingGmail || isProcessingGoogleServices) return;

    const msg = input.trim();
    const filesToSend = [...uploadedFiles];
    setInput("");
    setUploadedFiles([]);

    let isNewChat = !currentChat;
    let chatToUpdate = currentChat;
    let duumychatId = `temp-chat-${Date.now()}`

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
          await selectChat(chatId);
          
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
        const handleExtractionComplete = (event: any) => {
          console.log('Computer Use extraction completed, refreshing chat...', event.detail);
          
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

      const intent = await aiService.classifyIntent(msg, chatToUpdate?.messages || []);

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
      const message = (err && (err.message || '')) as string;
      const status = err?.status || err?.statusCode || (err?.response && err.response.status);
      if (status === 429 || message.toLowerCase().includes('monthly') || message.toLowerCase().includes('limit')) {
        setSubscribeOpen(true);
        toast.error('You reached your free quota — subscribe to continue.');
        return;
      }
      toast.error(err?.message || 'Send failed');

      // Add error message to chat
      const errorMessage = {
        id: `msg-error-${Date.now()}`,
        chatId: chatToUpdate?.id || 'unknown',
        role: 'ASSISTANT' as const,
        content: '',
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

  const isInitial = !currentChat && !showAudioPanel

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

      <div className="flex flex-1 overflow-hidden">
        <div className={`relative flex flex-col h-full ${documentPreviewUrl ? 'w-1/2' : 'w-full'}`}>
          {/* Header */}
          <div className="absolute top-0 left-0 right-0 z-10 p-4">
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
              <div className="flex items-center gap-2">
                <WhatsAppButton message="Hi 👋, I'm interested in SiraGPT. Could you share more about its features and pricing?" />
                <ThemeToggle />
                <Button variant="ghost" size={currentPlan === 'FREE' ? 'sm' : 'icon'} onClick={() => setSubscribeOpen(true)} className={currentPlan !== 'FREE' ? 'h-9 w-9' : ''}>
                  {currentPlan === 'FREE' ? 'Upgrade Plan' : <span role="img" aria-label="Manage Plan" className="text-xl">💰</span>}
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
                        uploadProgress={uploadProgress}
                      />
                      <Textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => {
                          setInput(e.target.value);
                        }}
                        onKeyDown={handleKeyDown}
                        onKeyPress={handleKeyPress}
                        placeholder={
                          isImageGenerationActive
                            ? "Describe the image you want to create..."
                            : isVideoGenerationActive
                              ? "Describe the video you want to create..."
                              : isWebSearchActive
                                ? "Enter your search query..."
                                : isGmailActive
                                  ? "Enter Gmail command (e.g., 'send email to john@example.com about meeting')..."
                                  : (isGoogleCalendarActive || isGoogleDriveActive)
                                    ? "Enter Google command (e.g., 'show my meetings for tomorrow')..."
                                    : isSpotifyActive
                                      ? "Enter Spotify command (e.g., 'search for a song by Queen')..."
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
                          isComputerUseActive={isComputerUseActive}
                          setIsComputerUseActive={setIsComputerUseActive}
                          computerUseStatus={computerUseStatus}
                          isGmailActive={isGmailActive}
                          isGoogleCalendarActive={isGoogleCalendarActive}
                          isGoogleDriveActive={isGoogleDriveActive}
                          isSpotifyActive={isSpotifyActive}
                          setShowAudioPanel={setShowAudioPanel}

                          handleComputerUseToggle={handleComputerUseToggle}
                          handleGmailToggle={handleGmailToggle}
                          handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                          handleGoogleDriveToggle={handleGoogleDriveToggle}
                          handleSpotifyToggle={handleSpotifyToggle}
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
                        <ActiveToolsDisplay
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
                          setChatType={setChatType}

                          handleComputerUseToggle={handleComputerUseToggle}
                          handleGmailToggle={handleGmailToggle}
                          handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                          handleGoogleDriveToggle={handleGoogleDriveToggle}
                          handleSpotifyToggle={handleSpotifyToggle}
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
                              disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices || isProcessingSpotify}
                              size="sm"
                              className="h-8 w-8 p-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
                            >
                              {isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices ? (
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
                    <div className="space-y-6 max-w-3xl mx-auto w-full px-4 md:px-0 pt-24 pb-40">
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
                                onRegenerate={regenerateLastMessage}
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
                                onRegenerate={regenerateLastMessage}
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

                      {/* <div className="relative rounded-3xl border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden"> */}
                      <div className="border-wrapper">
                        <div className="relative  rounded-3xl .card border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden ">
                          <ActiveOptionsDisplay
                            uploadedFiles={uploadedFiles}
                            removeFile={removeFile}
                            uploadProgress={uploadProgress}
                          />
                          <Textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => {
                              setInput(e.target.value);
                            }}
                            onKeyDown={handleKeyDown}
                            onKeyPress={handleKeyPress}
                            placeholder={
                              isImageGenerationActive
                                ? "Describe the image you want to create..."
                                :
                                isVideoGenerationActive
                                  ? "Describe the video you want to create..."
                                  : isWebSearchActive
                                    ? "Enter your search query..."
                                    : isGmailActive
                                      ? "Enter Gmail command (e.g., 'send email to john@example.com about meeting')..."
                                      : (isGoogleCalendarActive || isGoogleDriveActive)
                                        ? "Enter Google command (e.g., 'show my meetings for tomorrow')..."
                                        : isSpotifyActive
                                          ? "Enter Spotify command (e.g., 'search for a song by Queen')..."
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
                              isComputerUseActive={isComputerUseActive}
                              setIsComputerUseActive={setIsComputerUseActive}
                              computerUseStatus={computerUseStatus}
                              isGmailActive={isGmailActive}
                              isGoogleCalendarActive={isGoogleCalendarActive}
                              isGoogleDriveActive={isGoogleDriveActive}
                              isSpotifyActive={isSpotifyActive}
                              setShowAudioPanel={setShowAudioPanel}

                              handleComputerUseToggle={handleComputerUseToggle}
                              handleGmailToggle={handleGmailToggle}
                              handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                              handleGoogleDriveToggle={handleGoogleDriveToggle}
                              handleSpotifyToggle={handleSpotifyToggle}
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
                            <ActiveToolsDisplay
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
                              setChatType={setChatType}

                              handleComputerUseToggle={handleComputerUseToggle}
                              handleGmailToggle={handleGmailToggle}
                              handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                              handleGoogleDriveToggle={handleGoogleDriveToggle}
                              handleSpotifyToggle={handleSpotifyToggle}
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
                                  disabled={!input.trim() || isLoading || isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices || isProcessingSpotify}
                                  size="sm"
                                  className="h-8 w-8 p-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
                                >
                                  {isGeneratingImage || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices ? (
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
                          :
                          isVideoGenerationActive
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
        </div>
        {splitViewContent && (
          <div className="w-full border-l border-border/40">
            <CodePreview {...splitViewContent} onClose={() => setSplitViewContent(null)} />
          </div>
        )}
        {documentPreviewUrl && (
          <div className="w-1/2 border-l border-border/40">
            <DocumentPreview
              url={documentPreviewUrl}
              onClose={() => setDocumentPreviewUrl(null)}
            />
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
      </div>
    </div >
  )
}
