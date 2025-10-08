"use client"

import { useEffect, useState } from 'react'
import { AuthGuard } from '@/components/auth-guard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, ExternalLink, FileText, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { apiClient } from '@/lib/api'
import { toast } from 'sonner'

interface StripeInvoiceSummary {
  id: string
  number?: string
  status?: string
  amountPaid: number
  currency: string
  hostedInvoiceUrl?: string
  invoicePdf?: string
  created: string | Date
}

export default function UserInvoicesPage() {
  return (
    <AuthGuard>
      <Content />
    </AuthGuard>
  )
}

function Content() {
  const [invoices, setInvoices] = useState<StripeInvoiceSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    try {
      const res = await apiClient.listStripeInvoices()
      setInvoices(res.invoices || [])
    } catch (e) {
      toast.error('Failed to load invoices')
    } finally {
      setLoading(false)
    }
  }

  const download = async (id: string) => {
    try {
      const blob = await apiClient.downloadStripeInvoice(id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `stripe-invoice-${id}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      toast.error(e.message || 'Download failed')
    }
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/billing?tab=billing-history">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Billing
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-5 w-5"/>Invoices</h1>
            <p className="text-muted-foreground">Official Stripe invoices for your subscription</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Stripe Invoices</CardTitle>
            <CardDescription>Total: {invoices.length}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="p-8">Loading…</div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map(inv => (
                      <TableRow key={inv.id}>
                        <TableCell>{new Date(inv.created).toLocaleString()}</TableCell>
                        <TableCell className="font-mono">{inv.number || inv.id}</TableCell>
                        <TableCell>
                          <Badge variant={(inv.status || '').toUpperCase() === 'PAID' ? 'default' : 'secondary'}>
                            {(inv.status || '').toUpperCase() || 'UNKNOWN'}
                          </Badge>
                        </TableCell>
                        <TableCell>${inv.amountPaid.toFixed(2)} {inv.currency?.toUpperCase?.()}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => download(inv.id)}>
                              <Download className="h-3 w-3 mr-1"/> PDF
                            </Button>
                            {inv.hostedInvoiceUrl && (
                              <Button size="sm" variant="ghost" onClick={() => window.open(inv.hostedInvoiceUrl!, '_blank')}>
                                <ExternalLink className="h-3 w-3"/>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
