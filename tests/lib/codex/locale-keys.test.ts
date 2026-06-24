import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const { ES, EN } = require('../../../scripts/add-codex-locale-keys.js')

const MESSAGES_DIR = path.resolve(__dirname, '../../../messages')

function deepKeys(obj: any, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? deepKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}

describe('codex i18n namespace', () => {
  it('es (source) and en (fallback) have identical key structure', () => {
    expect(deepKeys(ES).sort()).toEqual(deepKeys(EN).sort())
  })

  it('all eleven groups are present', () => {
    expect(Object.keys(ES).sort()).toEqual(['actionRequired', 'checkpoint', 'composer', 'errors', 'files', 'panel', 'plan', 'preview', 'summary', 'tabs', 'timeline'])
  })

  it('every locale file carries the codex namespace with full key parity vs en', () => {
    const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(50)
    const enKeys = deepKeys(EN).sort()
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8'))
      expect(data.codex, `${file} missing codex namespace`).toBeTruthy()
      expect(deepKeys(data.codex).sort(), `${file} codex key drift`).toEqual(enKeys)
    }
  })

  it('es.json and en.json match the script source exactly', () => {
    const es = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'es.json'), 'utf8'))
    const en = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'en.json'), 'utf8'))
    expect(es.codex).toEqual(ES)
    expect(en.codex).toEqual(EN)
  })
})
