"use client"

import * as React from "react"
import { Send, Paperclip, Mic, Square, Loader2, FileText, ImageIcon, Video, Wand2, Globe, Sparkles, Bot, ChevronDown, X, Upload } from "lucide-react"
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
import { apiClient } from "@/lib/api"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Props = {
  selectedModel: string;
  setSelectedModel: (name: string) => void;
};

export const NavbarModelSelector: React.FC<Props> = ({ selectedModel, setSelectedModel }) => {
  const selectedModelData = llmModels.find((m) => m.name === selectedModel);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-muted transition">
        {selectedModelData?.icon && <selectedModelData.icon className="h-4 w-4" />}
        <span className="text-sm font-medium">{selectedModel}</span>
        <ChevronDown className="h-4 w-4 opacity-70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {llmModels.map((model) => (
          <DropdownMenuItem
            key={model.name}
            onSelect={() => setSelectedModel(model.name)}
            className="flex items-center gap-2 py-2"
          >
            <model.icon className="h-4 w-4 flex-shrink-0" />
            <div className="flex flex-col">
              <span className="text-sm">{model.name}</span>
              <span className="text-xs text-muted-foreground">{model.description}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// File Upload Component
const FileUploadDialog = ({ onFilesUploaded }: { onFilesUploaded: (files: any[]) => void }) => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList) => {
    if (files.length === 0) return

    setIsUploading(true)
    try {
      const response = await apiClient.uploadFiles(files)
      onFilesUploaded(response.files)
      toast.success(`${files.length} file(s) uploaded successfully`)
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
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
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
                  Uploading...
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

// File Display Component
const FileDisplay = ({ files, onRemove }: { files: any[]; onRemove: (index: number) => void }) => {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {files.map((file, index) => (
        <div key={index} className="flex items-center gap-2 bg-muted rounded-md px-3 py-2 text-sm">
          <FileText className="h-4 w-4" />
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
    addMessage, 
    clearCurrentChat, 
    selectedModel, 
    createNewChat, 
    isLoading, 
    setSelectedModel,
    uploadedFiles,
    setUploadedFiles
  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)

  const scrollAreaRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!currentChat) createNewChat()
  }, [currentChat, createNewChat])

  const handleSend = async () => {
    if (!input.trim() || isLoading || !currentChat) return
    const msg = input.trim()
    setInput("")
    await addMessage(msg)
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

  const removeFile = (index: number) => {
    setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
  }

  /* --- UI Scroll --- */
  React.useEffect(() => {
    scrollAreaRef.current?.scrollTo({
      top: scrollAreaRef.current.scrollHeight,
    })
  }, [currentChat?.messages, isLoading])

  /* -------------- render -------------- */
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
            />
          </div>
          <div className="flex items-center gap-2">
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
          {currentChat.messages.map((m) => (
            <div key={m.id} className={`flex gap-3 ${m.role === "USER" ? "justify-end" : "justify-start"}`}>
              {m.role === "ASSISTANT" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
              )}
              <Card
                className={`max-w-[80%] p-3 ${m.role === "USER" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"
                  }`}
              >
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.content}</p>
                {m.files && m.files.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/20">
                    <div className="flex flex-wrap gap-1">
                      {m.files.map((file: any, index: number) => (
                        <Badge key={index} variant="outline" className="text-xs">
                          <FileText className="h-3 w-3 mr-1" />
                          {file.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-xs opacity-70">
                  {new Date(m.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </Card>
              {m.role === "USER" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                  <AvatarFallback className="text-xs">U</AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
              </Avatar>
              <Card className="bg-muted p-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Thinking...</span>
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
          <FileDisplay files={uploadedFiles} onRemove={removeFile} />

          {/* Input Area */}
          <div className="bg-background">
            <div className="flex-1 relative">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message here..."
                className="min-h-[60px] max-h-[200px] resize-none pr-20 py-4"
                disabled={isLoading}
              />

              {/* Send button at bottom right of input */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <Button onClick={handleSend} disabled={!input.trim() || isLoading} size="sm" className="h-8 w-8 p-0">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Function buttons row */}
          <div className="flex flex-wrap items-center justify-start gap-2">
            <FileUploadDialog onFilesUploaded={handleFilesUploaded} />
            
            <Button
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
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              disabled={isSearching || !input.trim()}
              className="flex items-center gap-2 bg-transparent"
            >
              {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              Web Search
            </Button>
            
            <Dialog open={showInstructions} onOpenChange={setShowInstructions}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="flex items-center gap-2 bg-transparent">
                  <Wand2 className="h-4 w-4" />
                  GPT Instructions
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>GPT Instructions</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Add custom instructions to guide the AI's responses.
                  </p>
                  <Textarea
                    placeholder="Enter your instructions here..."
                    className="min-h-[100px]"
                  />
                  <Button className="w-full">Apply Instructions</Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          <p className="text-center text-xs text-muted-foreground">Press Enter to send, Shift+Enter for new line</p>
        </div>
      </div>
    </div>
  )
}

// LLM Models with more detailed descriptions
const llmModels = [
  {
    name: "ChatGPT",
    icon: Bot,
    description: "GPT-4 & GPT-3.5",
    subtitle: "OpenAI",
  },
  {
    name: "Claude",
    icon: Sparkles,
    description: "Anthropic AI",
    subtitle: "Claude-3",
  },
  {
    name: "Grok",
    icon: Bot,
    description: "xAI Model",
    subtitle: "Grok-2",
  },
  {
    name: "DeepSeek",
    icon: Bot,
    description: "DeepSeek AI",
    subtitle: "DeepSeek-V2",
  },
  {
    name: "Gemini",
    icon: Sparkles,
    description: "Google AI",
    subtitle: "Gemini-Pro",
  },
]