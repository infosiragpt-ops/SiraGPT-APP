const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const XLSX = require('xlsx');
const fs = require('fs').promises;
const path = require('path');
const PptxGenJS = require('pptxgenjs');

const router = express.Router();

// Simple content cleaning for exports
function cleanContentForExport(text) {
    return text
        // Remove LaTeX delimiters
        .replace(/\$\$([^$]+)\$\$/g, '$1')
        .replace(/\$([^$]+)\$/g, '$1')
        // Basic LaTeX conversions
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)')
        .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
        .replace(/\^{([^}]+)}/g, '^($1)')
        .replace(/_{([^}]+)}/g, '_($1)')
        // Remove LaTeX commands
        .replace(/\\[a-zA-Z]+/g, '')
        .replace(/[{}]/g, '')
        // Clean markdown
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^#+\s*/gm, '')
        // Clean spacing
        .replace(/\s+/g, ' ')
        .trim();
}


// Extract structured math content for better parsing
function extractMathExamples(content) {
    const lines = content.split('\n').filter(line => line.trim());

    const mathExamples = [];
    let currentDescription = '';

    for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();

        // Skip empty lines and headers
        if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.includes('Here are') || trimmedLine.includes('Let me know')) {
            continue;
        }

        // Check if it's a section header (like "Derivative of...")
        if (trimmedLine.includes('Derivative of') || trimmedLine.includes('Derivative using')) {
            currentDescription = trimmedLine.replace(/:/g, '').trim();
            continue;
        }

        // Check if it's a condition + formula line (starts with "If" and contains f'(x))
        if (trimmedLine.startsWith('If ') && (trimmedLine.includes("f'(x)") || trimmedLine.includes("f′(x)"))) {
            // Split at "then:" to separate condition from formula
            const parts = trimmedLine.split(/then:?\s*/);
            if (parts.length >= 2) {
                const condition = parts[0].trim();
                const formula = parts.slice(1).join(' ').trim();

                const description = currentDescription ? `${currentDescription} - ${condition}` : condition;
                const cleanFormula = cleanContentForExport(formula);

                mathExamples.push({
                    description: description,
                    formula: cleanFormula
                });

                currentDescription = '';
            }
            continue;
        }

        // Check for example lines (like "So, for example...")
        if (trimmedLine.startsWith('So, for example') && (trimmedLine.includes("f'(x)") || trimmedLine.includes("f′(x)"))) {
            // Extract the example part
            const exampleMatch = trimmedLine.match(/if\s+(.+?),\s*then\s+(.+)/i);
            if (exampleMatch) {
                const condition = exampleMatch[1].trim();
                const formula = exampleMatch[2].trim().replace(/\.$/, ''); // Remove trailing period

                mathExamples.push({
                    description: `Example: ${condition}`,
                    formula: cleanContentForExport(formula)
                });
            }
            continue;
        }
    }

    if (mathExamples.length >= 2) {
        return {
            headers: ['Description', 'Formula'],
            rows: mathExamples.map(ex => [ex.description, ex.formula])
        };
    }

    return null;
}

// Utility function to detect table data from text
function detectTableData(content) {
    // First try to extract math examples
    const mathData = extractMathExamples(content);
    if (mathData) {
        return mathData;
    }

    // Look for markdown tables
    const markdownTableRegex = /\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/g;
    const match = markdownTableRegex.exec(content);

    if (match) {
        const headerRow = match[1].split('|').map(cell => cleanContentForExport(cell.trim())).filter(cell => cell);
        const bodyRows = match[2].split('\n')
            .filter(row => row.trim() && row.includes('|'))
            .map(row => row.split('|').map(cell => cleanContentForExport(cell.trim())).filter(cell => cell));

        return {
            headers: headerRow,
            rows: bodyRows
        };
    }

    // Look for simple structured data patterns
    const lines = content.split('\n').filter(line => line.trim());

    // Check if content looks like a list with consistent structure
    const listPattern = /^\d+\.\s+(.+?):\s*(.+)$/;
    const structuredLines = lines.filter(line => listPattern.test(line));

    if (structuredLines.length >= 3) {
        const headers = ['Item', 'Value'];
        const rows = structuredLines.map(line => {
            const match = listPattern.exec(line);
            return match ? [cleanContentForExport(match[1]), cleanContentForExport(match[2])] : ['', ''];
        });

        return { headers, rows };
    }

    // Check for colon-separated data
    const colonPattern = /^(.+?):\s*(.+)$/;
    const colonLines = lines.filter(line => colonPattern.test(line));

    if (colonLines.length >= 3) {
        const headers = ['Property', 'Value'];
        const rows = colonLines.map(line => {
            const match = colonPattern.exec(line);
            return match ? [cleanContentForExport(match[1].trim()), cleanContentForExport(match[2].trim())] : ['', ''];
        });

        return { headers, rows };
    }

    return null;
}

