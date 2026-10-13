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
  // Which (account, chat) lookup has settled: until then a caller cannot know
  // whether the chat has a workspace (a reload resumes before it answers).
  const [settledKey, setSettledKey] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    let fallback: ReturnType<typeof setTimeout> | undefined
    if (userId && chatId && !chatId.startsWith("temp-chat-")) {
      const key = `${userId}\u0000${chatId}`
      // A lookup that never answers must not hold the chat forever.
      fallback = setTimeout(() => { if (!cancelled) setSettledKey(key) }, 8_000)
      void projectsCodexApi.getProjectByChat(chatId).then((project) => {
        if (!cancelled && project?.id) setBinding({ userId, chatId, projectId: project.id, projectName: project.name })
      }).catch(() => { /* No project is a normal conversation. */ }).finally(() => {
        clearTimeout(fallback)
        if (!cancelled) setSettledKey(key)
      })
    }
    return () => { cancelled = true; clearTimeout(fallback) }
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
  // The chat whose workspace question is answered (bound, or known unbound).
  // Temporary chats have nothing to look up.
  const resolvedChatId = !userId || !chatId ? null
    : chatId.startsWith("temp-chat-") || workspace || settledKey === `${userId}\u0000${chatId}` ? chatId : null
  return { workspace, onProjectReady, resolvedChatId }
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
  const [snapshot, setSnapshot] = React.useState<(CodingPreviewDetail & { basePath: string; revision: number }) | null>(null)
  const userId = workspace?.userId, chatId = workspace?.chatId, projectId = workspace?.projectId
  React.useEffect(() => {
    if (!userId || !chatId || !projectId) return
    const controller = new AbortController()
    void projectsCodexApi.previewStatus(projectId, controller.signal).then((status) => {
      if (controller.signal.aborted) return
      const basePath = readyCodingPreviewPath(status, projectId)
      // A stable capability URL can serve newly edited files. Publish the
      // event revision only after the owned status confirms actual readiness.
      setSnapshot(basePath ? { userId, chatId, projectId, basePath, revision: refresh } : null)
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
