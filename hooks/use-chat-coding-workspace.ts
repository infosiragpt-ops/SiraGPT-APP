"use client"

import * as React from "react"
import { coreCodexApi } from "@/lib/codex/api/core"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import type { CodexProject } from "@/lib/codex/api/types"
import { CODING_WORKSPACE_READY_EVENT, type CodingWorkspaceReadyDetail } from "@/lib/chat/coding-workspace-event"
import { CODING_PREVIEW_READY_EVENT, readyCodingPreviewPath, type CodingPreviewDetail } from "@/lib/chat/coding-preview-event"

export function useChatCodingWorkspace(userId?: string, chatId?: string) {
  const [binding, setBinding] = React.useState<(CodingWorkspaceReadyDetail) | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    if (userId && chatId && !chatId.startsWith("temp-chat-")) {
      void projectsCodexApi.getProjectByChat(chatId).then((project) => {
        if (!cancelled && project?.id) setBinding({ userId, chatId, projectId: project.id, projectName: project.name })
      }).catch(() => { /* No project is a normal conversation. */ })
    }
    return () => { cancelled = true }
  }, [userId, chatId, refresh])
  React.useEffect(() => {
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<CodingWorkspaceReadyDetail>).detail
      if (!userId || !detail || detail.userId !== userId || detail.chatId !== chatId || !detail.projectId) return
      setBinding(detail)
    }
    window.addEventListener(CODING_WORKSPACE_READY_EVENT, onReady)
    return () => window.removeEventListener(CODING_WORKSPACE_READY_EVENT, onReady)
  }, [userId, chatId])
  // A previous render's project cannot activate another account or chat while
  // its lookup is pending. No workspace/draft is persisted in global storage.
  const workspace = binding && binding.userId === userId && binding.chatId === chatId ? binding : null
  const onProjectReady = React.useCallback((ready: boolean) => {
    if (ready) setRefresh((version) => version + 1)
  }, [])
  return { workspace, onProjectReady }
}

/** The existing Carpetas section reads durable cloud projects in one request. */
export function useCloudCodingProjects(userId?: string) {
  const [snapshot, setSnapshot] = React.useState<{ userId: string; projects: CodexProject[] } | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    if (!userId) return
    void coreCodexApi.access().then(async (access) => {
      if (cancelled) return
      if (!access.enabled || !access.canRun) {
        setSnapshot({ userId, projects: [] })
        return
      }
      const projects = await projectsCodexApi.listProjects()
      if (!cancelled) setSnapshot({ userId, projects: projects.filter((project) => Boolean(project.id && project.chatId && project.name)) })
    }).catch(() => { /* Keep the last account-owned result during an outage. */ })
    return () => { cancelled = true }
  }, [userId, refresh])
  React.useEffect(() => {
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<CodingWorkspaceReadyDetail>).detail
      if (userId && detail?.userId === userId) setRefresh((version) => version + 1)
    }
    window.addEventListener(CODING_WORKSPACE_READY_EVENT, onReady)
    return () => window.removeEventListener(CODING_WORKSPACE_READY_EVENT, onReady)
  }, [userId])
  return snapshot && snapshot.userId === userId ? snapshot.projects : []
}

/** Recovery is read-only: opening a chat never starts a new dev server. */
export function useChatCodingPreview(workspace: CodingWorkspaceReadyDetail | null) {
  const [refresh, setRefresh] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<(CodingPreviewDetail & { basePath: string }) | null>(null)
  const userId = workspace?.userId, chatId = workspace?.chatId, projectId = workspace?.projectId
  React.useEffect(() => {
    if (!userId || !chatId || !projectId) return
    const controller = new AbortController()
    void projectsCodexApi.previewStatus(projectId, controller.signal).then((status) => {
      if (controller.signal.aborted) return
      const basePath = readyCodingPreviewPath(status, projectId)
      setSnapshot(basePath ? { userId, chatId, projectId, basePath } : null)
    }).catch(() => { if (!controller.signal.aborted) setSnapshot(null) })
    return () => controller.abort()
  }, [userId, chatId, projectId, refresh])
  React.useEffect(() => {
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<CodingPreviewDetail>).detail
      if (detail && userId && detail.userId === userId && detail.chatId === chatId && detail.projectId === projectId) {
        setRefresh((version) => version + 1)
      }
    }
    window.addEventListener(CODING_PREVIEW_READY_EVENT, onReady)
    return () => window.removeEventListener(CODING_PREVIEW_READY_EVENT, onReady)
  }, [userId, chatId, projectId])
  return snapshot && snapshot.userId === userId && snapshot.chatId === chatId && snapshot.projectId === projectId ? snapshot : null
}
