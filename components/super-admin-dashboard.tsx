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

interface UserStats {
  total: number
  free: number
  pro: number
  proMax: number
  enterprise: number
}

export function SuperAdminDashboard() {
  const [users, setUsers] = useState<User[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [planFilter, setPlanFilter] = useState("ALL")
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalUsers, setTotalUsers] = useState(0)
  const [userStats, setUserStats] = useState<UserStats>({
    total: 0,
    free: 0,
    pro: 0,
    proMax: 0,
    enterprise: 0
  })
  const usersPerPage = 20

  const { user: currentUser, logout, loginWithToken } = useAuth()
  const router = useRouter()

  useEffect(() => {
    fetchUsers()
  }, [currentPage, searchTerm, planFilter])

  useEffect(() => {
    fetchUserStats()
  }, [])

  const fetchUsers = async () => {
    try {
      setIsLoading(true)
      const params: any = {
        page: currentPage,
        limit: usersPerPage
      }

      if (searchTerm) {
        params.search = searchTerm
      }

      if (planFilter !== "ALL") {
        params.plan = planFilter
      }

      const response = await apiClient.getUsers(params)
      
      // Exclude current user from the list (super admins are already excluded by backend)
      const filteredUsers = (response.users || []).filter((user: User) => 
        user.id !== currentUser?.id
      )
      
      setUsers(filteredUsers)
      
      // Use pagination object from response (backend returns pagination object)
      const pagination = response.pagination || {}
      const total = pagination.total || 0
      const pages = pagination.pages || Math.ceil(total / usersPerPage)
      
      setTotalUsers(total)
      setTotalPages(pages)
    } catch (error) {
      console.error('Failed to fetch users:', error)
      toast.error('Failed to load users')
    } finally {
      setIsLoading(false)
    }
  }

  const fetchUserStats = async () => {
    try {
      // Fetch all users without pagination to get accurate stats
      const response = await apiClient.getUsers({ limit: 10000 })
      const allUsers = (response.users || []).filter((user: User) => !user.isSuperAdmin)
      
      const stats: UserStats = {
        total: allUsers.length,
        free: allUsers.filter((u: User) => u.plan === 'FREE').length,
        pro: allUsers.filter((u: User) => u.plan === 'PRO').length,
        proMax: allUsers.filter((u: User) => u.plan === 'PRO_MAX').length,
        enterprise: allUsers.filter((u: User) => u.plan === 'ENTERPRISE').length
      }
      
      setUserStats(stats)
    } catch (error) {
      console.error('Failed to fetch user stats:', error)
    }
  }

  const handleImpersonateUser = async (targetUser: User) => {
    try {
      console.log('Starting to access user account:', targetUser.email)
      
      // Call backend API to get impersonation token
      const response = await apiClient.impersonateUser(targetUser.id)
      
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
              <div className="text-2xl font-bold">{userStats.total}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Free Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{userStats.free}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pro Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{userStats.pro + userStats.proMax}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Enterprise Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{userStats.enterprise}</div>
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
                  onChange={(e) => {
                    setSearchTerm(e.target.value)
                    setCurrentPage(1) // Reset to first page on search
                  }}
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
                    <DropdownMenuItem onClick={() => {
                      setPlanFilter("ALL")
                      setCurrentPage(1)
                    }}>
                      All Plans
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setPlanFilter("FREE")
                      setCurrentPage(1)
                    }}>
                      Free
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setPlanFilter("PRO")
                      setCurrentPage(1)
                    }}>
                      Pro
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setPlanFilter("PRO_MAX")
                      setCurrentPage(1)
                    }}>
                      Pro Max
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setPlanFilter("ENTERPRISE")
                      setCurrentPage(1)
                    }}>
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
                ) : users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8">
                      No users found
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
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

        {/* Pagination */}
        {!isLoading && totalPages > 1 && (
          <div className="mt-6 flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Showing {((currentPage - 1) * usersPerPage) + 1} to {Math.min(currentPage * usersPerPage, totalUsers)} of {totalUsers} users
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNumber;
                  if (totalPages <= 5) {
                    pageNumber = i + 1;
                  } else if (currentPage <= 3) {
                    pageNumber = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNumber = totalPages - 4 + i;
                  } else {
                    pageNumber = currentPage - 2 + i;
                  }
                  
                  return (
                    <Button
                      key={pageNumber}
                      variant={currentPage === pageNumber ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCurrentPage(pageNumber)}
                    >
                      {pageNumber}
                    </Button>
                  );
                })}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}