// Generate Excel file from message content
router.post(
    '/excel',
    [
        body('messageId').notEmpty().withMessage('Message ID is required'),
        body('filename').optional().isString()
    ],
    authenticateToken,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { messageId, filename } = req.body;
            const userId = req.user.id;

            // Get message from database
            const message = await prisma.message.findFirst({
                where: {
                    id: messageId,
                    chat: { userId }
                },
                include: { chat: true }
            });

            if (!message) {
                return res.status(404).json({ error: 'Message not found' });
            }

            // Detect table data
            const tableData = detectTableData(message.content);

            if (!tableData) {
                return res.status(400).json({ error: 'No tabular data found in message' });
            }

            // Create Excel workbook
            const wb = XLSX.utils.book_new();
            const wsData = [tableData.headers, ...tableData.rows];
            const ws = XLSX.utils.aoa_to_sheet(wsData);

            // Auto-size columns
            const colWidths = tableData.headers.map((_, colIndex) => {
                const maxLength = Math.max(
                    tableData.headers[colIndex]?.length || 0,
                    ...tableData.rows.map(row => row[colIndex]?.length || 0)
                );
                return { wch: Math.min(maxLength + 2, 50) };
            });
            ws['!cols'] = colWidths;

            XLSX.utils.book_append_sheet(wb, ws, 'AI Response Data');

            // Generate filename
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const finalFilename = filename || `ai-response-${timestamp}.xlsx`;

            // Write to buffer
            const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

            // Set headers for file download
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
            res.setHeader('Content-Length', excelBuffer.length);

            res.send(excelBuffer);

        } catch (error) {
            console.error('Excel generation error:', error);
            res.status(500).json({ error: 'Failed to generate Excel file' });
        }
    }
);

// Generate CSV file from message content
router.post(
    '/csv',
    [
        body('messageId').notEmpty().withMessage('Message ID is required'),
        body('filename').optional().isString()
    ],
    authenticateToken,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { messageId, filename } = req.body;
            const userId = req.user.id;

            // Get message from database
            const message = await prisma.message.findFirst({
                where: {
                    id: messageId,
                    chat: { userId }
                },
                include: { chat: true }
            });

            if (!message) {
                return res.status(404).json({ error: 'Message not found' });
            }

            // Detect table data
            const tableData = detectTableData(message.content);

            if (!tableData) {
                return res.status(400).json({ error: 'No tabular data found in message' });
            }

            // Generate CSV content
            const csvRows = [
                tableData.headers.join(','),
                ...tableData.rows.map(row =>
                    row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')
                )
            ];
            const csvContent = csvRows.join('\n');

            // Generate filename
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const finalFilename = filename || `ai-response-${timestamp}.csv`;

            // Set headers for file download
            res.setHeader('Content-Type', 'text/csv;charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);

            res.send(csvContent);

        } catch (error) {
            console.error('CSV generation error:', error);
            res.status(500).json({ error: 'Failed to generate CSV file' });
        }
    }
);

// Generate text file from message content
router.post(
    '/text',
    [
        body('messageId').notEmpty().withMessage('Message ID is required'),
        body('filename').optional().isString()
    ],
    authenticateToken,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { messageId, filename } = req.body;
            const userId = req.user.id;

            // Get message from database
            const message = await prisma.message.findFirst({
                where: {
                    id: messageId,
                    chat: { userId }
                },
                include: { chat: true }
            });

            if (!message) {
                return res.status(404).json({ error: 'Message not found' });
            }

            // Generate filename
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const finalFilename = filename || `ai-response-${timestamp}.txt`;

            // Set headers for file download
            res.setHeader('Content-Type', 'text/plain;charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);

            res.send(message.content);

        } catch (error) {
            console.error('Text file generation error:', error);
            res.status(500).json({ error: 'Failed to generate text file' });
        }
    }
);

