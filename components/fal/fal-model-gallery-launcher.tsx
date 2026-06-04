"use client"

import * as React from "react"
import { Sparkles } from "lucide-react"
import { toast } from "sonner"
import { FalModelGallery, type FalModel } from "./fal-model-gallery"

export const FAL_MODEL_EVENT = "siragpt:fal-model-selected"

/**
 * Floating launcher for the fal.ai model gallery, mounted on /chat. Decoupled
 * from the (large) chat composer: selecting a model dispatches a window
 * CustomEvent the composer listens for to activate the matching media model.
 */
export function FalModelGalleryLauncher() {
  const [open, setOpen] = React.useState(false)
  const [activeEndpoint, setActiveEndpoint] = React.useState<string | null>(null)

  const handleSelect = React.useCallback((model: FalModel) => {
    setActiveEndpoint(model.id)
    try {
      window.dispatchEvent(new CustomEvent(FAL_MODEL_EVENT, { detail: model }))
    } catch {
      /* no-op */
    }
    const groupLabel = { image: "imagen", video: "video", audio: "audio", "3d": "3D" }[model.group] || model.group
    toast.success(`${model.displayName} activado`, {
      description: `${model.brand} · ${model.qualityTier} · modelo de ${groupLabel}`,
    })
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fal-launcher"
        title="Explorar todos los modelos de fal.ai"
        aria-label="Explorar modelos fal.ai"
      >
        <span className="fal-launcher__sheen" aria-hidden="true" />
        <Sparkles className="relative h-4 w-4" />
        <span className="relative hidden sm:inline">Modelos</span>
      </button>
      <FalModelGallery
        open={open}
        onOpenChange={setOpen}
        activeEndpoint={activeEndpoint}
        onSelect={handleSelect}
      />
    </>
  )
}

export default FalModelGalleryLauncher
