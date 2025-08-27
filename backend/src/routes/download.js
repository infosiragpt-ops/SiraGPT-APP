const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const XLSX = require('xlsx');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();

// Utility function to detect table data from text
function detectTableData(content) {
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

module.exports = router;