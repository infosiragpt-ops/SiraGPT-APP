import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

type ProjectBrief = {
  platform: "web" | "mobile" | "landing" | "desktop"
  purpose: string
  dataEntities: Array<{ name: string; fields: string[] }>
}

type ScaffoldFile = { path: string; language: string; content: string }

const { briefFromPrompt } = require(path.join(process.cwd(), "backend/src/services/builder/brief-from-prompt")) as {
  briefFromPrompt(prompt: string): ProjectBrief
}

const { scaffoldFromBrief } = require(path.join(process.cwd(), "backend/src/services/builder/scaffold")) as {
  scaffoldFromBrief(brief: ProjectBrief): { blueprint: unknown; files: ScaffoldFile[] }
}

function fileContent(files: ScaffoldFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === path)
  assert.ok(file, `missing generated file ${path}`)
  return file.content
}

test("restaurant management prompt with landing prefix generates a real full-stack app", () => {
  const prompt = "Landing one-page para crea una software para gestionar un restaurante"
  const brief = briefFromPrompt(prompt)

  assert.equal(brief.platform, "web")
  assert.deepEqual(
    brief.dataEntities.map((entity) => entity.name),
    ["Plato", "Pedido", "Mesa"],
  )

  const { files } = scaffoldFromBrief(brief)
  const paths = files.map((file) => file.path)

  assert.ok(paths.includes("index.html"), "keeps the instant preview")
  assert.ok(paths.includes("package.json"), "emits a runnable Next.js project")
  assert.ok(paths.includes("docker-compose.yml"), "emits the local database service")
  assert.ok(paths.includes(".env.example"), "emits DATABASE_URL setup")
  assert.ok(paths.includes("prisma/schema.prisma"), "emits the database schema")
  assert.ok(paths.includes("prisma/seed.ts"), "emits seed data")
  assert.ok(paths.includes("lib/db.ts"), "emits the Prisma client layer")
  assert.ok(paths.includes("app/manifest.ts"), "emits a mobile-installable PWA manifest")
  assert.ok(paths.includes("app/icon.svg"), "emits the mobile/web app icon")
  assert.ok(paths.includes("app/api/plato/route.ts"), "emits a backend route for Plato")
  assert.ok(paths.includes("app/api/pedido/route.ts"), "emits a backend route for Pedido")
  assert.ok(paths.includes("app/api/mesa/route.ts"), "emits a backend route for Mesa")
  assert.ok(paths.includes("app/plato/page.tsx"), "emits a frontend screen for Plato")
  assert.ok(paths.includes("app/pedido/page.tsx"), "emits a frontend screen for Pedido")
  assert.ok(paths.includes("app/mesa/page.tsx"), "emits a frontend screen for Mesa")

  const schema = fileContent(files, "prisma/schema.prisma")
  assert.match(schema, /model Plato \{/)
  assert.match(schema, /model Pedido \{/)
  assert.match(schema, /model Mesa \{/)

  const pkg = JSON.parse(fileContent(files, "package.json"))
  assert.equal(pkg.scripts["db:push"], "prisma db push")
  assert.equal(pkg.scripts["build:web"], "prisma generate && next build")
  assert.equal(pkg.scripts["build:mobile"], "prisma generate && next build")
  assert.equal(pkg.dependencies.next, "15.5.19")
  assert.equal(pkg.dependencies["@prisma/client"], "5.19.1")

  const readme = fileContent(files, "README.md")
  assert.match(readme, /Frontend:\*\* páginas React\/Next\.js/)
  assert.match(readme, /Backend:\*\* Route Handlers/)
  assert.match(readme, /Base de datos:\*\* Prisma \+ PostgreSQL/)
  assert.match(readme, /Celular:\*\* responsive mobile-first/)
  assert.doesNotMatch(readme, /sin servidor y sin base de datos/)
})

test("restaurant prompt with web and mobile wording stays full-stack web responsive", () => {
  const prompt = "Crea un software para gestionar un restaurante con base de datos, backend, frontend y formato responsive para web y celular."
  const brief = briefFromPrompt(prompt)

  assert.equal(brief.platform, "web")
  assert.deepEqual(
    brief.dataEntities.map((entity) => entity.name),
    ["Plato", "Pedido", "Mesa"],
  )

  const { files } = scaffoldFromBrief(brief)
  const paths = files.map((file) => file.path)
  assert.ok(paths.includes("package.json"), "emits a runnable Next.js project")
  assert.ok(paths.includes("docker-compose.yml"), "emits PostgreSQL service")
  assert.ok(paths.includes("app/api/plato/route.ts"), "emits Plato API")
  assert.ok(paths.includes("app/api/pedido/route.ts"), "emits Pedido API")
  assert.ok(paths.includes("app/api/mesa/route.ts"), "emits Mesa API")
  assert.ok(paths.includes("app/manifest.ts"), "emits PWA/mobile manifest")
})

test("cafeteria website prompt generates a public cafe landing, not a management CRUD", () => {
  const brief = briefFromPrompt("crea una web de cafeteria")

  assert.equal(brief.platform, "landing")
  assert.deepEqual(brief.dataEntities, [])
  assert.match(brief.purpose, /Cafetería de especialidad/)

  const { files } = scaffoldFromBrief(brief)
  const paths = files.map((file) => file.path)
  assert.ok(paths.includes("index.html"), "emits an instant preview")
  assert.ok(paths.includes("app/page.tsx"), "emits a publishable Next landing")
  assert.ok(!paths.some((path) => path.startsWith("app/api/")), "does not emit CRUD API routes")
  assert.ok(!paths.includes("prisma/schema.prisma"), "does not emit a database schema")

  const html = fileContent(files, "index.html")
  assert.match(html, /Cafetería Aurora/)
  assert.match(html, /Favoritos de la casa/)
  assert.match(html, /Reservar mesa/)
})
