"use client"

import React, { useState } from 'react';
import { Download, FileSpreadsheet, FileText, File, Presentation } from 'lucide-react';
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
  downloadHTMLPresentation,
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
  
  // Check if this is an image message
  const isImageMessage = content.startsWith('http') && (content.includes('uploads/images') || content.includes('oaidalleapiprodscus') || content.includes('dalle'));
  
  // Detect if content has downloadable data
  const tableData = detectTableData(content);
  
  // If no structured data found and not an image, don't show download buttons
  if (!tableData && !content.trim() && !isImageMessage) {
    return null;
  }

  const handleDownload = async (format: 'csv' | 'excel' | 'word' | 'powerpoint' | 'text' | 'image') => {
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
          try {
            // Use backend Word generation for better formatting
            const blob = await apiClient.downloadWord(messageId, `${baseFilename}.docx`);
            downloadFile(blob, `${baseFilename}.docx`);
            toast.success('Word document downloaded successfully!');
          } catch (backendError) {
            console.warn('Backend Word failed, using frontend:', backendError);
            // Fallback to frontend generation
            await downloadWord(content, `${baseFilename}.docx`, tableData);
            toast.success('Word document downloaded successfully!');
          }
          break;

        case 'powerpoint':
          try {
            // Try backend PowerPoint first
            const blob = await apiClient.downloadPowerPoint(messageId, `${baseFilename}.pptx`);
            downloadFile(blob, `${baseFilename}.pptx`);
            toast.success('PowerPoint presentation downloaded successfully!');
          } catch (backendError) {
            console.warn('Backend PowerPoint failed, using HTML presentation:', backendError);
            // Fallback to HTML presentation
            downloadHTMLPresentation(content, `${baseFilename}.html`, tableData);
            toast.success('HTML presentation downloaded successfully! (PowerPoint fallback)');
          }
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

        case 'image':
          try {
            // Download image directly from URL
            const response = await fetch(content);
            const blob = await response.blob();
            const extension = content.includes('.png') ? 'png' : 'jpg';
            downloadFile(blob, `${baseFilename}.${extension}`);
            toast.success('Image downloaded successfully!');
          } catch (error) {
            toast.error('Failed to download image. Please try again.');
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
        {isImageMessage ? (
          // Show only image download option for image messages
          <DropdownMenuItem 
            onClick={() => handleDownload('image')}
            className="flex items-center gap-2"
          >
            <File size={16} />
            Download Image
          </DropdownMenuItem>
        ) : (
          // Show regular download options for text/data messages
          <>
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
              onClick={() => handleDownload('powerpoint')}
              className="flex items-center gap-2"
            >
              <Presentation size={16} />
              Download as PowerPoint
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={() => handleDownload('text')}
              className="flex items-center gap-2"
            >
              <File size={16} />
              Download as Text
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}