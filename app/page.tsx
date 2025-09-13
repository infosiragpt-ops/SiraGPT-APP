import { Button } from "@/components/ui/button"
import { Bot, MessageSquare, Shield, Users } from "lucide-react"
import Link from "next/link"
import { ThemeToggle } from "@/components/theme-toggle"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Home() {
  return (
    <div className="min-h-screen bg-background antialiased">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Bot className="h-8 w-8 text-primary" />
            <h1 className="text-2xl font-bold">OpenWebUI</h1>
          </div>
          <div className="flex items-center space-x-4">
            <Link href="/chat">
              <Button variant="outline">Try Free Chat (5)</Button>
            </Link>
            <ThemeToggle />
            <Link href="/auth/login">
              <Button variant="outline">Login</Button>
            </Link>
            <Link href="/auth/register">
              <Button>Get Started</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-4xl md:text-6xl font-bold mb-6">AI-Powered Chat Platform</h2>
          <p className="text-xl text-muted-foreground mb-8">
            Experience the future of AI conversation with multiple language models, advanced features, and seamless
            integration.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/chat">
              <Button size="lg" className="w-full sm:w-auto">
                Start Chatting
              </Button>
            </Link>
            {/* <Link href="/auth/register">
              <Button size="lg" className="w-full sm:w-auto">
                Start Chatting
              </Button>
            </Link> */}
            <Link href="/auth/login">
              <Button variant="outline" size="lg" className="w-full sm:w-auto">
                Sign In
              </Button>
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Free guest usage: 5 messages • Upgrade anytime for history, files & advanced features.
          </p>
        </div>
      </section>
      {/* Features */}
      <section className="container mx-auto px-4 py-20 ">
        <div className="text-center mb-12">
          <h3 className="text-3xl font-bold mb-4">Powerful Features</h3>
          <p className="text-muted-foreground">Everything you need for AI-powered conversations</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <Card>
            <CardHeader>
              <MessageSquare className="h-12 w-12 text-primary mb-4" />
              <CardTitle>Multi-Model Chat</CardTitle>
              <CardDescription>
                Access multiple AI models including GPT-4, Claude, and more in one platform
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Users className="h-12 w-12 text-primary mb-4" />
              <CardTitle>User Management</CardTitle>
              <CardDescription>Complete user management system with roles, permissions, and analytics</CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Shield className="h-12 w-12 text-primary mb-4" />
              <CardTitle>Admin Dashboard</CardTitle>
              <CardDescription>
                Comprehensive admin panel for managing users, models, and system settings
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>


      {/* Footer */}
      {/* <footer className="border-t flex justify-end items-end h-20">
        <div className="container mx-auto px-4 py-8 text-center text-muted-foreground">
          <p>&copy; 2024 OpenWebUI Platform. All rights reserved.</p>
        </div>
      </footer> */}
    </div>
  )
}
