'use strict';

// Reuse the existing document sandbox and installed Office readers. This
// is fixed server code: document bytes remain data in its isolated workspace.
const crypto = require('node:crypto');
const READ_OFFICE = String.raw`
import sys, io, json, math, hashlib, os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
if sys.platform.startswith('linux'):
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
try:
    ext = sys.argv[1]
    with open(sys.argv[2], 'rb') as candidate:
        raw = candidate.read(48 * 1024 * 1024 + 1)
    if len(raw) > 48 * 1024 * 1024: raise ValueError('file budget exceeded')
    stream = io.BytesIO(raw)
    if ext == 'xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(stream, read_only=False, data_only=False, keep_links=False)
        cells = 0
        sheets = []
        for ws in wb.worksheets:
            # Populated cells only, never the possibly forged dimensions.
            for cell in ws._cells.values():
                cells += 1
                if cells > 200000: raise ValueError('cell budget exceeded')
                value = cell.value
                if isinstance(value, float) and not math.isfinite(value): raise ValueError('nonfinite cell')
            sheets.append({'name': ws.title[:80], 'rows': ws.max_row, 'columns': ws.max_column,
                'headers': [None if ws.cell(1, col).value is None else str(ws.cell(1, col).value)[:80] for col in range(1, min(ws.max_column, 10) + 1)]})
        result = {'reader': 'openpyxl', 'sheetCount': len(wb.sheetnames), 'cellCount': cells,
            'totalRows': sum(sheet['rows'] for sheet in sheets), 'sheets': sheets[:10]}
        wb.close()
    elif ext == 'docx':
        from docx import Document
        doc = Document(stream)
        paragraphs = 0
        def read_table(table):
            global paragraphs
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        _ = paragraph.text
                        paragraphs += 1
                    for nested in cell.tables: read_table(nested)
        for paragraph in doc.paragraphs:
            _ = paragraph.text
            paragraphs += 1
        for table in doc.tables: read_table(table)
        for section in doc.sections:
            for part in (section.header, section.footer, section.first_page_header, section.first_page_footer, section.even_page_header, section.even_page_footer):
                for paragraph in part.paragraphs: _ = paragraph.text
                for table in part.tables: read_table(table)
        result = {'reader': 'python-docx', 'paragraphCount': paragraphs,
            'firstParagraphs': [paragraph.text[:240] for paragraph in doc.paragraphs if paragraph.text.strip()][:5]}
    elif ext == 'pptx':
        from pptx import Presentation
        prs = Presentation(stream)
        shapes = 0
        def read_shapes(items):
            global shapes
            for shape in items:
                shapes += 1
                if shapes > 100000: raise ValueError('shape budget exceeded')
                _ = (shape.shape_id, shape.name, shape.left, shape.top, shape.width, shape.height)
                if shape.has_text_frame:
                    for paragraph in shape.text_frame.paragraphs: _ = paragraph.text
                if shape.has_table:
                    for row in shape.table.rows:
                        for cell in row.cells: _ = cell.text
                if shape.has_chart: _ = shape.chart.chart_type
                if hasattr(shape, 'shapes'): read_shapes(shape.shapes)
        for slide in prs.slides: read_shapes(slide.shapes)
        result = {'reader': 'python-pptx', 'slideCount': len(prs.slides), 'shapeCount': shapes}
    else: raise ValueError('unsupported office format')
    result['readerThreads'] = int(os.environ['OPENBLAS_NUM_THREADS'])
    if sys.platform.startswith('linux'):
        result['addressSpaceLimitBytes'] = resource.getrlimit(resource.RLIMIT_AS)[0]
    print(json.dumps({'ok': True, 'sha256': hashlib.sha256(raw).hexdigest(), 'summary': result}))
except ImportError:
    print(json.dumps({'ok': False, 'reason': 'format_reader_required'}))
except Exception:
    print(json.dumps({'ok': False, 'reason': 'office_unreadable'}))
`;

async function readOffice(format, buffer, { signal, sandbox: currentSandbox } = {}) {
  const reuse = currentSandbox && typeof currentSandbox.putFile === 'function'
    && typeof currentSandbox.writeFile === 'function' && typeof currentSandbox.exec === 'function';
  let sandbox;
  const directory = `tmp/format-readback-${crypto.randomUUID()}`;
  try {
    // Production's Office readers live in the document sandbox, not the API
    // container. Reuse its current session when collection already has one.
    sandbox = reuse ? currentSandbox : await require('../doc-agent/sandbox').createSandbox({ signal });
    const file = `${directory}/artifact.${format}`;
    const script = `${directory}/reader.py`;
    await sandbox.putFile(file, buffer);
    await sandbox.writeFile(script, READ_OFFICE);
    const run = await sandbox.exec(`python3 ${script} ${format} ${file}`, { timeoutMs: 12_000 });
    if (run.exitCode !== 0 || run.timedOut || run.truncated || Buffer.byteLength(String(run.stdout)) > 16 * 1024) return { ok: false, reason: 'format_reader_required' };
    const result = JSON.parse(String(run.stdout).trim());
    return result.ok === true && result.summary?.reader
      && result.sha256 === crypto.createHash('sha256').update(buffer).digest('hex')
      ? result : { ok: false, reason: result.reason || 'office_unreadable' };
  } catch { return { ok: false, reason: 'format_reader_required' }; }
  finally {
    // A reused chat sandbox survives the turn. Remove only this server-owned
    // UUID directory so repeated readbacks cannot accumulate document copies.
    if (sandbox && reuse) await sandbox.exec(`rm -rf ${directory}`, {
      timeoutMs: 2_000, signal: new AbortController().signal,
    }).catch(() => {});
    if (sandbox && !reuse) await sandbox.destroy().catch(() => {});
  }
}

module.exports = { readOffice };
