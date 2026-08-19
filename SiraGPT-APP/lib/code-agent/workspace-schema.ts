/**
 * workspace-schema — detect the REAL data model of the app in the /code
 * workspace so the Database tool can show it instead of only demo tables.
 *
 * Two sources, in priority order:
 *  1. prisma/schema.prisma (the builder's codegen emits one per entity app) —
 *     parsed into models/fields/attributes.
 *  2. app/api/<slug>/route.ts files (the in-memory CRUD codegen path) — the
 *     entity names are recovered from the route paths; fields from lib/store.ts
 *     seed objects when present.
 *
 * Pure + deterministic: no network, no workspace mutation. Tolerant of
 * malformed input (returns what it can parse, never throws).
 */

export type SchemaField = {
  name: string
  type: string
  optional: boolean
  list: boolean
  isId: boolean
  isUnique: boolean
  hasDefault: boolean
  /** Set when the field points at another model (relation). */
  relation: string | null
}

export type SchemaModel = {
  name: string
  fields: SchemaField[]
}

export type WorkspaceSchema = {
  source: "prisma" | "api-routes"
  /** Workspace path the schema was detected from. */
  path: string
  models: SchemaModel[]
}

type FileLike = { content?: string }

const MODEL_BLOCK = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g

/** Parse `model X { ... }` blocks out of a Prisma schema source. */
export function parsePrismaModels(source: string): SchemaModel[] {
  if (typeof source !== "string" || !source.trim()) return []
  const models: SchemaModel[] = []
  const modelNames = new Set<string>()
  for (const match of source.matchAll(MODEL_BLOCK)) modelNames.add(match[1])
  MODEL_BLOCK.lastIndex = 0
  for (const match of source.matchAll(MODEL_BLOCK)) {
    const [, name, body] = match
    const fields: SchemaField[] = []
    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\/\/.*$/, "").trim()
      // Skip blanks and block-level attributes (@@id, @@index, @@map, …).
      if (!line || line.startsWith("@@")) continue
      const parts = line.split(/\s+/)
      if (parts.length < 2) continue
      const [fieldName, rawType] = parts
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) continue
      const list = rawType.endsWith("[]")
      const optional = rawType.endsWith("?")
      const baseType = rawType.replace(/(\[\]|\?)$/, "")
      if (!baseType) continue
      const attrs = parts.slice(2).join(" ")
      fields.push({
        name: fieldName,
        type: baseType,
        optional,
        list,
        isId: /@id\b/.test(attrs),
        isUnique: /@unique\b/.test(attrs),
        hasDefault: /@default\(/.test(attrs),
        relation:
          modelNames.has(baseType) || /@relation\b/.test(attrs) ? baseType : null,
      })
    }
    models.push({ name, fields })
  }
  return models
}

/** Slug (kebab/plural route segment) → display model name: `pet-owners` → `PetOwners`. */
function slugToModelName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
}

/**
 * Recover field names for an in-memory CRUD entity from the codegen store
 * seeds (`lib/store.ts` object literals). Best-effort: returns [] when the
 * store shape isn't recognisable.
 */
function fieldsFromStoreSource(storeSource: string, slug: string): SchemaField[] {
  // Codegen emits blocks like: `"<slug>": [ { id: "...", name: "...", ... } ]`
  const entry = new RegExp(`["']${slug}["']\\s*:\\s*\\[\\s*\\{([\\s\\S]*?)\\}`, "m").exec(storeSource)
  if (!entry) return []
  const fields: SchemaField[] = []
  const seen = new Set<string>()
  for (const key of entry[1].matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    const name = key[1]
    if (seen.has(name)) continue
    seen.add(name)
    fields.push({
      name,
      type: "String",
      optional: false,
      list: false,
      isId: name === "id",
      isUnique: name === "id",
      hasDefault: false,
      relation: null,
    })
  }
  return fields
}

/**
 * Detect the app's data model from the workspace file map.
 * Returns null when the project has no recognisable schema (the Database
 * tool then keeps its honest local-playground presentation).
 */
export function detectWorkspaceSchema(
  files: Record<string, FileLike | string> | null | undefined,
): WorkspaceSchema | null {
  if (!files || typeof files !== "object") return null
  const contentOf = (path: string): string => {
    const file = files[path]
    if (typeof file === "string") return file
    return typeof file?.content === "string" ? file.content : ""
  }
  const paths = Object.keys(files)

  // 1. Prisma schema anywhere in the tree (codegen emits prisma/schema.prisma).
  const prismaPath = paths
    .filter((path) => path.endsWith("schema.prisma"))
    .sort((a, b) => a.length - b.length)[0]
  if (prismaPath) {
    const models = parsePrismaModels(contentOf(prismaPath))
    if (models.length > 0) return { source: "prisma", path: prismaPath, models }
  }

  // 2. In-memory CRUD API routes: app/api/<slug>/route.ts (skip the root api dir).
  const routeSlugs = Array.from(
    new Set(
      paths
        .map((path) => /^app\/api\/([^/]+)\/route\.tsx?$/.exec(path)?.[1])
        .filter((slug): slug is string => Boolean(slug)),
    ),
  ).sort()
  if (routeSlugs.length > 0) {
    const storePath = paths.find((path) => /(^|\/)lib\/store\.tsx?$/.test(path))
    const storeSource = storePath ? contentOf(storePath) : ""
    return {
      source: "api-routes",
      path: storePath || `app/api/${routeSlugs[0]}/route.ts`,
      models: routeSlugs.map((slug) => ({
        name: slugToModelName(slug),
        fields: storeSource ? fieldsFromStoreSource(storeSource, slug) : [],
      })),
    }
  }

  return null
}

/** Compact field label for UI chips: `email String? @unique` → `email: String?`. */
export function fieldLabel(field: SchemaField): string {
  return `${field.name}: ${field.type}${field.list ? "[]" : field.optional ? "?" : ""}`
}
