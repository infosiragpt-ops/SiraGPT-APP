import React, { useState, useMemo } from 'react';
import { Download, Expand } from 'lucide-react';
import { Button } from './ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
    detectTableData,
    downloadCSV,
    downloadExcel,
    downloadWord,
    downloadHTMLPresentation,
    downloadFile,
    type TableData
} from '@/lib/download-utils';
import apiClient from '@/lib/api';
import { toast } from 'sonner';

interface TableControlsProps {
    content: string;
    messageId: string;
    title?: string;
    onExpand: () => void;
}


const TableControls: React.FC<TableControlsProps> = ({ content, messageId, title, onExpand }) => {
    const [isDownloading, setIsDownloading] = useState(false);

    const isImageMessage = content.startsWith('http') && (content.includes('uploads/images') || content.includes('oaidalleapiprodscus') || content.includes('dalle'));

    // Memoize table data detection to prevent infinite loops
    const tableData = useMemo(() => detectTableData(content), [content]);

    // If no structured data found and not an image, don't show download buttons
    if (!tableData && !content.trim() && !isImageMessage) {
        return null;
    }

    const handleDownload = async (format: 'csv' | 'excel') => {
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
                            await downloadExcel(tableData, `${baseFilename}.xlsx`);
                        }
                        toast.success('Excel file downloaded successfully!');
                    } else {
                        toast.error('No tabular data found for Excel export');
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
        <div
            data-copy-exclude=""
            className="absolute top-2 right-2 z-10 flex items-center space-x-1 rounded-lg bg-background/90 p-1 backdrop-blur-sm border border-border/50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 ease-in-out transform scale-90 group-hover:scale-100 shadow-sm"
        >
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-7 w-7 hover:bg-accent/80 transition-colors duration-200"
                        disabled={isDownloading}
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuItem 
                        onClick={() => handleDownload('csv')}
                        disabled={isDownloading}
                    >
                        Download as CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                        onClick={() => handleDownload('excel')}
                        disabled={isDownloading}
                    >
                        Download as Excel
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <Button 
                variant="ghost" 
                size="icon" 
                onClick={onExpand} 
                className="h-7 w-7 hover:bg-accent/80 transition-colors duration-200"
            >
                <Expand className="h-4 w-4" />
            </Button>
        </div>
    );
};

export default TableControls;



// import React, { useState } from 'react';
// import { Download, Expand } from 'lucide-react';
// import { Button } from './ui/button';
// import {
//     DropdownMenu,
//     DropdownMenuContent,
//     DropdownMenuItem,
//     DropdownMenuTrigger,
// } from './ui/dropdown-menu';
// import {
//     detectTableData,
//     downloadCSV,
//     downloadExcel,
//     downloadWord,
//     downloadHTMLPresentation,
//     downloadFile,
//     type TableData
// } from '@/lib/download-utils';
// import apiClient from '@/lib/api';
// import { toast } from 'sonner';
// interface TableControlsProps {
//     content: string;
//     messageId: string;
//     title?: string;
//     onExpand: () => void;
// }
// const TableControls: React.FC<TableControlsProps> = ({ content, messageId, title, onExpand }) => {
//     const [isDownloading, setIsDownloading] = useState(false);
//     const isImageMessage = content.startsWith('http') && (content.includes('uploads/images') || content.includes('oaidalleapiprodscus') || content.includes('dalle'));
//     // Detect if content has downloadable data
//     const tableData = detectTableData(content);
//     // If no structured data found and not an image, don't show download buttons
//     if (!tableData && !content.trim() && !isImageMessage) {
//         return null;
//     }
//     const handleDownload = async (format: 'csv' | 'excel') => {
//         setIsDownloading(true);
//         try {
//             const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
//             const baseFilename = `ai-response-${timestamp}`;
//             switch (format) {
//                 case 'csv':
//                     if (tableData) {
//                         // Try backend first, fallback to frontend
//                         try {
//                             const blob = await apiClient.downloadCSV(messageId, `${baseFilename}.csv`);
//                             downloadFile(blob, `${baseFilename}.csv`);
//                         } catch (backendError) {
//                             console.warn('Backend CSV failed, using frontend:', backendError);
//                             downloadCSV(tableData, `${baseFilename}.csv`);
//                         }
//                         toast.success('CSV file downloaded successfully!');
//                     } else {
//                         toast.error('No tabular data found for CSV export');
//                     }
//                     break;
//                 case 'excel':
//                     if (tableData) {
//                         // Try backend first, fallback to frontend
//                         try {
//                             const blob = await apiClient.downloadExcel(messageId, `${baseFilename}.xlsx`);
//                             downloadFile(blob, `${baseFilename}.xlsx`);
//                         } catch (backendError) {
//                             console.warn('Backend Excel failed, using frontend:', backendError);
//                             downloadExcel(tableData, `${baseFilename}.xlsx`);
//                         }
//                         toast.success('Excel file downloaded successfully!');
//                     } else {
//                         toast.error('No tabular data found for Excel export');
//                     }
//                     break;
//                 default:
//                     toast.error('Unsupported format');
//             }
//         } catch (error) {
//             console.error('Download error:', error);
//             toast.error('Failed to download file. Please try again.');
//         } finally {
//             setIsDownloading(false);
//         }
//     };
//     return (
//         <div className={`flex items-center ${title ? 'justify-between' : 'justify-end'} p-2`}>
//             {title && <h3 className="text-lg font-semibold">{title}</h3>}
//             <div className="flex items-center space-x-2">
//                 <DropdownMenu>
//                     <DropdownMenuTrigger asChild>
//                         <Button variant="ghost" size="icon">
//                             <Download className="h-5 w-5" />
//                         </Button>
//                     </DropdownMenuTrigger>
//                     <DropdownMenuContent>
//                         <DropdownMenuItem onClick={() => handleDownload('csv')}>
//                             Download as CSV
//                         </DropdownMenuItem>
//                         <DropdownMenuItem onClick={() => handleDownload('excel')}>
//                             Download as Excel
//                         </DropdownMenuItem>
//                     </DropdownMenuContent>
//                 </DropdownMenu>
//                 <Button variant="ghost" size="icon" onClick={onExpand}>
//                     <Expand className="h-5 w-5" />
//                 </Button>
//             </div>
//         </div>
//     );
// };
// export default TableControls;
