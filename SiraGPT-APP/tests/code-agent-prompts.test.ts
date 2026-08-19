import { test } from "node:test"
import assert from "node:assert/strict"

import {
  FULL_STACK_APP_CONTRACT_PATHS,
  contractPathsForContext,
  landingSystemPrompt,
  streamOutputFormat,
} from "../lib/code-agent/prompts"
import type { AgentBuildContext } from "../lib/code-agent/types"

const appContext: AgentBuildContext = {
  goal: "app",
  productType: "CRM para ventas B2B",
  brand: "Pipeline Pro",
  features: "clientes, oportunidades, tareas y reportes",
  dataEntities: "clientes, oportunidades, tareas",
}

test("app prompt requires full-stack Next.js, API routes and Prisma database", () => {
  const prompt = landingSystemPrompt(appContext)

  assert.match(prompt, /Next\.js 14 App Router/i)
  assert.match(prompt, /frontend, backend y base de datos/i)
  assert.match(prompt, /app\/api\/<entidad>\/route\.ts/)
  assert.match(prompt, /prisma\/schema\.prisma/)
  assert.match(prompt, /lib\/db\.ts/)
  assert.match(prompt, /DATABASE_URL/)
  assert.doesNotMatch(prompt, /100% ESTÁTICO/i)
  assert.doesNotMatch(prompt, /sin backend ni llamadas reales a APIs/i)
})

test("stream output format switches to the full-stack app contract", () => {
  const format = streamOutputFormat({ strictStart: false, paths: FULL_STACK_APP_CONTRACT_PATHS })

  assert.match(format, /next\.config\.mjs/)
  assert.match(format, /prisma\/schema\.prisma/)
  assert.match(format, /app\/api\/<entidad>\/route\.ts/)
  assert.match(format, /app\/api\/<entidad>\/\[id\]\/route\.ts/)
  assert.match(format, /app\/<entidad>\/page\.tsx/)
})

test("contract paths are selected by build context goal", () => {
  assert.deepEqual(contractPathsForContext(appContext), FULL_STACK_APP_CONTRACT_PATHS)
  assert.notDeepEqual(contractPathsForContext({ goal: "landing" }), FULL_STACK_APP_CONTRACT_PATHS)
})
