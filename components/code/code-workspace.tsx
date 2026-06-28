"use client"

/**
 * CodeWorkspace — Replit-style agentic build surface for /code.
 *
 * Owner-requested layout ("solo un chat agéntico … tipo Replit"): a pure
 * agentic chat — the owner gives orders and it builds the software — beside a
 * live preview of the running app. No code editor, file tree, terminal,
 * command palette, or other IDE chrome is shown; every interaction happens
 * through the chat. The "pensando" activity is the red DotmCircular15 glyph
 * rendered inside the chat panel.
 */

import * as React from "react"
import { Rocket } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { PreviewPane } from "./preview-pane"
import { ProjectChip } from "./project-chip"
import { PublishingConsole } from "./publishing-console"

const CHAT_DEFAULT_SIZE = 42
const CHAT_MIN_SIZE = 30
const PREVIEW_MIN_SIZE = 30

export function CodeWorkspace() {
  const { focusChat } = useCodeWorkspace()
  const [publishingOpen, setPublishingOpen] = React.useState(false)

  // Land the cursor in the chat composer on entry — the chat is the only way
  // the owner drives the build.
  React.useEffect(() => {
    focusChat()
  }, [focusChat])

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background/55 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-background/40">
        <ProjectChip />
        <Button
          type="button"
          size="sm"
          onClick={() => setPublishingOpen(true)}
          className="h-7 gap-1.5 rounded-md px-3 text-[12px] font-medium"
        >
          <Rocket className="h-3.5 w-3.5" />
          Publicar
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Agentic chat — the owner gives orders here and it builds. */}
          <ResizablePanel
            defaultSize={CHAT_DEFAULT_SIZE}
            minSize={CHAT_MIN_SIZE}
            maxSize={65}
            className="min-w-0"
          >
            <AICodeChatPanel />
          </ResizablePanel>
          <ResizableHandle withHandle />
          {/* Live preview of the running software — the result, never the code. */}
          <ResizablePanel
            defaultSize={100 - CHAT_DEFAULT_SIZE}
            minSize={PREVIEW_MIN_SIZE}
            className="relative min-w-0"
          >
            <div className="absolute inset-0">
              <PreviewPane />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <PublishingConsole open={publishingOpen} onOpenChange={setPublishingOpen} />
    </div>
  )
}
