// Autonomous-company profile, resources, operations, governance, and evidence.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexActivityReport,
  CodexBusinessAudit,
  CodexCompanyCapacity,
  CodexCompanyContext,
  CodexCompanyDepartment,
  CodexCompanyInboxItem,
  CodexCompanyLead,
  CodexCompanyOperations,
  CodexCompanyProfilePatch,
  CodexCompanyResourceState,
  CodexDepartmentPool,
  CodexExternalAction,
  CodexMissionEvidenceLedger,
  CodexMissionEvidenceRecord,
  CodexMissionReviewStatus,
  CodexObjectivePortfolio,
  CodexObjectiveReview,
  CodexOfficeState,
  CodexProgressMemory,
  CodexProjectActivity,
  CodexProactiveState,
} from "./types"
import { arrayOrEmpty, requestCodex as req } from "./core"

export const companyCodexApi = {
  // Modo PROACTIVO (compañía de agentes autónoma). no-store: el estado cambia
  // desde el ticker del backend, un 304 cacheado dejaría el chip mintiendo.
  getProactive: (id: string) =>
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity; memory: CodexProgressMemory; company: CodexCompanyContext }>(`/projects/${id}/proactive`, { cache: "no-store" }),
  setProactive: (id: string, enabled: boolean) =>
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(`/projects/${id}/proactive`, { method: "POST", body: JSON.stringify({ enabled }) }),
  getCompanyOkrs: (id: string) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs`,
      { cache: "no-store" },
    ).then((result) => result.portfolio),
  reviewCompanyOkrs: (
    id: string,
    portfolio: Pick<CodexObjectivePortfolio, "revision" | "objectives">,
    options?: {
      decision?: CodexObjectiveReview["decision"]
      rationale?: string | null
    },
  ) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs/review`,
      {
        method: "PUT",
        body: JSON.stringify({
          objectives: portfolio.objectives,
          expectedRevision: portfolio.revision,
          decision: options?.decision || "approved",
          rationale: options?.rationale || null,
        }),
      },
    ).then((result) => result.portfolio),
  reprioritizeCompanyOkrs: (
    id: string,
    orderedIds: string[],
    expectedRevision: number,
    rationale?: string | null,
  ) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs/reprioritize`,
      {
        method: "POST",
        body: JSON.stringify({
          orderedIds,
          expectedRevision,
          rationale: rationale || null,
        }),
      },
    ).then((result) => result.portfolio),
  upsertDepartment: (id: string, department: Partial<CodexCompanyDepartment> & { name: string; poolSize?: number; dailyBudgetUsd?: number | null }) =>
    req<{ departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/departments`,
      { method: "PUT", body: JSON.stringify({ department }) },
    ),
  deleteDepartment: (id: string, departmentId: string) =>
    req<{ departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/departments/${encodeURIComponent(departmentId)}`,
      { method: "DELETE" },
    ),
  getDepartmentPools: (id: string) =>
    req<{ departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/department-pools`,
      { cache: "no-store" },
    ),
  updateDepartmentPool: (
    id: string,
    departmentId: string,
    pool: { size: number; dailyBudgetUsd?: number | null; enabled?: boolean },
  ) =>
    req<{ departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/department-pools/${encodeURIComponent(departmentId)}`,
      { method: "PUT", body: JSON.stringify(pool) },
    ),
  getCompanyResources: (id: string) =>
    req<{ resources: CodexCompanyResourceState }>(
      `/projects/${id}/company-resources`,
      { cache: "no-store" },
    ).then((result) => result.resources),
  updateCompanyResources: (id: string, resources: CodexCompanyResourceState) =>
    req<{ resources: CodexCompanyResourceState }>(
      `/projects/${id}/company-resources`,
      {
        method: "PUT",
        body: JSON.stringify({
          ...resources,
          expectedRevision: resources.revision,
        }),
      },
    ).then((result) => result.resources),
  getCompanyProfile: (id: string) =>
    req<{ company: CodexCompanyContext }>(`/projects/${id}/company-profile`, { cache: "no-store" })
      .then((result) => result.company),
  updateCompanyProfile: (
    id: string,
    profile: CodexCompanyProfilePatch,
    options?: { confirmAuto?: boolean },
  ) =>
    req<{ company: CodexCompanyContext }>(`/projects/${id}/company-profile`, {
      method: "PATCH",
      body: JSON.stringify({ profile, confirmAuto: options?.confirmAuto === true }),
    }).then((result) => result.company),
  runBusinessAudit: (id: string) =>
    req<{ audit: CodexBusinessAudit; company: CodexCompanyContext }>(
      `/projects/${id}/business-audit`,
      { method: "POST", timeoutMs: 90_000 },
    ),
  getCompanyOperations: (id: string) =>
    req<{ operations: CodexCompanyOperations }>(
      `/projects/${id}/company-operations`,
      { cache: "no-store" },
    ).then((result) => result.operations),
  getOfficeState: (id: string, options?: { take?: number }) => {
    const requestedTake = Number(options?.take)
    const query = Number.isFinite(requestedTake)
      ? `?take=${Math.max(1, Math.min(100, Math.trunc(requestedTake)))}`
      : ""
    return req<{ state: CodexOfficeState }>(
      `/projects/${encodeURIComponent(id)}/office-state${query}`,
      { cache: "no-store" },
    ).then((result) => result.state)
  },
  researchCompanyLeads: (id: string) =>
    req<{ result: { action: string; leads?: CodexCompanyLead[]; sourceCount?: number } }>(
      `/projects/${id}/company-operations/research-leads`,
      { method: "POST" },
    ).then((result) => result.result),
  triageCompanyInbox: (id: string, maxResults = 15) =>
    req<{ result: { action: string; items: CodexCompanyInboxItem[]; actions: CodexExternalAction[] } }>(
      `/projects/${id}/company-operations/triage-inbox`,
      { method: "POST", body: JSON.stringify({ maxResults }) },
    ).then((result) => result.result),
  triageCompanySocial: (id: string, maxResults = 20) =>
    req<{ result: {
      action: string
      items: CodexCompanyInboxItem[]
      actions: CodexExternalAction[]
      errors?: Array<{ platform: string; code: string; message: string }>
    } }>(
      `/projects/${id}/company-operations/triage-social`,
      { method: "POST", body: JSON.stringify({ maxResults }) },
    ).then((result) => result.result),
  updateCompanyLead: (
    id: string,
    leadId: string,
    patch: { email?: string | null; contactName?: string | null; status?: string },
  ) =>
    req<{ lead: CodexCompanyLead }>(`/projects/${id}/company-operations/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((result) => result.lead),
  prepareLeadOutreach: (id: string, leadId: string) =>
    req<{ result: { action: string; record: CodexExternalAction | null } }>(
      `/projects/${id}/company-operations/leads/${leadId}/outreach`,
      { method: "POST" },
    ).then((result) => result.result),
  approveCompanyAction: (
    id: string,
    actionId: string,
    approval: { actionHash: string; actionVersion: number },
  ) =>
    req<{ result: { action: string; record: CodexExternalAction | null } }>(
      `/projects/${id}/company-operations/actions/${actionId}/approve`,
      { method: "POST", body: JSON.stringify(approval) },
    ).then((result) => result.result),
  rejectCompanyAction: (id: string, actionId: string) =>
    req<{ result: { action: string } }>(
      `/projects/${id}/company-operations/actions/${actionId}/reject`,
      { method: "POST" },
    ).then((result) => result.result),
  listProjectActivity: (id: string, limit = 80) =>
    req<{ activity?: unknown }>(`/projects/${id}/activity?limit=${Math.max(1, Math.min(200, limit))}`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexProjectActivity>(r?.activity)),
  getMissionEvidence: (id: string) =>
    req<{ ledger: CodexMissionEvidenceLedger }>(
      `/projects/${id}/mission-evidence`,
      { cache: "no-store" },
    ).then((result) => result.ledger),
  reviewMissionEvidence: (
    id: string,
    recordId: string,
    status: CodexMissionReviewStatus,
    note?: string | null,
  ) =>
    req<{ record: CodexMissionEvidenceRecord }>(
      `/projects/${id}/mission-evidence/${encodeURIComponent(recordId)}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ status, note: note || null }),
      },
    ).then((result) => result.record),
  createActivityReport: (
    id: string,
    options?: {
      days?: number
      requestEmail?: boolean
      confirmEmailQueue?: boolean
    },
  ) =>
    req<{ report: CodexActivityReport }>(
      `/projects/${id}/activity-reports`,
      {
        method: "POST",
        body: JSON.stringify({
          days: options?.days || 7,
          requestEmail: options?.requestEmail === true,
          confirmEmailQueue: options?.confirmEmailQueue === true,
        }),
      },
    ).then((result) => result.report),
} as const
