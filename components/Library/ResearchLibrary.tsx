"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import {
  BookMarked,
  BookTemplate,
  Building2,
  Check,
  ChevronRight,
  FileCheck2,
  FolderPlus,
  GitFork,
  Loader2,
  Network,
  MessageSquare,
  Plus,
  Search,
  Send,
  Share2,
  Tags,
  Trash2,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"
import apiClient, {
  type OrganizationMember,
  type OrganizationSummary,
  type ResearchCollectionCommentRecord,
  type ResearchCollectionRecord,
  type ResearchLibraryEnvelope,
  type ResearchReferenceRecord,
  type ResearchTemplateRecord,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

function authorLine(reference: ResearchReferenceRecord) {
  const names = (reference.authors || []).map((author) => typeof author === "string" ? author : author?.name || "").filter(Boolean)
  if (!names.length) return "Autor no disponible"
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ")
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ResearchLibrary() {
  const searchParams = useSearchParams()
  const [data, setData] = React.useState<ResearchLibraryEnvelope | null>(null)
  const [organizations, setOrganizations] = React.useState<OrganizationSummary[]>([])
  const [organizationId, setOrganizationId] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState("")
  const [collectionId, setCollectionId] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [activeReference, setActiveReference] = React.useState<ResearchReferenceRecord | null>(null)
  const [note, setNote] = React.useState("")
  const [tags, setTags] = React.useState("")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [collectionName, setCollectionName] = React.useState("")
  const [collectionFolder, setCollectionFolder] = React.useState("")
  const [auditOpen, setAuditOpen] = React.useState(false)
  const [auditText, setAuditText] = React.useState("")
  const [auditResult, setAuditResult] = React.useState<any>(null)
  const [graphOpen, setGraphOpen] = React.useState(false)
  const [graph, setGraph] = React.useState<any>(null)
  const [conflictsOpen, setConflictsOpen] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<any[]>([])
  const [syncOpen, setSyncOpen] = React.useState(false)
  const [syncProvider, setSyncProvider] = React.useState<"zotero" | "mendeley">("zotero")
  const [syncUser, setSyncUser] = React.useState("")
  const [syncToken, setSyncToken] = React.useState("")
  const [shareOpen, setShareOpen] = React.useState(false)
  const [shareOrganizationId, setShareOrganizationId] = React.useState("")
  const [shareAccess, setShareAccess] = React.useState<"VIEW" | "EDIT">("EDIT")
  const [sideTab, setSideTab] = React.useState<"reference" | "team">("reference")
  const [comments, setComments] = React.useState<ResearchCollectionCommentRecord[]>([])
  const [commentBody, setCommentBody] = React.useState("")
  const [mentionUserId, setMentionUserId] = React.useState("")
  const [members, setMembers] = React.useState<OrganizationMember[]>([])
  const [commentsLoading, setCommentsLoading] = React.useState(false)
  const [canComment, setCanComment] = React.useState(false)
  const [templatesOpen, setTemplatesOpen] = React.useState(false)
  const [templates, setTemplates] = React.useState<ResearchTemplateRecord[]>([])
  const [templateName, setTemplateName] = React.useState("")
  const [templateQuery, setTemplateQuery] = React.useState("")
  const [templateDescription, setTemplateDescription] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)

  React.useEffect(() => {
    const linkedOrganizationId = searchParams.get("organizationId") || ""
    const linkedCollectionId = searchParams.get("collectionId") || ""
    if (linkedOrganizationId) setOrganizationId(linkedOrganizationId)
    if (linkedCollectionId) {
      setCollectionId(linkedCollectionId)
      setSideTab("team")
    }
  }, [searchParams])

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiClient.getResearchLibrary({
        limit: 100,
        search: search.trim() || undefined,
        collectionId: collectionId || undefined,
        organizationId: organizationId || undefined,
      })
      setData(response)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo cargar la biblioteca científica")
    } finally {
      setLoading(false)
    }
  }, [collectionId, organizationId, search])

  React.useEffect(() => {
    let cancelled = false
    apiClient.listMyOrganizations()
      .then((result) => { if (!cancelled) setOrganizations(result.items || []) })
      .catch(() => { if (!cancelled) setOrganizations([]) })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    const timer = setTimeout(load, 250)
    return () => clearTimeout(timer)
  }, [load])

  React.useEffect(() => {
    setSelectedIds([])
    setActiveReference(null)
  }, [collectionId, organizationId])

  const collections = data?.collections || []
  const references = data?.references || []
  const activeCollection = collections.find((collection) => collection.id === collectionId)
  const activeOrganization = organizations.find((organization) => organization.id === organizationId)
  const selectionPayload = {
    ...(selectedIds.length ? { referenceIds: selectedIds } : (collectionId ? { collectionId } : {})),
    ...(organizationId ? { organizationId } : {}),
  }

  const loadTeamContext = React.useCallback(async () => {
    if (!organizationId || !collectionId) {
      setComments([])
      setMembers([])
      setCanComment(false)
      return
    }
    setCommentsLoading(true)
    try {
      const [commentsResult, membersResult] = await Promise.all([
        apiClient.getResearchCollectionComments(collectionId, organizationId),
        apiClient.listOrganizationMembers(organizationId),
      ])
      setComments(commentsResult.items || [])
      setCanComment(Boolean(commentsResult.canComment))
      setMembers(membersResult.items || [])
    } catch (error: any) {
      toast.error(error?.message || "No se pudo cargar la colaboración")
    } finally {
      setCommentsLoading(false)
    }
  }, [collectionId, organizationId])

  React.useEffect(() => {
    void loadTeamContext()
  }, [loadTeamContext])

  const createCollection = async () => {
    if (!collectionName.trim()) return
    setBusy("collection")
    try {
      const created = await apiClient.createResearchCollection({
        name: collectionName.trim(),
        folder: collectionFolder.trim() || undefined,
        organizationId: organizationId || undefined,
      }) as ResearchCollectionRecord
      setCreateOpen(false)
      setCollectionName("")
      setCollectionFolder("")
      setCollectionId(created.id)
      toast.success("Colección creada")
      await load()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo crear la colección")
    } finally {
      setBusy(null)
    }
  }

  const saveReference = async () => {
    if (!activeReference || activeReference.isOwned === false) return
    setBusy("note")
    try {
      const updated = await apiClient.updateResearchReference(activeReference.id, {
        note: note.trim() || null,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      }) as ResearchReferenceRecord
      setActiveReference(updated)
      toast.success("Anotación guardada")
      await load()
    } finally {
      setBusy(null)
    }
  }

  const exportSelection = async (format: "bibtex" | "ris") => {
    setBusy(format)
    try {
      const blob = await apiClient.exportResearchReferences({ ...selectionPayload, format })
      downloadBlob(blob, `siragpt-references.${format === "bibtex" ? "bib" : "ris"}`)
      toast.success(`Referencias exportadas en ${format === "bibtex" ? "BibTeX" : "RIS"}`)
    } finally {
      setBusy(null)
    }
  }

  const runAudit = async () => {
    setBusy("audit")
    try {
      setAuditResult(await apiClient.auditResearchReferences({ text: auditText, ...selectionPayload }))
    } finally {
      setBusy(null)
    }
  }

  const loadGraph = async () => {
    setBusy("graph")
    setGraphOpen(true)
    try {
      setGraph(await apiClient.getResearchCitationGraph({ ...selectionPayload, limit: 5 }))
    } finally {
      setBusy(null)
    }
  }

  const loadConflicts = async () => {
    setConflictsOpen(true)
    setBusy("conflicts")
    try {
      const result = await apiClient.getResearchReferenceConflicts() as any
      setConflicts(result.items || [])
    } finally {
      setBusy(null)
    }
  }

  const resolveConflict = async (id: string, action: "keep_existing" | "keep_candidate" | "merge") => {
    setBusy(id)
    try {
      await apiClient.resolveResearchReferenceConflict(id, action)
      setConflicts((current) => current.filter((conflict) => conflict.id !== id))
      toast.success("Duplicado resuelto")
      await load()
    } finally {
      setBusy(null)
    }
  }

  const syncCollection = async () => {
    if (!syncToken.trim()) return
    setBusy("sync")
    try {
      const base = { ...selectionPayload, collectionName: activeCollection?.name || "SiraGPT" }
      const result = syncProvider === "zotero"
        ? await apiClient.syncResearchCollectionToZotero({ ...base, apiKey: syncToken.trim(), zoteroUserId: syncUser.trim() })
        : await apiClient.syncResearchCollectionToMendeley({ ...base, accessToken: syncToken.trim() })
      toast.success(`${(result as any).created || 0} referencias enviadas; ${(result as any).skippedDuplicates || 0} duplicadas omitidas`)
      setSyncToken("")
      setSyncOpen(false)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo sincronizar la colección")
    } finally {
      setBusy(null)
    }
  }

  const shareCollection = async () => {
    if (!activeCollection || !shareOrganizationId) return
    setBusy("share")
    try {
      await apiClient.shareResearchCollection(activeCollection.id, shareOrganizationId, shareAccess)
      toast.success("Colección compartida con la Empresa")
      setShareOpen(false)
      setOrganizationId(shareOrganizationId)
      setCollectionId(activeCollection.id)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo compartir la colección")
    } finally {
      setBusy(null)
    }
  }

  const createComment = async () => {
    if (!organizationId || !collectionId || !commentBody.trim()) return
    setBusy("comment")
    try {
      await apiClient.createResearchCollectionComment(collectionId, {
        organizationId,
        body: commentBody.trim(),
        mentionedUserIds: mentionUserId ? [mentionUserId] : [],
      })
      setCommentBody("")
      setMentionUserId("")
      toast.success("Comentario publicado")
      await loadTeamContext()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo publicar el comentario")
    } finally {
      setBusy(null)
    }
  }

  const loadTemplates = async () => {
    if (!organizationId) return
    setTemplatesOpen(true)
    setBusy("templates")
    try {
      const result = await apiClient.getResearchTemplates(organizationId)
      setTemplates(result.items || [])
    } catch (error: any) {
      toast.error(error?.message || "No se pudieron cargar las plantillas")
    } finally {
      setBusy(null)
    }
  }

  const createTemplate = async () => {
    if (!organizationId || !templateName.trim() || !templateQuery.trim()) return
    setBusy("template-create")
    try {
      const created = await apiClient.createResearchTemplate({
        organizationId,
        name: templateName.trim(),
        description: templateDescription.trim() || undefined,
        query: templateQuery.trim(),
      })
      setTemplates((current) => [created, ...current])
      setTemplateName("")
      setTemplateDescription("")
      setTemplateQuery("")
      toast.success("Plantilla guardada para la Empresa")
    } catch (error: any) {
      toast.error(error?.message || "No se pudo crear la plantilla")
    } finally {
      setBusy(null)
    }
  }

  const applyTemplate = (template: ResearchTemplateRecord) => {
    setSearch(template.query)
    setTemplatesOpen(false)
    toast.success(`Plantilla “${template.name}” aplicada`)
  }

  const openReference = (reference: ResearchReferenceRecord) => {
    setActiveReference(reference)
    setNote(reference.note || "")
    setTags((reference.tags || []).join(", "))
    setSideTab("reference")
  }

  return (
    <TooltipProvider>
      <div className="research-library overflow-hidden border border-border/60 bg-background">
        <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{activeOrganization ? `Biblioteca de ${activeOrganization.name}` : "Referencias científicas"}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{activeOrganization ? "Fuentes, comentarios y plantillas compartidas por la Empresa." : "Colecciones privadas, notas, auditoría y exportación sin perder metadatos."}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="research-library-scope">Espacio de biblioteca</label>
            <select
              id="research-library-scope"
              value={organizationId}
              onChange={(event) => { setOrganizationId(event.target.value); setCollectionId(""); setSideTab(event.target.value ? "team" : "reference") }}
              className="h-9 min-w-[190px] border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Mi biblioteca</option>
              {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
            <div className="relative min-w-[220px] flex-1 lg:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar título, revista o nota" className="pl-9" />
            </div>
            {organizationId && <Button variant="outline" onClick={() => void loadTemplates()}><BookTemplate className="mr-2 h-4 w-4" />Plantillas</Button>}
            {!organizationId && activeCollection && organizations.length > 0 && (
              <Button variant="outline" onClick={() => { setShareOrganizationId(organizations[0]?.id || ""); setShareOpen(true) }}>
                <Share2 className="mr-2 h-4 w-4" />Compartir
              </Button>
            )}
            <Button variant="outline" onClick={() => setCreateOpen(true)}><FolderPlus className="mr-2 h-4 w-4" />Colección</Button>
          </div>
        </div>

        <div className="grid min-h-[520px] lg:grid-cols-[230px_minmax(0,1fr)_300px]">
          <aside className="border-b border-border/60 p-3 lg:border-b-0 lg:border-r">
            <button type="button" onClick={() => setCollectionId("")} className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${!collectionId ? "bg-muted font-medium" : "hover:bg-muted/60"}`}>
              <span className="flex items-center gap-2"><BookMarked className="h-4 w-4" />Todas</span><span>{data?.total || 0}</span>
            </button>
            <div className="mt-3 px-3 text-[11px] font-semibold uppercase text-muted-foreground">{organizationId ? "Colecciones de la Empresa" : "Colecciones"}</div>
            <div className="mt-1 space-y-0.5">
              {collections.map((collection) => (
                <button key={collection.id} type="button" onClick={() => { setCollectionId(collection.id); if (organizationId) setSideTab("team") }} className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${collectionId === collection.id ? "bg-muted font-medium" : "hover:bg-muted/60"}`}>
                  <span className="min-w-0 truncate">{collection.name}</span>
                  <span className="ml-2 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {organizationId && (collection._count?.comments || 0) > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{collection._count?.comments}</span>}
                    <span>{collection._count?.items || 0}</span>
                  </span>
                </button>
              ))}
            </div>
            {(data?.pendingConflicts || 0) > 0 && (
              <button type="button" onClick={loadConflicts} className="mt-4 flex w-full items-center justify-between border-t border-border/60 px-3 pt-3 text-left text-sm text-amber-700 dark:text-amber-300">
                <span className="flex items-center gap-2"><GitFork className="h-4 w-4" />Duplicados</span><span>{data?.pendingConflicts}</span>
              </button>
            )}
          </aside>

          <section className="min-w-0 border-b border-border/60 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
              <div className="text-sm text-muted-foreground">{activeCollection?.name || "Todas las referencias"} · {references.length}</div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => exportSelection("bibtex")} disabled={busy !== null || references.length === 0}>BibTeX</Button>
                <Button size="sm" variant="ghost" onClick={() => exportSelection("ris")} disabled={busy !== null || references.length === 0}>RIS</Button>
                <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Auditar referencias" onClick={() => setAuditOpen(true)}><FileCheck2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Auditar citas</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Explorar grafo de citación" onClick={loadGraph} disabled={references.length === 0}><Network className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Grafo de citación</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Sincronizar gestor bibliográfico" onClick={() => setSyncOpen(true)} disabled={references.length === 0}><Send className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zotero o Mendeley</TooltipContent></Tooltip>
              </div>
            </div>
            {loading ? (
              <div className="flex h-72 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : references.length === 0 ? (
              <div className="flex h-72 flex-col items-center justify-center px-6 text-center"><BookMarked className="h-8 w-8 text-muted-foreground" /><p className="mt-3 font-medium">Aún no hay referencias guardadas</p><p className="mt-1 text-sm text-muted-foreground">Guarda las fuentes finalistas desde la actividad de una búsqueda científica.</p></div>
            ) : (
              <div className="divide-y divide-border/60">
                {references.map((reference) => {
                  const checked = selectedIds.includes(reference.id)
                  return (
                    <div key={reference.id} className={`flex gap-3 px-4 py-3 ${activeReference?.id === reference.id ? "bg-muted/45" : "hover:bg-muted/25"}`}>
                      <button type="button" aria-label={checked ? "Quitar de la selección" : "Seleccionar referencia"} onClick={() => setSelectedIds((current) => checked ? current.filter((id) => id !== reference.id) : [...current, reference.id])} className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center border ${checked ? "border-foreground bg-foreground text-background" : "border-border"}`}>{checked && <Check className="h-3 w-3" />}</button>
                      <button type="button" onClick={() => openReference(reference)} className="min-w-0 flex-1 text-left">
                        <div className="line-clamp-2 text-sm font-medium leading-5">{reference.title}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{authorLine(reference)}{reference.year ? ` · ${reference.year}` : ""}{reference.venue ? ` · ${reference.venue}` : ""}</div>
                        <div className="mt-1.5 flex flex-wrap gap-1">{reference.tags.slice(0, 4).map((tag) => <span key={tag} className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>)}</div>
                      </button>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <aside className="p-4">
            {organizationId && collectionId && (
              <div className="mb-4 grid grid-cols-2 border border-border/60 p-1" role="tablist" aria-label="Detalle de colección">
                <button type="button" role="tab" aria-selected={sideTab === "team"} onClick={() => setSideTab("team")} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs ${sideTab === "team" ? "bg-foreground text-background" : "text-muted-foreground"}`}><MessageSquare className="h-3.5 w-3.5" />Equipo</button>
                <button type="button" role="tab" aria-selected={sideTab === "reference"} onClick={() => setSideTab("reference")} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs ${sideTab === "reference" ? "bg-foreground text-background" : "text-muted-foreground"}`}><BookMarked className="h-3.5 w-3.5" />Referencia</button>
              </div>
            )}

            {organizationId && collectionId && sideTab === "team" ? (
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{activeCollection?.name || "Colección compartida"}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{activeCollection?.accessLevel === "EDIT" ? "Edición compartida" : "Lectura compartida"}</p>
                  </div>
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="mt-4 max-h-72 divide-y divide-border/60 overflow-auto border-y border-border/60">
                  {commentsLoading ? (
                    <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
                  ) : comments.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">No hay comentarios. Registra decisiones, observaciones o tareas para el equipo.</p>
                  ) : comments.map((comment) => (
                    <div key={comment.id} className="py-3">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted"><UserRound className="h-3.5 w-3.5" /></span>
                        <span className="font-medium">{comment.author?.name || "Miembro"}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">{new Date(comment.createdAt).toLocaleDateString()}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-foreground/90">{comment.body}</p>
                    </div>
                  ))}
                </div>
                {canComment && (
                  <div className="mt-4">
                    <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} rows={4} className="w-full resize-y border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Añade una decisión, observación o pregunta…" />
                    <label className="mt-2 block text-[11px] font-medium text-muted-foreground" htmlFor="research-comment-mention">Mencionar a un miembro</label>
                    <select id="research-comment-mention" value={mentionUserId} onChange={(event) => setMentionUserId(event.target.value)} className="mt-1 h-9 w-full border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring">
                      <option value="">Sin mención</option>
                      {members.filter((member) => member.user).map((member) => <option key={member.user!.id} value={member.user!.id}>{member.user!.name} · {member.role}</option>)}
                    </select>
                    <Button className="mt-2 w-full" onClick={() => void createComment()} disabled={!commentBody.trim() || busy === "comment"}>{busy === "comment" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquare className="mr-2 h-4 w-4" />}Publicar comentario</Button>
                  </div>
                )}
              </div>
            ) : activeReference ? (
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="line-clamp-3 text-sm font-semibold leading-5">{activeReference.title}</h3>
                  {activeReference.isOwned !== false && <Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" aria-label="Eliminar referencia" onClick={async () => { await apiClient.deleteResearchReference(activeReference.id); setActiveReference(null); await load() }}><Trash2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Eliminar</TooltipContent></Tooltip>}
                </div>
                {activeReference.doi && <a href={`https://doi.org/${activeReference.doi}`} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-sky-700 hover:underline dark:text-sky-300">DOI {activeReference.doi}</a>}
                {activeReference.isOwned === false ? (
                  <p className="mt-5 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">Referencia aportada por otro miembro. Sus notas privadas no se comparten; usa la conversación de la colección para colaborar.</p>
                ) : (
                  <>
                    <label className="mt-5 block text-xs font-medium">Nota privada</label>
                    <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={7} className="mt-1 w-full resize-y border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Hallazgos, decisiones o preguntas…" />
                    <label className="mt-4 flex items-center gap-1.5 text-xs font-medium"><Tags className="h-3.5 w-3.5" />Etiquetas</label>
                    <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="metodología, capítulo 2" className="mt-1" />
                    <Button className="mt-4 w-full" onClick={saveReference} disabled={busy === "note"}>{busy === "note" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Guardar cambios</Button>
                  </>
                )}
              </div>
            ) : <div className="flex h-full min-h-48 items-center justify-center text-center text-sm text-muted-foreground">{organizationId && !collectionId ? "Selecciona una colección compartida para ver la actividad del equipo." : "Selecciona una referencia para revisar sus metadatos, notas y etiquetas."}</div>}
          </aside>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Nueva colección</DialogTitle><DialogDescription>{activeOrganization ? `Se compartirá con ${activeOrganization.name} y sus miembros podrán editarla.` : "Agrupa referencias por investigación, cliente o capítulo."}</DialogDescription></DialogHeader><Input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="Nombre de la colección" /><Input value={collectionFolder} onChange={(event) => setCollectionFolder(event.target.value)} placeholder="Carpeta opcional" /><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button><Button onClick={createCollection} disabled={!collectionName.trim() || busy === "collection"}><Plus className="mr-2 h-4 w-4" />Crear</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}><DialogContent><DialogHeader><DialogTitle>Compartir colección</DialogTitle><DialogDescription>Publica “{activeCollection?.name}” en la biblioteca de una Empresa sin duplicar referencias.</DialogDescription></DialogHeader><label className="text-xs font-medium" htmlFor="share-research-org">Empresa</label><select id="share-research-org" value={shareOrganizationId} onChange={(event) => setShareOrganizationId(event.target.value)} className="h-10 w-full border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring">{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select><label className="text-xs font-medium" htmlFor="share-research-access">Permiso</label><select id="share-research-access" value={shareAccess} onChange={(event) => setShareAccess(event.target.value as "VIEW" | "EDIT")} className="h-10 w-full border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"><option value="EDIT">Miembros pueden editar</option><option value="VIEW">Solo lectura</option></select><DialogFooter><Button variant="outline" onClick={() => setShareOpen(false)}>Cancelar</Button><Button onClick={() => void shareCollection()} disabled={!shareOrganizationId || busy === "share"}>{busy === "share" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Share2 className="mr-2 h-4 w-4" />}Compartir</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Plantillas de investigación</DialogTitle><DialogDescription>Consultas y criterios reutilizables para mantener la misma metodología en toda la Empresa.</DialogDescription></DialogHeader><div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]"><div className="max-h-[48vh] divide-y divide-border overflow-auto border border-border">{busy === "templates" ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : templates.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">Aún no hay plantillas compartidas.</p> : templates.map((template) => <div key={template.id} className="p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{template.name}</span>{template.isDefault && <span className="bg-muted px-1.5 py-0.5 text-[10px]">Predeterminada</span>}</div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.description || template.query}</p><p className="mt-2 line-clamp-2 text-xs">{template.query}</p></div><Button size="sm" variant="outline" onClick={() => applyTemplate(template)}>Usar</Button></div></div>)}</div><div className="space-y-3"><div><div className="text-sm font-semibold">Nueva plantilla</div><p className="mt-0.5 text-xs text-muted-foreground">Guarda una consulta científica para repetirla con precisión.</p></div><Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Nombre" /><textarea value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} rows={5} className="w-full resize-y border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Consulta o protocolo de búsqueda" /><textarea value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} rows={3} className="w-full resize-y border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Descripción opcional" /><Button className="w-full" onClick={() => void createTemplate()} disabled={!templateName.trim() || !templateQuery.trim() || busy === "template-create"}>{busy === "template-create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BookTemplate className="mr-2 h-4 w-4" />}Guardar plantilla</Button></div></div></DialogContent></Dialog>

      <Dialog open={auditOpen} onOpenChange={setAuditOpen}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Auditoría de referencias</DialogTitle><DialogDescription>Pega el texto para detectar citas huérfanas, DOI inválidos y referencias no utilizadas.</DialogDescription></DialogHeader><textarea value={auditText} onChange={(event) => setAuditText(event.target.value)} rows={10} className="w-full resize-y border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Texto con citas [1] o (Autor, 2024)…" />{auditResult && <div className="grid grid-cols-2 gap-2 border border-border/60 p-3 text-sm sm:grid-cols-4"><span>Usadas: {auditResult.counts?.used}</span><span>No usadas: {auditResult.counts?.unused}</span><span>Huérfanas: {auditResult.counts?.orphanCitations}</span><span>DOI inválidos: {auditResult.counts?.invalidDois}</span></div>}<DialogFooter><Button onClick={runAudit} disabled={!auditText.trim() || busy === "audit"}><FileCheck2 className="mr-2 h-4 w-4" />Auditar</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={graphOpen} onOpenChange={setGraphOpen}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Grafo de citación</DialogTitle><DialogDescription>Trabajos citados y citantes recuperados desde OpenAlex.</DialogDescription></DialogHeader>{busy === "graph" ? <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : <div className="max-h-[55vh] overflow-auto border border-border/60"><div className="grid grid-cols-3 border-b p-3 text-sm"><span>Nodos: {graph?.meta?.nodeCount || 0}</span><span>Conexiones: {graph?.meta?.edgeCount || 0}</span><span>Semillas: {graph?.meta?.seeds || 0}</span></div><div className="divide-y">{(graph?.nodes || []).slice(0, 80).map((node: any) => <div key={node.id} className="flex items-center justify-between gap-3 p-3 text-sm"><span className="line-clamp-1">{node.title}</span><span className="shrink-0 text-xs text-muted-foreground">{node.role} · {node.citedByCount || 0} citas</span></div>)}</div></div>}</DialogContent></Dialog>

      <Dialog open={conflictsOpen} onOpenChange={setConflictsOpen}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Resolver duplicados</DialogTitle><DialogDescription>Compara registros con el mismo título y DOI distintos antes de fusionarlos.</DialogDescription></DialogHeader><div className="max-h-[55vh] divide-y overflow-auto border border-border/60">{conflicts.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">No hay conflictos pendientes.</p> : conflicts.map((conflict) => <div key={conflict.id} className="p-4"><div className="grid gap-3 text-sm sm:grid-cols-2"><div><div className="font-medium">{conflict.existing?.title}</div><div className="text-xs text-muted-foreground">DOI {conflict.existing?.doi || "sin DOI"}</div></div><div><div className="font-medium">{conflict.candidate?.title}</div><div className="text-xs text-muted-foreground">DOI {conflict.candidate?.doi || "sin DOI"}</div></div></div><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => resolveConflict(conflict.id, "keep_existing")}>Conservar primero</Button><Button size="sm" variant="outline" onClick={() => resolveConflict(conflict.id, "keep_candidate")}>Conservar segundo</Button><Button size="sm" onClick={() => resolveConflict(conflict.id, "merge")}>Fusionar metadatos</Button></div></div>)}</div></DialogContent></Dialog>

      <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent><DialogHeader><DialogTitle>Enviar a gestor bibliográfico</DialogTitle><DialogDescription>Las credenciales se usan solo para esta sincronización y no se guardan.</DialogDescription></DialogHeader><div className="grid grid-cols-2 border border-border/60 p-1"><button type="button" onClick={() => setSyncProvider("zotero")} className={`px-3 py-2 text-sm ${syncProvider === "zotero" ? "bg-foreground text-background" : ""}`}>Zotero</button><button type="button" onClick={() => setSyncProvider("mendeley")} className={`px-3 py-2 text-sm ${syncProvider === "mendeley" ? "bg-foreground text-background" : ""}`}>Mendeley</button></div>{syncProvider === "zotero" && <Input value={syncUser} onChange={(event) => setSyncUser(event.target.value)} placeholder="ID de usuario Zotero" />}<Input type="password" value={syncToken} onChange={(event) => setSyncToken(event.target.value)} placeholder={syncProvider === "zotero" ? "API key de Zotero" : "Access token de Mendeley"} /><DialogFooter><Button onClick={syncCollection} disabled={!syncToken.trim() || (syncProvider === "zotero" && !syncUser.trim()) || busy === "sync"}><Send className="mr-2 h-4 w-4" />Sincronizar</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  )
}