// Generate PowerPoint file from message content
router.post(
    '/powerpoint',
    [
        body('messageId').notEmpty().withMessage('Message ID is required'),
        body('filename').optional().isString()
    ],
    authenticateToken,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { messageId, filename } = req.body;
            const userId = req.user.id;

            // Get message from database
            const message = await prisma.message.findFirst({
                where: {
                    id: messageId,
                    chat: { userId }
                },
                include: { chat: true }
            });

            if (!message) {
                return res.status(404).json({ error: 'Message not found' });
            }

            // Create PowerPoint presentation
            const pptx = new PptxGenJS();

            // Set presentation properties
            pptx.author = 'AI Assistant';
            pptx.company = 'AI Chat';
            pptx.title = 'AI Generated Content';

            // Title slide
            const titleSlide = pptx.addSlide();
            titleSlide.addText('AI Generated Content', {
                x: 1,
                y: 1,
                w: 8,
                h: 1.5,
                fontSize: 32,
                bold: true,
                align: 'center'
            });

            titleSlide.addText(new Date().toLocaleDateString(), {
                x: 1,
                y: 2.5,
                w: 8,
                h: 0.5,
                fontSize: 16,
                align: 'center',
                color: '666666'
            });

            // Content slides
            const contentLines = message.content.split('\n').filter(line => line.trim());
            const slidesContent = [];
            let currentSlide = [];

            for (const line of contentLines) {
                const trimmedLine = line.trim();

                // Start new slide on headers or after 8 lines
                if (trimmedLine.startsWith('#') || currentSlide.length >= 8) {
                    if (currentSlide.length > 0) {
                        slidesContent.push([...currentSlide]);
                        currentSlide = [];
                    }
                }

                if (trimmedLine) {
                    // Clean math content for PowerPoint
                    const cleanLine = cleanContentForExport(trimmedLine);
                    currentSlide.push(cleanLine);
                }
            }

            // Add remaining content
            if (currentSlide.length > 0) {
                slidesContent.push(currentSlide);
            }

            // Create content slides
            slidesContent.forEach((slideContent, index) => {
                const slide = pptx.addSlide();

                // Add slide title
                const title = slideContent[0]?.replace(/^#+\s*/, '') || `Content ${index + 1}`;
                slide.addText(title, {
                    x: 0.5,
                    y: 0.3,
                    w: 9,
                    h: 0.8,
                    fontSize: 24,
                    bold: true,
                    color: '333333'
                });

                // Add content
                const content = slideContent.slice(1).join('\n');
                if (content) {
                    slide.addText(content, {
                        x: 0.5,
                        y: 1.2,
                        w: 9,
                        h: 5,
                        fontSize: 14,
                        valign: 'top'
                    });
                }
            });

            // Add table slide if available
            const tableData = detectTableData(message.content);
            if (tableData) {
                const tableSlide = pptx.addSlide();
                tableSlide.addText('Data Table', {
                    x: 0.5,
                    y: 0.3,
                    w: 9,
                    h: 0.8,
                    fontSize: 24,
                    bold: true,
                    color: '333333'
                });

                // Prepare table data for PowerPoint
                const pptTableData = [
                    tableData.headers.map(header => ({ text: header, options: { bold: true, fill: 'F2F2F2' } })),
                    ...tableData.rows.map(row => row.map(cell => ({ text: cell })))
                ];

                tableSlide.addTable(pptTableData, {
                    x: 0.5,
                    y: 1.2,
                    w: 9,
                    h: 4,
                    fontSize: 12,
                    border: { pt: 1, color: 'CCCCCC' }
                });
            }

            // Generate filename
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const finalFilename = filename || `ai-response-${timestamp}.pptx`;

            // Write to buffer
            const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });

            // Set headers for file download
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
            res.setHeader('Content-Length', pptxBuffer.length);

            res.send(pptxBuffer);

        } catch (error) {
            console.error('PowerPoint generation error:', error);
            res.status(500).json({ error: 'Failed to generate PowerPoint file' });
        }
    }
);

module.exports = router;