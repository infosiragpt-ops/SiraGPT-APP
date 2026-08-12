import type { AgentDepartmentDefinition } from "./code-agent-company"
import type { CodeChatSession } from "./code-chat-sessions"
import type { AgentOfficeWorker } from "./agent-office-model"
import type {
  CodexMissionEvidenceLedger,
  CodexMissionEvidenceRecord,
  CodexRun,
} from "./codex/codex-api"

export type CompanyFileLike = {
  path: string
  content: string
  updatedAt: number
}

export type CompanyAgentFileArtifact = {
  id: string
  name: string
  path: string
  content: string
  updatedAt: number
  departmentId: string
  departmentName: string
  agentId: string
  agentName: string
  kind: "file" | "report"
  extension: string
  source: "workspace" | "session" | "agent-report" | "mission" | "activity-report"
}

export type CompanyAgentFileGroup = {
  id: string
  name: string
  departmentId: string
  departmentName: string
  artifacts: CompanyAgentFileArtifact[]
  reportCount: number
  fileCount: number
}

function normalizeHaystack(value: string): string {
  return String(value || "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

function compactLine(value: string, fallback: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim() || fallback
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function safeSlug(value: string, fallback = "agente"): string {
  const slug = normalizeHaystack(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || fallback
}

function artifactExtension(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || "txt"
}

function matchDepartment(
  haystack: string,
  departments: readonly AgentDepartmentDefinition[],
): AgentDepartmentDefinition | null {
  const source = normalizeHaystack(haystack)
  return (
    departments.find((department) => {
      const candidates = [department.id, department.name, ...department.keywords].map(normalizeHaystack)
      return candidates.some((candidate) => candidate.length > 2 && source.includes(candidate))
    }) || null
  )
}

function seatAgentsForDepartment(department: AgentDepartmentDefinition): Array<{
  id: string
  name: string
  departmentId: string
  departmentName: string
  updatedAt: number
  statusLabel: string
  task: string
  active: boolean
}> {
  const desired = Math.max(1, Math.min(48, Number(department.desiredAgents) || 1))
  return Array.from({ length: desired }, (_, index) => {
    const seat = index + 1
    return {
      id: `seat:${department.id}:${seat}`,
      name: `${department.name} · Agente ${String(seat).padStart(2, "0")}`,
      departmentId: department.id,
      departmentName: department.name,
      updatedAt: 0,
      statusLabel: "Disponible",
      task: department.description,
      active: false,
    }
  })
}

function workerAgents(workers: readonly AgentOfficeWorker[]) {
  return workers.map((worker) => ({
    id: worker.id,
    name: worker.name,
    departmentId: worker.departmentId,
    departmentName: worker.departmentName,
    updatedAt: worker.updatedAt,
    statusLabel: worker.statusLabel,
    task: worker.task,
    active: worker.active,
    sessionId: worker.sessionId,
    runId: worker.runId,
  }))
}

export function resolveCompanyAgents({
  departments,
  workers = [],
}: {
  departments: readonly AgentDepartmentDefinition[]
  workers?: readonly AgentOfficeWorker[]
}) {
  const live = workerAgents(workers)
  const byDepartment = new Map<string, typeof live>()
  for (const worker of live) {
    const list = byDepartment.get(worker.departmentId) || []
    list.push(worker)
    byDepartment.set(worker.departmentId, list)
  }

  const agents: Array<{
    id: string
    name: string
    departmentId: string
    departmentName: string
    updatedAt: number
    statusLabel: string
    task: string
    active: boolean
    sessionId?: string | null
    runId?: string | null
  }> = []

  for (const department of departments) {
    if (department.enabled === false) continue
    const existing = byDepartment.get(department.id) || []
    if (existing.length > 0) {
      agents.push(...existing)
      continue
    }
    agents.push(...seatAgentsForDepartment(department))
  }

  // Keep any workers whose department is no longer listed.
  for (const worker of live) {
    if (!agents.some((agent) => agent.id === worker.id)) agents.push(worker)
  }

  return agents.sort((a, b) => {
    const dept = a.departmentName.localeCompare(b.departmentName, "es")
    if (dept !== 0) return dept
    return a.name.localeCompare(b.name, "es")
  })
}

function scoreAgentMatch(
  agent: { id: string; name: string; departmentId: string; departmentName: string; sessionId?: string | null; runId?: string | null },
  haystack: string,
  departmentId: string | null,
): number {
  let score = 0
  const source = normalizeHaystack(haystack)
  if (departmentId && agent.departmentId === departmentId) score += 4
  if (agent.runId && source.includes(normalizeHaystack(agent.runId))) score += 12
  if (agent.sessionId && source.includes(normalizeHaystack(agent.sessionId))) score += 10
  const agentName = normalizeHaystack(agent.name)
  if (agentName.length > 2 && source.includes(agentName)) score += 8
  const deptName = normalizeHaystack(agent.departmentName)
  if (deptName.length > 2 && source.includes(deptName)) score += 2
  return score
}

function pickAgentForHaystack<T extends {
  id: string
  name: string
  departmentId: string
  departmentName: string
  sessionId?: string | null
  runId?: string | null
}>(
  agents: readonly T[],
  haystack: string,
  departmentId: string | null,
): T | null {
  let best: T | null = null
  let bestScore = 0
  for (const agent of agents) {
    const score = scoreAgentMatch(agent, haystack, departmentId)
    if (score > bestScore) {
      best = agent
      bestScore = score
    }
  }
  if (best) return best
  if (!departmentId) return null
  return agents.find((agent) => agent.departmentId === departmentId) || null
}

function formatTimestamp(value: number): string {
  if (!value) return "sin actividad"
  try {
    return new Date(value).toLocaleString("es-PE", {
      dateStyle: "medium",
      timeStyle: "short",
    })
  } catch {
    return new Date(value).toISOString()
  }
}

function buildAgentReportMarkdown({
  companyName,
  agent,
  files,
  missions,
  sessions,
}: {
  companyName: string
  agent: {
    id: string
    name: string
    departmentId: string
    departmentName: string
    updatedAt: number
    statusLabel: string
    task: string
    active: boolean
  }
  files: CompanyAgentFileArtifact[]
  missions: CodexMissionEvidenceRecord[]
  sessions: CodeChatSession[]
}): string {
  const fileLines = files.length
    ? files.map((file) => `- \`${file.path}\` (${file.extension}, ${file.content.length} B)`).join("\n")
    : "- Sin archivos de workspace atribuidos todavía."
  const missionLines = missions.length
    ? missions.map((mission) => {
      const deliverables = mission.deliverables.map((item: { name: string }) => item.name).join(", ") || "sin entregables"
      return `- **${mission.missionTitle}** · ${mission.status} · CEO: ${mission.ceoReview.status}\n  - ${compactLine(mission.summary, "Sin resumen", 220)}\n  - Entregables: ${deliverables}`
    }).join("\n")
    : "- Sin misiones cerradas todavía."
  const sessionLines = sessions.length
    ? sessions.map((session) => {
      const last = [...session.turns].reverse().find((turn) => turn.content.trim())
      return `- **${session.title}** · actualizado ${formatTimestamp(session.updatedAt)}\n  - ${compactLine(last?.content || "Sin turnos", "Sin turnos", 220)}`
    }).join("\n")
    : "- Sin chats de agente todavía."

  return [
    `# Reporte de archivos · ${agent.name}`,
    "",
    `- Empresa: **${companyName}**`,
    `- Departamento: **${agent.departmentName}**`,
    `- Estado: **${agent.statusLabel}**${agent.active ? " (activo)" : ""}`,
    `- Última actividad: ${formatTimestamp(agent.updatedAt)}`,
    `- Tarea actual: ${compactLine(agent.task, agent.departmentName, 240)}`,
    "",
    "## Archivos del agente",
    fileLines,
    "",
    "## Memorias / chats",
    sessionLines,
    "",
    "## Evidencia de misiones",
    missionLines,
    "",
    "## Resumen",
    `- Archivos: ${files.length}`,
    `- Memorias: ${sessions.length}`,
    `- Misiones: ${missions.length}`,
    `- Generado automáticamente por SiraGPT Archivos (uno por agente).`,
    "",
  ].join("\n")
}

export function buildCompanyAgentFileArtifacts({
  companyName,
  departments,
  files,
  sessions,
  runs = [],
  workers = [],
  missionEvidence = null,
  rootSessionId = null,
}: {
  companyName: string
  departments: readonly AgentDepartmentDefinition[]
  files: Record<string, CompanyFileLike> | CompanyFileLike[]
  sessions: readonly CodeChatSession[]
  runs?: readonly CodexRun[]
  workers?: readonly AgentOfficeWorker[]
  missionEvidence?: CodexMissionEvidenceLedger | null
  rootSessionId?: string | null
}): {
  agents: ReturnType<typeof resolveCompanyAgents>
  artifacts: CompanyAgentFileArtifact[]
  groups: CompanyAgentFileGroup[]
} {
  const agents = resolveCompanyAgents({ departments, workers })
  const fileList = Array.isArray(files) ? files : Object.values(files)
  const missions = missionEvidence?.records || []

  const workspaceArtifacts: CompanyAgentFileArtifact[] = fileList.map((file) => {
    const department = matchDepartment(file.path, departments)
    const agent = pickAgentForHaystack(
      agents,
      `${file.path} ${department?.name || ""}`,
      department?.id || null,
    )
    return {
      id: `file:${file.path}`,
      name: file.path.split("/").pop() || file.path,
      path: file.path,
      content: file.content,
      updatedAt: file.updatedAt,
      departmentId: agent?.departmentId || department?.id || "workspace",
      departmentName: agent?.departmentName || department?.name || "Espacio de trabajo",
      agentId: agent?.id || "workspace",
      agentName: agent?.name || "Espacio de trabajo",
      kind: "file" as const,
      extension: artifactExtension(file.path),
      source: "workspace" as const,
    }
  })

  const sessionArtifacts: CompanyAgentFileArtifact[] = sessions.flatMap((session) => {
    const result = [...session.turns].reverse().find(
      (turn) => turn.role === "assistant" && !turn.streaming && turn.content.trim(),
    )
    if (!result) return []
    const department = departments.find((candidate) => candidate.id === session.departmentId)
      || matchDepartment(`${session.title} ${result.agentLabel || ""}`, departments)
    const agent = pickAgentForHaystack(
      agents,
      `${session.id} ${session.title} ${result.agentLabel || ""}`,
      department?.id || null,
    )
    const safeTitle = session.title
      .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 70) || "memoria"
    return [{
      id: `report:session:${session.id}`,
      name: `${safeTitle}.md`,
      path: `Agentes/${agent?.name || "Espacio de trabajo"}/Memorias/${safeTitle}.md`,
      content: result.content,
      updatedAt: session.updatedAt,
      departmentId: agent?.departmentId || department?.id || "workspace",
      departmentName: agent?.departmentName || department?.name || "Espacio de trabajo",
      agentId: agent?.id || "workspace",
      agentName: agent?.name || "Espacio de trabajo",
      kind: "report" as const,
      extension: "md",
      source: "session" as const,
    }]
  })

  const missionArtifacts: CompanyAgentFileArtifact[] = missions.flatMap((mission) => {
    const department = matchDepartment(`${mission.department} ${mission.author}`, departments)
    const agent = pickAgentForHaystack(
      agents,
      `${mission.runId || ""} ${mission.author} ${mission.department} ${mission.missionTitle}`,
      department?.id || null,
    )
    const title = safeSlug(mission.missionTitle, "mision")
    const content = [
      `# ${mission.missionTitle}`,
      "",
      `- Departamento: ${mission.department}`,
      `- Autor: ${mission.author}`,
      `- Estado: ${mission.status}`,
      `- Revisión CEO: ${mission.ceoReview.status}`,
      "",
      mission.summary || "Sin resumen.",
      "",
      "## Entregables",
      ...(mission.deliverables.length
        ? mission.deliverables.map((item: { name: string; ref: string | null }) => `- ${item.name}${item.ref ? ` (\`${item.ref}\`)` : ""}`)
        : ["- Sin entregables"]),
      "",
      "## Evidencia",
      ...(mission.evidence.length
        ? mission.evidence.map((item: { label: string; detail: string }) => `- **${item.label}**: ${item.detail}`)
        : ["- Sin evidencia"]),
      "",
    ].join("\n")
    return [{
      id: `report:mission:${mission.id}`,
      name: `${title}.md`,
      path: `Agentes/${agent?.name || "Espacio de trabajo"}/Misiones/${title}.md`,
      content,
      updatedAt: Date.parse(mission.updatedAt || mission.createdAt) || Date.now(),
      departmentId: agent?.departmentId || department?.id || "workspace",
      departmentName: agent?.departmentName || department?.name || "Espacio de trabajo",
      agentId: agent?.id || "workspace",
      agentName: agent?.name || "Espacio de trabajo",
      kind: "report" as const,
      extension: "md",
      source: "mission" as const,
    }]
  })

  const activityReportArtifacts: CompanyAgentFileArtifact[] = (missionEvidence?.reports || []).map((report) => {
    const agent = agents.find((candidate) => candidate.departmentId === "ceo-office") || agents[0]
    const title = safeSlug(report.title, "resumen-actividad")
    const content = [
      `# ${report.title}`,
      "",
      report.summary || "Sin resumen.",
      "",
      `- Autor: ${report.author || "CEO Office"}`,
      `- Periodo: ${report.period.from} → ${report.period.to}`,
      `- Estado: ${report.status}`,
      `- Misiones: ${report.counts.missions}`,
      `- Completadas: ${report.counts.completed}`,
      `- Bloqueadas: ${report.counts.blocked}`,
      `- Pendientes de revisión: ${report.counts.pendingReview}`,
      `- Aprobadas: ${report.counts.approved}`,
      `- Entrega: ${report.delivery.status}`,
      ...(report.contentHash ? [`- Hash: ${report.contentHash}`] : []),
      "",
    ].join("\n")
    return {
      id: `report:activity:${report.id}`,
      name: `${report.title}.md`,
      path: `Agentes/${agent?.name || "CEO Office"}/Reportes/${title}.md`,
      content,
      updatedAt: Date.parse(report.createdAt) || Date.now(),
      departmentId: agent?.departmentId || "ceo-office",
      departmentName: agent?.departmentName || "CEO Office",
      agentId: agent?.id || "ceo-office",
      agentName: agent?.name || report.author || "CEO Office",
      kind: "report" as const,
      extension: "md",
      source: "activity-report" as const,
    }
  })

  // Touch agents with run activity timestamps when available.
  const runById = new Map(runs.map((run) => [run.id, run]))
  for (const agent of agents) {
    if (!agent.runId) continue
    const run = runById.get(agent.runId)
    if (!run) continue
    const stamp = Date.parse(String(run.finishedAt || run.startedAt || run.createdAt || "")) || 0
    if (stamp > agent.updatedAt) agent.updatedAt = stamp
  }
  if (rootSessionId) {
    // no-op: root id reserved for future CEO-only filtering
  }

  const ownedFilesByAgent = new Map<string, CompanyAgentFileArtifact[]>()
  for (const artifact of workspaceArtifacts) {
    const list = ownedFilesByAgent.get(artifact.agentId) || []
    list.push(artifact)
    ownedFilesByAgent.set(artifact.agentId, list)
  }
  const ownedSessionsByAgent = new Map<string, CodeChatSession[]>()
  for (const session of sessions) {
    const department = departments.find((candidate) => candidate.id === session.departmentId)
      || matchDepartment(session.title, departments)
    const agent = pickAgentForHaystack(
      agents,
      `${session.id} ${session.title}`,
      department?.id || null,
    )
    if (!agent) continue
    const list = ownedSessionsByAgent.get(agent.id) || []
    list.push(session)
    ownedSessionsByAgent.set(agent.id, list)
  }
  const ownedMissionsByAgent = new Map<string, CodexMissionEvidenceRecord[]>()
  for (const mission of missions) {
    const department = matchDepartment(`${mission.department} ${mission.author}`, departments)
    const agent = pickAgentForHaystack(
      agents,
      `${mission.runId || ""} ${mission.author} ${mission.department} ${mission.missionTitle}`,
      department?.id || null,
    )
    if (!agent) continue
    const list = ownedMissionsByAgent.get(agent.id) || []
    list.push(mission)
    ownedMissionsByAgent.set(agent.id, list)
  }

  const agentReports: CompanyAgentFileArtifact[] = agents.map((agent) => {
    const agentFiles = ownedFilesByAgent.get(agent.id) || []
    const agentSessions = ownedSessionsByAgent.get(agent.id) || []
    const agentMissions = ownedMissionsByAgent.get(agent.id) || []
    const updatedAt = Math.max(
      agent.updatedAt || 0,
      ...agentFiles.map((item) => item.updatedAt),
      ...agentSessions.map((item) => item.updatedAt),
      ...agentMissions.map((item) => Date.parse(item.updatedAt || item.createdAt) || 0),
      1,
    )
    const slug = safeSlug(agent.name)
    return {
      id: `report:agent:${agent.id}`,
      name: `reporte-archivos-${slug}.md`,
      path: `Agentes/${agent.name}/reporte-archivos.md`,
      content: buildAgentReportMarkdown({
        companyName,
        agent,
        files: agentFiles,
        missions: agentMissions,
        sessions: agentSessions,
      }),
      updatedAt,
      departmentId: agent.departmentId,
      departmentName: agent.departmentName,
      agentId: agent.id,
      agentName: agent.name,
      kind: "report" as const,
      extension: "md",
      source: "agent-report" as const,
    }
  })

  const artifacts = [
    ...agentReports,
    ...activityReportArtifacts,
    ...missionArtifacts,
    ...sessionArtifacts,
    ...workspaceArtifacts,
  ].sort((a, b) => b.updatedAt - a.updatedAt)

  const groupsMap = new Map<string, CompanyAgentFileGroup>()
  for (const agent of agents) {
    groupsMap.set(agent.id, {
      id: agent.id,
      name: agent.name,
      departmentId: agent.departmentId,
      departmentName: agent.departmentName,
      artifacts: [],
      reportCount: 0,
      fileCount: 0,
    })
  }
  for (const artifact of artifacts) {
    const group = groupsMap.get(artifact.agentId) || {
      id: artifact.agentId,
      name: artifact.agentName,
      departmentId: artifact.departmentId,
      departmentName: artifact.departmentName,
      artifacts: [],
      reportCount: 0,
      fileCount: 0,
    }
    group.artifacts.push(artifact)
    if (artifact.kind === "report") group.reportCount += 1
    else group.fileCount += 1
    groupsMap.set(artifact.agentId, group)
  }

  const groups = [...groupsMap.values()]
    .map((group) => ({
      ...group,
      artifacts: [...group.artifacts].sort((a, b) => {
        // Keep the agent report first inside each folder.
        if (a.source === "agent-report" && b.source !== "agent-report") return -1
        if (b.source === "agent-report" && a.source !== "agent-report") return 1
        return b.updatedAt - a.updatedAt
      }),
    }))
    .sort((a, b) => {
      const dept = a.departmentName.localeCompare(b.departmentName, "es")
      if (dept !== 0) return dept
      return a.name.localeCompare(b.name, "es")
    })

  return { agents, artifacts, groups }
}
