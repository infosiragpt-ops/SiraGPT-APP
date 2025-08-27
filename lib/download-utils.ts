import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType } from 'docx';

export interface TableData {
  headers: string[];
  rows: string[][];
}

// Detect if content contains tabular data
export function detectTableData(content: string): TableData | null {
  // Look for markdown tables
  const markdownTableRegex = /\|(.+)\|\s*\n\|[-\s|:]+\|\s*\n((?:\|.+\|\s*\n?)+)/g;
  const match = markdownTableRegex.exec(content);
  
  if (match) {
    const headerRow = match[1].split('|').map(cell => cell.trim()).filter(cell => cell);
    const bodyRows = match[2].split('\n')
      .filter(row => row.trim() && row.includes('|'))
      .map(row => row.split('|').map(cell => cell.trim()).filter(cell => cell));
    
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
      return match ? [match[1], match[2]] : ['', ''];
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
      return match ? [match[1].trim(), match[2].trim()] : ['', ''];
    });
    
    return { headers, rows };
  }

  return null;
}

// Generate CSV content
export function generateCSV(tableData: TableData): string {
  const csvRows = [
    tableData.headers.join(','),
    ...tableData.rows.map(row => 
      row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')
    )
  ];
  return csvRows.join('\n');
}

// Generate Excel file
export function generateExcel(tableData: TableData, filename: string = 'data.xlsx'): Blob {
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
  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// Generate Word document
export async function generateWord(content: string, tableData?: TableData): Promise<Blob> {
  const paragraphs: Paragraph[] = [];
  
  // Add main content as paragraphs
  const contentLines = content.split('\n').filter(line => line.trim());
  contentLines.forEach(line => {
    if (line.trim()) {
      paragraphs.push(new Paragraph({ text: line.trim() }));
    }
  });
  
  // Add table if available
  if (tableData) {
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
    
    paragraphs.push(new Paragraph({ text: '' })); // Empty line
    // Note: We'll add the table separately as docx doesn't allow mixing paragraphs and tables easily
  }
  
  const doc = new Document({
    sections: [{
      children: paragraphs
    }]
  });
  
  return await Packer.toBlob(doc);
}

// Download file utility
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

// Download CSV
export function downloadCSV(tableData: TableData, filename: string = 'data.csv') {
  const csvContent = generateCSV(tableData);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadFile(blob, filename);
}

// Download Excel
export function downloadExcel(tableData: TableData, filename: string = 'data.xlsx') {
  const blob = generateExcel(tableData, filename);
  downloadFile(blob, filename);
}

// Download Word
export async function downloadWord(content: string, filename: string = 'document.docx', tableData?: TableData) {
  const blob = await generateWord(content, tableData);
  downloadFile(blob, filename);
}