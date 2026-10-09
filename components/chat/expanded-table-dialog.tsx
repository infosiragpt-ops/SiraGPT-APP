"use client"
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogClose } from '@/components/ui/dialog'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  headers: string[]
  rows: string[][]
  restoreFocus?: HTMLElement | null
}

export function ExpandedTableDialog({ open, onOpenChange, title, headers, rows, restoreFocus }: Props) {
  return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent showCloseButton={false} aria-modal="true" aria-describedby={undefined} className="max-w-none w-screen h-[100dvh] rounded-none sm:rounded-none p-4 flex flex-col" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus?.focus(); }}>
                    <div className="flex items-center justify-between mb-4">
                        <DialogTitle className="text-lg font-bold">{title || 'Tabla ampliada'}</DialogTitle>
                        <DialogClose asChild><Button variant="outline">Cerrar</Button></DialogClose>
                    </div>
                    <div className="flex-grow overflow-auto border rounded-md">
                        <div className="overflow-x-auto overflow-y-auto h-full">
                            <table className="w-full border-collapse border border-muted" style={{ minWidth: 'max-content' }}>
                                <thead className="sticky top-0 bg-background">
                                    <tr>
                                        {headers.map((header, index) => (
                                            <th key={index} className="border border-muted px-4 py-3 bg-muted/50 text-left font-medium text-sm whitespace-nowrap min-w-[120px]">{header}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row, rowIndex) => (
                                        <tr key={rowIndex} className="hover:bg-muted/20">
                                            {row.map((cell, cellIndex) => (
                                                <td key={cellIndex} className="border border-muted px-4 py-3 text-sm whitespace-nowrap min-w-[120px]">{cell}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
  )
}
