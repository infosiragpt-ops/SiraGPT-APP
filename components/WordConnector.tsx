"use client";

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Mathematics, { migrateMathStrings } from '@tiptap/extension-mathematics';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import FontFamily from '@tiptap/extension-font-family';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Underline from '@tiptap/extension-underline';
import { Button } from '@/components/ui/button';
import { Download, Loader2, X, Maximize2, Minimize2, Bold, Italic, Underline as UnderlineIcon, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify, List, ListOrdered, Sparkles, Undo, Redo, FileText, ChevronDown, Image as ImageIcon, Link as LinkIcon, Table as TableIcon, Palette, RotateCcw, RotateCw, Type, Highlighter, Quote, Code, Minus } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useChat } from '@/lib/chat-context-integrated';
import { useAuth } from '@/lib/auth-context-integrated';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { saveAs } from 'file-saver';


interface WordConnectorProps {
    onClose: () => void;
    selectedModel: string;
    selectProvider: string;
    onGenerateContent?: (content: string) => void;
    isFullPage?: boolean;
    onTextSelected?: (text: string) => void; // Callback to send selected text to chat
    isGeneratingExternal?: boolean; // When chat triggers generation, show loader overlay
}

import { Extension } from '@tiptap/core';

// const FontSize = Extension.create({
//     name: 'fontSize',
//     addOptions() {
//         return {
//             types: ['textStyle'],
//         };
//     },
//     addGlobalAttributes() {
//         return [
//             {
//                 types: this.options.types,
//                 attributes: {
//                     fontSize: {
//                         default: null,
//                         parseHTML: element => element.style.fontSize.replace('px', ''),
//                         renderHTML: attributes => {
//                             if (!attributes.fontSize) {
//                                 return {};
//                             }
//                             return {
//                                 style: `font-size: ${attributes.fontSize}px`,
//                             };
//                         },
//                     },
//                 },
//             },
//         ];
//     },
//     addCommands() {
//         return {
//             setFontSize: fontSize => ({ chain }) => {
//                 return chain()
//                     .setMark('textStyle', { fontSize })
//                     .run();
//             },
//             unsetFontSize: () => ({ chain }) => {
//                 return chain()
//                     .setMark('textStyle', { fontSize: null })
//                     .removeEmptyTextStyle()
//                     .run();
//             },
//         };
//     },
// });


const FontSize = Extension.create({
    name: 'fontSize',
    addOptions() {
        return { types: ['textStyle'] };
    },
    addGlobalAttributes() {
        return [{
            types: this.options.types,
            attributes: {
                fontSize: {
                    default: null,
                    parseHTML: element => element.style.fontSize,
                    renderHTML: attributes => {
                        if (!attributes.fontSize) return {};
                        // Ensure we don't double px
                        const val = attributes.fontSize.includes('px') ? attributes.fontSize : `${attributes.fontSize}px`;
                        return { style: `font-size: ${val}` };
                    },
                },
            },
        }];
    },
    addCommands() {
        return {
            setFontSize: fontSize => ({ chain }) => chain().setMark('textStyle', { fontSize }).run(),
            unsetFontSize: () => ({ chain }) => chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
        };
    },
});

// Table Grid Selector Component
const TableGridSelector: React.FC<{ onSelectTable: (rows: number, cols: number) => void }> = ({ onSelectTable }) => {
    const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);

    return (
        <div className="space-y-2">
            <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {hoveredCell ? `${hoveredCell.row} × ${hoveredCell.col} Table` : 'Select Table Size'}
            </label>
            <div
                className="grid grid-cols-10 gap-0.5"
                onMouseLeave={() => setHoveredCell(null)}
            >
                {Array.from({ length: 100 }, (_, i) => {
                    const row = Math.floor(i / 10) + 1;
                    const col = (i % 10) + 1;
                    const isSelected = hoveredCell && row <= hoveredCell.row && col <= hoveredCell.col;

                    return (
                        <button
                            key={i}
                            className={`w-6 h-6 border transition-all ${isSelected
                                ? 'bg-blue-200 dark:bg-blue-500/40 border-blue-400 dark:border-blue-400'
                                : 'bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                                }`}
                            onMouseEnter={() => setHoveredCell({ row, col })}
                            onClick={() => {
                                onSelectTable(row, col);
                            }}
                        />
                    );
                })}
            </div>
            <p className="text-xs text-center text-muted-foreground">
                {hoveredCell ? `Click to insert ${hoveredCell.row} × ${hoveredCell.col} table` : 'Hover to preview table size'}
            </p>
        </div>
    );
};

