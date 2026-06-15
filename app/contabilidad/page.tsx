"use client"

/**
 * /contabilidad — Dashboard contable (PCGE peruano). KPIs (ingresos, gastos,
 * utilidad, activo), libro diario, comprobantes y reportes, con exportación a
 * Excel/PDF. Consume el backend vía apiClient (/api/accounting/*).
 */

import * as React from "react"
import { Download, FileSpreadsheet, FileText, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

const money = (v: unknown) => `S/ ${Number(v ?? 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateStr = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString("es-PE") : "")

type AnyRow = Record<string, any>

export default function ContabilidadPage() {
  const [loading, setLoading] = React.useState(true)
  const [income, setIncome] = React.useState<AnyRow | null>(null)
  const [balance, setBalance] = React.useState<AnyRow | null>(null)
  const [entries, setEntries] = React.useState<AnyRow[]>([])
  const [invoices, setInvoices] = React.useState<AnyRow[]>([])

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [is, bs, je, inv] = await Promise.all([
        apiClient.getAccountingIncomeStatement().catch(() => null),
        apiClient.getAccountingBalanceSheet().catch(() => null),
        apiClient.listAccountingJournalEntries({ take: 100 }).catch(() => ({ items: [] })),
        apiClient.listAccountingInvoices({ take: 100 }).catch(() => ({ items: [] })),
      ])
      setIncome(is as AnyRow)
      setBalance(bs as AnyRow)
      setEntries(((je as AnyRow)?.items as AnyRow[]) || [])
      setInvoices(((inv as AnyRow)?.items as AnyRow[]) || [])
    } catch {
      toast.error("No se pudo cargar la contabilidad")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const exportFile = async (path: string, filename: string) => {
    try {
      await apiClient.downloadAccountingExport(path, filename)
    } catch {
      toast.error("No se pudo exportar")
    }
  }

  const kpis = [
    { label: "Ingresos", value: income?.ingresos },
    { label: "Gastos", value: income?.gastos },
    { label: "Utilidad", value: income?.utilidad },
    { label: "Activo", value: balance?.activo },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Contabilidad</h1>
          <p className="text-sm text-muted-foreground">Plan Contable General Empresarial · partida doble</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" /> Actualizar
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{loading ? <ThinkingIndicator size="sm" /> : money(k.value)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="asientos">
        <TabsList>
          <TabsTrigger value="asientos">Asientos</TabsTrigger>
          <TabsTrigger value="comprobantes">Comprobantes</TabsTrigger>
          <TabsTrigger value="reportes">Reportes</TabsTrigger>
        </TabsList>

        {/* Libro Diario */}
        <TabsContent value="asientos" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportFile("journal.xlsx", "libro-diario.xlsx")}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Diario (Excel)
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportFile("trial-balance.xlsx", "balance-comprobacion.xlsx")}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Balance de comprobación (Excel)
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>N°</TableHead><TableHead>Fecha</TableHead><TableHead>Glosa</TableHead>
                    <TableHead className="text-right">Debe</TableHead><TableHead className="text-right">Haber</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Sin asientos</TableCell></TableRow>}
                  {entries.map((e) => {
                    const debit = (e.lines || []).reduce((s: number, l: AnyRow) => s + Number(l.debit || 0), 0)
                    const credit = (e.lines || []).reduce((s: number, l: AnyRow) => s + Number(l.credit || 0), 0)
                    return (
                      <TableRow key={e.id}>
                        <TableCell>{e.number}</TableCell>
                        <TableCell>{dateStr(e.date)}</TableCell>
                        <TableCell className="max-w-[320px] truncate">{e.glosa}</TableCell>
                        <TableCell className="text-right">{money(debit)}</TableCell>
                        <TableCell className="text-right">{money(credit)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Comprobantes */}
        <TabsContent value="comprobantes" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportFile("invoices.xlsx", "comprobantes.xlsx")}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Comprobantes (Excel)
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Comprobante</TableHead><TableHead>Fecha</TableHead><TableHead>Cliente</TableHead>
                    <TableHead className="text-right">IGV</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Sin comprobantes</TableCell></TableRow>}
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.docType === "FACTURA" ? "Factura" : "Boleta"} {inv.series}-{inv.number}</TableCell>
                      <TableCell>{dateStr(inv.issueDate)}</TableCell>
                      <TableCell className="max-w-[220px] truncate">{inv.customerName}</TableCell>
                      <TableCell className="text-right">{money(inv.igv)}</TableCell>
                      <TableCell className="text-right">{money(inv.total)}</TableCell>
                      <TableCell><Badge variant={inv.status === "ISSUED" ? "default" : "secondary"}>{inv.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reportes */}
        <TabsContent value="reportes" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportFile("income-statement.pdf", "estado-resultados.pdf")}>
              <FileText className="mr-2 h-4 w-4" /> Estado de resultados (PDF)
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportFile("balance-sheet.pdf", "balance-general.pdf")}>
              <FileText className="mr-2 h-4 w-4" /> Balance general (PDF)
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Estado de resultados</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Ingresos</span><span>{money(income?.ingresos)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Gastos</span><span>{money(income?.gastos)}</span></div>
                <div className="flex justify-between font-semibold"><span>Utilidad</span><span>{money(income?.utilidad)}</span></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Balance general</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Activo</span><span>{money(balance?.activo)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Pasivo</span><span>{money(balance?.pasivo)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Patrimonio</span><span>{money(balance?.patrimonio)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Resultado</span><span>{money(balance?.resultado)}</span></div>
                {balance && (
                  <div className="pt-1 text-xs">
                    <Badge variant={balance.balanced ? "default" : "secondary"}>{balance.balanced ? "Cuadrado" : "Descuadre"}</Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
