import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  makeDocx,
  makeSourceDoc,
  makeUpnTemplate,
  writeZipWithEntries,
  UPN_SECTPR,
} from './fixtures'

const require = createRequire(import.meta.url)
const ooxml = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/ooxml.js'))
const transform = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/transform-to-template.js'))
const flags = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/flags.js'))
const runner = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/runner.js'))
const verify = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/verify-loop.js'))
const pipeline = require(path.resolve(process.cwd(), 'backend/src/services/doc-engine/pipeline.js'))

const SCRIPTS = path.resolve(process.cwd(), 'packages/doc-skills/scripts')

function tmp(prefix = 'de-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('FEATURE_DOC_ENGINE flag', () => {
  it('defaults to false', () => {
    expect(flags.isDocEngineEnabled({})).toBe(false)
    expect(flags.isDocEngineEnabled({ FEATURE_DOC_ENGINE: '0' })).toBe(false)
    expect(flags.isDocEngineEnabled({ FEATURE_DOC_ENGINE: '1' })).toBe(true)
  })

  it('detects UPN template-transform prompts', () => {
    const files = [{ name: 'tesis.docx' }, { name: 'formato-upn.docx' }]
    expect(flags.isTemplateTransformRequest('pasa este word al formato UPN', files)).toBe(true)
    expect(flags.isTemplateTransformRequest('pásalo', files)).toBe(true)
    expect(flags.isTemplateTransformRequest('hola', files)).toBe(false)
    expect(flags.isTemplateTransformRequest('hola', [{ name: 'a.docx' }, { name: 'b.docx' }])).toBe(false)
  })
})

describe('ooxml unpack — path traversal + zip-bomb', () => {
  it('rejects .. traversal entries', () => {
    const buf = writeZipWithEntries({
      '[Content_Types].xml': '<Types xmlns="x"/>',
      '../../etc/passwd': 'root:x:0:0:root:/root:/bin/sh\n',
    })
    const dest = tmp('trav-')
    expect(() => ooxml.unpackBuffer(buf, dest)).toThrow(/path traversal/)
  })

  it('rejects absolute zip paths', () => {
    expect(() => ooxml.assertSafeZipName('/tmp/evil.xml')).toThrow(/path traversal/)
    expect(() => ooxml.assertSafeZipName('word/../../outside')).toThrow(/path traversal/)
  })

  it('rejects zip-bomb entry counts over 5000', () => {
    const entries: Record<string, string> = { '[Content_Types].xml': '<Types xmlns="x"/>' }
    for (let i = 0; i < 5001; i += 1) entries[`pad/${i}.txt`] = 'x'
    const buf = writeZipWithEntries(entries)
    const dest = tmp('bomb-')
    expect(() => ooxml.unpackBuffer(buf, dest)).toThrow(/zip-bomb/)
  })

  it('python unpack script rejects traversal', () => {
    const buf = writeZipWithEntries({
      '[Content_Types].xml': '<Types xmlns="x"/>',
      '../escape.txt': 'nope',
    })
    const dir = tmp('py-')
    const zipPath = path.join(dir, 'bad.docx')
    fs.writeFileSync(zipPath, buf)
    const r = spawnSync('python3', [path.join(SCRIPTS, 'ooxml_unpack.py'), zipPath, path.join(dir, 'out')], {
      encoding: 'utf8',
    })
    expect(r.status).not.toBe(0)
    expect(String(r.stderr)).toMatch(/path traversal|ooxml_unpack/)
  })
})

describe('ooxml validate — .rels integrity', () => {
  it('fails when document r:id is missing from .rels', () => {
    const root = tmp('rels-')
    fs.mkdirSync(path.join(root, 'word', '_rels'), { recursive: true })
    fs.writeFileSync(path.join(root, '[Content_Types].xml'), '<Types xmlns="x"/>')
    fs.writeFileSync(
      path.join(root, 'word', 'document.xml'),
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rId99"/></w:sectPr></w:body></w:document>`,
    )
    fs.writeFileSync(
      path.join(root, 'word', '_rels', 'document.xml.rels'),
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    )
    expect(() => ooxml.validateUnpacked(root)).toThrow(/rId99/)
  })

  it('accepts matching r:id vs .rels', () => {
    const buf = makeUpnTemplate()
    const dest = tmp('okrels-')
    ooxml.unpackBuffer(buf, dest)
    expect(ooxml.validateUnpacked(dest).ok).toBe(true)
  })
})

describe('style map', () => {
  it('maps source Heading1 → template TituloUPN by name', () => {
    const source = ooxml.parseStyles(
      '<w:styles><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
    )
    const template = ooxml.parseStyles(
      '<w:styles><w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:styleId="TituloUPN"><w:name w:val="heading 1"/></w:style></w:styles>',
    )
    const { mapping, allowed } = ooxml.buildStyleMap(source, template)
    expect(mapping.Heading1).toBe('TituloUPN')
    expect(allowed).toContain('TituloUPN')
    const remapped = ooxml.remapStyleIds('<w:pStyle w:val="Heading1"/>', mapping, allowed)
    expect(remapped).toContain('w:val="TituloUPN"')
    expect(remapped).not.toContain('w:val="Heading1"')
  })
})

