import ChatInterface from "@/components/chat-interface-enhanced"
import { FalModelGalleryLauncher } from "@/components/fal/fal-model-gallery-launcher"

export default function ChatPage() {
  return (
    <>
      <ChatInterface />
      <div className="pointer-events-none fixed right-3 top-2.5 z-50 sm:right-5 sm:top-3">
        <div className="pointer-events-auto">
          <FalModelGalleryLauncher />
        </div>
      </div>
    </>
  )
}
