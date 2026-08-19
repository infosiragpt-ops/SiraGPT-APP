"use client"

import { useState } from "react"
import { Shield, Key, XCircle, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const securityEvents = [
  {
    id: 1,
    type: "Failed Login",
    user: "unknown@example.com",
    ip: "192.168.1.100",
    time: "2024-01-15 14:30",
    severity: "medium",
  },
  {
    id: 2,
    type: "Admin Access",
    user: "admin@example.com",
    ip: "10.0.0.1",
    time: "2024-01-15 14:25",
    severity: "low",
  },
  {
    id: 3,
    type: "API Key Generated",
    user: "user@example.com",
    ip: "203.0.113.1",
    time: "2024-01-15 14:20",
    severity: "low",
  },
  {
    id: 4,
    type: "Multiple Failed Logins",
    user: "attacker@evil.com",
    ip: "198.51.100.1",
    time: "2024-01-15 14:15",
    severity: "high",
  },
]

const securitySettings = [
  { name: "Two-Factor Authentication", enabled: true, description: "Require 2FA for admin accounts" },
  { name: "IP Whitelist", enabled: false, description: "Restrict access to specific IP addresses" },
  { name: "Session Timeout", enabled: true, description: "Auto-logout after 30 minutes of inactivity" },
  { name: "Password Complexity", enabled: true, description: "Enforce strong password requirements" },
  { name: "API Rate Limiting", enabled: true, description: "Limit API requests per user" },
]

export default function SecurityPage() {
  const [settings, setSettings] = useState(securitySettings)
  const [showApiKey, setShowApiKey] = useState(false)

  const toggleSetting = (index: number) => {
    setSettings((prev) => prev.map((setting, i) => (i === index ? { ...setting, enabled: !setting.enabled } : setting)))
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "high":
        return "destructive"
      case "medium":
        return "secondary"
      case "low":
        return "outline"
      default:
        return "outline"
    }
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Security Center</h1>
          <p className="text-muted-foreground">Monitor and configure security settings</p>
        </div>
        <Button>
          <Shield className="mr-2 h-4 w-4" />
          Security Scan
        </Button>
      </div>

      {/* Security Overview */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Security Score</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">85/100</div>
            <p className="text-xs text-muted-foreground">Good security posture</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">23</div>
            <p className="text-xs text-muted-foreground">Current user sessions</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed Logins</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">12</div>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <Key className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">156</div>
            <p className="text-xs text-muted-foreground">Active API keys</p>
          </CardContent>
        </Card>
      </div>

      {/* Security Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Security Settings</CardTitle>
          <CardDescription>Configure security policies and features</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {settings.map((setting, index) => (
              <div key={setting.name} className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{setting.name}</div>
                  <div className="text-xs text-muted-foreground">{setting.description}</div>
                </div>
                <Switch checked={setting.enabled} onCheckedChange={() => toggleSetting(index)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* API Key Management */}
      <Card>
        <CardHeader>
          <CardTitle>API Key Management</CardTitle>
          <CardDescription>Manage system API keys</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="master-key">Master API Key</Label>
            <div className="flex gap-2">
              <Input
                id="master-key"
                type={showApiKey ? "text" : "password"}
                value="EXAMPLE_PLACEHOLDER_KEY_DO_NOT_USE"
                readOnly
              />
              <Button variant="outline" size="icon" onClick={() => setShowApiKey(!showApiKey)}>
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button variant="outline">Regenerate</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security Events */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Security Events</CardTitle>
          <CardDescription>Monitor security-related activities</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event Type</TableHead>
                <TableHead>User</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Severity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {securityEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">{event.type}</TableCell>
                  <TableCell>{event.user}</TableCell>
                  <TableCell>{event.ip}</TableCell>
                  <TableCell>{event.time}</TableCell>
                  <TableCell>
                    <Badge variant={getSeverityColor(event.severity)}>{event.severity}</Badge>
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
