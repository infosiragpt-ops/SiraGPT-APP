'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { VERSION, PHRASE, sha256 } = require('./build-docs.cjs');

// Case specifications, not passed golden executions. Selected explicitly by
// doc-sandbox-real.cjs --suite=complex; the default remains the SMOKE suite.
async function loadComplexCases(directory) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === path.parse(directory).root)
    throw new Error('fixture directory must be absolute, normalized and non-root');
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('fixture directory must be regular');
  const manifestStat = await fs.lstat(path.join(directory, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 2 * 1024 * 1024)
    throw new Error('fixture manifest must be a regular bounded file');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== VERSION || manifest.synthetic !== true || manifest.editorExecuted !== false)
    throw new Error('unrecognized synthetic fixture manifest');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 6) throw new Error('unexpected fixture count');
  const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf' };
  const files = {};
  for (const meta of manifest.files) {
    if (path.basename(meta.name) !== meta.name || !['tesis.docx', 'presupuesto.xlsx', 'defensa.pptx', 'informe.pdf', 'anexo.pdf', 'escaneado.pdf'].includes(meta.name))
      throw new Error('unexpected fixture name');
    if (files[meta.name]) throw new Error('duplicate fixture name');
    const stat = await fs.lstat(path.join(directory, meta.name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) throw new Error('fixture must be a regular bounded file');
    const data = await fs.readFile(path.join(directory, meta.name));
    if (data.length !== meta.bytes || sha256(data) !== meta.sha256) throw new Error('fixture hash mismatch');
    const format = meta.name.split('.').pop();
    files[meta.name] = { name: meta.name, format, mime: mime[format], data, sha256: meta.sha256 };
  }
  for (const name of ['tesis.docx', 'presupuesto.xlsx', 'defensa.pptx', 'informe.pdf', 'anexo.pdf', 'escaneado.pdf'])
    if (!files[name]) throw new Error('required fixture missing');
  const after = 'La gestion de compras mejora los costos operativos.';
  return [
    { id: 'G1', inputs: [files['tesis.docx']], candidateOnly: true,
      instructions: `En el mismo Word reemplaza la frase "${PHRASE}" por "${after}". La frase esta partida en tres runs. Conserva el w:rPr del primer run y los formatos, las imagenes, el encabezado, el pie, las notas y todas las demas partes. No anadas anexos.`,
      expected: { changed: true, before: PHRASE, after, allowedChangedParts: ['word/document.xml'], preserveFirstRunProperties: true, unaffectedPage: 2 } },
    { id: 'G4', inputs: [files['presupuesto.xlsx']], candidateOnly: true,
      instructions: 'En el mismo Excel, hoja Presupuesto, cambia solo B4 de 100 a 110, B5 de 120 a 130 y B6 de 80 a 90. Conserva las formulas, los shared strings, el grafico y su XML, los formatos y las dos hojas. Recalcula dependientes o activa fullCalcOnLoad.',
      expected: { changed: true, cells: { B4: 110, B5: 130, B6: 90 }, formulaResults: { 'Resumen!B4': 2830, 'Resumen!B5': 509.4, 'Resumen!B6': 3339.4 },
        requiredIdenticalParts: ['xl/charts/chart1.xml'], edits: 3 } },
    { id: 'G7', inputs: [files['defensa.pptx']], candidateOnly: true,
      instructions: 'En esta misma presentacion de ocho diapositivas cambia solamente el titulo de la diapositiva 3 de "Objetivos originales 2026" a "Objetivos revisados 2027" y su nota de "Nota original de la diapositiva 3." a "Nota revisada de la diapositiva 3.". Conserva todas las otras diapositivas, notas, imagenes, masters y layouts.',
      expected: { changed: true, allowedChangedParts: ['ppt/slides/slide3.xml', 'ppt/notesSlides/notesSlide3.xml'], slides: 8,
        present: ['Objetivos revisados 2027', 'Nota revisada de la diapositiva 3.'], edits: 2 } },
    { id: 'G8', inputs: [files['informe.pdf'], files['anexo.pdf']], candidateOnly: true,
      instructions: 'Une informe.pdf seguido de anexo.pdf en ese orden. Devuelve informe.pdf de tres paginas. Conserva todo el texto original y el formulario. Anade numeracion "1 / 3", "2 / 3", "3 / 3" respectivamente en (270,30), fuente Helvetica 10; y marca de agua textual "COPIA DE PRUEBA" en (180,400), fuente Helvetica 18, en cada pagina. Coordenadas PDF en puntos, origen inferior izquierdo. No alteres nada mas.',
      expected: { changed: true, pages: 3, preserveOriginalText: true, preserveForm: true,
        numbering: ['1 / 3', '2 / 3', '3 / 3'], watermark: 'COPIA DE PRUEBA', edits: 7 } },
    { id: 'G11', inputs: [files['tesis.docx']], candidateOnly: true,
      instructions: 'No cambies nada. Devuelve exactamente el mismo archivo, mismos bytes, nombre y formato. No regeneres ni reempaquetes el documento.',
      expected: { changed: false, identicalBytes: true, edits: 0 } },
    { id: 'G10', inputs: [files['escaneado.pdf']], candidateOnly: true, acceptancePhase: 1,
      instructions: 'Reescribe el parrafo "Este parrafo solo existe como imagen." por "Este parrafo ha sido revisado." en este mismo PDF, preservando todo lo demas. Si no es posible editarlo quirurgicamente porque es una imagen escaneada, devuelve el archivo intacto e informa not_possible y el motivo; no simules que lo editaste.',
      expected: { changed: false, identicalBytes: true, outcome: 'not_possible', jobState: 'done', warningRequired: true } },
  ];
}
module.exports = { loadComplexCases };
