"use client"

/**
 * Admin · Reportes — generación real sobre GET /api/admin/reports.
 * Reemplaza el catálogo ficticio (5 reportes inventados con fechas
 * hardcodeadas y un botón de descarga que hacía alert()).
 */

import { useCallback, useEffect, useState } from "react"
import { FileText, Download, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { toast } from "sonner"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type ReportType = {
  id: string
  nombre: string
  descripcion: string
  superAdmin: boolean
}

type ReportResult = {
  type: string
  nombre: string
  range: { from: string; to: string }
  rows: Array<Record<string, string | number>>
  total: number
}

const RANGES = [
  { id: "7", label: "Últimos 7 días" },
  { id: "30", label: "Últimos 30 días" },
  { id: "90", label: "Últimos 90 días" },
]

function rangeParams(days: string): string {
  const to = new Date()
  const from = new Date(to.getTime() - Number(days) * 24 * 60 * 60 * 1000)
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
}

async function adminFetch(path: string): Promise<any> {
  const res = await authenticatedFetch(path)
  if (!res.ok) {
    const err: any = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export default function ReportsPage() {
  const [types, setTypes] = useState<ReportType[]>([])
  const [days, setDays] = useState("30")
  const [loadingType, setLoadingType] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadTypes = useCallback(async () => {
    try {
      const data = await adminFetch("/api/admin/reports")
      setTypes(data.types || [])
    } catch {
      setError("No se pudo cargar el catálogo de reportes")
    }
  }, [])

  useEffect(() => { void loadTypes() }, [loadTypes])

  const generate = async (type: ReportType) => {
    setLoadingType(type.id)
    setError(null)
    try {
      const data = await adminFetch(`/api/admin/reports/${type.id}?${rangeParams(days)}`)
      setResult(data)
      if (!data.rows?.length) toast.info("El reporte no tiene filas en este rango")
    } catch (err: any) {
      if (err?.status === 403) toast.error("Este reporte requiere super-admin")
      else toast.error("No se pudo generar el reporte")
    } finally {
      setLoadingType(null)
    }
  }

  const downloadCsv = async (type: string) => {
    try {
      const res = await authenticatedFetch(`/api/admin/reports/${type}?${rangeParams(days)}&format=csv`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${type}-${days}d.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("No se pudo descargar el CSV")
    }
  }

  const columns = result?.rows?.length ? Object.keys(result.rows[0]) : []

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="md:hidden" />
          <div>
            <h1 className="text-3xl font-bold">Reportes</h1>
            <p className="text-muted-foreground">Generados en vivo desde la base de datos</p>
          </div>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {/* Catálogo real */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {types.map((type) => (
          <Card key={type.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  {type.nombre}
                </CardTitle>
                {type.superAdmin && <Badge variant="outline">super-admin</Badge>}
              </div>
              <CardDescription>{type.descripcion}</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button size="sm" onClick={() => void generate(type)} disabled={loadingType !== null}>
                {loadingType === type.id ? (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                )}
                Generar
              </Button>
              <Button size="sm" variant="outline" onClick={() => void downloadCsv(type.id)}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Resultado */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>{result.nombre}</CardTitle>
            <CardDescription>
              {new Date(result.range.from).toLocaleDateString("es")} — {new Date(result.range.to).toLocaleDateString("es")}
              {" · "}{result.total.toLocaleString("es")} filas
            </CardDescription>
          </CardHeader>
          <CardContent>
            {result.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Sin datos en este rango.</p>
            ) : (
              <div className="max-h-[28rem] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {columns.map((col) => (
                        <TableHead key={col} className="capitalize">{col}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row, i) => (
                      <TableRow key={i}>
                        {columns.map((col) => (
                          <TableCell key={col} className="tabular-nums">{String(row[col])}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
