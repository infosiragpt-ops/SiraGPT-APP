"use client"

import { Button } from "@/components/ui/button"
import { Bot, MessageSquare, Shield, Users } from "lucide-react"
import Link from "next/link"
import { ThemeToggle } from "@/components/theme-toggle"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { motion } from "framer-motion"

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i = 1) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.2, duration: 0.6, ease: "easeOut" },
  }),
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background antialiased">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 py-4 sm:flex-row">
          <motion.div
            className="flex items-center space-x-2"
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >

            <img
              src="/sira-gpt.png"
              alt="Icon"
              className="h-10 w-10 brightness-0 dark:brightness-0 dark:invert"
            />
            <h1 className="text-2xl font-bold">Sira Gpt</h1>
          </motion.div>
          <motion.div
            className="flex items-center space-x-4"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            {/* <Link href="/chat">
              <Button variant="outline">Try Free Chat (2)</Button>
            </Link> */}
            <ThemeToggle />
            <Link href="/auth/login">
              <Button variant="outline">Login</Button>
            </Link>
            <Link href="/auth/register">
              <Button>Get Started</Button>
            </Link>
          </motion.div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-4xl md:text-6xl font-bold mb-6"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={1}
          >
            AI-Powered Chat Platform
          </motion.h2>
          <motion.p
            className="text-xl text-muted-foreground mb-8"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={2}
          >
            Experience the future of AI conversation with multiple language models, advanced features, and seamless
            integration.
          </motion.p>
          <motion.div
            className="flex flex-col sm:flex-row gap-4 justify-center"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={3}
          >
            <Link href="/auth/register">
              <Button size="lg" className="w-full sm:w-auto">
                Start Chatting
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button variant="outline" size="lg" className="w-full sm:w-auto">
                Sign In
              </Button>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Features Section */}
      <section className="container mx-auto px-4 py-20 ">
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h3 className="text-3xl font-bold mb-4">Powerful Features</h3>
          <p className="text-muted-foreground">Everything you need for AI-powered conversations</p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8">
          {[
            { icon: MessageSquare, title: "Multi-Model Chat", desc: "Access GPT-4, Claude, and more in one platform" },
            { icon: Users, title: "User Management", desc: "Roles, permissions, and analytics included" },
            { icon: Shield, title: "Admin Dashboard", desc: "Manage users, models, and system settings" },
          ].map((feature, i) => (
            <motion.div
              key={i}
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i + 1}
              whileHover={{ scale: 1.05, rotate: 1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 200, damping: 10 }}
            >
              <Card className="shadow-md">
                <CardHeader>
                  <feature.icon className="h-12 w-12 text-primary mb-4" />
                  <CardTitle>{feature.title}</CardTitle>
                  <CardDescription>{feature.desc}</CardDescription>
                </CardHeader>
              </Card>
            </motion.div>

          ))}
        </div>
      </section>
    </div>
  )
}
