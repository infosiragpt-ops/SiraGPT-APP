"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Bot,
  Plus,
  Search,
  Star,
  Users,
  TrendingUp,
  Sparkles,
  BookOpen,
  Code,
  Palette,
  MoreHorizontal,
  Edit,
  Trash2,
  Share2,
  Copy,
  MessageSquare,
  User,
  Loader2,
  Eye,
  Lock,
  Globe,
  Briefcase,
  Heart,
  Gamepad2,
  ChevronRight,
  UserCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card" // Added CardTitle
import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter, // Added DialogFooter
} from "@/components/ui/dialog"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { gptsService, type CustomGPT, type GPTFilters } from "@/lib/gpts-service"
import { useChat } from "@/lib/chat-context-integrated"

// Categories with icons - reordered for a more "store-like" feel
const categories = [
  { name: "All", icon: <Sparkles className="w-4 h-4" /> }, // Use Sparkles for All to signify "discovery"
  { name: "Trending", icon: <TrendingUp className="w-4 h-4" /> }, // Added a "Trending" category (will need data support)
  { name: "Writing", icon: <BookOpen className="w-4 h-4" /> },
  { name: "Productivity", icon: <Briefcase className="w-4 h-4" /> },
  { name: "Programming", icon: <Code className="w-4 h-4" /> },
  { name: "Design", icon: <Palette className="w-4 h-4" /> },
  { name: "Research & Analysis", icon: <Search className="w-4 h-4" /> },
  { name: "Education", icon: <BookOpen className="w-4 h-4" /> },
  { name: "Data Analysis", icon: <Users className="w-4 h-4" /> },
  { name: "Lifestyle", icon: <Heart className="w-4 h-4" /> },
  { name: "Entertainment", icon: <Gamepad2 className="w-4 h-4" /> },
  { name: "Marketing", icon: <TrendingUp className="w-4 h-4" /> },
  { name: "Finance", icon: <Users className="w-4 h-4" /> },
  { name: "Health & Fitness", icon: <Heart className="w-4 h-4" /> },
  { name: "Travel", icon: <Globe className="w-4 h-4" /> },
  { name: "Other", icon: <Star className="w-4 h-4" /> },
]

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

// Custom Avatar/Icon component for GPTs - Updated to handle both images and text/emoji
const GPTAvatar = ({ gpt }: { gpt: CustomGPT }) => {
  // Check if iconUrl is a valid image URL (starts with http/https or data:)
  const isImageUrl = gpt.iconUrl && (
    gpt.iconUrl.startsWith('http') ||
    gpt.iconUrl.startsWith('https') ||
    gpt.iconUrl.startsWith('data:')
  )

  if (isImageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={gpt.iconUrl}
        alt={`${gpt.name} icon`}
        className="w-10 h-10 sm:w-12 sm:h-12 rounded-full object-cover flex-shrink-0"
      />
    )
  }

  // If iconUrl is text/emoji or no iconUrl
  return (
    <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-lg sm:text-xl font-semibold flex-shrink-0">
      {gpt.iconUrl || (gpt.name ? gpt.name[0].toUpperCase() : "🤖")}
    </div>
  )
}

