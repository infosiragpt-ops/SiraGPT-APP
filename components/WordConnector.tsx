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
import { Button } from '@/components/ui/button';
import { Download, Loader2, X, Maximize2, Minimize2, Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify, List, ListOrdered, Sparkles } from 'lucide-react';
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

const FontSize = Extension.create({
    name: 'fontSize',
    addOptions() {
        return {
            types: ['textStyle'],
        };
    },
    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    fontSize: {
                        default: null,
                        parseHTML: element => element.style.fontSize.replace('px', ''),
                        renderHTML: attributes => {
                            if (!attributes.fontSize) {
                                return {};
                            }
                            return {
                                style: `font-size: ${attributes.fontSize}px`,
                            };
                        },
                    },
                },
            },
        ];
    },
    addCommands() {
        return {
            setFontSize: fontSize => ({ chain }) => {
                return chain()
                    .setMark('textStyle', { fontSize })
                    .run();
            },
            unsetFontSize: () => ({ chain }) => {
                return chain()
                    .setMark('textStyle', { fontSize: null })
                    .removeEmptyTextStyle()
                    .run();
            },
        };
    },
});

export const WordConnector = React.forwardRef<{ updateContent: (content: string) => void }, WordConnectorProps>(
    function WordConnector({ onClose, selectedModel, selectProvider, onGenerateContent, isFullPage = false, onTextSelected, isGeneratingExternal = false }, ref) {
        const [isGenerating, setIsGenerating] = useState(false);
        const [isCollapsed, setIsCollapsed] = useState(false);
        const { currentChat } = useChat();
        const { user } = useAuth();

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
                Mathematics.configure({
                    katexOptions: {
                        throwOnError: false,
                    },
                    inlineOptions: {
                        onClick: (node, pos) => {
                            const newCalculation = prompt('Enter new calculation:', node.attrs.latex);
                            if (newCalculation) {
                                editor?.chain().setNodeSelection(pos).updateInlineMath({ latex: newCalculation }).focus().run();
                            }
                        },
                    },
                    blockOptions: {
                        onClick: (node, pos) => {
                            const newCalculation = prompt('Enter new calculation:', node.attrs.latex);
                            if (newCalculation) {
                                editor?.chain().setNodeSelection(pos).updateBlockMath({ latex: newCalculation }).focus().run();
                            }
                        },
                    },
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
                }),
                TableRow,
                TableHeader,
                TableCell,
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

                        // Convert markdown lists
                        cleanContent = cleanContent.replace(/^\* (.*$)/gim, '<ul><li>$1</li></ul>');
                        cleanContent = cleanContent.replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>');
                        cleanContent = cleanContent.replace(/^\d+\. (.*$)/gim, '<ol><li>$1</li></ol>');

                        // Wrap paragraphs (but preserve math nodes and other block elements)
                        const lines = cleanContent.split('\n');
                        const wrappedLines = lines.map(line => {
                            line = line.trim();
                            if (!line) return '<p><br></p>';
                            if (line.startsWith('<h') || line.startsWith('<ul') || line.startsWith('<ol') || line.startsWith('<li') || line.startsWith('<div data-type="block-math"')) {
                                return line;
                            }
                            return `<p>${line}</p>`;
                        });
                        cleanContent = wrappedLines.join('');

                        // Set content in editor
                        editor.commands.setContent(cleanContent);

                        // After setting content, migrate any remaining LaTeX strings
                        setTimeout(() => {
                            if (editor) {
                                migrateMathStrings(editor);
                            }
                        }, 100);
                    } catch (error) {
                        console.error('Error updating editor content:', error);
                        // Fallback: set as plain text
                        editor.commands.setContent(`<p>${content}</p>`);
                    }
                }
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
                      body { font-family: Arial, sans-serif; padding: 20px; }
                      .prose { max-width: 800px; margin: 0 auto; }
                      img { max-width: 100%; height: auto; }
                      table { border-collapse: collapse; width: 100%; }
                      table td, table th { border: 1px solid #ddd; padding: 8px; }
                    </style>
                  </head>
                  <body>
                    <div class="prose">${htmlContent}</div>
                    <script>
                      window.onload = function() {
                        window.print();
                        window.onafterprint = function() {
                          window.close();
                        };
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

        // Download as plain text
        const downloadAsText = useCallback(() => {
            if (!editor) return;

            try {
                const textContent = editor.getText();
                const blob = new Blob([textContent], { type: 'text/plain' });
                saveAs(blob, 'document.txt');
                toast.success('Document downloaded as text file');
            } catch (error) {
                console.error('Error downloading text file:', error);
                toast.error('Failed to download text file');
            }
        }, [editor]);

        // Handle text selection - send to chat input
        useEffect(() => {
            if (!editor || !onTextSelected) return;

            const handleUpdate = () => {
                const { from, to } = editor.state.selection;
                const selectedText = editor.state.doc.textBetween(from, to, ' ');

                if (selectedText && selectedText.trim().length > 0) {
                    // Send selected text to chat input
                    onTextSelected(selectedText.trim());
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
                {/* Header with Toolbar */}
                <div className="flex flex-col border-b border-border/40 bg-white dark:bg-zinc-900">
                    <div className="flex items-center justify-between p-3 border-b border-border/40">
                        <h3 className="font-semibold text-base">New Word Document</h3>
                        <div className="flex items-center gap-2">
                            {isGenerating && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    <span>Generating...</span>
                                </div>
                            )}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="outline" className="h-8">
                                        <Download className="h-3 w-3 mr-1" />
                                        Download
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={downloadAsWord}>
                                        Download as Word (.docx)
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={downloadAsPDF}>
                                        Download as PDF
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={downloadAsText}>
                                        Download as Text (.txt)
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            {/* <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setIsCollapsed(!isCollapsed)}
                                className="h-8 w-8 p-0"
                            >
                                {isCollapsed ? (
                                    <Maximize2 className="h-4 w-4" />
                                ) : (
                                    <Minimize2 className="h-4 w-4" />
                                )}
                            </Button> */}
                            {/* <Button
                                size="sm"
                                variant="ghost"
                                onClick={onClose}
                                className="h-8 w-8 p-0"
                            >
                                <X className="h-4 w-4" />
                            </Button> */}
                        </div>
                    </div>

                    {/* Toolbar */}
                    {!isCollapsed && (
                        <div className="flex items-center gap-1 p-2 border-b border-border/40 bg-white dark:bg-zinc-900">
                            {/* Text Style Dropdown */}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-8 px-3">
                                        <span className="text-xs">Normal Text</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                        Normal Text
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                                        Heading 1
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                                        Heading 2
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                                        Heading 3
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>

                            <div className="w-px h-6 bg-border mx-1" />

                            {/* Font Family */}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-8 px-3">
                                        <span className="text-xs">Inter</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Inter').run()}>Inter</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Arial').run()}>Arial</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Times New Roman').run()}>Times New Roman</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => editor.chain().focus().setFontFamily('Calibri').run()}>Calibri</DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>

                            {/* Font Size */}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="sm" className="h-8 px-3">
                                        <span className="text-xs">12</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                    {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(size => (
                                        <DropdownMenuItem key={size} onClick={() => editor.chain().focus().setFontSize(`${size}px`).run()}>
                                            {size}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>

                            <div className="w-px h-6 bg-border mx-1" />

                            {/* Formatting Buttons */}
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('bold') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleBold().run()}
                            >
                                <Bold className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('italic') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleItalic().run()}
                            >
                                <Italic className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('underline') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleUnderline().run()}
                            >
                                <Underline className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('strike') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleStrike().run()}
                            >
                                <Strikethrough className="h-4 w-4" />
                            </Button>

                            <div className="w-px h-6 bg-border mx-1" />

                            {/* Alignment Buttons */}
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive({ textAlign: 'left' }) ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().setTextAlign('left').run()}
                            >
                                <AlignLeft className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive({ textAlign: 'center' }) ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().setTextAlign('center').run()}
                            >
                                <AlignCenter className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive({ textAlign: 'right' }) ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().setTextAlign('right').run()}
                            >
                                <AlignRight className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive({ textAlign: 'justify' }) ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().setTextAlign('justify').run()}
                            >
                                <AlignJustify className="h-4 w-4" />
                            </Button>

                            <div className="w-px h-6 bg-border mx-1" />

                            {/* List Buttons */}
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('bulletList') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleBulletList().run()}
                            >
                                <List className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={`h-8 w-8 p-0 ${editor.isActive('orderedList') ? 'bg-muted' : ''}`}
                                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                            >
                                <ListOrdered className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </div>

                {/* Editor Content */}
                {!isCollapsed && (
                    <div className="relative flex-1 min-h-0 overflow-hidden">
                        <ScrollArea className="h-full bg-[#F3F4F6] dark:bg-zinc-950">
                            <div className={isBusy ? 'pointer-events-none select-none opacity-60 blur-[1px]' : ''} aria-busy={isBusy}>
                                <div className="flex justify-center p-8 min-h-full">
                                    <div
                                        className="bg-white dark:bg-zinc-900 shadow-sm w-full max-w-[816px] min-h-[1056px] p-16 rounded-sm border border-zinc-200 dark:border-zinc-800 mx-auto transition-shadow hover:shadow-md"
                                        style={{
                                            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)'
                                        }}
                                    >
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
                )}
            </div>
        );
    });
