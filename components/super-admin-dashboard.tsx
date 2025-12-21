"use client"

import { useState, useEffect } from "react"
import { Users, Shield, ChevronDown, Eye, UserCheck, LogOut, Home } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"
import { useRouter } from "next/navigation"

interface User {
  id: string
  name: string
  email: string
  plan: string
  isAdmin: boolean
  isSuperAdmin?: boolean
  apiUsage: number
  monthlyLimit: number
  createdAt: string
  updatedAt: string
}

export function SuperAdminDashboard() {
  const [users, setUsers] = useState<User[]>([])
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [planFilter, setPlanFilter] = useState("ALL")

  const { user: currentUser, logout, loginWithToken } = useAuth()
  const router = useRouter()

  useEffect(() => {
    fetchUsers()
  }, [])

  useEffect(() => {
    filterUsers()
  }, [users, searchTerm, planFilter])

  const fetchUsers = async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.getUsers()
      setUsers(response.users || [])
    } catch (error) {
      console.error('Failed to fetch users:', error)
      toast.error('Failed to load users')
    } finally {
      setIsLoading(false)
    }
  }

  const filterUsers = () => {
    let filtered = users

    // Filter by search term
    if (searchTerm) {
      filtered = filtered.filter(user => 
        user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.email.toLowerCase().includes(searchTerm.toLowerCase())
      )
    }

    // Filter by plan
    if (planFilter !== "ALL") {
      filtered = filtered.filter(user => user.plan === planFilter)
    }

    // Exclude current user and other super admins from impersonation list
    filtered = filtered.filter(user => 
      user.id !== currentUser?.id && !user.isSuperAdmin
    )

    setFilteredUsers(filtered)
  }

  const handleImpersonateUser = async (targetUser: User) => {
    try {
      console.log('Starting to access user account:', targetUser.email)
      
      // Call backend API to get impersonation token
      const response = await apiClient.request(`/auth/impersonate/${targetUser.id}`, {
        method: 'POST',
      })
      
      if (response.token) {
        // Store super admin info for quick return (hidden from normal user)
        localStorage.setItem('superadmin-return-data', JSON.stringify({
          originalToken: localStorage.getItem('auth-token'),
          originalUser: currentUser,
          returnTime: Date.now()
        }))
        
        // Login with the new token (complete login as target user)
        const loginSuccess = await loginWithToken(response.token)
        if (loginSuccess) {
          toast.success(`Successfully logged in as ${targetUser.name}`)
          // Redirect to chat interface as that user
          router.push('/chat')
        } else {
          toast.error('Failed to access user account')
        }
      }
    } catch (error) {
      console.error('User access failed:', error)
      toast.error('Failed to access user account')
    }
  }

  const handleReturnToSuperAdmin = async () => {
    try {
      const returnData = localStorage.getItem('superadmin-return-data')
      if (returnData) {
        const { originalToken, originalUser } = JSON.parse(returnData)
        if (originalToken) {
          // Restore original super admin session
          const loginSuccess = await loginWithToken(originalToken)
          if (loginSuccess) {
            // Clean up return data
            localStorage.removeItem('superadmin-return-data')
            
            toast.success('Returned to super admin account')
            router.push('/super-admin')
          } else {
            toast.error('Failed to return to super admin account')
          }
        }
      }
    } catch (error) {
      console.error('Failed to return to super admin:', error)
      toast.error('Failed to return to super admin account')
    }
  }

  const handleLogout = async () => {
    // Clean up any return data
    localStorage.removeItem('superadmin-return-data')
    
    await logout()
    router.push('/auth/login')
  }

  const isImpersonating = false // Remove impersonation indication as we want complete user experience

  const getPlanBadgeColor = (plan: string) => {
    switch (plan) {
      case 'FREE': return 'bg-gray-100 text-gray-800'
      case 'PRO': return 'bg-blue-100 text-blue-800'
      case 'PRO_MAX': return 'bg-purple-100 text-purple-800'
      case 'ENTERPRISE': return 'bg-green-100 text-green-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  if (!currentUser?.isSuperAdmin) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Shield className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground">You don't have super admin privileges.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600">
                <Shield className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">Super Admin Panel</h1>
                <p className="text-muted-foreground">
                  {isImpersonating ? 'You are currently impersonating a user account' : 'Manage and access user accounts'}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {isImpersonating && (
                <Button 
                  onClick={handleReturnToSuperAdmin}
                  variant="outline"
                  className="bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100"
                >
                  <Home className="h-4 w-4 mr-2" />
                  Return to Super Admin
                </Button>
              )}
              <Button onClick={handleLogout} variant="outline">
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{filteredUsers.length}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Free Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {users.filter(u => u.plan === 'FREE' && !u.isSuperAdmin).length}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pro Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {users.filter(u => (u.plan === 'PRO' || u.plan === 'PRO_MAX') && !u.isSuperAdmin).length}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Enterprise Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {users.filter(u => u.plan === 'ENTERPRISE' && !u.isSuperAdmin).length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>User Management</CardTitle>
            <CardDescription>Search and filter users, then access their accounts</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <Label htmlFor="search">Search Users</Label>
                <Input
                  id="search"
                  placeholder="Search by name or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="w-full md:w-48">
                <Label htmlFor="plan-filter">Filter by Plan</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between">
                      {planFilter === "ALL" ? "All Plans" : planFilter}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-full">
                    <DropdownMenuItem onClick={() => setPlanFilter("ALL")}>
                      All Plans
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPlanFilter("FREE")}>
                      Free
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPlanFilter("PRO")}>
                      Pro
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPlanFilter("PRO_MAX")}>
                      Pro Max
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPlanFilter("ENTERPRISE")}>
                      Enterprise
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Users Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>API Usage</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8">
                      Loading users...
                    </TableCell>
                  </TableRow>
                ) : filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8">
                      No users found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.name}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Badge className={getPlanBadgeColor(user.plan)}>
                          {user.plan}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {user.isAdmin ? (
                          <Badge variant="destructive">Admin</Badge>
                        ) : (
                          <Badge variant="secondary">User</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {Number(user.apiUsage).toLocaleString()} / {Number(user.monthlyLimit).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {new Date(user.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              Actions
                              <ChevronDown className="h-4 w-4 ml-2" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem 
                              onClick={() => handleImpersonateUser(user)}
                              className="text-blue-600 focus:text-blue-600"
                            >
                              <UserCheck className="h-4 w-4 mr-2" />
                              Access Account
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <Eye className="h-4 w-4 mr-2" />
                              View Profile
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}