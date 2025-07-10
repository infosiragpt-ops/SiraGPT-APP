"use client"

import * as React from "react"
import { Send, Paperclip, Mic, Square, Loader2, FileText, ImageIcon, Video, Wand2, Globe, Sparkles, Bot, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card } from "@/components/ui/card"
import { useChat } from "@/lib/chat-context"
import { useAuth } from "@/lib/auth-context"
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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

export default function ChatInterface() {
  const { user } = useAuth()
  const { currentChat, addMessage, clearCurrentChat, selectedModel, createNewChat, isLoading, setSelectedModel } = useChat()

  const [input, setInput] = React.useState("")
  const [isRecording, setIsRecording] = React.useState(false)
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)

  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

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
            {/* <div className="flex items-center justify-between px-4 py-2 border-b"> */}


            <NavbarModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
            />
            {/* </div> */}
            {/* <h1 className="text-lg font-semibold">{selectedModel}</h1>
            <p className="text-sm text-muted-foreground">{selectedModel} • Text Generation</p> */}
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
            <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
              )}
              <Card
                className={`max-w-[80%] p-3 ${m.role === "user" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"
                  }`}
              >
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.content}</p>
                <p className="mt-2 text-xs opacity-70">
                  {m.timestamp.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </Card>
              {m.role === "user" && (
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

      {/* ------- INPUT & ACTIONS -------- */}
      <div className="border-t border-border/40 p-4">
        <div className="max-w-4xl mx-auto space-y-3">
          {/* Input row */}
          {/* <div className="flex items-end gap-3">
            <div className="flex-1 relative">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message…"
                className="min-h-[60px] max-h-[200px] resize-none pr-12 py-3 rounded-md focus-visible:ring-2 focus-visible:ring-primary"
                disabled={isLoading}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 absolute bottom-3 right-10"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-3 w-3" />
              </Button>
            </div>
            <Button onClick={handleSend} disabled={!input.trim() || isLoading} className="h-[50px] px-4">
              {isLoading ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </Button>
          </div> */}
          {/* Input Area */}
          <div className="   bg-background">

            <div className="flex-1 relative">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message here..."
                className="min-h-[60px] max-h-[200px] resize-none pr-20 py-4"
                disabled={isLoading}
              />

              {/* Media Functions at bottom right of input */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip className="h-4 w-4" />
                </Button>
                {/* <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                  <Mic className="h-4 w-4" />
                </Button> */}
                <Button onClick={handleSend} disabled={!input.trim() || isLoading} size="sm" className="h-8 w-8 p-0">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>



            <input ref={fileInputRef} type="file" className="hidden" accept="image/*,audio/*,video/*,.pdf,.doc,.docx" />
          </div>

          {/* Function buttons row */}
          <div className="flex flex-wrap items-center justify-start gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2"
            >
              <FileText className="h-4 w-4" />
              Documents
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2"
            >
              <ImageIcon className="h-4 w-4" />
              Images
            </Button>
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
              <DialogContent>…</DialogContent>
            </Dialog>
          </div>

          <p className="text-center text-xs text-muted-foreground">Press Enter to send, Shift+Enter for new line</p>
        </div>

        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" className="hidden" />
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