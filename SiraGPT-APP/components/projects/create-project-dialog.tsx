"use client"

/**
 * CreateProjectDialog — modal matching the "Crear un proyecto
 * personal" screenshot: two-field form (name + description) and a
 * Cancelar / Crear proyecto button row.
 *
 * Uses the shared Dialog primitive so it inherits the app's overlay,
 * focus-trap, and close-on-escape behaviour. Controlled from the
 * parent via `open` + `onOpenChange` so the list page can trigger it
 * from the "+ Nuevo proyecto" button AND from the empty-state CTA.
 *
 * Submission semantics:
 *   - Disabled while the API call is in flight (prevents double-submit).
 *   - Success: calls onCreated(project) and closes the dialog. The
 *     parent is expected to navigate to /projects/:id or refresh the
 *     list — we deliberately don't navigate from inside the dialog so
 *     the same component can be reused without coupling to routing.
 *   - Error: surfaces via toast; dialog stays open so the user can
 *     retry without retyping.
 */

import * as React from "react"
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

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (project: Project) => void
}

export function CreateProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations("projects")
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  // Reset local state whenever the dialog closes so a second open
  // doesn't inherit the previous attempt's typed text.
  React.useEffect(() => {
    if (!open) {
      setName("")
      setDescription("")
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
      })
      onCreated?.(project)
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || t("createFailed"))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="text-2xl font-serif tracking-tight">
            {t("createTitle")}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="project-name" className="text-sm">
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
              className="h-11"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-description" className="text-sm">
              {t("whatTryingAchieve")}
            </Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={4}
              maxLength={4000}
              disabled={submitting}
              className="resize-none"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
