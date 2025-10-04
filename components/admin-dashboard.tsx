"use client"

import { useState, useEffect } from "react"
import { Users, Bot, Activity, TrendingUp, TrendingDown, DollarSign } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ThemeToggle } from "@/components/theme-toggle"

export function AdminDashboard() {
  const [analytics, setAnalytics] = useState<any>(null)

  useEffect(() => {
    // Simulate loading analytics data
    setTimeout(() => {
      setAnalytics({
        totalUsers: 2847,
        activeUsers: 1234,
        totalRevenue: 45231,
        totalApiCalls: 892000,
        usersByPlan: {
          Free: 1500,
          Pro: 800,
          Enterprise: 547,
        },
      })
    }, 1000)
  }, [])

  if (!analytics) {
    return (
      <div className="flex-1 space-y-6 p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-muted rounded w-1/4 mb-2"></div>
          <div className="h-4 bg-muted rounded w-1/2"></div>
        </div>
      </div>
    )
  }

  const stats = [
    {
      title: "Total Users",
      value: analytics.totalUsers.toLocaleString(),
      change: "+12.5%",
      trend: "up",
      icon: Users,
    },
    {
      title: "Active Users",
      value: analytics.activeUsers.toLocaleString(),
      change: "+8.2%",
      trend: "up",
      icon: Activity,
    },
    {
      title: "Total Revenue",
      value: `$${analytics.totalRevenue.toLocaleString()}`,
      change: "+15.3%",
      trend: "up",
      icon: DollarSign,
    },
    {
      title: "API Calls",
      value: `${(analytics.totalApiCalls / 1000).toFixed(0)}K`,
      change: "-2.1%",
      trend: "down",
      icon: Bot,
    },
  ]

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Admin Dashboard</h1>
          <p className="text-muted-foreground">Overview of your Sira Gpt platform</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button>Refresh Data</Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <div className="flex items-center text-xs text-muted-foreground">
                {stat.trend === "up" && <TrendingUp className="mr-1 h-3 w-3 text-green-500" />}
                {stat.trend === "down" && <TrendingDown className="mr-1 h-3 w-3 text-red-500" />}
                <span
                  className={
                    stat.trend === "up"
                      ? "text-green-500"
                      : stat.trend === "down"
                        ? "text-red-500"
                        : "text-muted-foreground"
                  }
                >
                  {stat.change}
                </span>
                <span className="ml-1">from last month</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Plan Distribution and System Health */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Users by Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm">Free</span>
                <div className="flex items-center gap-2">
                  <Progress value={60} className="w-20" />
                  <Badge variant="outline">{analytics.usersByPlan.Free}</Badge>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Pro</span>
                <div className="flex items-center gap-2">
                  <Progress value={35} className="w-20" />
                  <Badge variant="secondary">{analytics.usersByPlan.Pro}</Badge>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Enterprise</span>
                <div className="flex items-center gap-2">
                  <Progress value={25} className="w-20" />
                  <Badge variant="default">{analytics.usersByPlan.Enterprise}</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System Health</CardTitle>
            <CardDescription>All systems operational</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">Database: Connected</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">API: Operational</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">AI Services: Active</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" className="w-full justify-start">
              Export User Data
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              Generate Report
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              System Backup
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest user actions and system events</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              { user: "John Doe", action: "Started new chat", time: "2 min ago", status: "active" },
              { user: "Jane Smith", action: "Upgraded to Pro", time: "5 min ago", status: "success" },
              { user: "Mike Johnson", action: "API limit reached", time: "10 min ago", status: "warning" },
              { user: "Sarah Wilson", action: "Account created", time: "15 min ago", status: "success" },
            ].map((activity, index) => (
              <div key={index} className="flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    activity.status === "success"
                      ? "bg-green-500"
                      : activity.status === "warning"
                        ? "bg-yellow-500"
                        : "bg-blue-500"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{activity.user}</p>
                  <p className="text-xs text-muted-foreground">{activity.action}</p>
                </div>
                <span className="text-xs text-muted-foreground">{activity.time}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
