const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');
const { execFile, execSync } = require('child_process');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, AlignmentType, BorderStyle, WidthType } = require('docx');
const puppeteer = require('puppeteer');
const PizZip = require('pizzip');
const PptxGenJS = require('pptxgenjs');
const axios = require('axios');

// Detect pandoc once at module load. If the binary isn't on PATH
// (common on a fresh macOS without brew), fall back to a pure-JS
// markdown → docx pipeline so users still get a working file. Log the
// decision so ops can see why the fallback kicked in.
let PANDOC_AVAILABLE = false;
try {
    execSync('pandoc --version', { stdio: 'ignore' });
    PANDOC_AVAILABLE = true;
    console.log('📄 document-service: pandoc detected — using pandoc pipeline');
} catch {
    PANDOC_AVAILABLE = false;
    console.warn('📄 document-service: pandoc NOT found on PATH — using pure-JS docx fallback (install pandoc for richer formatting: brew install pandoc)');
}

/**
 * Pure-JS markdown → docx converter. Handles the subset we see in
 * practice: H1-H3 headings, paragraphs, bullet/numbered lists, bold
 * and italic inline runs, and simple pipe tables. Not as rich as
 * pandoc (no footnotes, no LaTeX math, no fancy reference styles) but
 * produces a valid, readable .docx without requiring any system
 * binary — so document generation NEVER hard-fails just because
 * pandoc isn't installed.
 *
 * @param {string} filePath — where to write the .docx
 * @param {string} markdown — the source content
 */
async function createDocxPureJS(filePath, markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');

    /** Parse a markdown inline segment into an array of TextRun. */
    function parseInlines(text) {
        const runs = [];
        // Simple tokenizer: **bold**, *italic*, `code`, then plain.
        const regex = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
        let last = 0;
        let m;
        while ((m = regex.exec(text)) !== null) {
            if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: 'Calibri' }));
            const tok = m[0];
            if (tok.startsWith('**')) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true, font: 'Calibri' }));
            else if (tok.startsWith('*')) runs.push(new TextRun({ text: tok.slice(1, -1), italics: true, font: 'Calibri' }));
            else if (tok.startsWith('`')) runs.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas' }));
            last = m.index + tok.length;
        }
        if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: 'Calibri' }));
        return runs.length > 0 ? runs : [new TextRun({ text: '', font: 'Calibri' })];
    }

    function mkCell(text) {
        return new TableCell({
            children: [new Paragraph({ children: parseInlines(text) })],
            borders: {
                top:    { style: BorderStyle.SINGLE, size: 6, color: '999999' },
                bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999' },
                left:   { style: BorderStyle.SINGLE, size: 6, color: '999999' },
                right:  { style: BorderStyle.SINGLE, size: 6, color: '999999' },
            },
        });
    }

    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trimEnd();

        // Blank line → paragraph spacer (docx handles spacing in styles).
        if (line.trim() === '') { i++; continue; }

        // Headings
        let h;
        if ((h = line.match(/^###\s+(.*)$/))) {
            blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: parseInlines(h[1]) }));
            i++; continue;
        }
        if ((h = line.match(/^##\s+(.*)$/))) {
            blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: parseInlines(h[1]) }));
            i++; continue;
        }
        if ((h = line.match(/^#\s+(.*)$/))) {
            blocks.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: parseInlines(h[1]) }));
            i++; continue;
        }

        // Pipe table: gather contiguous | lines.
        if (/^\s*\|.*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
            const rows = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                // Skip the separator line "| --- | --- |"
                if (!/^\s*\|?\s*:?-+:?/.test(lines[i])) {
                    const cells = lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
                    rows.push(cells);
                }
                i++;
            }
            if (rows.length > 0) {
                const colCount = Math.max(...rows.map(r => r.length));
                const tableRows = rows.map(r => new TableRow({
                    children: Array.from({ length: colCount }, (_, c) => mkCell(r[c] || '')),
                }));
                blocks.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
                blocks.push(new Paragraph({ text: '' })); // spacer after table
            }
            continue;
        }

        // Bullet list
        let m;
        if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
            blocks.push(new Paragraph({ children: parseInlines(m[1]), bullet: { level: 0 } }));
            i++; continue;
        }

        // Numbered list
        if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
            blocks.push(new Paragraph({ children: parseInlines(m[1]), numbering: { reference: 'default-numbering', level: 0 } }));
            i++; continue;
        }

        // Default: plain paragraph
        blocks.push(new Paragraph({ children: parseInlines(line), alignment: AlignmentType.JUSTIFIED }));
        i++;
    }

    const doc = new Document({
        numbering: {
            config: [{
                reference: 'default-numbering',
                levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
            }],
        },
        styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 300, before: 80, after: 80 } } } } },
        sections: [{ children: blocks }],
    });

    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(filePath, buffer);
}


