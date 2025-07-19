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
  Camera
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
        openai: localStorage.getItem('openai_api_key') || "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",
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

// Image Generation Dialog
/*const ImageGenerationDialog = ({ onImageGenerated }: { onImageGenerated: (imageUrl: string) => void }) => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [prompt, setPrompt] = React.useState('')
  const [isGenerating, setIsGenerating] = React.useState(false)

  const handleGenerate = async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    try {
      const imageUrl = await aiService.generateImage('ChatGPT', prompt)
      onImageGenerated(imageUrl)
      toast.success('Image generated successfully')
      setIsOpen(false)
      setPrompt('')
    } catch (error) {
      console.error('Image generation failed:', error)
      toast.error('Image generation failed. Please check your API key.')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="flex items-center gap-2">
          <Palette className="h-4 w-4" />
          Generate Image
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Image with AI</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="image-prompt">Describe the image you want to create</Label>
            <Textarea
              id="image-prompt"
              placeholder="A beautiful sunset over mountains..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[100px]"
            />
          </div>
          <Button
            onClick={handleGenerate}
            disabled={!prompt.trim() || isGenerating}
            className="w-full"
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Palette className="mr-2 h-4 w-4" />
                Generate Image
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}*/

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

  const handleFiles = async (files: FileList) => {
    if (files.length === 0) return

    setIsUploading(true)
    try {
      const uploadedFiles = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const fileData = {
          id: `file-${Date.now()}-${i}`,
          name: file.name,
          type: file.type,
          size: file.size,
          url: URL.createObjectURL(file),
          extractedText: await extractTextFromFile(file)
        }
        uploadedFiles.push(fileData)
      }

      onFilesUploaded(uploadedFiles)
      toast.success(`${files.length} file(s) uploaded successfully`)
      setIsOpen(false)
    } catch (error) {
      console.error('File upload failed:', error)
      toast.error('File upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const extractTextFromFile = async (file: File): Promise<string> => {
    return new Promise((resolve) => {
      if (file.type.startsWith('text/')) {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target?.result as string || '')
        reader.readAsText(file)
      } else if (file.type === 'application/pdf') {
        resolve(`PDF file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`)
      } else if (file.type.startsWith('image/')) {
        resolve(`Image file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`)
      } else {
        resolve(`File: ${file.name} (${file.type})`)
      }
    })
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
          {message.images && message.images.length > 0 && (
            <div className="space-y-2">
              {message.images.map((imageUrl: string, index: number) => (
                <div key={index} className="relative">
                  <img
                    src={imageUrl}
                    alt="Generated image"
                    className="max-w-full h-auto rounded-lg"
                  />
                  <div className="absolute top-2 right-2 flex gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 w-6 p-0"
                      onClick={() => window.open(imageUrl, '_blank')}
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 w-6 p-0"
                      onClick={() => {
                        const a = document.createElement('a')
                        a.href = imageUrl
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
          {message.files && message.files.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border/20">
              <div className="flex flex-wrap gap-1">
                {message.files.map((file: any, index: number) => (
                  <div key={index} className="flex items-center gap-1">
                    {file.type?.startsWith('image/') ? (
                      <img src={file.url} alt={file.name} className="w-8 h-8 object-cover rounded" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    <Badge variant="outline" className="text-xs">
                      {file.name}
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
    setUploadedFiles,
    availableModels
  } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)

  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);

  // React.useEffect(() => {
  //   if (!currentChat && availableModels.length > 0 && selectedModel) {
  //     createNewChat()
  //   }
  // }, [currentChat, createNewChat, availableModels, selectedModel])

  React.useEffect(() => {
    if (currentChat || chatCreationInitiated.current) {
      return;
    }
    // Add a check for !isLoading to prevent multiple calls
    if (!currentChat && availableModels.length > 0 && selectedModel) {
      chatCreationInitiated.current = true;
      createNewChat()
    }
  }, [currentChat, createNewChat, availableModels, selectedModel])
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

  const handleImageGenerated = (imageUrl: string) => {
    // Add generated image to chat
    const imageMessage = `Here's the image I generated for you:`
    setInput(imageMessage)
    // You could also automatically send it
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
          </div>
          <div className="flex items-center gap-2">
            <ApiKeysDialog />
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
                placeholder="Type your message here... (Try: 'generate image of a sunset')"
                className="min-h-[60px] max-h-[200px] resize-none pr-20 py-4"
                disabled={isLoading}
              />

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
            {/* <ImageGenerationDialog onImageGenerated={handleImageGenerated} /> */}

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
            Press Enter to send, Shift+Enter for new line. Try: "generate image of..." for AI image creation
          </p>
        </div>
      </div>
    </div>
  )
}