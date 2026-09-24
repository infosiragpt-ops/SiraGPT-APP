import assert from "node:assert/strict"
import test from "node:test"

import { describeAttachmentKind } from "../lib/attachment-kinds"
import { isMediaUpload, validateFile } from "../lib/attachment-ingest"
import { isVideoComposerFile } from "../lib/chat/composer-files"

test("every family gets a Spanish label; stored-only formats say so", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["informe.pdf", "", "PDF", true],
    ["viejo.doc", "", "Documento", true],
    ["memoria.pages", "", "Documento", true],
    ["ventas.numbers", "", "Hoja de cálculo", true],
    ["charla.key", "", "Presentación", true],
    ["correo.msg", "", "Correo", true],
    ["agenda.ics", "", "Calendario", true],
    ["libro.mobi", "", "Libro electrónico", true],
    ["fuentes.7z", "", "Archivo comprimido", true],
    ["fotos.rar", "", "Archivo comprimido", false],
    ["plano.dwg", "", "Dibujo CAD", false],
    ["pieza.stl", "", "Modelo 3D", false],
    ["portada.psd", "", "Diseño", false],
    ["marca.woff2", "", "Fuente tipográfica", false],
    ["datos.parquet", "", "Base de datos", false],
    ["setup.exe", "", "Programa", false],
    ["notas.md", "", "Texto", true],
    ["main.py", "", "Código", true],
    ["backup.tar.gz", "", "Archivo comprimido", true],
    ["foto.heic", "", "Imagen", true],
    ["voz.m4a", "audio/x-m4a", "Audio", true],
    ["clase.mp4", "video/mp4", "Video", true],
  ]
  for (const [name, type, label, readable] of cases) {
    const kind = describeAttachmentKind({ name, type })
    assert.equal(kind.label, label, name)
    assert.equal(kind.readable, readable, name)
  }
  assert.equal(describeAttachmentKind({ name: "modelo.xyz" }).label, "Archivo .xyz")
  assert.equal(describeAttachmentKind({ name: "LICENSE" }).label, "Archivo")
  assert.equal(describeAttachmentKind(null).family, "other")
})

test("TypeScript sources labelled video/mp2t by the browser stay code, not video", () => {
  for (const name of ["app.ts", "server.mts", "config.cts"]) {
    const file = { name, type: "video/mp2t" }
    assert.equal(describeAttachmentKind(file).label, "Código", name)
    assert.equal(isMediaUpload(file), false, name)
    assert.equal(isVideoComposerFile({ name, type: "video/mp2t", size: 10 }), false, name)
  }
  assert.equal(isMediaUpload({ name: "disco.m2ts", type: "" }), true)
  const recording = { name: "canal.ts", type: "video/mp2t", size: 300 * 1024 * 1024 }
  assert.equal(isMediaUpload(recording), true)
  assert.equal(describeAttachmentKind(recording).label, "Video")
  assert.equal(isVideoComposerFile(recording), true)
  assert.equal(isVideoComposerFile({ name: "clase.mp4", type: "video/mp4", size: 10 }), true)
})

test("documents of any format are accepted up to 1 GB", () => {
  const big = { name: "planos.dwg", type: "", size: 900 * 1024 * 1024 } as unknown as File
  assert.equal(validateFile(big).ok, true)
  const huge = { name: "planos.dwg", type: "", size: 1100 * 1024 * 1024 } as unknown as File
  const rejected = validateFile(huge)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason || "", /1 GB/)
})