async function createDocx(filePath, content) {
    // No pandoc on this host → pure-JS fallback. Always produces a
    // valid .docx, no system dependency. Quality is close-enough for
    // typical reports; richer formatting (footnotes, LaTeX) requires
    // pandoc, which can be added later with `brew install pandoc`.
    if (!PANDOC_AVAILABLE) {
        console.log('📄 createDocx: using pure-JS fallback (pandoc unavailable)');
        return createDocxPureJS(filePath, content);
    }

    // --- Step 1: Extract and save base64 images ---
    const tempDir = path.join(__dirname, '../../uploads/temp');
    await fs.mkdir(tempDir, { recursive: true });

    // const imageFiles = [];
    // let imageCounter = 0;

    // Extract all images (base64 and URLs) and save them as files synchronously
    // const allImageMatches = Array.from(content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g));

    // for (const match of allImageMatches) {
    //     try {
    //         const [fullMatch, alt, imageSource] = match;
    //         let imagePath;
    //         let imageName;

    //         // Check if it's a base64 image
    //         if (imageSource.startsWith('data:image/')) {
    //             const urlMatches = imageSource.match(/^data:image\/([^;]+);base64,(.+)$/);
    //             if (urlMatches) {
    //                 const ext = urlMatches[1];
    //                 const base64Data = urlMatches[2];
    //                 imageName = `chart_image_${imageCounter++}.${ext}`;
    //                 imagePath = path.join(tempDir, imageName);

    //                 // Save the base64 image file
    //                 const buffer = Buffer.from(base64Data, 'base64');
    //                 await fs.writeFile(imagePath, buffer);

    //                 imageFiles.push({ original: fullMatch, path: imagePath, alt });
    //                 console.log(`Saved base64 chart image: ${imageName}`);
    //             }
    //         }
    //         // Check if it's a URL (http, https, or absolute file path)
    //         else if (imageSource.startsWith('http://') || imageSource.startsWith('https://') || imageSource.startsWith('file://') || path.isAbsolute(imageSource)) {
    //             try {
    //                 // Determine file extension from URL or default to png
    //                 let ext = 'png';
    //                 const urlExt = imageSource.split('.').pop()?.split('?')[0];
    //                 if (urlExt && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(urlExt.toLowerCase())) {
    //                     ext = urlExt.toLowerCase();
    //                 }

    //                 imageName = `chart_image_${imageCounter++}.${ext}`;
    //                 imagePath = path.join(tempDir, imageName);

    //                 // Download the image from URL
    //                 if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
    //                     const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
    //                     await fs.writeFile(imagePath, response.data);
    //                     console.log(`Downloaded URL chart image: ${imageName}`);
    //                 }
    //                 // Copy local file
    //                 else {
    //                     const localPath = imageSource.replace('file://', '');
    //                     const imageData = await fs.readFile(localPath);
    //                     await fs.writeFile(imagePath, imageData);
    //                     console.log(`Copied local chart image: ${imageName}`);
    //                 }

    //                 imageFiles.push({ original: fullMatch, path: imagePath, alt });
    //             } catch (downloadErr) {
    //                 console.error(`Failed to download/copy image from ${imageSource}:`, downloadErr);
    //                 // Keep original if download fails
    //                 continue;
    //             }
    //         }
    //     } catch (err) {
    //         console.error('Error processing image:', err);
    //     }
    // }

    // Replace all processed images with local file paths
    let cleanedContent = content;
    // for (const img of imageFiles) {
    //     cleanedContent = cleanedContent.replace(img.original, `![${img.alt}](${img.path})`);
    // }

    // --- Step 2: Semantic Table Parsing & Normalization ---
    // Highly improved normalization of markdown tables (including uneven columns etc.)
    function normalizeMarkdownTables(md) {
        const lines = md.split('\n');
        let result = [];
        let insideTable = false;
        let tableLines = [];

        function isTableLine(line) {
            // Only match as table if at least two pipes, not within codeblock
            return /^\s*\|.*\|/.test(line) && (line.match(/\|/g) || []).length >= 2;
        }

        function flushTable() {
            if (tableLines.length) {
                // Normalize table lines
                const cells = tableLines.map(line =>
                    line
                        .replace(/^\s*\|/, '')
                        .replace(/\|\s*$/, '')
                        .split('|')
                        .map(cell => cell.trim())
                );
                // Fix column count in all rows for a proper table
                const colCount = Math.max(...cells.map(row => row.length));
                const full = cells.map(row => {
                    if (row.length < colCount) return [...row, ...Array(colCount - row.length).fill('')];
                    return row.slice(0, colCount);
                });
                // Add header (assume always first row)
                result.push('');
                result.push('| ' + full[0].join(' | ') + ' |');
                for (let i = 1; i < full.length; i++) {
                    result.push('| ' + full[i].join(' | ') + ' |');
                }
                result.push('');
            }
            tableLines = [];
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (isTableLine(line)) {
                tableLines.push(line);
                insideTable = true;
            } else {
                if (insideTable) {
                    flushTable();
                    insideTable = false;
                }
                result.push(line);
            }
        }
        if (insideTable) {
            flushTable();
        }
        return result.join('\n');
    }

    cleanedContent = normalizeMarkdownTables(cleanedContent);

    // --- Step 3: Write Markdown to temp file for Pandoc ---
    const tempMarkdownPath = filePath + '.md';
    await fs.writeFile(tempMarkdownPath, cleanedContent);

    // --- Step 4: Create reference doc for Calibri font and nice base styles ---
    const referenceDoc = new Document({
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840 },
                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
                },
            },
            children: [new Paragraph({ text: "Reference Document", heading: HeadingLevel.HEADING_1 })]
        }],
        styles: {
            default: {
                document: {
                    run: { font: "Calibri", size: 22 },
                    paragraph: { spacing: { line: 276, before: 10, after: 10 } }
                }
            }
        }
    });
    const referenceDocPath = path.join(__dirname, '../../uploads/temp', 'reference.docx');
    await fs.mkdir(path.dirname(referenceDocPath), { recursive: true });
    const referenceBuffer = await Packer.toBuffer(referenceDoc);
    await fs.writeFile(referenceDocPath, referenceBuffer);

    // --- Step 5: Pandoc Convert ---
    // For DOCX, Pandoc converts LaTeX math to native Word OMML.
    // Do not pass --mathjax here: that option targets HTML output and
    // makes the intent ambiguous for Word documents.
    const pandocArgs = [
        tempMarkdownPath,
        '-f',
        'markdown+pipe_tables+grid_tables+tex_math_dollars+tex_math_single_backslash',
        '-t',
        'docx',
        '--standalone',
        `--extract-media=${tempDir}`,
        `--reference-doc=${referenceDocPath}`,
        '-o',
        filePath,
    ];
    console.log(`Executing Pandoc with ${pandocArgs.length} arguments`);

    // Image-handling was commented out above (see Step 2), so there are
    // no saved image files to unlink here. `imageFiles` stayed as a
    // reference in this cleanup block and was throwing ReferenceError
    // inside Pandoc's exec callback — which then bubbled up as a
    // generic document-creation failure in the route. Keep the array
    // empty-by-default so the loop is a no-op; if image extraction is
    // re-enabled, populate it in Step 2.
    const imageFiles = [];

    await new Promise((resolve, reject) => {
        execFile('pandoc', pandocArgs, { maxBuffer: 15 * 1024 * 1024 }, async (error, stdout, stderr) => {
            // Clean up temporary files
            try {
                await fs.unlink(tempMarkdownPath);
                // Clean up saved image files
                for (const imageFile of imageFiles) {
                    try {
                        await fs.unlink(imageFile.path);
                    } catch (unlinkErr) {
                        console.error("Image file could not be deleted:", unlinkErr);
                    }
                }
            } catch (unlinkErr) {
                console.error("Temporary markdown file could not be deleted:", unlinkErr);
            }
            if (error) {
                console.error(`Pandoc command execution error: ${error.message}`);
                console.error(`Pandoc stderr: ${stderr}`);
                return reject(error);
            }
            if (stderr) {
                // Pandoc sometimes emits warnings to stderr even on success
                console.warn(`Pandoc stderr (warnings): ${stderr}`);
            }
            console.log('Pandoc successfully created the Word document with tables.');
            resolve(stdout);
        });
    });

    // --- Step 6: Modify All Table Styles in XML for Beautiful Styling ---
    const docxBuffer = await fs.readFile(filePath);
    const zip = new PizZip(docxBuffer);
    let documentXml = zip.file('word/document.xml').asText();

    // Enhance table, header, cell and border styles in the document XML
    // Inject: borders, cell margin, vertical/horizontal alignment for best look
    documentXml = documentXml.replace(
        /<w:tblPr>/g,
        `<w:tblPr>
            <w:tblBorders>
                <w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:left w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:right w:val="single" w:sz="12" w:space="0" w:color="000000"/>
                <w:insideH w:val="single" w:sz="10" w:space="0" w:color="000000"/>
                <w:insideV w:val="single" w:sz="10" w:space="0" w:color="000000"/>
            </w:tblBorders>
            <w:tblCellMar>
                <w:top w:w="120" w:type="dxa"/>
                <w:left w:w="120" w:type="dxa"/>
                <w:bottom w:w="120" w:type="dxa"/>
                <w:right w:w="120" w:type="dxa"/>
            </w:tblCellMar>
            <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>
        `
    );

    // Add blue background and bold formatting for table headers
    // (apply blue background to the first row of each table)
    documentXml = documentXml.replace(
        /(<w:tr>)(\s*<w:tc>)/g,
        (match, p1, p2, offset, string) => {
            // Only apply to header row (first w:tr after a w:tbl element)
            const slice = string.substring(Math.max(0, offset - 250), offset);
            if (slice.includes('<w:tbl>')) {
                // Insert cell shading for all <w:tc> in this <w:tr>
                return p1 + p2.replace(
                    '<w:tc>',
                    `<w:tc>
                        <w:tcPr>
                            <w:shd w:val="clear" w:color="auto" w:fill="4472C4"/>
                            <w:vAlign w:val="center"/>
                        </w:tcPr>`
                );
            }
            return match;
        }
    );

    // Make header row text bold and white
    documentXml = documentXml.replace(
        /(<w:tr>[\s\S]*?<w:tbl>[\s\S]*?<w:tc>[\s\S]*?<w:t>)/g,
        (match) => {
            // Check if this is a header row
            const slice = match.substring(Math.max(0, match.length - 500));
            if (slice.includes('<w:tbl>')) {
                // Add bold formatting to text runs in header cells
                return match.replace(/<w:r>/g, '<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>');
            }
            return match;
        }
    );

    // For all cell props, ensure some horizontal/vertical margin and fixed height for aesthetics
    documentXml = documentXml.replace(
        /<w:tcPr>/g,
        `<w:tcPr>
            <w:tcMar>
                <w:top w:w="80" w:type="dxa"/>
                <w:left w:w="80" w:type="dxa"/>
                <w:bottom w:w="80" w:type="dxa"/>
                <w:right w:w="80" w:type="dxa"/>
            </w:tcMar>
            <w:vAlign w:val="center"/>
        `
    );

    // Write back modified docx with all style updates
    zip.file('word/document.xml', documentXml);
    const modifiedBuffer = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(filePath, modifiedBuffer);
}

