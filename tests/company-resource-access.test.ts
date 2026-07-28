import assert from "node:assert/strict"
import test from "node:test"

import { isCompanyResourceActive } from "../lib/company-resource-access"

test("a durable connector grant without company availability stays inactive", () => {
  assert.equal(isCompanyResourceActive({
    assignedToDepartment: true,
    connected: true,
    connectorResource: true,
    availableToCompany: false,
  }), false)
})

test("a connector becomes active only after availability is confirmed", () => {
  assert.equal(isCompanyResourceActive({
    assignedToDepartment: true,
    connected: true,
    connectorResource: true,
    availableToCompany: true,
  }), true)
})

test("social resources do not require a company connector assignment", () => {
  assert.equal(isCompanyResourceActive({
    assignedToDepartment: true,
    connected: true,
    connectorResource: false,
  }), true)
})
