const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');
const { exec, execSync } = require('child_process');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, AlignmentType, BorderStyle, WidthType } = require('docx');
const puppeteer = require('puppeteer');
const PizZip = require('pizzip');
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

    // --- Step 5: Pandoc Convert (with grid_tables and image extraction enabled) ---
    const pandocCommand = `pandoc "${tempMarkdownPath}" -f markdown+pipe_tables+grid_tables -t docx --extract-media="${tempDir}" --mathjax --reference-doc="${referenceDocPath}" -o "${filePath}"`;
    console.log(`Executing Pandoc command: ${pandocCommand}`);

    // Image-handling was commented out above (see Step 2), so there are
    // no saved image files to unlink here. `imageFiles` stayed as a
    // reference in this cleanup block and was throwing ReferenceError
    // inside Pandoc's exec callback — which then bubbled up as a
    // generic document-creation failure in the route. Keep the array
    // empty-by-default so the loop is a no-op; if image extraction is
    // re-enabled, populate it in Step 2.
    const imageFiles = [];

    await new Promise((resolve, reject) => {
        exec(pandocCommand, { maxBuffer: 15 * 1024 * 1024 }, async (error, stdout, stderr) => {
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

async function createDocument(userId, filename, content) {
    const uploadsDir = path.join(__dirname, '../../uploads/documents', userId);
    await fs.mkdir(uploadsDir, { recursive: true });
    const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(uploadsDir, safeFilename);

    const extension = path.extname(safeFilename).toLowerCase();

    if (extension === '.docx') {
        await createDocx(filePath, content);
    } else if (extension === '.pdf') {
        await createPdf(filePath, content);
    } else {
        await fs.writeFile(filePath, content);
    }

    return { filePath, safeFilename };
}

module.exports = {
    createDocument,
};
