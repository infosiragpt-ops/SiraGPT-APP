"use client"

import * as React from "react"
import { Send, Paperclip, Mic, Square, Loader2, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card } from "@/components/ui/card"
import { useChat } from "@/lib/chat-context"
import { useAuth } from "@/lib/auth-context"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ThemeToggle } from "@/components/theme-toggle"
import { toast } from "sonner"

export function ChatInterface() {
  const { user } = useAuth()
  const { currentChat, addMessage, clearCurrentChat, selectedModel, createNewChat, isLoading } = useChat()

  const [input, setInput] = React.useState("")
  const [apiKeys, setApiKeys] = React.useState<Record<string, string>>({})
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)

  // Create initial chat if none exists
  React.useEffect(() => {
    if (!currentChat && user) {
      createNewChat()
    }
  }, [currentChat, createNewChat, user])

  const handleSend = async () => {
    if (!input.trim() || isLoading || !currentChat) return

    const message = input.trim()
    setInput("")

    try {
      await addMessage(message)
    } catch (error) {
      console.error("Failed to send message:", error)
      toast.error("Failed to send message. Please try again.")
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  React.useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight
    }
  }, [currentChat?.messages])

  if (!currentChat) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading chat...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{selectedModel}</h1>
            <p className="text-sm text-muted-foreground">
              {selectedModel === "ChatGPT"
                ? "GPT-4 • Text Generation"
                : selectedModel === "Claude"
                  ? "Claude-3 • Text Generation"
                  : selectedModel === "Grok"
                    ? "Grok-2 • Text Generation"
                    : selectedModel === "DeepSeek"
                      ? "DeepSeek-V2 • Text Generation"
                      : "Gemini-Pro • Text Generation"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Chat Settings</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="temperature">Temperature</Label>
                    <Input id="temperature" type="number" min="0" max="2" step="0.1" defaultValue="0.7" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="max-tokens">Max Tokens</Label>
                    <Input id="max-tokens" type="number" min="1" max="4000" defaultValue="1000" />
                  </div>
                </div>
              </DialogContent>
            </Dialog>
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
            <div key={message.id} className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role === "assistant" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    {selectedModel === "ChatGPT"
                      ? "GPT"
                      : selectedModel === "Claude"
                        ? "CL"
                        : selectedModel === "Grok"
                          ? "GK"
                          : selectedModel === "DeepSeek"
                            ? "DS"
                            : "GM"}
                  </AvatarFallback>
                </Avatar>
              )}

              <Card
                className={`max-w-[80%] p-3 ${
                  message.role === "user" ? "bg-primary text-primary-foreground ml-auto" : "bg-muted"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
                <p className="mt-2 text-xs opacity-70">
                  {message.timestamp.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </Card>

              {message.role === "user" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                  <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                  <AvatarFallback className="text-xs">
                    {user?.name
                      ?.split(" ")
                      .map((n) => n[0])
                      .join("") || "U"}
                  </AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-3 justify-start">
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {selectedModel === "ChatGPT"
                    ? "GPT"
                    : selectedModel === "Claude"
                      ? "CL"
                      : selectedModel === "Grok"
                        ? "GK"
                        : selectedModel === "DeepSeek"
                          ? "DS"
                          : "GM"}
                </AvatarFallback>
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

      {/* Input */}
      <div className="border-t border-border/40 p-4">
        <div className="flex items-end gap-3 max-w-4xl mx-auto">
          <div className="flex-1 relative">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message here..."
              className="min-h-[50px] max-h-[200px] resize-none pr-20 py-3"
              disabled={isLoading}
            />
            <div className="absolute bottom-3 right-3 flex gap-1">
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0">
                <Paperclip className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0">
                <Mic className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <Button onClick={handleSend} disabled={!input.trim() || isLoading} className="h-[50px] px-4" size="default">
            {isLoading ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground text-center max-w-4xl mx-auto">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