export const WordConnector = React.forwardRef<{ updateContent: (content: string) => void; replaceSelection: (content: string) => void; getHTML: () => string; }, WordConnectorProps>(
    function WordConnector({ onClose, selectedModel, selectProvider, onGenerateContent, isFullPage = false, onTextSelected, isGeneratingExternal = false }, ref) {
        const [isGenerating, setIsGenerating] = useState(false);
        const [isCollapsed, setIsCollapsed] = useState(false);
        const selectionRef = useRef<{ from: number; to: number } | null>(null);
        const { currentChat } = useChat();
        const { user } = useAuth();
        const lastChatIdRef = useRef<string | null>(null);

        const isBusy = isGenerating || isGeneratingExternal;

        // Initialize Tiptap editor with all extensions
        const editor = useEditor({
            immediatelyRender: false,
            extensions: [
                StarterKit.configure({
                    heading: {
                        levels: [1, 2, 3, 4, 5, 6],
                    },
                }),
                Underline,
                Mathematics.configure({
                    katexOptions: {
                        throwOnError: false,
                    },
                    // Commented out to prevent modal popups on equation click
                    // inlineOptions: {
                    //     onClick: (node, pos) => {
                    //         const newCalculation = prompt('Enter new calculation:', node.attrs.latex);
                    //         if (newCalculation) {
                    //             editor?.chain().setNodeSelection(pos).updateInlineMath({ latex: newCalculation }).focus().run();
                    //         }
                    //     },
                    // },
                    // blockOptions: {
                    //     onClick: (node, pos) => {
                    //         const newCalculation = prompt('Enter new calculation:', node.attrs.latex);
                    //         if (newCalculation) {
                    //             editor?.chain().setNodeSelection(pos).updateBlockMath({ latex: newCalculation }).focus().run();
                    //         }
                    //     },
                    // },
                }),
                Placeholder.configure({
                    placeholder: 'Start writing your document here...',
                }),
                TextStyle,
                FontFamily,
                FontSize,
                Color,
                TextAlign.configure({
                    types: ['heading', 'paragraph'],
                }),
                Link.configure({
                    openOnClick: false,
                    HTMLAttributes: {
                        class: 'text-blue-600 underline cursor-pointer',
                    },
                }),
                Image.configure({
                    HTMLAttributes: {
                        class: 'max-w-full h-auto rounded-lg',
                    },
                }),
                Table.configure({
                    resizable: true,
                    HTMLAttributes: {
                        class: 'border-collapse w-full my-4',
                        style: 'table-layout: fixed; max-width: 100%;',
                    },
                }),
                TableRow.configure({
                    HTMLAttributes: {
                        class: 'border border-zinc-300 dark:border-zinc-700',
                    },
                }),
                TableHeader.configure({
                    HTMLAttributes: {
                        class: 'border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-2 font-bold text-left',
                        style: 'word-wrap: break-word; overflow-wrap: break-word; word-break: break-word; min-width: 50px;',
                    },
                }),
                TableCell.configure({
                    HTMLAttributes: {
                        class: 'border border-zinc-300 dark:border-zinc-700 p-2',
                        style: 'word-wrap: break-word; overflow-wrap: break-word; word-break: break-word; min-width: 50px;',
                    },
                }),
            ],
            content: '',
            editorProps: {
                attributes: {
                    class: 'focus:outline-none w-full h-full text-zinc-900 dark:text-zinc-100',
                },
            },
            onCreate: ({ editor: currentEditor }) => {
                // Migrate any existing LaTeX strings to math nodes
                migrateMathStrings(currentEditor);
            },
        });

        // Function to convert LaTeX strings to Tiptap math nodes
        const convertLaTeXToMathNodes = (text: string): string => {
            // First, convert block math $$...$$ (can span multiple lines)
            // Use [\s\S] to match any character including newlines
            text = text.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
                // Skip if already converted
                if (match.includes('data-type="block-math"')) return match;
                // Escape HTML entities and preserve LaTeX backslashes
                const escapedLatex = latex
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .trim();
                return `<div data-type="block-math" data-latex="${escapedLatex}"></div>`;
            });

            // Then, convert inline math $...$ (single line only)
            // Split by lines to avoid matching across HTML tags
            const lines = text.split('\n');
            const convertedLines = lines.map(line => {
                // Skip if line contains HTML tags (already processed)
                if (line.includes('<') && line.includes('>')) {
                    // Only process if not already a math node
                    if (!line.includes('data-type="inline-math"') && !line.includes('data-type="block-math"')) {
                        // Try to find inline math in text parts
                        return line.replace(/\$([^$<>]+?)\$/g, (match, latex) => {
                            // Skip if inside HTML tag
                            const beforeMatch = line.substring(0, line.indexOf(match));
                            const afterMatch = line.substring(line.indexOf(match) + match.length);
                            const openTags = (beforeMatch.match(/</g) || []).length;
                            const closeTags = (beforeMatch.match(/>/g) || []).length;
                            if (openTags > closeTags) return match; // Inside HTML tag

                            const escapedLatex = latex
                                .replace(/&/g, '&amp;')
                                .replace(/"/g, '&quot;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .trim();
                            return `<span data-type="inline-math" data-latex="${escapedLatex}"></span>`;
                        });
                    }
                    return line;
                } else {
                    // Simple line without HTML, convert all $...$ patterns
                    return line.replace(/\$([^$\n]+?)\$/g, (match, latex) => {
                        const escapedLatex = latex
                            .replace(/&/g, '&amp;')
                            .replace(/"/g, '&quot;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .trim();
                        return `<span data-type="inline-math" data-latex="${escapedLatex}"></span>`;
                    });
                }
            });
            text = convertedLines.join('\n');

            return text;
        };

        // Clear editor content when chat changes
        useEffect(() => {
            const currentChatId = currentChat?.id;
            if (editor && currentChatId && lastChatIdRef.current && lastChatIdRef.current !== currentChatId) {
                // Chat has changed, clear the editor
                editor.commands.setContent('');
            }
            lastChatIdRef.current = currentChatId || null;
        }, [currentChat?.id, editor]);

        // Expose method to update editor content via ref
        React.useImperativeHandle(ref, () => ({
            updateContent: (content: string) => {
                if (editor && content) {
                    try {
                        // Clean content - remove markdown if present
                        let cleanContent = content;

                        // Remove markdown code blocks
                        cleanContent = cleanContent.replace(/```[\s\S]*?```/g, '');
                        cleanContent = cleanContent.replace(/`([^`]+)`/g, '$1');

                        // Convert LaTeX math expressions to Tiptap math nodes BEFORE other processing
                        cleanContent = convertLaTeXToMathNodes(cleanContent);

                        // Convert markdown headings to HTML
                        cleanContent = cleanContent.replace(/^### (.*$)/gim, '<h3>$1</h3>');
                        cleanContent = cleanContent.replace(/^## (.*$)/gim, '<h2>$1</h2>');
                        cleanContent = cleanContent.replace(/^# (.*$)/gim, '<h1>$1</h1>');

                        // Convert markdown bold/italic (but preserve math nodes)
                        cleanContent = cleanContent.replace(/\*\*(.*?)\*\*/g, (match, text) => {
                            // Don't convert if it's inside a math node
                            if (match.includes('data-type')) return match;
                            return `<strong>${text}</strong>`;
                        });
                        cleanContent = cleanContent.replace(/\*(.*?)\*/g, (match, text) => {
                            // Don't convert if it's inside a math node or already bold
                            if (match.includes('data-type') || match.includes('<strong>')) return match;
                            return `<em>${text}</em>`;
                        });

                        // Convert markdown tables to HTML tables
                        // Simple parser for standard markdown tables
                        cleanContent = cleanContent.replace(/\|(.+)\|\n\|( *:?-+:? *\|)+\n((?:\|.+?\|\n)+)/g, (match, header, separator, body) => {
                            const headers = header.split('|').filter((cell: string) => cell.trim()).map((cell: string) => `<th>${cell.trim()}</th>`).join('');
                            const rows = body.trim().split('\n').map((row: string) => {
                                const cells = row.split('|').filter((cell: string) => cell.trim() || cell === '').map((cell: string) => `<td>${cell.trim()}</td>`).join('');
                                return `<tr>${cells}</tr>`;
                            }).join('');
                            return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
                        });

                        // Convert markdown lists and process lines properly
                        const lines = cleanContent.split('\n');
                        const processedLines: string[] = [];

                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();

                            // Skip completely empty lines
                            if (line === '') continue;

                            // Check if line is already an HTML element
                            const isHtmlElement = line.startsWith('<') && line.includes('>');

                            if (isHtmlElement) {
                                processedLines.push(line);
                            } else {
                                // Wrap plain text in paragraph without inline styles
                                processedLines.push(`<p>${line}</p>`);
                            }
                        }

                        cleanContent = processedLines.join('');

                        // Replace entire content to prevent duplication
                        editor.commands.setContent(cleanContent);

                        // After setting content, migrate any remaining LaTeX strings
                        setTimeout(() => {
                            if (editor) {
                                migrateMathStrings(editor);
                            }
                        }, 100);
                    } catch (error) {
                        console.error('Error updating editor content:', error);
                        // Fallback: append as plain text
                        if (!editor.isEmpty) {
                            editor.chain().focus('end').insertContent(`<p>${content}</p>`).run();
                        } else {
                            editor.commands.setContent(`<p>${content}</p>`);
                        }
                    }
                }
            },
            replaceSelection: (content: string) => {
                if (editor && content && selectionRef.current) {
                    const { from, to } = selectionRef.current;
                    editor.chain().focus()
                        .setTextSelection({ from, to })
                        .insertContent(content)
                        .run();
                    selectionRef.current = null;
                }
            },
            getHTML: () => {
                return editor ? editor.getHTML() : '';
            }
        }), [editor]);

        // Download as Word document
        const downloadAsWord = useCallback(async () => {
            if (!editor) return;

            try {
                const textContent = editor.getText();

                const doc = new Document({
                    sections: [{
                        properties: {},
                        children: textContent.split('\n').map(line =>
                            new Paragraph({
                                children: [new TextRun(line || ' ')],
                            })
                        ),
                    }],
                });

                const blob = await Packer.toBlob(doc);
                saveAs(blob, 'document.docx');
                toast.success('Document downloaded as Word file');
            } catch (error) {
                console.error('Error downloading Word document:', error);
                toast.error('Failed to download Word document');
            }
        }, [editor]);

        // Download as PDF
        const downloadAsPDF = useCallback(async () => {
            if (!editor) return;

            try {
                const htmlContent = editor.getHTML();

                const printWindow = window.open('', '_blank');
                if (!printWindow) {
                    toast.error('Please allow popups to download PDF');
                    return;
                }

                printWindow.document.write(`
                <!DOCTYPE html>
                <html>
                  <head>
                    <title>Document</title>
                    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
                    <style>
                      @page {
                        margin: 1in;
                      }
                      body { 
                        font-family: 'Segoe UI', -apple-system, sans-serif;
                        padding: 40px;
                        max-width: 800px;
                        margin: 0 auto;
                        background: white;
                        color: #1e293b;
                        line-height: 1.75;
                      }
                      h1 {
                        font-size: 2.25em;
                        font-weight: 700;
                        margin: 1.2em 0 0.5em 0;
                        line-height: 1.2;
                        color: #0f172a;
                        border-bottom: 3px solid #3b82f6;
                        padding-bottom: 0.3em;
                      }
                      h2 {
                        font-size: 1.75em;
                        font-weight: 600;
                        margin: 1em 0 0.4em 0;
                        color: #1e40af;
                      }
                      h3 {
                        font-size: 1.4em;
                        font-weight: 600;
                        margin: 0.9em 0 0.3em 0;
                        color: #2563eb;
                      }
                      h4 {
                        font-size: 1.2em;
                        font-weight: 600;
                        margin: 0.7em 0 0.3em 0;
                        color: #3b82f6;
                      }
                      h5, h6 {
                        font-size: 1.1em;
                        font-weight: 600;
                        margin: 0.6em 0 0.2em 0;
                        color: #3b82f6;
                      }
                      p {
                        margin: 0.75em 0;
                        font-size: 16px;
                      }
                      ul, ol {
                        padding-left: 2em;
                        margin: 1em 0;
                      }
                      li {
                        margin: 0.5em 0;
                        line-height: 1.7;
                      }
                      strong {
                        font-weight: 700;
                        color: #0f172a;
                      }
                      em {
                        font-style: italic;
                      }
                      table {
                        border-collapse: collapse;
                        width: 100%;
                        margin: 1.5em 0;
                      }
                      table th {
                        background: #eff6ff;
                        color: #1e40af;
                        font-weight: 600;
                        padding: 8px;
                        border: 1px solid #cbd5e1;
                      }
                      table td {
                        border: 1px solid #cbd5e1;
                        padding: 8px;
                      }
                      blockquote {
                        border-left: 4px solid #3b82f6;
                        padding-left: 1em;
                        margin: 1em 0;
                        color: #475569;
                        font-style: italic;
                      }
                      code {
                        background: #f1f5f9;
                        color: #0f172a;
                        padding: 0.2em 0.4em;
                        border-radius: 3px;
                        font-family: 'Consolas', monospace;
                        font-size: 0.9em;
                      }
                      img {
                        max-width: 100%;
                        height: auto;
                        margin: 1em 0;
                      }
                      .katex {
                        font-size: 1.1em;
                      }
                      @media print {
                        body {
                          padding: 0;
                        }
                      }
                    </style>
                  </head>
                  <body>
                    ${htmlContent}
                                        <script src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>
                                        <script src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js"></script>
                                        <script>
                                            // decode HTML entities produced in data-latex attributes
                                            function decodeEntities(encoded) {
                                                const textarea = document.createElement('textarea');
                                                textarea.innerHTML = encoded;
                                                return textarea.value;
                                            }

                                            function transformMathPlaceholders() {
                                                // Inline math
                                                document.querySelectorAll('[data-type="inline-math"]').forEach(el => {
                                                    const latex = el.getAttribute('data-latex') || '';
                                                    const decoded = decodeEntities(latex);
                                                    // Replace the element with delimiters for auto-render
                                                    const span = document.createElement('span');
                                                    span.textContent = '$' + decoded + '$';
                                                    el.parentNode.replaceChild(span, el);
                                                });

                                                // Block math
                                                document.querySelectorAll('[data-type="block-math"]').forEach(el => {
                                                    const latex = el.getAttribute('data-latex') || '';
                                                    const decoded = decodeEntities(latex);
                                                    const div = document.createElement('div');
                                                    div.textContent = '$$' + decoded + '$$';
                                                    el.parentNode.replaceChild(div, el);
                                                });
                                            }

                                            window.onload = function() {
                                                try {
                                                    transformMathPlaceholders();

                                                    // Render math in the document using KaTeX auto-render
                                                    if (window.renderMathInElement) {
                                                        renderMathInElement(document.body, {
                                                            delimiters: [
                                                                {left: '$$', right: '$$', display: true},
                                                                {left: '$', right: '$', display: false},
                                                                {left: '\\(', right: '\\)', display: false},
                                                                {left: '\\[', right: '\\]', display: true}
                                                            ],
                                                            throwOnError: false
                                                        });
                                                    }

                                                    setTimeout(() => {
                                                        window.print();
                                                        window.onafterprint = function() {
                                                            window.close();
                                                        };
                                                    }, 300);
                                                } catch (e) {
                                                    // fallback: still attempt to print
                                                    setTimeout(() => {
                                                        window.print();
                                                        window.onafterprint = function() { window.close(); };
                                                    }, 300);
                                                }
                                            };
                                        </script>
                  </body>
                </html>
            `);
                printWindow.document.close();

                toast.success('PDF download initiated');
            } catch (error) {
                console.error('Error downloading PDF:', error);
                toast.error('Failed to download PDF');
            }
        }, [editor]);


        // Handle text selection - send to chat input
        useEffect(() => {
            if (!editor || !onTextSelected) return;

            const handleUpdate = () => {
                const { from, to, empty } = editor.state.selection;
                if (!empty) {
                    selectionRef.current = { from, to };
                    const selectedText = editor.state.doc.textBetween(from, to, ' ');
                    if (selectedText.trim().length > 0) {
                        onTextSelected(selectedText.trim());
                    }
                }
            };

            editor.on('selectionUpdate', handleUpdate);

            return () => {
                editor.off('selectionUpdate', handleUpdate);
            };
        }, [editor, onTextSelected]);

        if (!editor) {
            return (
                <div className="w-full h-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin" />
                </div>
            );
        }

        return (
            <div className={`flex flex-col h-full min-h-0 bg-background border-l border-border/40 transition-all duration-300 ${isCollapsed ? 'w-0' : (isFullPage ? 'w-full' : 'w-[60%]')}`}>
                {/* Fixed Top Header — minimalist: icon + label left,
                    two ghost icon buttons (download, close) right.
                    Download still exposes the .docx/.pdf choice via the
                    dropdown, but through a single icon trigger instead
                    of a labeled button. */}
                <div className="flex items-center justify-between p-3 border-b border-border/40 bg-white dark:bg-zinc-900">
                    <div className="flex items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/icons/Word.png" alt="Word" className="h-5 w-5" />
                        <h3 className="font-semibold text-sm text-foreground">Word Document</h3>
                    </div>
                    <div className="flex items-center gap-1">
                        {isGenerating && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground mr-1" aria-label="Generating" />
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 hover:bg-muted/60"
                                    title="Descargar"
                                    aria-label="Descargar"
                                >
                                    <Download className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={downloadAsWord}>
                                    Descargar como Word (.docx)
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={downloadAsPDF}>
                                    Descargar como PDF
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 hover:bg-muted/60"
                            title="Cerrar"
                            aria-label="Cerrar"
                            onClick={onClose}
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {/* Scrollable Editor Content */}
                {!isCollapsed && (
                    <>
                        {/* Floating Toolbar - Fixed position with gap from top */}
                        <div className="bg-gradient-to-br from-slate-50 to-slate-100 dark:from-zinc-950 dark:to-zinc-950 pt-6 px-4">
                            <div className="mx-auto max-w-[820px]">
                                <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-lg border border-slate-200 dark:border-zinc-800 overflow-hidden">
                                    {/* Toolbar - Complete Professional Design Matching Image */}
                                    <div className="flex flex-wrap items-center gap-1 px-3 py-2.5 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-900">
                                        {/* Undo/Redo with circular design */}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full"
                                            onClick={() => editor.chain().focus().undo().run()}
                                            disabled={!editor.can().undo()}
                                            title="Undo"
                                        >
                                            <RotateCcw className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full"
                                            onClick={() => editor.chain().focus().redo().run()}
                                            disabled={!editor.can().redo()}
                                            title="Redo"
                                        >
                                            <RotateCw className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* Text Style Dropdown with Chevron */}
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-9 px-3 min-w-[130px] justify-between bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"
                                                >
                                                    <span className="text-sm font-normal text-zinc-700 dark:text-zinc-300">
                                                        {editor.isActive('heading', { level: 1 }) ? 'Heading 1' :
                                                            editor.isActive('heading', { level: 2 }) ? 'Heading 2' :
                                                                editor.isActive('heading', { level: 3 }) ? 'Heading 3' :
                                                                    'Normal Text'}
                                                    </span>
                                                    <ChevronDown className="h-3.5 w-3.5 ml-2 text-zinc-500" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent className="w-40">
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                                    <span className="text-sm">Normal Text</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                                                    <span className="text-2xl font-bold">Heading 1</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                                                    <span className="text-xl font-bold">Heading 2</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                                                    <span className="text-lg font-bold">Heading 3</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>

                                        {/* Font Family with Chevron */}
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-9 px-3 min-w-[110px] justify-between bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"
                                                >
                                                    <span className="text-sm font-normal text-zinc-700 dark:text-zinc-300">
                                                        {editor.getAttributes('textStyle').fontFamily || 'Arial'}
                                                    </span>
                                                    <ChevronDown className="h-3.5 w-3.5 ml-2 text-zinc-500" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent className="w-48">
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Arial').run()}>
                                                    <span style={{ fontFamily: 'Arial' }}>Arial</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Times New Roman').run()}>
                                                    <span style={{ fontFamily: 'Times New Roman' }}>Times New Roman</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Calibri').run()}>
                                                    <span style={{ fontFamily: 'Calibri' }}>Calibri</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Georgia').run()}>
                                                    <span style={{ fontFamily: 'Georgia' }}>Georgia</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Verdana').run()}>
                                                    <span style={{ fontFamily: 'Verdana' }}>Verdana</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Courier New').run()}>
                                                    <span style={{ fontFamily: 'Courier New' }}>Courier New</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>

                                        {/* Font Size with Chevron */}
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-9 px-3 w-[70px] justify-between bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"
                                                >
                                                    <span className="text-sm font-normal text-zinc-700 dark:text-zinc-300">
                                                        {editor.getAttributes('textStyle').fontSize ? editor.getAttributes('textStyle').fontSize.replace('px', '') : '14'}
                                                    </span>
                                                    <ChevronDown className="h-3.5 w-3.5 ml-1 text-zinc-500" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent className="w-24">
                                                {[8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72].map(size => (
                                                    <DropdownMenuItem key={size} onClick={() => editor.chain().focus().setFontSize(`${size}px`).run()}>
                                                        {size}
                                                    </DropdownMenuItem>
                                                ))}
                                            </DropdownMenuContent>
                                        </DropdownMenu>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* Formatting Buttons */}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('bold') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleBold().run()}
                                            title="Bold"
                                        >
                                            <Bold className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('italic') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleItalic().run()}
                                            title="Italic"
                                        >
                                            <Italic className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('underline') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleUnderline().run()}
                                            title="Underline"
                                        >
                                            <UnderlineIcon className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('strike') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleStrike().run()}
                                            title="Strikethrough"
                                        >
                                            <Strikethrough className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>

                                        {/* Text Color */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                                    title="Text Color"
                                                >
                                                    <div className="relative flex items-center justify-center">
                                                        <Palette className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                                        <div className="absolute -bottom-0.5 left-1 right-1 h-1 rounded-full" style={{ backgroundColor: editor.getAttributes('textStyle').color || '#000000' }} />
                                                    </div>
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-64">
                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Text Color</label>
                                                    <div className="grid grid-cols-8 gap-1.5">
                                                        {['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef',
                                                            '#f3f3f3', '#ffffff', '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff',
                                                            '#4a86e8', '#0000ff', '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc',
                                                            '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'].map(color => (
                                                                <button
                                                                    key={color}
                                                                    className="w-6 h-6 rounded border border-zinc-300 cursor-pointer hover:scale-110 transition-transform"
                                                                    style={{ backgroundColor: color }}
                                                                    onClick={() => editor.chain().focus().setColor(color).run()}
                                                                />
                                                            ))}
                                                    </div>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="w-full mt-2"
                                                        onClick={() => editor.chain().focus().unsetColor().run()}
                                                    >
                                                        Reset Color
                                                    </Button>
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* Alignment Buttons */}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive({ textAlign: 'left' }) ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().setTextAlign('left').run()}
                                            title="Align Left"
                                        >
                                            <AlignLeft className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive({ textAlign: 'center' }) ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().setTextAlign('center').run()}
                                            title="Align Center"
                                        >
                                            <AlignCenter className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive({ textAlign: 'right' }) ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().setTextAlign('right').run()}
                                            title="Align Right"
                                        >
                                            <AlignRight className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive({ textAlign: 'justify' }) ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().setTextAlign('justify').run()}
                                            title="Justify"
                                        >
                                            <AlignJustify className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* List Buttons */}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('bulletList') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleBulletList().run()}
                                            title="Bullet List"
                                        >
                                            <List className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('orderedList') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                            title="Numbered List"
                                        >
                                            <ListOrdered className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* Additional Formatting */}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                            onClick={() => {
                                                const { from, to, empty } = editor.state.selection;
                                                if (!empty) {
                                                    const selectedText = editor.state.doc.textBetween(from, to, ' ');
                                                    // Wrap in bold and add quotation marks
                                                    editor.chain().focus()
                                                        .setTextSelection({ from, to })
                                                        .insertContent(`<strong>"${selectedText}"</strong>`)
                                                        .run();
                                                } else {
                                                    editor.chain().focus().insertContent('<strong>""</strong>').run();
                                                    // Move cursor back to be inside the quotes
                                                    const newPos = editor.state.selection.from - 1;
                                                    editor.chain().focus().setTextSelection(newPos).run();
                                                }
                                            }}
                                            title="Add Bold Quote"
                                        >
                                            <Quote className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={`h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded ${editor.isActive('code') ? 'bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : ''}`}
                                            onClick={() => editor.chain().focus().toggleCode().run()}
                                            title="Code"
                                        >
                                            <Code className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                            onClick={() => editor.chain().focus().setHorizontalRule().run()}
                                            title="Horizontal Line"
                                        >
                                            <Minus className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                        </Button>

                                        <div className="w-px h-6 bg-zinc-300 dark:bg-zinc-700 mx-1.5" />

                                        {/* Insert Options */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                                    title="Insert Image"
                                                >
                                                    <ImageIcon className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-80">
                                                <div className="space-y-2">
                                                    <label className="text-sm font-medium">Image URL</label>
                                                    <Input
                                                        placeholder="https://example.com/image.jpg"
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                const url = e.currentTarget.value;
                                                                if (url) {
                                                                    editor.chain().focus().setImage({ src: url }).run();
                                                                    e.currentTarget.value = '';
                                                                }
                                                            }
                                                        }}
                                                    />
                                                    <p className="text-xs text-muted-foreground">Press Enter to insert</p>
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                                    title="Insert Link"
                                                >
                                                    <LinkIcon className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-80">
                                                <div className="space-y-2">
                                                    <label className="text-sm font-medium">Link URL</label>
                                                    <Input
                                                        placeholder="https://example.com"
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                const url = e.currentTarget.value;
                                                                if (url) {
                                                                    editor.chain().focus().setLink({ href: url }).run();
                                                                    e.currentTarget.value = '';
                                                                }
                                                            }
                                                        }}
                                                    />
                                                    <p className="text-xs text-muted-foreground">Press Enter to insert</p>
                                                    {editor.isActive('link') && (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="w-full"
                                                            onClick={() => editor.chain().focus().unsetLink().run()}
                                                        >
                                                            Remove Link
                                                        </Button>
                                                    )}
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        {/* Table Grid Selector */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-9 w-9 p-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
                                                    title="Insert Table"
                                                >
                                                    <TableIcon className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-auto p-3">
                                                <TableGridSelector
                                                    onSelectTable={(rows, cols) => {
                                                        editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
                                                    }}
                                                />
                                            </PopoverContent>
                                        </Popover>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Scrollable Document Area */}
                        <div className="relative flex-1 min-h-0 overflow-hidden bg-gradient-to-br from-slate-50  dark:from-zinc-950 dark:to-zinc-950">
                            <ScrollArea className="h-full">
                                <div className={isBusy ? 'pointer-events-none select-none opacity-60 blur-[1px]' : ''} aria-busy={isBusy}>
                                    {/* Document Editor Page */}
                                    <div className="flex justify-center px-2 py-8">
                                        <div
                                            className="bg-white dark:bg-zinc-900 shadow-2xl w-full max-w-[816px] min-h-[2000px] p-12 rounded-lg border border-slate-200 dark:border-zinc-800"
                                        >
                                            <style>{`
                                            .ProseMirror {
                                                min-height: 100%;
                                                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                                            }
                                             .ProseMirror p {
                                                margin: 0.1em 0;
                                                line-height: 1.5;
                                                color: #1e293b;
                                                font-size: 16px;
                                            }
                                            .dark .ProseMirror p {
                                                color: #e2e8f0;
                                            }
                                            .ProseMirror h1 {
                                                font-size: 2.25em;
                                                font-weight: 700;
                                                margin: 0.8em 0 0.3em 0;
                                                line-height: 1.2;
                                                color: #2563eb;
                                                border-bottom: 3px solid #3b82f6;
                                                padding-bottom: 0.3em;
                                            }
                                            .dark .ProseMirror h1 {
                                                color: #f1f5f9;
                                                border-bottom-color: #60a5fa;
                                            }
                                            .ProseMirror h2 {
                                                font-size: 1.75em;
                                                font-weight: 600;
                                                margin: 0.7em 0 0.3em 0;
                                                line-height: 1.3;
                                                color: #1e40af;
                                            }
                                            .dark .ProseMirror h2 {
                                                color: #93c5fd;
                                            }
                                            .ProseMirror h3 {
                                                font-size: 1.4em;
                                                font-weight: 600;
                                                margin: 0.6em 0 0.2em 0;
                                                line-height: 1.4;
                                                color: #2563eb;
                                            }
                                            .dark .ProseMirror h3 {
                                                color: #60a5fa;
                                            }
                                            .ProseMirror h4 {
                                                font-size: 1.2em;
                                                font-weight: 600;
                                                margin: 0.7em 0 0.3em 0;
                                                color: #3b82f6;
                                            }
                                            .dark .ProseMirror h4 {
                                                color: #60a5fa;
                                            }
                                            .ProseMirror h5, .ProseMirror h6 {
                                                font-size: 1.1em;
                                                font-weight: 600;
                                                margin: 0.6em 0 0.2em 0;
                                                color: #3b82f6;
                                            }
                                            .dark .ProseMirror h5, .dark .ProseMirror h6 {
                                                color: #60a5fa;
                                            }
                                            .ProseMirror ul, .ProseMirror ol {
                                                padding-left: 2em;
                                                margin: 1em 0;
                                                color: #1e293b;
                                                list-style-position: outside;
                                            }
                                            .dark .ProseMirror ul, .dark .ProseMirror ol {
                                                color: #e2e8f0;
                                            }
                                            .ProseMirror ul {
                                                list-style-type: disc;
                                            }
                                            .ProseMirror ol {
                                                list-style-type: decimal;
                                            }
                                            .ProseMirror li {
                                                margin: 0.2em 0;
                                                color: inherit;
                                                display: list-item;
                                                line-height: 1.5;
                                            }
                                            .ProseMirror strong {
                                                font-weight: 700;
                                                color: #0f172a;
                                            }
                                            .dark .ProseMirror strong {
                                                color: #f8fafc;
                                            }
                                            .ProseMirror em {
                                                font-style: italic;
                                                color: #334155;
                                            }
                                            .dark .ProseMirror em {
                                                color: #cbd5e1;
                                            }
                                            .ProseMirror table {
                                                margin: 1.5em 0;
                                                border-collapse: collapse;
                                                width: 100%;
                                                max-width: 100%;
                                                table-layout: fixed;
                                                overflow: hidden;
                                            }
                                            .ProseMirror table td,
                                            .ProseMirror table th {
                                                word-wrap: break-word;
                                                overflow-wrap: break-word;
                                                word-break: break-word;
                                                min-width: 50px;
                                                max-width: 100%;
                                                vertical-align: top;
                                                padding: 8px;
                                                border: 1px solid #cbd5e1;
                                            }
                                            .dark .ProseMirror table td,
                                            .dark .ProseMirror table th {
                                                border-color: #3f3f46;
                                            }
                                            .ProseMirror table th {
                                                background: #eff6ff;
                                                color: #1e40af;
                                                font-weight: 600;
                                            }
                                            .dark .ProseMirror table th {
                                                background: #1e3a8a;
                                                color: #dbeafe;
                                            }
                                            .ProseMirror blockquote {
                                                border-left: 4px solid #3b82f6;
                                                padding-left: 1em;
                                                margin: 1em 0;
                                                color: #475569;
                                                font-style: italic;
                                            }
                                            .dark .ProseMirror blockquote {
                                                border-left-color: #60a5fa;
                                                color: #94a3b8;
                                            }
                                            .ProseMirror code {
                                                background: #f1f5f9;
                                                color: #0f172a;
                                                padding: 0.2em 0.4em;
                                                border-radius: 3px;
                                                font-family: 'Consolas', monospace;
                                                font-size: 0.9em;
                                            }
                                            .dark .ProseMirror code {
                                                background: #1e293b;
                                                color: #e2e8f0;
                                            }
                                        `}</style>
                                            <EditorContent editor={editor} />
                                        </div>
                                    </div>
                                </div>
                            </ScrollArea>

                            {isBusy && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm">
                                    <div className="flex items-center gap-2 text-sm text-foreground">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        <span>Generating document…</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        );
    });
