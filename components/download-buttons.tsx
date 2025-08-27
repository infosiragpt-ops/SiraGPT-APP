"use client"

import React, { useState } from 'react';
import { Download, FileSpreadsheet, FileText, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { 
  detectTableData, 
  downloadCSV, 
  downloadExcel, 
  downloadWord,
  downloadFile,
  type TableData 
} from '@/lib/download-utils';
import { apiClient } from '@/lib/api';

interface DownloadButtonsProps {
  content: string;
  messageId: string;
}

export function DownloadButtons({ content, messageId }: DownloadButtonsProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Detect if content has downloadable data
  const tableData = detectTableData(content);
  
  // If no structured data found, don't show download buttons
  if (!tableData && !content.trim()) {
    return null;
  }

  const handleDownload = async (format: 'csv' | 'excel' | 'word' | 'text') => {
    setIsDownloading(true);
    
    try {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const baseFilename = `ai-response-${timestamp}`;
      
      switch (format) {
        case 'csv':
          if (tableData) {
            // Try backend first, fallback to frontend
            try {
              const blob = await apiClient.downloadCSV(messageId, `${baseFilename}.csv`);
              downloadFile(blob, `${baseFilename}.csv`);
            } catch (backendError) {
              console.warn('Backend CSV failed, using frontend:', backendError);
              downloadCSV(tableData, `${baseFilename}.csv`);
            }
            toast.success('CSV file downloaded successfully!');
          } else {
            toast.error('No tabular data found for CSV export');
          }
          break;
          
        case 'excel':
          if (tableData) {
            // Try backend first, fallback to frontend
            try {
              const blob = await apiClient.downloadExcel(messageId, `${baseFilename}.xlsx`);
              downloadFile(blob, `${baseFilename}.xlsx`);
            } catch (backendError) {
              console.warn('Backend Excel failed, using frontend:', backendError);
              downloadExcel(tableData, `${baseFilename}.xlsx`);
            }
            toast.success('Excel file downloaded successfully!');
          } else {
            toast.error('No tabular data found for Excel export');
          }
          break;
          
        case 'word':
          await downloadWord(content, `${baseFilename}.docx`, tableData);
          toast.success('Word document downloaded successfully!');
          break;

        case 'text':
          try {
            const blob = await apiClient.downloadText(messageId, `${baseFilename}.txt`);
            downloadFile(blob, `${baseFilename}.txt`);
            toast.success('Text file downloaded successfully!');
          } catch (error) {
            // Fallback to frontend text download
            const textBlob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            downloadFile(textBlob, `${baseFilename}.txt`);
            toast.success('Text file downloaded successfully!');
          }
          break;
          
        default:
          toast.error('Unsupported format');
      }
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-1 text-muted-foreground hover:text-foreground"
          title="Download response"
          disabled={isDownloading}
        >
          <Download size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {tableData && (
          <>
            <DropdownMenuItem 
              onClick={() => handleDownload('csv')}
              className="flex items-center gap-2"
            >
              <FileSpreadsheet size={16} />
              Download as CSV
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={() => handleDownload('excel')}
              className="flex items-center gap-2"
            >
              <FileSpreadsheet size={16} />
              Download as Excel
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem 
          onClick={() => handleDownload('word')}
          className="flex items-center gap-2"
        >
          <FileText size={16} />
          Download as Word
        </DropdownMenuItem>
        <DropdownMenuItem 
          onClick={() => handleDownload('text')}
          className="flex items-center gap-2"
        >
          <File size={16} />
          Download as Text
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}