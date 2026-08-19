import React, { useState, useMemo } from 'react';
import { Check, Copy, Download, Expand } from 'lucide-react';
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
    type TableData
} from '@/lib/download-utils';
import { toast } from 'sonner';

interface TableControlsProps {
    content: string;
    messageId: string;
    title?: string;
    tableData?: TableData | null;
    onExpand: () => void;
}


const TableControls: React.FC<TableControlsProps> = ({ content, messageId, title, tableData: explicitTableData, onExpand }) => {
    const [isDownloading, setIsDownloading] = useState(false);
    const [copied, setCopied] = useState(false);

    const isImageMessage = content.startsWith('http') && (content.includes('uploads/images') || content.includes('oaidalleapiprodscus') || content.includes('dalle'));

    const tableData = useMemo(
        () => explicitTableData || detectTableData(content),
        [content, explicitTableData],
    );

    // If no structured data found and not an image, don't show download buttons
    if (!tableData && !content.trim() && !isImageMessage) {
        return null;
    }

    const filenameStem = () => {
        const safeTitle = String(title || 'tabla')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase()
            .slice(0, 48);
        return safeTitle || 'tabla';
    };

    const handleCopy = async () => {
        if (!tableData) {
            toast.error('No se encontró una tabla para copiar');
            return;
        }

        const rows = [tableData.headers, ...tableData.rows];
        const tsv = rows
            .map(row => row.map(cell => String(cell ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))
            .join('\n');

        try {
            await navigator.clipboard.writeText(tsv);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1300);
            toast.success('Tabla copiada');
        } catch (error) {
            console.error('Table copy error:', error);
            toast.error('No se pudo copiar la tabla');
        }
    };

    const handleDownload = async (format: 'csv' | 'excel') => {
        setIsDownloading(true);

        try {
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const baseFilename = `${filenameStem()}-${timestamp}`;

            switch (format) {
                case 'csv':
                    if (tableData) {
                        downloadCSV(tableData, `${baseFilename}.csv`);
                        toast.success('CSV descargado');
                    } else {
                        toast.error('No se encontró una tabla para exportar');
                    }
                    break;

                case 'excel':
                    if (tableData) {
                        await downloadExcel(tableData, `${baseFilename}.xlsx`);
                        toast.success('Excel descargado');
                    } else {
                        toast.error('No se encontró una tabla para exportar');
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
            className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-full border border-border/50 bg-background/90 p-1 shadow-sm backdrop-blur-sm opacity-0 invisible group-hover:opacity-100 group-hover:visible focus-within:opacity-100 focus-within:visible transition-all duration-200 ease-out"
        >
            <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                className="h-7 w-7 rounded-full hover:bg-accent/80 transition-colors duration-200"
                title="Copiar tabla"
                aria-label="Copiar tabla"
            >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-7 w-7 rounded-full hover:bg-accent/80 transition-colors duration-200"
                        disabled={isDownloading}
                        title="Descargar tabla"
                        aria-label="Descargar tabla"
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuItem 
                        onClick={() => handleDownload('csv')}
                        disabled={isDownloading}
                    >
                        Descargar CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                        onClick={() => handleDownload('excel')}
                        disabled={isDownloading}
                    >
                        Descargar Excel
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <Button 
                variant="ghost" 
                size="icon" 
                onClick={onExpand} 
                className="h-7 w-7 rounded-full hover:bg-accent/80 transition-colors duration-200"
                title="Expandir tabla"
                aria-label="Expandir tabla"
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