describe('transformToTemplate — UPN fixture', () => {
  let result: any
  let documentXml = ''

  beforeAll(() => {
    const source = makeSourceDoc()
    const template = makeUpnTemplate()
    result = transform.transformBuffers(source, template)
    documentXml = result.documentXml
  })

  it('keeps template sectPr margins byte-identical', () => {
    expect(result.templateSectPr).toBe(UPN_SECTPR)
    expect(result.resultSectPr).toBe(UPN_SECTPR)
    expect(documentXml).toContain(UPN_SECTPR)
  })

  it('does not change header/footer count', () => {
    expect(result.headerFooterBefore).toEqual(result.headerFooterAfter)
    expect(result.headerFooterAfter).toEqual(['word/footer1.xml', 'word/header1.xml'])
  })

  it('every transplanted w:styleId exists in the template', () => {
    const ids = [...documentXml.matchAll(/w:val="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => ['Heading1', 'TituloUPN', 'Normal', 'CuerpoUPN'].includes(id))
    for (const id of ids) {
      expect(result.allowedStyleIds).toContain(id === 'Heading1' ? 'TituloUPN' : id)
    }
    expect(documentXml).not.toMatch(/w:pStyle w:val="Heading1"/)
    expect(documentXml).toMatch(/w:pStyle w:val="TituloUPN"/)
  })

  it('transplants source content instead of leaving XXXXXXXX placeholders', () => {
    expect(documentXml).toContain('Portada original UPN')
    expect(documentXml).toContain('Capitulo 1 contenido real del source.')
    expect(documentXml).toContain('Celda fuente')
    const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/)?.[1] || ''
    const bodyWithoutSect = body.replace(/<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/, '')
    expect(bodyWithoutSect).not.toContain('XXXXXXXX')
  })

  it('keeps numbering.xml hash and header/footer counts', () => {
    const numbering = ooxml.hashZipPart(makeUpnTemplate(), 'word/numbering.xml')
    expect(numbering).toBeTruthy()
    expect(ooxml.hashZipPart(result.buffer, 'word/numbering.xml')).toBe(numbering)
    expect(result.headerFooterBefore).toEqual(result.headerFooterAfter)
  })

  it('golden C14N document.xml snapshot', () => {
    const goldenDir = path.resolve(process.cwd(), 'tests/lib/doc-engine/__snapshots__')
    fs.mkdirSync(goldenDir, { recursive: true })
    const goldenPath = path.join(goldenDir, 'document.xml')
    const c14nPath = path.join(goldenDir, 'document.c14n.xml')
    const canonical = ooxml.c14nXml(documentXml)
    if (!fs.existsSync(goldenPath)) fs.writeFileSync(goldenPath, documentXml)
    if (!fs.existsSync(c14nPath)) fs.writeFileSync(c14nPath, canonical)
    expect(documentXml).toBe(fs.readFileSync(goldenPath, 'utf8'))
    expect(canonical).toBe(fs.readFileSync(c14nPath, 'utf8'))
    expect(canonical).toContain('Portada original UPN')
  })

  it('PDF preview has ≥ 1 page', async () => {
    const source = makeSourceDoc()
    const template = makeUpnTemplate()
    const ran = await pipeline.runPipeline({
      sourceBuffer: source,
      templateBuffer: template,
      instructions: 'pasa este word al formato UPN',
      verifyDeps: { client: null },
    })
    expect(ran.ok).toBe(true)
    expect(ran.artifact.pdfPages).toBeGreaterThanOrEqual(1)
  })
})

describe('hardened runner', () => {
  it('emits network=none, read-only, cap-drop ALL, uid 10001, noexec tmpfs, pids/memory/cpus', () => {
    const args = runner.buildHardenedRunArgs({
      name: 'sira-doc-test',
      image: 'siragpt-sandbox:doc-engine',
      jobId: 'job1',
    })
    const joined = args.join(' ')
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop')
    expect(args).toContain('ALL')
    expect(args).toContain('--user')
    expect(args).toContain('10001:10001')
    expect(args).toContain('--pids-limit')
    expect(args).toContain('256')
    expect(args).toContain('--memory')
    expect(args).toContain('768m')
    expect(args).toContain('--cpus')
    expect(args).toContain('1')
    expect(args.some((a: string) => String(a).includes('nosuid,nodev,noexec'))).toBe(true)
    expect(args.some((a: string) => String(a).includes('/workspace:'))).toBe(true)
    expect(joined).not.toMatch(/unconfined/)
    expect(joined).not.toMatch(/openrouter/i)
  })
})

describe('DeepSeek verify loop', () => {
  it('skips when DEEPSEEK_API_KEY is missing (does not invent keys)', async () => {
    const r = await verify.runVerifyLoop({ pages: [] }, { env: {}, client: null })
    expect(r.skipped).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('calls only DeepSeek Flash/Pro and cuts token budget', async () => {
    const calls: any[] = []
    const client = {
      chat: {
        completions: {
          create: async (body: any) => {
            calls.push(body)
            return {
              choices: [{ message: { content: '{"ok":true,"placeholdersVisible":false,"issues":[]}' } }],
              usage: { total_tokens: 50 },
            }
          },
        },
      },
    }
    const r = await verify.runVerifyLoop(
      { pages: [], jobId: 'j1' },
      { client, env: { DEEPSEEK_API_KEY: 'present', DOC_ENGINE_VERIFY_MAX_ITERATIONS: '1' } },
    )
    expect(r.ok).toBe(true)
    expect(calls[0].model).toMatch(/deepseek-v4-(flash|pro)/)
    expect(String(calls[0].model)).not.toMatch(/openrouter/i)
    expect(calls[0].max_tokens).toBeLessThanOrEqual(400)
  })
})
