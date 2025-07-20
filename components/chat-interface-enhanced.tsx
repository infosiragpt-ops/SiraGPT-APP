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
  MessageSquare
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// API Keys Settings Dialog
const ApiKeysDialog = () => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [keys, setKeys] = React.useState({
    openai: '',
    anthropic: ''
  })

  React.useEffect(() => {
    if (isOpen) {
      setKeys({
        openai: process.env.OPENAI_API_KEY || "",
        anthropic: localStorage.getItem('anthropic_api_key') || ''
      })
    }
  }, [isOpen])

  const handleSave = () => {
    if (keys.openai) {
      aiService.setApiKey('ChatGPT', keys.openai)
    }
    if (keys.anthropic) {
      aiService.setApiKey('Claude', keys.anthropic)
    }
    toast.success('API keys saved successfully')
    setIsOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="h-4 w-4 mr-2" />
          API Keys
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure AI API Keys</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="openai-key">OpenAI API Key</Label>
            <Input
              id="openai-key"
              type="password"
              placeholder="sk-..."
              value={keys.openai}
              onChange={(e) => setKeys({ ...keys, openai: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="anthropic-key">Anthropic API Key</Label>
            <Input
              id="anthropic-key"
              type="password"
              placeholder="sk-ant-..."
              value={keys.anthropic}
              onChange={(e) => setKeys({ ...keys, anthropic: e.target.value })}
            />
          </div>
          <Button onClick={handleSave} className="w-full">
            Save API Keys
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Enhanced Model Selector
const NavbarModelSelector = ({ selectedModel, setSelectedModel, availableModels }: any) => {
  const selectedModelData = availableModels.find((m: any) => m.name === selectedModel);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
        <Bot className="h-4 w-4" />
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
        {availableModels.map((model: any) => (
          <DropdownMenuItem
            key={model.name}
            onSelect={() => setSelectedModel(model.name)}
            className="flex items-center gap-2 py-2"
          >
            <Bot className="h-4 w-4 flex-shrink-0" />
            <div className="flex flex-col flex-1">
              <span className="text-sm">{model.displayName}</span>
              <span className="text-xs text-muted-foreground">{model.description}</span>
            </div>
            {aiService.hasApiKey(model.name) ? (
              <div className="w-2 h-2 bg-green-500 rounded-full" />
            ) : (
              <div className="w-2 h-2 bg-red-500 rounded-full" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// Enhanced File Upload Dialog
const FileUploadDialog = ({ onFilesUploaded }: { onFilesUploaded: (files: any[]) => void }) => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const { user } = useAuth()

  const handleFiles = async (files: FileList) => {
    if (files.length === 0) return

    setIsUploading(true)
    try {
      // Upload files to backend
      const response = await apiClient.uploadFiles(files)

      if (response.files) {
        onFilesUploaded(response.files)
        toast.success(`${response.files.length} file(s) uploaded successfully`)
      } else {
        toast.error('File upload failed')
      }
      setIsOpen(false)
    } catch (error) {
      console.error('File upload failed:', error)
      toast.error('File upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true)
    } else if (e.type === "dragleave") {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFiles(e.dataTransfer.files)
    }
  }

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
  )
}

// Enhanced File Display Component
const FileDisplay = ({ files, onRemove }: { files: any[]; onRemove: (index: number) => void }) => {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {files.map((file, index) => (
        <div key={index} className="flex items-center gap-2 bg-muted rounded-md px-3 py-2 text-sm">
          {file.type?.startsWith('image/') ? (
            <div className="flex items-center gap-2">
              <img src={file.url} alt={file.name} className="w-6 h-6 object-cover rounded" />
              <ImageIcon className="h-4 w-4" />
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

// Enhanced Message Component
const MessageComponent = ({ message, user }: { message: any; user: any }) => {
  // Parse files if they exist
  let parsedFiles = []
  if (message.files) {
    try {
      parsedFiles = typeof message.files === 'string' ? JSON.parse(message.files) : message.files
    } catch (e) {
      parsedFiles = []
    }
  }


  return (
    <div className={`flex gap-3 ${message.role === "USER" ? "justify-end" : "justify-start"}`}>
      {message.role === "ASSISTANT" && (
        <Avatar className="h-8 w-8 flex-shrink-0">
          <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
        </Avatar>
      )}
      <Card
        className={`max-w-[80%] p-3 ${message.role === "USER" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"
          }`}
      >
        <div className="space-y-2">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>

          {/* Display generated images */}
          {parsedFiles && parsedFiles.length > 0 && parsedFiles.some((f: any) => f.type === 'image') && (
            <div className="space-y-2">
              {parsedFiles.filter((f: any) => f.type === 'image').map((file: any, index: number) => (
                <div key={index} className="relative">
                  <img
                    src={file.url}
                    alt="Generated image"
                    className="max-w-full h-auto rounded-lg"
                  />
                  <div className="absolute top-2 right-2 flex gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 w-6 p-0"
                      onClick={() => window.open(file.url, '_blank')}
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 w-6 p-0"
                      onClick={() => {
                        const a = document.createElement('a')
                        a.href = file.url
                        a.download = `generated-image-${Date.now()}.png`
                        a.click()
                      }}
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Display attached files */}
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
        </div>

        <p className="mt-2 text-xs opacity-70">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </Card>
      {message.role === "USER" && (
        <Avatar className="h-8 w-8 flex-shrink-0">
          <AvatarImage src={user?.avatar || "/placeholder.svg"} />
          <AvatarFallback className="text-xs">U</AvatarFallback>
        </Avatar>
      )}
    </div>
  )
}

export default function ChatInterface() {
  const { user } = useAuth()
  const {
    currentChat,
    addMessage,
    clearCurrentChat,
    selectedModel,
    createNewChat,
    isLoading,
    setSelectedModel,
    uploadedFiles,
    selectChat,
    setUploadedFiles,
    availableModels
  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = React.useState(false)
  const [chatType, setChatType] = React.useState<'text' | 'image'>('text')

  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);

  // React.useEffect(() => {
  //   if (currentChat || chatCreationInitiated.current) {
  //     return;
  //   }
  //   // Add a check for !isLoading to prevent multiple calls
  //   if (!currentChat && availableModels.length > 0 && selectedModel) {
  //     chatCreationInitiated.current = true;
  //     createNewChat()
  //   }
  // }, [currentChat, createNewChat, availableModels, selectedModel])
  React.useEffect(() => {
    if (currentChat || chatCreationInitiated.current) {
      return;
    }

    // Check if there's a chat id in localStorage
    const savedChatId = localStorage.getItem('currentChatId');
    if (savedChatId) {

      // Maybe call API to load this chat into currentChat
      selectChat(savedChatId)
      return;
    }

    // First time after auth and no saved chat
    if (!currentChat && availableModels.length > 0 && selectedModel) {
      chatCreationInitiated.current = true;
      createNewChat()

    }
  }, [currentChat, createNewChat, availableModels, selectedModel]);

  const loadChatById = async () => {

  }
  const handleSend = async () => {
    if (!input.trim() || isLoading || !currentChat) return

    const msg = input.trim()
    setInput("")

    if (chatType === 'image') {
      await handleImageGeneration(msg)
    } else {
      await addMessage(msg, uploadedFiles.map(f => f.id))
    }
  }

  const handleImageGeneration = async (prompt: string) => {
    if (!currentChat) return

    setIsGeneratingImage(true)
    try {
      const response = await apiClient.generateImage({
        prompt,
        chatId: currentChat.id
      })

      // Reload chat to get updated messages
      const chatResponse = await apiClient.getChat(currentChat.id)
      // Update chat context with new messages
      toast.success('Image generated successfully!')
    } catch (error) {
      console.error('Image generation failed:', error)
      toast.error('Image generation failed. Please try again.')
    } finally {
      setIsGeneratingImage(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFilesUploaded = (files: any[]) => {
    setUploadedFiles([...uploadedFiles, ...files])
  }

  const createNewImageChat = () => {
    setChatType('image')
    createNewChat()
  }

  const createNewTextChat = () => {
    setChatType('text')
    createNewChat()
  }

  const removeFile = (index: number) => {
    setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
  }

  React.useEffect(() => {
    scrollAreaRef.current?.scrollTo({
      top: scrollAreaRef.current.scrollHeight,
    })
  }, [currentChat?.messages, isLoading])

  if (!currentChat) return null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            <NavbarModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              availableModels={availableModels}
            />
            <div className="flex items-center gap-2">
              <Badge variant={chatType === 'text' ? 'default' : 'outline'}>
                {chatType === 'text' ? 'Text Chat' : 'Image Generation'}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* <ApiKeysDialog /> */}
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={clearCurrentChat}>
              Clear Chat
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
        <div className="space-y-4 max-w-4xl mx-auto">
          {currentChat.messages.map((message) => (
            <MessageComponent key={message.id} message={message} user={user} />
          ))}

          {(isLoading || isGeneratingImage) && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
              </Avatar>
              <Card className="bg-muted p-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">
                    {isGeneratingImage ? 'Generating image...' : 'Thinking...'}
                  </span>
                </div>
              </Card>
            </div>
          )}
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
                    : "Type your message here..."
                }
                className="min-h-[60px] max-h-[200px] resize-none pr-20 py-4"
                disabled={isLoading || isGeneratingImage}
              />

              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading || isGeneratingImage}
                  size="sm"
                  className="h-8 w-8 p-0"
                >
                  {isGeneratingImage ? (
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
              <FileUploadDialog onFilesUploaded={handleFilesUploaded} />
            )}

            {/* <Button
              variant="outline"
              size="sm"
              onClick={createNewTextChat}
              className="flex items-center gap-2"
            >
              <MessageSquare className="h-4 w-4" />
              New Text Chat
            </Button> */}

            <Button
              variant="outline"
              size="sm"
              onClick={createNewImageChat}
              className="flex items-center gap-2"
            >
              <Palette className="h-4 w-4" />
              New Image Chat
            </Button>

            {/* <Button
              variant="outline"
              size="sm"
              onClick={() => setIsRecording((prev) => !prev)}
              className={`flex items-center gap-2 ${isRecording ? "bg-red-100 text-red-600" : ""}`}
            >
              <Mic className="h-4 w-4" />
              Audio
            </Button>

            <Button variant="outline" size="sm" disabled className="flex items-center gap-2 bg-transparent">
              <Video className="h-4 w-4" />
              Video
              <Badge variant="secondary" className="text-xs ml-1">
                Soon
              </Badge>
            </Button> */}

            {/* <Button
                variant="outline"
                size="sm"
                disabled={isSearching || !input.trim()}
                className="flex items-center gap-2 bg-transparent"
              >
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
                Web Search
              </Button> */}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {chatType === 'image'
              ? 'Press Enter to generate image, Shift+Enter for new line'
              : 'Press Enter to send, Shift+Enter for new line'
            }
          </p>
        </div>
      </div>
    </div>
  )
}