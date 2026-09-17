// Durable Empresa ↔ Codex project identity and connector assignments.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexCompanyAssociation,
  CodexCompanyAssociationProject,
  CodexCompanyAssociationState,
  CodexCompanyConnectorAssignment,
} from "./types"
import { requestCodex as req } from "./core"

export const companyAssociationsCodexApi = {
  getCompanyAssociation: (projectId: string) =>
    req<CodexCompanyAssociationState>(
      `/company-associations?projectId=${encodeURIComponent(projectId)}`,
      { cache: "no-store" },
    ),
  listCompanyAssociationOrphans: () =>
    req<{
      companies: CodexCompanyAssociationProject[]
      codexProjects: CodexCompanyAssociationProject[]
      backfillApplied: false
    }>("/company-associations/orphans", { cache: "no-store" }),
  associateCompany: (
    projectId: string,
    codexProjectId: string,
    connectorAccountIds: string[] = [],
    source: "manual" | "created_for_company" = "manual",
  ) =>
    req<{ association: CodexCompanyAssociation }>("/company-associations", {
      method: "POST",
      body: JSON.stringify({ projectId, codexProjectId, connectorAccountIds, source }),
    }).then((result) => result.association),
  assignCompanyConnectors: (projectId: string, connectorAccountIds: string[]) =>
    req<{ connectors: CodexCompanyConnectorAssignment[] }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors`,
      {
        method: "PUT",
        body: JSON.stringify({ connectorAccountIds }),
      },
    ).then((result) => result.connectors),
  addCompanyConnector: (projectId: string, connectorAccountId: string) =>
    req<{ connector: CodexCompanyConnectorAssignment; changed: boolean }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorAccountId)}`,
      { method: "POST" },
    ),
  removeCompanyConnector: (projectId: string, connectorAccountId: string) =>
    req<{ connector: CodexCompanyConnectorAssignment; changed: boolean }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorAccountId)}`,
      { method: "DELETE" },
    ),
} as const
