"use client"

import { authenticatedFetch } from "./authenticated-fetch"

/**
 * project-documents-service — CRUD client for ProjectDocument rows.
 *
 * Mirrors the style of lib/projects-service.ts (localStorage JWT,
 * credentials:include) so the app's fetch conventions stay uniform.
 * Auto-save on the editor page uses updateDebounced() so we don't
 * hammer the backend on every keystroke.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface ProjectDocument {
  id: string
  projectId: string
  title: string
  content: string
  meta?: Record<string, any> | null
  createdAt: string
  updatedAt: string
}

export interface ProjectDocumentSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  snippet?: string
  meta?: Record<string, any> | null
}

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.error || msg
    } catch { /* non-JSON body */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const projectDocumentsService = {
  async list(projectId: string): Promise<ProjectDocumentSummary[]> {
    const res = await authenticatedFetch(`${API_ROOT}/projects/${projectId}/documents`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ documents: ProjectDocumentSummary[] }>(res)
    return json.documents
  },

  async get(projectId: string, docId: string): Promise<ProjectDocument> {
    const res = await authenticatedFetch(`${API_ROOT}/projects/${projectId}/documents/${docId}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ document: ProjectDocument }>(res)
    return json.document
  },

  async create(projectId: string, body: { title?: string; content?: string }): Promise<ProjectDocument> {
    const res = await authenticatedFetch(`${API_ROOT}/projects/${projectId}/documents`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    const json = await handle<{ document: ProjectDocument }>(res)
    return json.document
  },

  async update(projectId: string, docId: string, body: { title?: string; content?: string; meta?: any }): Promise<ProjectDocument> {
    const res = await authenticatedFetch(`${API_ROOT}/projects/${projectId}/documents/${docId}`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    const json = await handle<{ document: ProjectDocument }>(res)
    return json.document
  },

  async remove(projectId: string, docId: string): Promise<void> {
    const res = await authenticatedFetch(`${API_ROOT}/projects/${projectId}/documents/${docId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ deleted: boolean }>(res)
  },
}
