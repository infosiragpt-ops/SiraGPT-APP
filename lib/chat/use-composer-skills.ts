"use client"

/**
 * Agent Skills in the composer («+ → Skills»), claude.ai style.
 *
 * The catalog (built-in document skills + the user's Biblioteca) is fetched
 * lazily the first time the menu opens and cached for the session. Picked
 * skills ride the NEXT turn only (`skills: [name]` on /api/ai/generate) and
 * are cleared after send, like Claude's skill chips.
 */

import { useCallback, useMemo, useRef, useState } from "react"

import { apiClient, type ChatSkillSummary } from "@/lib/api"

export const MAX_COMPOSER_SKILLS = 3

export type ComposerSkillsStatus = "idle" | "loading" | "ready" | "error"

export type ComposerSkills = {
  catalog: ChatSkillSummary[]
  status: ComposerSkillsStatus
  selected: ChatSkillSummary[]
  selectedNames: string[]
  isSelected: (name: string) => boolean
  toggle: (skill: ChatSkillSummary) => void
  remove: (name: string) => void
  clear: () => void
  ensureLoaded: () => void
  reload: () => void
}

/** Built-ins shown instantly (and when the API is unreachable). */
export const BUILTIN_COMPOSER_SKILLS: ChatSkillSummary[] = [
  { name: "docx", title: "Word", description: "Documentos Word (.docx) con formato profesional.", source: "builtin" },
  { name: "pptx", title: "PowerPoint", description: "Presentaciones .pptx con diseño profesional.", source: "builtin" },
  { name: "xlsx", title: "Excel", description: "Hojas de cálculo .xlsx: fórmulas y formato.", source: "builtin" },
  { name: "pdf", title: "PDF", description: "Leer, crear, combinar y editar PDF.", source: "builtin" },
  { name: "csv", title: "CSV", description: "Limpiar y analizar datos en CSV.", source: "builtin" },
]

export function toggleSkillSelection(current: ChatSkillSummary[], skill: ChatSkillSummary, max = MAX_COMPOSER_SKILLS): ChatSkillSummary[] {
  if (current.some((s) => s.name === skill.name)) return current.filter((s) => s.name !== skill.name)
  const next = current.concat(skill)
  return next.length > max ? next.slice(next.length - max) : next
}

export function filterSkills(catalog: ChatSkillSummary[], query: string): ChatSkillSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return catalog
  return catalog.filter((s) => `${s.name} ${s.title} ${s.description}`.toLowerCase().includes(q))
}

export function useComposerSkills(): ComposerSkills {
  const [catalog, setCatalog] = useState<ChatSkillSummary[]>(BUILTIN_COMPOSER_SKILLS)
  const [status, setStatus] = useState<ComposerSkillsStatus>("idle")
  const [selected, setSelected] = useState<ChatSkillSummary[]>([])
  const inFlight = useRef(false)

  const load = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setStatus("loading")
    apiClient
      .listChatSkills()
      .then((res) => {
        const list = Array.isArray(res?.skills) ? res.skills.filter((s) => s && typeof s.name === "string") : []
        if (list.length) setCatalog(list)
        setStatus("ready")
      })
      .catch(() => setStatus("error"))
      .finally(() => {
        inFlight.current = false
      })
  }, [])

  const ensureLoaded = useCallback(() => {
    if (status === "idle") load()
  }, [load, status])

  const toggle = useCallback((skill: ChatSkillSummary) => {
    setSelected((current) => toggleSkillSelection(current, skill))
  }, [])

  const remove = useCallback((name: string) => {
    setSelected((current) => current.filter((s) => s.name !== name))
  }, [])

  const clear = useCallback(() => setSelected([]), [])

  const selectedNames = useMemo(() => selected.map((s) => s.name), [selected])
  const isSelected = useCallback((name: string) => selectedNames.includes(name), [selectedNames])

  return {
    catalog,
    status,
    selected,
    selectedNames,
    isSelected,
    toggle,
    remove,
    clear,
    ensureLoaded,
    reload: load,
  }
}
