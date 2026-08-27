"use client"

/**
 * CreateProjectDialog — professional create flow:
 * name, goal, optional local folder, then land on /projects/:id.
 */

import * as React from "react"
import { Folder } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { projectsService, type Project } from "@/lib/projects-service"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (project: Project, folderFiles?: File[]) => void
}

export function CreateProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations("projects")
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [useFolder, setUseFolder] = React.useState(false)
  const [folderFiles, setFolderFiles] = React.useState<File[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const folderInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!open) {
      setName("")
      setDescription("")
      setUseFolder(false)
      setFolderFiles([])
      setSubmitting(false)
    }
  }, [open])

  const canSubmit = name.trim().length > 0 && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    const cleanName = normalizeChatInput(name).value.trim()
    const normalizedDesc = normalizeChatInput(description)
    if (shouldWarnUser(normalizedDesc)) {
      toast.error(
        `La descripción supera el límite (${normalizedDesc.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const cleanDesc = normalizedDesc.value.trim()
    setSubmitting(true)
    try {
      const project = await projectsService.create({
        name: cleanName,
        description: cleanDesc || undefined,
        type: "general",
      })
      onCreated?.(project, useFolder ? folderFiles : undefined)
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || t("createFailed"))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader className="space-y-1 px-5 pb-1 pt-5">
            <DialogTitle className="text-[17px] font-semibold tracking-tight">
              {t("createTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 px-5 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-name" className="text-[13px] font-medium text-foreground/90">
                {t("whatWorkingOn")}
              </Label>
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={120}
                disabled={submitting}
                className="h-10 rounded-lg"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-description" className="text-[13px] font-medium text-foreground/90">
                {t("whatTryingAchieve")}
              </Label>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                rows={3}
                maxLength={4000}
                disabled={submitting}
                className="min-h-[88px] resize-none rounded-lg"
              />
            </div>

            <button
              type="button"
              data-testid="project-use-folder"
              onClick={() => folderInputRef.current?.click()}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-1 py-1 text-[13px] text-foreground/80 hover:text-foreground",
                folderFiles.length > 0 && "text-foreground",
              )}
            >
              <Folder className="h-4 w-4" />
              {folderFiles.length > 0
                ? `${t("useFolder")} · ${folderFiles.length}`
                : t("useFolder")}
            </button>
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              multiple
              // @ts-expect-error webkitdirectory is valid in Chromium
              webkitdirectory=""
              directory=""
              onChange={(event) => {
                const files = Array.from(event.target.files || [])
                setFolderFiles(files)
                setUseFolder(files.length > 0)
                if (event.target) event.target.value = ""
              }}
            />
          </div>

          <DialogFooter className="gap-2 border-t border-border/50 px-5 py-3 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-md px-3"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="h-8 rounded-md bg-foreground px-3 text-background hover:bg-foreground/90"
            >
              {submitting ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