// GPT Card Component - Updated for click behavior and ownership controls
const GPTCard = ({
  gpt,
  onStartChat,
  onEdit,
  onDelete,
  showActions = false,
  isOwner = false,
}: {
  gpt: CustomGPT
  onStartChat: (gpt: CustomGPT) => void
  onEdit?: (gpt: CustomGPT) => void
  onDelete?: (gpt: CustomGPT) => void
  showActions?: boolean
  isOwner?: boolean
}) => {
  const [isLoadingChat, setIsLoadingChat] = useState(false)

  const handleStartChat = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsLoadingChat(true)
    try {
      await onStartChat(gpt)
    } catch (error) {
      console.error('Error starting chat:', error)
      toast.error('Failed to start chat')
    } finally {
      setIsLoadingChat(false)
    }
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onEdit) onEdit(gpt)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onDelete) onDelete(gpt)
  }

  return (
    <div className="bg-white dark:bg-card rounded-lg p-3 sm:p-4 md:p-6 hover:shadow-lg transition-shadow border border-border">
      <div className="flex items-start space-x-3 sm:space-x-4">
        <GPTAvatar gpt={gpt} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground mb-1 text-sm sm:text-base truncate">{gpt.name}</h3>
          <p className="text-muted-foreground text-xs sm:text-sm mb-2 sm:mb-3 line-clamp-2">{gpt.description}</p>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
            <div className="flex items-center flex-wrap gap-2 sm:gap-4 text-xs text-muted-foreground">
              <span className="truncate">By {gpt.creator?.name || 'Unknown'}</span>
              {gpt._count?.conversations && gpt._count.conversations > 0 && (
                <div className="flex items-center space-x-1 flex-shrink-0">
                  <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                  <span>4.5</span>
                </div>
              )}
              {gpt._count?.conversations && (
                <span className="flex-shrink-0">{gpt._count.conversations.toLocaleString()} users</span>
              )}
            </div>
            <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
              {isOwner && onEdit && (
                <button
                  onClick={handleEdit}
                  className="flex items-center px-2 sm:px-3 py-1 text-xs bg-muted hover:bg-muted/80 text-muted-foreground rounded-md sm:rounded-lg transition-colors flex-shrink-0"
                >
                  <Edit className="w-3 h-3 mr-1" />
                  <span className="hidden sm:inline">Edit</span>
                </button>
              )}
              {isOwner && onDelete && (
                <button
                  onClick={handleDelete}
                  className="flex items-center px-2 sm:px-3 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-600 rounded-md sm:rounded-lg transition-colors flex-shrink-0"
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              )}
              <button
                onClick={handleStartChat}
                disabled={isLoadingChat}
                className="flex items-center px-2 sm:px-3 py-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90 rounded-md sm:rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {isLoadingChat ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  'Chat'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Category Navigation Component
const CategoryNav = ({ selectedCategory, onSelectCategory }: {
  selectedCategory: string,
  onSelectCategory: (category: string) => void
}) => (
  <nav className="flex flex-wrap gap-1.5 sm:gap-2 lg:gap-3 mb-6 sm:mb-8 overflow-x-auto scrollbar-hide">
    {categories.map((category) => (
      <Button
        key={category.name}
        variant={selectedCategory === category.name ? "default" : "outline"}
        onClick={() => onSelectCategory(category.name)}
        className={cn(
          "px-2.5 sm:px-3 md:px-4 py-1.5 sm:py-2 text-xs sm:text-sm rounded-full transition-all duration-200 flex-shrink-0 whitespace-nowrap",
          selectedCategory === category.name
            ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
            : "border-border bg-card text-muted-foreground hover:bg-muted hover:border-muted-foreground"
        )}
      >
        {category.icon && <span className="mr-1 sm:mr-2 flex-shrink-0">{category.icon}</span>}
        <span className="truncate">{category.name}</span>
      </Button>
    ))}
  </nav>
)

export default function GPTsPage() {
  const { user } = useAuth()
  const { selectChat } = useChat()
  const router = useRouter()

  // State management
  const [gpts, setGpts] = useState<CustomGPT[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("All")
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [selectedGPT, setSelectedGPT] = useState<CustomGPT | null>(null)

  // Debounced search query
  const debouncedSearchQuery = useDebounce(searchQuery, 500)

  // Fetch GPTs based on filters
  const fetchGPTs = useCallback(async () => {
    setLoading(true)
    try {
      const filters: GPTFilters = {
        search: debouncedSearchQuery || undefined,
        category: selectedCategory !== "All" && selectedCategory !== "Trending" ? selectedCategory : undefined,
        visibility: "all"
      }

      console.log('Fetching GPTs with filters:', filters)
      let fetchedGPTs = await gptsService.getGPTs(filters)

      // Simulate "Trending" by sorting by conversations
      if (selectedCategory === "Trending") {
        fetchedGPTs = fetchedGPTs
          .sort((a, b) => (b._count?.conversations || 0) - (a._count?.conversations || 0))
          .slice(0, 12)
      }

      setGpts(fetchedGPTs)
    } catch (error) {
      console.error('Error fetching GPTs:', error)
      toast.error('Failed to load GPTs')
    } finally {
      setLoading(false)
    }
  }, [debouncedSearchQuery, selectedCategory])

  // Initial load and when filters change
  useEffect(() => {
    fetchGPTs()
  }, [fetchGPTs])

  // Update the handleStartChat function
  const handleStartChat = async (gpt: CustomGPT) => {
    console.log('Starting chat with GPT:', gpt)
    try {
      const chat = await gptsService.startChatWithGPT(gpt.id)
      console.log('Started chat:', chat)

      router.push(`/chat?id=${chat.id}`)
      localStorage.setItem('currentChatId', chat.id)

      selectChat(chat.id)

      toast.success(`Started chat with ${gpt.name}`)
    } catch (error: any) {
      console.error('Error starting chat:', error)
      toast.error(error.message || 'Failed to start chat')
    }
  }

  const handleEdit = (gpt: CustomGPT) => {
    router.push(`/gpts/create?edit=${gpt.id}`)
  }

  const handleDelete = async (gpt: CustomGPT) => {
    const confirmed = await new Promise((resolve) => {
      resolve(window.confirm(`Are you sure you want to delete "${gpt.name}"? This action cannot be undone.`))
    })

    if (!confirmed) return

    try {
      await gptsService.deleteGPT(gpt.id)
      setGpts(gpts.filter(g => g.id !== gpt.id))
      toast.success('GPT deleted successfully')
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete GPT')
    }
  }

  const handleShare = (gpt: CustomGPT) => {
    setSelectedGPT(gpt)
    setShareDialogOpen(true)
  }

  const copyShareLink = () => {
    if (selectedGPT) {
      const shareUrl = gptsService.getShareUrl(selectedGPT.shareId)
      navigator.clipboard.writeText(shareUrl)
      toast.success('Share link copied to clipboard!')
    }
  }

  const handleCreateNew = () => {
    router.push('/gpts/create')
  }

  // Filter GPTs based on category and search
  const getDisplayGPTs = () => {
    let filtered = gpts

    // Sort: Featured first, then by creation date
    filtered = filtered.sort((a, b) => {
      if (a.isFeatured && !b.isFeatured) return -1
      if (!a.isFeatured && b.isFeatured) return 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })

    return filtered
  }

  const allDisplayGPTs = getDisplayGPTs()
  const userOwnedGPTs = allDisplayGPTs.filter(gpt => gpt.creator?.id === user?.id)

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="h-full w-full px-3 sm:px-4 md:px-6 lg:px-8 py-4 md:py-6 lg:py-8 max-w-7xl mx-auto">
        {/* Header and Create Button */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 sm:gap-3">
              <SidebarTrigger className="md:hidden" />
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold flex items-center gap-2 text-foreground">
                <Bot className="h-5 w-5 sm:h-6 sm:w-6 text-primary flex-shrink-0" />
                <span className="truncate">GPTs Store</span>
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 line-clamp-2 ml-0 sm:ml-0">
              Discover and create custom AI assistants for any task
            </p>
          </div>

          <Button
            onClick={handleCreateNew}
            className="h-8 sm:h-9 px-3 sm:px-4 text-xs sm:text-sm bg-primary hover:bg-primary/90 text-primary-foreground shadow transition-transform hover:scale-[1.01] flex-shrink-0 w-full sm:w-auto"
          >
            <Plus className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
            Create New GPT
          </Button>
        </div>

        {/* Search and Categories */}
        <div className="mb-6 sm:mb-8 lg:mb-10">
          <div className="relative mb-4 sm:mb-6">
            <Search className="absolute left-3 sm:left-4 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
            <Input
              placeholder="Search for GPTs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 sm:pl-12 pr-3 sm:pr-4 py-2.5 sm:py-3 text-sm sm:text-base rounded-full border-border bg-card shadow-sm focus-visible:ring-offset-background"
            />
          </div>

          <CategoryNav selectedCategory={selectedCategory} onSelectCategory={setSelectedCategory} />
        </div>

        {/* User's GPTs Section (only if user has GPTs) */}
        {userOwnedGPTs.length > 0 && (
          <section className="mb-8 sm:mb-10 lg:mb-12">
            <div className="mb-4 sm:mb-6">
              <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold text-foreground">Your GPTs</h2>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
              {userOwnedGPTs.slice(0, 3).map((gpt) => (
                <GPTCard
                  key={`user-${gpt.id}`}
                  gpt={gpt}
                  onStartChat={handleStartChat}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  showActions={true}
                  isOwner={true}
                />
              ))}
            </div>
          </section>
        )}

        {/* All GPTs / Category Results */}
        <section className="mb-8 sm:mb-10 lg:mb-12">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 mb-4 sm:mb-6">
            <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold text-foreground">
              {selectedCategory === "All"
                ? "Discover GPTs"
                : selectedCategory === "Trending"
                  ? "Trending GPTs"
                  : `${selectedCategory} GPTs`}
            </h2>
            <p className="text-muted-foreground text-xs sm:text-sm">
              {allDisplayGPTs.length} GPT{allDisplayGPTs.length !== 1 ? 's' : ''}
            </p>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="bg-white dark:bg-card rounded-lg p-3 sm:p-4 md:p-6 border border-border">
                  <div className="animate-pulse">
                    <div className="flex items-start space-x-3 sm:space-x-4">
                      <div className="w-10 h-10 sm:w-12 sm:h-12 bg-muted rounded-full flex-shrink-0"></div>
                      <div className="flex-1 min-w-0">
                        <div className="h-3 sm:h-4 bg-muted rounded mb-2 w-3/4"></div>
                        <div className="h-2.5 sm:h-3 bg-muted rounded mb-2"></div>
                        <div className="h-2.5 sm:h-3 bg-muted rounded w-1/2"></div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : allDisplayGPTs.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
              {allDisplayGPTs.map((gpt) => (
                <GPTCard
                  key={gpt.id}
                  gpt={gpt}
                  onStartChat={handleStartChat}
                  onEdit={gpt.creator?.id === user?.id ? handleEdit : undefined}
                  onDelete={gpt.creator?.id === user?.id ? handleDelete : undefined}
                  showActions={gpt.creator?.id === user?.id}
                  isOwner={gpt.creator?.id === user?.id}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 sm:py-12 lg:py-16 px-4">
              <Bot className="h-12 w-12 sm:h-16 sm:w-16 text-muted-foreground mx-auto mb-4 sm:mb-6" />
              <h3 className="text-lg sm:text-xl lg:text-2xl font-semibold mb-2 sm:mb-3 text-foreground">
                {debouncedSearchQuery ? "No GPTs found" : `No GPTs in "${selectedCategory}"`}
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto leading-relaxed text-sm sm:text-base">
                {debouncedSearchQuery
                  ? "Try adjusting your search terms or exploring different categories."
                  : "It looks a little empty here! Be the first to create a GPT in this category and share your innovation."
                }
              </p>
              {!debouncedSearchQuery && (selectedCategory === "All" || selectedCategory === "Trending") && (
                <Button onClick={handleCreateNew} className="mt-6 sm:mt-8 h-9 sm:h-10 px-4 sm:px-5 text-sm sm:text-base">
                  <Plus className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                  Create Your First GPT
                </Button>
              )}
            </div>
          )}
        </section>

        {/* Share Dialog */}
        <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
          <DialogContent className="bg-card border-border p-4 sm:p-6 rounded-lg shadow-xl max-w-md sm:max-w-lg mx-auto">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-lg sm:text-xl lg:text-2xl font-bold text-foreground">Share GPT</DialogTitle>
              <DialogDescription className="text-muted-foreground text-sm sm:text-base">
                Share "<strong>{selectedGPT?.name}</strong>" with others.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 sm:space-y-4">
              <label htmlFor="share-link" className="text-xs sm:text-sm font-medium text-foreground">Shareable Link</label>
              <div className="flex items-center gap-2">
                <Input
                  id="share-link"
                  value={selectedGPT ? gptsService.getShareUrl(selectedGPT.shareId) : ''}
                  readOnly
                  className="flex-1 bg-muted/50 border-border text-foreground text-xs sm:text-sm h-9 sm:h-10"
                />
                <Button onClick={copyShareLink} size="icon" className="h-9 w-9 sm:h-10 sm:w-10 shrink-0">
                  <Copy className="h-3 w-3 sm:h-4 sm:w-4" />
                  <span className="sr-only">Copy link</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Anyone with this link can use your GPT if its visibility is set to Public or Unlisted.
              </p>
            </div>
            <DialogFooter className="mt-4 sm:mt-6">
              <Button 
                type="button" 
                variant="secondary" 
                onClick={() => setShareDialogOpen(false)}
                className="w-full sm:w-auto text-sm"
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
