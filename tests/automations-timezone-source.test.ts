import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

// Source guards for the automations time-zone plumbing: the composer sends
// the browser's IANA zone with every chat turn, and the AI route hands it to
// the agent tools so «mañana a las 9» is the user's 09:00.

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

test("lib/api.ts sends the client time zone on every /ai/generate turn, guarded against Intl failures", () => {
  const api = read("lib/api.ts")
  assert.match(api, /skills\?: string\[\]; timeZone\?: string \}/)
  assert.match(api, /export function resolveClientTimeZone\(\): string \| undefined \{\s*try \{\s*const tz = Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/)
  assert.match(api, /body: JSON\.stringify\(\{ \.\.\.data, progressProtocol: 2, timeZone: data\.timeZone \?\? resolveClientTimeZone\(\) \}\)/)
})

test("the AI route validates the zone and exposes it to the harness tool context", () => {
  const route = read("backend/src/routes/ai.js")
  assert.match(route, /body\('timeZone'\)\.optional\(\{ nullable: true \}\)\.isString\(\)\.isLength\(\{ max: 64 \}\)/)
  assert.match(route, /chatId: canPersist \? chatId : null,[\s\S]{0,400}timeZone: \(\(\) => \{\s*const raw = typeof req\.body\?\.timeZone === 'string' \? req\.body\.timeZone\.trim\(\) : '';\s*if \(!raw \|\| raw\.length > 64\) return 'UTC';\s*try \{ Intl\.DateTimeFormat\(undefined, \{ timeZone: raw \}\); return raw; \} catch \(_\) \{ return 'UTC'; \}\s*\}\)\(\),/)
})
