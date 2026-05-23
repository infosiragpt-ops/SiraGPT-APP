"use client"

import { useState } from "react"
import { RefreshCw, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

const databaseStats = [
  { name: "Users", count: 1247, size: "2.4 MB", growth: "+12%" },
  { name: "Chats", count: 8934, size: "45.2 MB", growth: "+28%" },
  { name: "Messages", count: 156789, size: "234.1 MB", growth: "+35%" },
  { name: "Payments", count: 892, size: "1.8 MB", growth: "+15%" },
  { name: "API Usage", count: 45623, size: "12.3 MB", growth: "+42%" },
]

const connectionStats = [
  { metric: "Active Connections", value: "23", status: "healthy" },
  { metric: "Query Response Time", value: "12ms", status: "healthy" },
  { metric: "CPU Usage", value: "34%", status: "healthy" },
  { metric: "Memory Usage", value: "67%", status: "warning" },
  { metric: "Disk Usage", value: "45%", status: "healthy" },
]

export default function DatabasePage() {
  const [isBackingUp, setIsBackingUp] = useState(false)

  const handleBackup = () => {
    setIsBackingUp(true)
    setTimeout(() => setIsBackingUp(false), 3000)
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Database Management</h1>
          <p className="text-muted-foreground">Monitor and manage database operations</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={handleBackup} disabled={isBackingUp}>
            {isBackingUp ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {isBackingUp ? "Backing up..." : "Backup"}
          </Button>
        </div>
      </div>

      {/* Database Health */}
      <div className="grid gap-4 md:grid-cols-5">
        {connectionStats.map((stat) => (
          <Card key={stat.metric}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.metric}</CardTitle>
              <Badge variant={stat.status === "healthy" ? "default" : "destructive"}>{stat.status}</Badge>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Database Tables */}
      <Card>
        <CardHeader>
          <CardTitle>Database Tables</CardTitle>
          <CardDescription>Overview of all database tables and their statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table Name</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Growth</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databaseStats.map((table) => (
                <TableRow key={table.name}>
                  <TableCell className="font-medium">{table.name}</TableCell>
                  <TableCell>{table.count.toLocaleString()}</TableCell>
                  <TableCell>{table.size}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{table.growth}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm">
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Storage Usage */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Storage Usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Database Size</span>
                <span>295.8 MB / 1 GB</span>
              </div>
              <Progress value={29.6} />
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Backup Storage</span>
                <span>1.2 GB / 5 GB</span>
              </div>
              <Progress value={24} />
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Log Files</span>
                <span>45.3 MB / 500 MB</span>
              </div>
              <Progress value={9.1} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Backups</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">Full Backup</p>
                  <p className="text-xs text-muted-foreground">2024-01-15 02:00 AM</p>
                </div>
                <Badge variant="default">Success</Badge>
              </div>
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">Incremental Backup</p>
                  <p className="text-xs text-muted-foreground">2024-01-14 02:00 AM</p>
                </div>
                <Badge variant="default">Success</Badge>
              </div>
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">Full Backup</p>
                  <p className="text-xs text-muted-foreground">2024-01-13 02:00 AM</p>
                </div>
                <Badge variant="default">Success</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