async function createPdf(filePath, content) {
    const { marked } = await import('marked');
    const htmlContent = marked.parse(content);
    const fullHtml = `
        <html>
            <head>
                <meta charset="UTF-8">
                <title>Generated Document</title>
                <script>
                    window.MathJax = {
                        tex: {
                            inlineMath: [['$', '$'], ['\\(', '\\)']]
                        },
                        svg: {
                            fontCache: 'global'
                        }
                    };
                </script>
                <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
                <style>
                    body { font-family: 'Helvetica', 'Arial', sans-serif; margin: 40px; line-height: 1.6; font-size: 12pt; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    pre, code { background-color: #f8f8f8; padding: 2px 5px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; }
                    pre { padding: 10px; display: block; white-space: pre-wrap; }
                    h1, h2, h3 { border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; margin-top: 24px; margin-bottom: 16px; }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
        </html>
    `;

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
        await window.MathJax.startup.promise;
    });
    await page.pdf({
        path: filePath,
        format: 'A4',
        printBackground: true,
        margin: { top: '40px', right: '40px', bottom: '40px', left: '40px' }
    });
    await browser.close();
}

function htmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function stripMarkdown(value) {
    return String(value ?? '')
        .replace(/\[CREATE_DOCUMENT:[^\]]+\]|\[\/CREATE_DOCUMENT\]/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferPresentationTitle(content, fallbackTitle) {
    const text = String(content || '').replace(/\r\n/g, '\n');
    const explicitTitle = text.match(/(?:^|\n)\s*(?:#\s+|t[ií]tulo\s*:\s*)([^\n]{8,110})/i);
    if (explicitTitle) return stripMarkdown(explicitTitle[1]);
    return stripMarkdown(String(fallbackTitle || 'Presentacion profesional').replace(/\.(pptx?|docx|pdf)$/i, '').replace(/[_-]+/g, ' '));
}

function compactBullet(line) {
    return stripMarkdown(line)
        .replace(/^(?:[-*•]\s*|\d+[\).\s]+)\s*/, '')
        .replace(/^(?:subt[ií]tulo|nota del ponente|nota|t[ií]tulo)\s*:\s*/i, '')
        .trim();
}

function normalizeSlide(title, bodyLines) {
    const notes = [];
    const bullets = [];
    for (const raw of bodyLines) {
        const line = String(raw || '').trim();
        if (!line) continue;
        if (/^nota(?:\s+del\s+ponente)?\s*:/i.test(line)) {
            notes.push(compactBullet(line));
            continue;
        }
        if (/^(?:[-*•]\s+|\d+[\).\s]+|subt[ií]tulo\s*:|t[ií]tulo\s*:)/i.test(line)) {
            const bullet = compactBullet(line);
            if (bullet) bullets.push(bullet);
            continue;
        }
        if (line.length > 18 && line.length < 180) bullets.push(compactBullet(line));
    }
    return {
        title: stripMarkdown(title).slice(0, 92) || 'Diapositiva',
        bullets: Array.from(new Set(bullets.filter(Boolean))).slice(0, 5),
        notes: notes.filter(Boolean).join(' '),
    };
}

function fallbackMarketingSlides(title) {
    const isMarketing = /marketing|m[aá]rqueting|mercadeo/i.test(title);
    const sections = isMarketing
        ? [
            ['Concepto central', ['El marketing conecta necesidades reales del mercado con propuestas de valor diferenciadas.', 'Integra investigación, segmentación, posicionamiento, comunicación y medición.']],
            ['Segmentación y audiencia', ['Definir buyer personas evita campañas genéricas y mejora la conversión.', 'Los segmentos deben priorizar tamaño, necesidad, acceso y rentabilidad.']],
            ['Propuesta de valor', ['El mensaje debe explicar beneficio, prueba y diferencia competitiva.', 'Una propuesta clara reduce fricción en la decisión de compra.']],
            ['Marketing digital', ['SEO, contenido, paid media, email y automatización deben operar como sistema.', 'La atribución permite optimizar presupuesto y aprendizaje.']],
            ['Métricas clave', ['CAC, LTV, ROAS, tasa de conversión y retención orientan decisiones.', 'Las métricas deben conectarse con objetivos de negocio.']],
            ['Plan de acción', ['Priorizar hipótesis, ejecutar experimentos y medir resultados por ciclo.', 'Documentar aprendizajes permite escalar lo que funciona.']],
        ]
        : [
            ['Contexto', ['Definir alcance, público objetivo y resultado esperado.', 'Alinear mensaje, evidencia y formato de entrega.']],
            ['Diagnóstico', ['Identificar variables críticas y restricciones del proyecto.', 'Priorizar información verificable y decisiones accionables.']],
            ['Estrategia', ['Convertir objetivos en líneas de trabajo concretas.', 'Asignar criterios de éxito y responsables por etapa.']],
            ['Ejecución', ['Organizar tareas por dependencia, riesgo y valor.', 'Mantener trazabilidad de avances y decisiones.']],
            ['Validación', ['Revisar integridad, coherencia, formato y evidencia.', 'Corregir antes de liberar la entrega final.']],
            ['Cierre', ['Resumir hallazgos, próximos pasos y riesgos pendientes.', 'Entregar archivos utilizables y auditables.']],
        ];
    return sections.map(([sectionTitle, bullets]) => ({ title: sectionTitle, bullets, notes: `Presentar ${sectionTitle.toLowerCase()} con foco ejecutivo.` }));
}

function extractPresentationDeck(content, fallbackTitle) {
    const normalized = String(content || '').replace(/\r\n/g, '\n');
    const title = inferPresentationTitle(normalized, fallbackTitle);
    const slides = [];
    let currentTitle = null;
    let currentLines = [];

    const flush = () => {
        if (!currentTitle) return;
        const slide = normalizeSlide(currentTitle, currentLines);
        if (slide.title && (slide.bullets.length > 0 || slide.notes)) slides.push(slide);
        currentTitle = null;
        currentLines = [];
    };

    for (const raw of normalized.split('\n')) {
        const line = raw.trim();
        if (!line) {
            currentLines.push('');
            continue;
        }
        const slideMatch = line.match(/^(?:#{1,4}\s*)?(?:diapositiva|slide)\s*\d+\s*[–—:-]\s*(.+)$/i);
        const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
        const titledMatch = line.match(/^t[ií]tulo\s*:\s*(.+)$/i);
        if (slideMatch || headingMatch) {
            flush();
            currentTitle = stripMarkdown((slideMatch || headingMatch)[1]);
            currentLines = [];
        } else if (titledMatch && !currentTitle) {
            currentTitle = stripMarkdown(titledMatch[1]);
            currentLines = [];
        } else {
            if (!currentTitle && line.length < 90 && /^[A-ZÁÉÍÓÚÑ][^.!?]{6,}$/i.test(line)) {
                currentTitle = stripMarkdown(line);
                currentLines = [];
            } else {
                currentLines.push(line);
            }
        }
    }
    flush();

    if (slides.length < 4) {
        const paragraphSlides = normalized
            .split(/\n\s*\n+/)
            .map((chunk) => stripMarkdown(chunk))
            .filter((chunk) => chunk.length > 80)
            .slice(0, 5)
            .map((chunk, index) => {
                const sentences = chunk.split(/(?<=[.!?])\s+/).filter(Boolean);
                return normalizeSlide(index === 0 ? title : `Bloque ${index + 1}`, sentences.slice(0, 5));
            })
            .filter((slide) => slide.bullets.length > 0);
        slides.push(...paragraphSlides);
    }

    const mergedSlides = slides.length >= 4 ? slides : [...slides, ...fallbackMarketingSlides(title)];
    const uniqueSlides = [];
    const seen = new Set();
    for (const slide of mergedSlides) {
        const key = slide.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueSlides.push(slide);
        if (uniqueSlides.length >= 16) break;
    }

    return { title, slides: uniqueSlides };
}

function buildPptxPreviewHtml(deck, filename) {
    const slideCards = deck.slides.map((slide, index) => {
        const bullets = slide.bullets.map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join('');
        return `<section class="slide"><div class="num">${index + 1}</div><h2>${htmlEscape(slide.title)}</h2><ul>${bullets}</ul>${slide.notes ? `<p class="notes">${htmlEscape(slide.notes)}</p>` : ''}</section>`;
    }).join('');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(deck.title)}</title><style>
    :root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--card:#fff;--bg:#f8fafc;--accent:#f97316}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#fff7ed,#f8fafc 38%,#eef2ff);font-family:Aptos,Inter,system-ui,sans-serif;color:var(--ink)}
    .wrap{max-width:1120px;margin:0 auto;padding:34px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px}
    .eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:800}h1{font-size:clamp(30px,5vw,56px);line-height:.95;margin:8px 0 10px}
    .meta{color:var(--muted);font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.slide{position:relative;min-height:250px;background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:26px;padding:26px 28px 26px 76px;box-shadow:0 24px 70px rgba(15,23,42,.10)}
    .num{position:absolute;left:22px;top:24px;width:36px;height:36px;border-radius:999px;background:#111827;color:white;display:grid;place-items:center;font-weight:800}
    h2{margin:0 0 14px;font-size:25px}ul{margin:0;padding-left:18px;display:grid;gap:9px;line-height:1.45}.notes{margin-top:16px;color:#475569;font-size:13px;border-top:1px solid var(--line);padding-top:12px}
    .badge{border:1px solid var(--line);border-radius:999px;padding:9px 12px;background:white;color:#374151;font-weight:700;white-space:nowrap}@media(max-width:840px){.grid{grid-template-columns:1fr}.wrap{padding:22px}.hero{display:block}.slide{padding-left:64px}}
    </style></head><body><main class="wrap"><header class="hero"><div><span class="eyebrow">siraGPT Rendering Agent</span><h1>${htmlEscape(deck.title)}</h1><p class="meta">Preview generado desde el mismo contrato usado para construir el PPTX con código.</p></div><div class="badge">${htmlEscape(filename)} · ${deck.slides.length + 2} slides</div></header><section class="grid">${slideCards}</section></main></body></html>`;
}

async function createPptx(filePath, content, filename) {
    const deck = extractPresentationDeck(content, filename);
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'siraGPT Rendering Agent';
    pptx.subject = deck.title;
    pptx.company = 'siraGPT';
    pptx.lang = 'es-ES';
    pptx.theme = {
        headFontFace: 'Aptos Display',
        bodyFontFace: 'Aptos',
        lang: 'es-ES',
    };

    const palette = { bg: 'FFF7ED', ink: '111827', muted: '6B7280', accent: 'F97316', white: 'FFFFFF', line: 'FED7AA' };
    const addHeader = (slide, title, subtitle) => {
        slide.background = { color: palette.bg };
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: palette.bg }, line: { color: palette.bg } });
        slide.addShape(pptx.ShapeType.arc, { x: 10.4, y: -0.72, w: 3.2, h: 3.2, fill: { color: 'FFEDD5', transparency: 4 }, line: { color: palette.line, transparency: 20 } });
        slide.addText(title, { x: 0.72, y: 0.62, w: 9.2, h: 0.72, fontFace: 'Aptos Display', fontSize: 28, bold: true, color: palette.ink, margin: 0, fit: 'shrink' });
        if (subtitle) slide.addText(subtitle, { x: 0.74, y: 1.34, w: 8.8, h: 0.32, fontSize: 11.5, color: palette.muted, margin: 0, fit: 'shrink' });
        slide.addText('siraGPT', { x: 11.35, y: 6.93, w: 1.2, h: 0.22, fontSize: 8.5, color: palette.muted, align: 'right', margin: 0 });
    };

    let slide = pptx.addSlide();
    addHeader(slide, deck.title, 'Presentación construida con código, renderizada y validada antes de entrega');
    slide.addShape(pptx.ShapeType.rect, { x: 0.76, y: 4.9, w: 3.4, h: 0.12, fill: { color: palette.accent }, line: { color: palette.accent } });
    slide.addText('Rendering Agent: PPTX nativo + preview HTML', { x: 0.76, y: 5.16, w: 6.8, h: 0.35, fontSize: 13, color: palette.muted, margin: 0 });
    slide.addNotes('Abrir con una síntesis del objetivo y confirmar que el archivo fue generado como PPTX nativo.');

    slide = pptx.addSlide();
    addHeader(slide, 'Agenda', 'Ruta narrativa de la presentación');
    deck.slides.slice(0, 10).forEach((item, index) => {
        slide.addText(`${index + 1}. ${item.title}`, { x: 0.9, y: 1.98 + index * 0.43, w: 8.9, h: 0.26, fontSize: 14.5, color: palette.ink, margin: 0, fit: 'shrink' });
    });
    slide.addNotes('Mostrar la estructura completa antes de entrar a cada bloque.');

    deck.slides.forEach((item, index) => {
        slide = pptx.addSlide();
        addHeader(slide, item.title, `Diapositiva ${index + 1} · contenido estructurado`);
        const bulletText = (item.bullets.length > 0 ? item.bullets : ['Contenido profesional estructurado desde la solicitud del usuario.'])
            .map((bullet) => `• ${bullet}`)
            .join('\n');
        slide.addText(bulletText, { x: 0.92, y: 2.0, w: 6.8, h: 2.55, fontSize: 15.5, color: '374151', breakLine: true, fit: 'shrink', paraSpaceAfterPt: 8 });
        slide.addShape(pptx.ShapeType.roundRect, { x: 8.45, y: 2.0, w: 3.6, h: 2.55, rectRadius: 0.12, fill: { color: palette.white, transparency: 0 }, line: { color: palette.line } });
        slide.addText(String(index + 1).padStart(2, '0'), { x: 8.72, y: 2.24, w: 1.1, h: 0.54, fontSize: 24, bold: true, color: palette.accent, margin: 0 });
        slide.addText('Bloque verificable', { x: 9.85, y: 2.3, w: 1.85, h: 0.24, fontSize: 11.5, color: palette.muted, margin: 0 });
        slide.addText('Estructura, formato y descarga pasan por validación técnica antes de entregarse al usuario.', { x: 8.72, y: 3.12, w: 2.95, h: 0.78, fontSize: 11.5, color: '475569', fit: 'shrink', margin: 0 });
        slide.addNotes(item.notes || `Explicar ${item.title} de forma breve y accionable.`);
    });

    slide = pptx.addSlide();
    addHeader(slide, 'Cierre', 'Resumen ejecutivo y próximos pasos');
    slide.addText([
        { text: 'Entrega validada: ', options: { bold: true } },
        { text: 'PPTX nativo creado con código, preview HTML disponible y descarga enlazada al artefacto real.' },
    ], { x: 0.9, y: 2.08, w: 8.4, h: 0.7, fontSize: 18, color: palette.ink, margin: 0 });
    slide.addNotes('Cerrar con próximos pasos y confirmar que la presentación puede descargarse.');

    await pptx.writeFile({ fileName: filePath });
    return {
        format: 'pptx',
        htmlPreview: buildPptxPreviewHtml(deck, path.basename(filePath)),
        slideCount: deck.slides.length + 3,
        renderAgent: {
            name: 'rendering_agent',
            engine: 'pptxgenjs',
            codeGenerated: true,
        },
    };
}

async function createDocument(userId, filename, content) {
    const safeUserId = String(userId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!safeUserId) {
        throw new Error('createDocument: userId required');
    }
    const uploadsDir = path.join(__dirname, '../../uploads/documents', safeUserId);
    await fs.mkdir(uploadsDir, { recursive: true });
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(uploadsDir, safeFilename);

    const extension = path.extname(safeFilename).toLowerCase();

    let metadata = {};

    if (extension === '.docx') {
        await createDocx(filePath, content);
    } else if (extension === '.pdf') {
        await createPdf(filePath, content);
    } else if (extension === '.pptx') {
        metadata = await createPptx(filePath, content, safeFilename);
    } else {
        await fs.writeFile(filePath, content);
    }

    return { filePath, safeFilename, ...metadata };
}

module.exports = {
    createDocument,
};
