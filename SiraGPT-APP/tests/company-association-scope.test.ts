import assert from "node:assert/strict"
import test from "node:test"

import {
  associatedCodexProjectIdForCompany,
  shouldAcceptCompanyAssociationResponse,
} from "../lib/company-association-scope"
import type { CodexCompanyAssociationState } from "../lib/codex/codex-api"

function association(
  companyId: string,
  codexProjectId: string,
): CodexCompanyAssociationState {
  return {
    company: {
      id: companyId,
      name: companyId,
      organizationId: null,
      updatedAt: null,
    },
    association: {
      id: `link-${companyId}`,
      source: "manual",
      organizationId: null,
      linkedAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      codexProject: {
        id: codexProjectId,
        name: codexProjectId,
        organizationId: null,
        updatedAt: null,
      },
      connectors: [],
    },
    candidates: [],
    connectors: [],
    requiresAssociation: false,
  }
}

test("a late company A response cannot hydrate company B", () => {
  const stateA = association("company-a", "runtime-a")

  assert.equal(shouldAcceptCompanyAssociationResponse({
    requestedCompanyId: "company-a",
    currentCompanyId: "company-b",
    requestGeneration: 1,
    currentGeneration: 2,
    state: stateA,
  }), false)
  assert.equal(
    associatedCodexProjectIdForCompany(stateA, "company-b"),
    null,
  )
})

test("the current generation can hydrate only its matching company", () => {
  const stateB = association("company-b", "runtime-b")

  assert.equal(shouldAcceptCompanyAssociationResponse({
    requestedCompanyId: "company-b",
    currentCompanyId: "company-b",
    requestGeneration: 2,
    currentGeneration: 2,
    state: stateB,
  }), true)
  assert.equal(
    associatedCodexProjectIdForCompany(stateB, "company-b"),
    "runtime-b",
  )
})
