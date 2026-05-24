"use client"

import { useState } from "react"
import { FileText, Download, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const reportTypes = [
  {
    name: "User Activity Report",
    description: "Detailed user engagement and activity metrics",
    lastGenerated: "2024-01-15",
    status: "ready",
  },
  {
    name: "Revenue Report",
    description: "Financial performance and payment analytics",
    lastGenerated: "2024-01-14",
    status: "ready",
  },
  {
    name: "API Usage Report",
    description: "API consumption and performance metrics",
    lastGenerated: "2024-01-15",
    status: "generating",
  },
  {
    name: "Security Report",
    description: "Security events and threat analysis",
    lastGenerated: "2024-01-13",
    status: "ready",
  },
  {
    name: "Performance Report",
    description: "System performance and uptime metrics",
    lastGenerated: "2024-01-15",
    status: "ready",
  },
]

const recentReports = [
  {
    id: 1,
    name: "Monthly User Report - December 2023",
    type: "User Activity",
    generatedBy: "System",
    date: "2024-01-01",
    size: "2.4 MB",
    downloads: 15,
  },
  {
    id: 2,
    name: "Q4 2023 Revenue Analysis",
    type: "Revenue",
    generatedBy: "Admin",
    date: "2023-12-31",
    size: "1.8 MB",
    downloads: 8,
  },
  {
    id: 3,
    name: "API Performance Report - Week 52",
    type: "API Usage",
    generatedBy: "System",
    date: "2023-12-30",
    size: "3.2 MB",
    downloads: 23,
  },
]

export default function ReportsPage() {
  const [selectedPeriod, setSelectedPeriod] = useState("last-30-days")
  const [selectedType, setSelectedType] = useState("all")

  const generateReport = (reportName: string) => {
    alert(`Generating ${reportName}... This may take a few minutes.`)
  }

  const downloadReport = (reportId: number) => {
    alert(`Downloading report ${reportId}...`)
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Reports</h1>
          <p className="text-muted-foreground">Generate and manage system reports</p>
        </div>
        <Button>
          <FileText className="mr-2 h-4 w-4" />
          Custom Report
        </Button>
      </div>

      {/* Report Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Report Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <div className="flex-1">
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger>
                  <SelectValue placeholder="Select time period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last-7-days">Last 7 days</SelectItem>
                  <SelectItem value="last-30-days">Last 30 days</SelectItem>
                  <SelectItem value="last-90-days">Last 90 days</SelectItem>
                  <SelectItem value="last-year">Last year</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select report type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All reports</SelectItem>
                  <SelectItem value="user-activity">User Activity</SelectItem>
                  <SelectItem value="revenue">Revenue</SelectItem>
                  <SelectItem value="api-usage">API Usage</SelectItem>
                  <SelectItem value="security">Security</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline">
              <Filter className="mr-2 h-4 w-4" />
              Apply Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Available Reports */}
      <Card>
        <CardHeader>
          <CardTitle>Available Reports</CardTitle>
          <CardDescription>Generate new reports or view existing ones</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {reportTypes.map((report) => (
              <Card key={report.name}>
                <CardHeader>
                  <CardTitle className="text-lg">{report.name}</CardTitle>
                  <CardDescription>{report.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Last generated:</span>
                      <span>{report.lastGenerated}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <Badge variant={report.status === "ready" ? "default" : "secondary"}>{report.status}</Badge>
                      <Button
                        size="sm"
                        onClick={() => generateReport(report.name)}
                        disabled={report.status === "generating"}
                      >
                        {report.status === "generating" ? "Generating..." : "Generate"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent Reports */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Reports</CardTitle>
          <CardDescription>Previously generated reports available for download</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Report Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Generated By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Downloads</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentReports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-medium">{report.name}</TableCell>
                  <TableCell>{report.type}</TableCell>
                  <TableCell>{report.generatedBy}</TableCell>
                  <TableCell>{report.date}</TableCell>
                  <TableCell>{report.size}</TableCell>
                  <TableCell>{report.downloads}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => downloadReport(report.id)}>
                      <Download className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
