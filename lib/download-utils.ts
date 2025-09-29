import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType } from 'docx';

export interface TableData {
  headers: string[];
  rows: string[][];
}

// Simple content cleaning for exports
function cleanContentForExport(text: string): string {
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

// Extract table data from content
export function detectTableData(content: string): TableData | null {
  const lines = content.split('\n').filter(line => line.trim());

  // Look for derivative examples pattern
  const examples: { rule: string; formula: string }[] = [];
  let currentRule = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and intro text
    if (!line || line.includes('Here are') || line.includes('Let me know')) {
      continue;
    }

    // Check for numbered rules (1. **Rule Name**)
    const ruleMatch = line.match(/^\d+\.\s*\*\*([^*]+)\*\*/);
    if (ruleMatch) {
      currentRule = ruleMatch[1].trim();
      continue;
    }

    // Check for formula lines
    if (line.includes('Formula:') && currentRule) {
      const formulaText = line.replace('Formula:', '').trim();
      const cleanFormula = cleanContentForExport(formulaText);

      examples.push({
        rule: currentRule,
        formula: cleanFormula
      });

      currentRule = '';
    }
  }

  if (examples.length >= 2) {
    return {
      headers: ['Derivative Rule', 'Formula'],
      rows: examples.map(ex => [ex.rule, ex.formula])
    };
  }

  // Look for markdown tables (prioritize existing tables in response)
  const tableMatches = content.match(/\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/g);
  if (tableMatches && tableMatches.length > 0) {
    // Use the first table found in the response
    const tableMatch = tableMatches[0].match(/\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/);
    if (tableMatch) {
      const headers = tableMatch[1].split('|').map(h => h.trim()).filter(h => h);
      const rows = tableMatch[2].split('\n')
        .filter(row => row.trim() && row.includes('|'))
        .map(row => row.split('|').map(cell => cell.trim()).filter(cell => cell));

      return { headers, rows };
    }
  }

  return null;
}

// Generate CSV
export function generateCSV(tableData: TableData): string {
  const rows = [
    tableData.headers.join(','),
    ...tableData.rows.map(row =>
      row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')
    )
  ];
  return rows.join('\n');
}

// Generate Excel
export function generateExcel(tableData: TableData): Blob {
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

  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// Generate Word document
export async function generateWord(content: string, tableData?: TableData): Promise<Blob> {
  const paragraphs: Paragraph[] = [];

  // Preserve original formatting - split by lines but don't clean content
  const lines = content.split('\n');

  lines.forEach(line => {
    // Add each line as a paragraph, including empty lines for spacing
    paragraphs.push(new Paragraph({
      text: line || ' ', // Use space for empty lines to maintain spacing
      spacing: {
        after: 120 // Add some spacing after each paragraph
      }
    }));
  });

  // Add table if available
  if (tableData) {
    paragraphs.push(new Paragraph({ text: '' }));
    paragraphs.push(new Paragraph({ text: 'Data Summary', heading: 'Heading2' }));

    const tableRows = [
      new TableRow({
        children: tableData.headers.map(header =>
          new TableCell({
            children: [new Paragraph({ text: header })],
            width: { size: 100 / tableData.headers.length, type: WidthType.PERCENTAGE }
          })
        )
      }),
      ...tableData.rows.map(row =>
        new TableRow({
          children: row.map(cell =>
            new TableCell({
              children: [new Paragraph({ text: cell })],
              width: { size: 100 / row.length, type: WidthType.PERCENTAGE }
            })
          )
        })
      )
    ];

    const table = new Table({
      rows: tableRows,
      width: { size: 100, type: WidthType.PERCENTAGE }
    });

    const doc = new Document({
      sections: [{ children: [...paragraphs, table] }]
    });

    return await Packer.toBlob(doc);
  }

  const doc = new Document({
    sections: [{ children: paragraphs }]
  });

  return await Packer.toBlob(doc);
}

// Download utilities
export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCSV(tableData: TableData, filename: string = 'data.csv') {
  const csvContent = generateCSV(tableData);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadFile(blob, filename);
}

export function downloadExcel(tableData: TableData, filename: string = 'data.xlsx') {
  const blob = generateExcel(tableData);
  downloadFile(blob, filename);
}

export async function downloadWord(content: string, filename: string = 'document.docx', tableData?: TableData) {
  const blob = await generateWord(content, tableData);
  downloadFile(blob, filename);
}

export function downloadText(content: string, filename: string = 'document.txt') {
  // Keep original formatting for text files
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  downloadFile(blob, filename);
}

// HTML presentation
export function generateHTMLPresentation(content: string, tableData?: TableData): string {
  const cleanContent = cleanContentForExport(content);
  const lines = cleanContent.split('\n').filter(line => line.trim());

  let slides: string[] = [];
  let currentSlide: string[] = [];

  lines.forEach(line => {
    if (line.includes(':') && line.length < 100) {
      if (currentSlide.length > 0) {
        slides.push(currentSlide.join('<br>'));
        currentSlide = [];
      }
      currentSlide.push(`<h2>${line}</h2>`);
    } else {
      currentSlide.push(line);
    }
  });

  if (currentSlide.length > 0) {
    slides.push(currentSlide.join('<br>'));
  }

  if (tableData) {
    let tableHTML = '<h2>Data Summary</h2><table border="1" style="border-collapse: collapse; width: 100%;">';
    tableHTML += '<tr>' + tableData.headers.map(h => `<th style="padding: 8px; background: #f2f2f2;">${h}</th>`).join('') + '</tr>';
    tableHTML += tableData.rows.map(row =>
      '<tr>' + row.map(cell => `<td style="padding: 8px;">${cell}</td>`).join('') + '</tr>'
    ).join('');
    tableHTML += '</table>';
    slides.push(tableHTML);
  }

  return `<!DOCTYPE html>
<html>
<head>
    <title>AI Generated Presentation</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .slide { padding: 20px; margin-bottom: 20px; border: 1px solid #ddd; }
        h2 { color: #333; margin-bottom: 15px; }
        table { margin: 15px 0; }
        th, td { text-align: left; }
    </style>
</head>
<body>
    ${slides.map((slide, i) => `<div class="slide"><h1>Slide ${i + 1}</h1>${slide}</div>`).join('')}
</body>
</html>`;
}

export function downloadHTMLPresentation(content: string, filename: string = 'presentation.html', tableData?: TableData) {
  const html = generateHTMLPresentation(content, tableData);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  downloadFile(blob, filename);
}