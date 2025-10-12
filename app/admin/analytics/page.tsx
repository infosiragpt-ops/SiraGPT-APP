"use client"

import { useState, useEffect } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { db } from "@/lib/database"
import { SidebarTrigger } from "@/components/ui/sidebar"

const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042"]

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<any>(null)
  const [timeRange, setTimeRange] = useState("7d")

  useEffect(() => {
    loadAnalytics()
  }, [timeRange])

  const loadAnalytics = async () => {
    try {
      const data = await db.getAnalytics()

      // Generate mock time series data
      const dates = Array.from({ length: 30 }, (_, i) => {
        const date = new Date()
        date.setDate(date.getDate() - (29 - i))
        return date.toISOString().slice(0, 10)
      })

      const userGrowth = dates.map((date, i) => ({
        date,
        users: Math.floor(Math.random() * 50) + i * 2,
        revenue: Math.floor(Math.random() * 1000) + i * 50,
      }))

      const modelUsage = [
        { name: "ChatGPT", value: 45, usage: 15420 },
        { name: "Claude", value: 25, usage: 8930 },
        { name: "Grok", value: 15, usage: 5240 },
        { name: "DeepSeek", value: 10, usage: 3150 },
        { name: "Gemini", value: 5, usage: 1680 },
      ]

      setAnalytics({
        ...data,
        userGrowth,
        modelUsage,
      })
    } catch (error) {
      console.error("Failed to load analytics:", error)
    }
  }

  if (!analytics) {
    return (
      <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
        <div className="animate-pulse">
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
            <SidebarTrigger className="md:hidden" />
            <div>
              <div className="h-6 sm:h-8 bg-muted rounded w-32 sm:w-48 mb-2"></div>
              <div className="h-3 sm:h-4 bg-muted rounded w-48 sm:w-64"></div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Analytics</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">Detailed insights and performance metrics</p>
            </div>
          </div>
        </div>
        <div className="flex gap-1 sm:gap-2 flex-shrink-0 flex-wrap">
          <Button 
            variant={timeRange === "7d" ? "default" : "outline"} 
            onClick={() => setTimeRange("7d")}
            size="sm"
            className="text-xs sm:text-sm"
          >
            7 Days
          </Button>
          <Button 
            variant={timeRange === "30d" ? "default" : "outline"} 
            onClick={() => setTimeRange("30d")}
            size="sm"
            className="text-xs sm:text-sm"
          >
            30 Days
          </Button>
          <Button 
            variant={timeRange === "90d" ? "default" : "outline"} 
            onClick={() => setTimeRange("90d")}
            size="sm"
            className="text-xs sm:text-sm"
          >
            90 Days
          </Button>
        </div>
      </div>

      {/* User Growth Chart */}
      <Card>
        <CardHeader>
          <CardTitle>User Growth</CardTitle>
          <CardDescription>Daily user registrations over time</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={analytics.userGrowth}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="users" stroke="#8884d8" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Revenue Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Revenue Trend</CardTitle>
            <CardDescription>Daily revenue over time</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={analytics.userGrowth}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="revenue" fill="#82ca9d" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Model Usage Distribution */}
        <Card>
          <CardHeader>
            <CardTitle>Model Usage Distribution</CardTitle>
            <CardDescription>Usage breakdown by AI model</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={analytics.modelUsage}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {analytics.modelUsage.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Metrics */}
      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Top Performing Models</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {analytics.modelUsage.map((model: any, index: number) => (
                <div key={model.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className="text-sm font-medium">{model.name}</span>
                  </div>
                  <span className="text-sm text-muted-foreground">{model.usage.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>User Plan Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm">Free Plan</span>
                <span className="text-sm font-medium">{analytics.usersByPlan.Free}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm">Pro Plan</span>
                <span className="text-sm font-medium">{analytics.usersByPlan.Pro}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm">Enterprise Plan</span>
                <span className="text-sm font-medium">{analytics.usersByPlan.Enterprise}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Key Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm">Avg. Revenue per User</span>
                <span className="text-sm font-medium">
                  ${(analytics.totalRevenue / analytics.totalUsers).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm">Active User Rate</span>
                <span className="text-sm font-medium">
                  {((analytics.activeUsers / analytics.totalUsers) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm">Avg. API Calls per User</span>
                <span className="text-sm font-medium">
                  {(analytics.totalApiCalls / analytics.totalUsers).toFixed(0)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
