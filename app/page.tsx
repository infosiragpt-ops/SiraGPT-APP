// "use client"

// import { Button } from "@/components/ui/button"
// import { Bot, MessageSquare, Shield, Users } from "lucide-react"
// import Link from "next/link"
// import { ThemeToggle } from "@/components/theme-toggle"
// import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
// import { motion } from "framer-motion"

// const fadeUp = {
//   hidden: { opacity: 0, y: 30 },
//   visible: (i = 1) => ({
//     opacity: 1,
//     y: 0,
//     transition: { delay: i * 0.2, duration: 0.6, ease: "easeOut" },
//   }),
// }

// export default function Home() {
//   return (
//     <div className="min-h-screen bg-background antialiased">
//       {/* Header */}
//       <header className="border-b">
//         <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 py-4 sm:flex-row">
//           <motion.div
//             className="flex items-center space-x-2"
//             initial={{ opacity: 0, x: -50 }}
//             animate={{ opacity: 1, x: 0 }}
//             transition={{ duration: 0.6 }}
//           >

//             <img
//               src="/sira-gpt.png"
//               alt="Icon"
//               className="h-10 w-10 brightness-0 dark:brightness-0 dark:invert"
//             />
//             <h1 className="text-2xl font-bold">Sira Gpt</h1>
//           </motion.div>
//           <motion.div
//             className="flex items-center space-x-4"
//             initial={{ opacity: 0, x: 50 }}
//             animate={{ opacity: 1, x: 0 }}
//             transition={{ duration: 0.6 }}
//           >
//             {/* <Link href="/chat">
//               <Button variant="outline">Try Free Chat (2)</Button>
//             </Link> */}
//             <ThemeToggle />
//             <Link href="/auth/login">
//               <Button variant="outline">Login</Button>
//             </Link>
//             <Link href="/auth/register">
//               <Button>Get Started</Button>
//             </Link>
//           </motion.div>
//         </div>
//       </header>

//       {/* Hero Section */}
//       <section className="container mx-auto px-4 py-20 text-center">
//         <div className="max-w-3xl mx-auto">
//           <motion.h2
//             className="text-4xl md:text-6xl font-bold mb-6"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={1}
//           >
//             AI-Powered Chat Platform
//           </motion.h2>
//           <motion.p
//             className="text-xl text-muted-foreground mb-8"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={2}
//           >
//             Experience the future of AI conversation with multiple language models, advanced features, and seamless
//             integration.
//           </motion.p>
//           <motion.div
//             className="flex flex-col sm:flex-row gap-4 justify-center"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={3}
//           >
//             <Link href="/auth/register">
//               <Button size="lg" className="w-full sm:w-auto">
//                 Start Chatting
//               </Button>
//             </Link>
//             <Link href="/auth/login">
//               <Button variant="outline" size="lg" className="w-full sm:w-auto">
//                 Sign In
//               </Button>
//             </Link>
//           </motion.div>
//         </div>
//       </section>

//       {/* Features Section */}
//       <section className="container mx-auto px-4 py-20 ">
//         <motion.div
//           className="text-center mb-12"
//           initial={{ opacity: 0, y: 20 }}
//           whileInView={{ opacity: 1, y: 0 }}
//           transition={{ duration: 0.6 }}
//         >
//           <h3 className="text-3xl font-bold mb-4">Powerful Features</h3>
//           <p className="text-muted-foreground">Everything you need for AI-powered conversations</p>
//         </motion.div>

//         <div className="grid md:grid-cols-3 gap-8">
//           {[
//             { icon: MessageSquare, title: "Multi-Model Chat", desc: "Access GPT-4, Claude, and more in one platform" },
//             { icon: Users, title: "User Management", desc: "Roles, permissions, and analytics included" },
//             { icon: Shield, title: "Admin Dashboard", desc: "Manage users, models, and system settings" },
//           ].map((feature, i) => (
//             <motion.div
//               key={i}
//               variants={fadeUp}
//               initial="hidden"
//               whileInView="visible"
//               viewport={{ once: true }}
//               custom={i + 1}
//               whileHover={{ scale: 1.05, rotate: 1 }}
//               whileTap={{ scale: 0.98 }}
//               transition={{ type: "spring", stiffness: 200, damping: 10 }}
//             >
//               <Card className="shadow-md">
//                 <CardHeader>
//                   <feature.icon className="h-12 w-12 text-primary mb-4" />
//                   <CardTitle>{feature.title}</CardTitle>
//                   <CardDescription>{feature.desc}</CardDescription>
//                 </CardHeader>
//               </Card>
//             </motion.div>

//           ))}
//         </div>
//       </section>
//     </div>
//   )
// }

// "use client"

// import { Button } from "@/components/ui/button"
// import { Bot, MessageSquare, Shield, Users } from "lucide-react"
// import Link from "next/link"
// import { ThemeToggle } from "@/components/theme-toggle"
// import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
// import { motion } from "framer-motion"

// const fadeUp = {
//   hidden: { opacity: 0, y: 30 },
//   visible: (i = 1) => ({
//     opacity: 1,
//     y: 0,
//     transition: { delay: i * 0.2, duration: 0.6, ease: "easeOut" },
//   }),
// }

// export default function Home() {
//   return (
//     <div className="min-h-screen bg-background antialiased">
//       {/* Header */}
//       <header className="border-b">
//         <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 py-4 sm:flex-row">
//           <motion.div
//             className="flex items-center space-x-2"
//             initial={{ opacity: 0, x: -50 }}
//             animate={{ opacity: 1, x: 0 }}
//             transition={{ duration: 0.6 }}
//           >

//             <img
//               src="/sira-gpt.png"
//               alt="Icon"
//               className="h-10 w-10 brightness-0 dark:brightness-0 dark:invert"
//             />
//             <h1 className="text-2xl font-bold">Sira Gpt</h1>
//           </motion.div>
//           <motion.div
//             className="flex items-center space-x-4"
//             initial={{ opacity: 0, x: 50 }}
//             animate={{ opacity: 1, x: 0 }}
//             transition={{ duration: 0.6 }}
//           >
//             {/* <Link href="/chat">
//               <Button variant="outline">Try Free Chat (2)</Button>
//             </Link> */}
//             <ThemeToggle />
//             <Link href="/auth/login">
//               <Button variant="outline">Login</Button>
//             </Link>
//             <Link href="/auth/register">
//               <Button>Get Started</Button>
//             </Link>
//           </motion.div>
//         </div>
//       </header>

//       {/* Hero Section */}
//       <section className="container mx-auto px-4 py-20 text-center">
//         <div className="max-w-3xl mx-auto">
//           <motion.h2
//             className="text-4xl md:text-6xl font-bold mb-6"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={1}
//           >
//             AI-Powered Chat Platform
//           </motion.h2>
//           <motion.p
//             className="text-xl text-muted-foreground mb-8"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={2}
//           >
//             Experience the future of AI conversation with multiple language models, advanced features, and seamless
//             integration.
//           </motion.p>
//           <motion.div
//             className="flex flex-col sm:flex-row gap-4 justify-center"
//             variants={fadeUp}
//             initial="hidden"
//             animate="visible"
//             custom={3}
//           >
//             <Link href="/auth/register">
//               <Button size="lg" className="w-full sm:w-auto">
//                 Start Chatting
//               </Button>
//             </Link>
//             <Link href="/auth/login">
//               <Button variant="outline" size="lg" className="w-full sm:w-auto">
//                 Sign In
//               </Button>
//             </Link>
//           </motion.div>
//         </div>
//       </section>

//       {/* Features Section */}
//       <section className="container mx-auto px-4 py-20 ">
//         <motion.div
//           className="text-center mb-12"
//           initial={{ opacity: 0, y: 20 }}
//           whileInView={{ opacity: 1, y: 0 }}
//           transition={{ duration: 0.6 }}
//         >
//           <h3 className="text-3xl font-bold mb-4">Powerful Features</h3>
//           <p className="text-muted-foreground">Everything you need for AI-powered conversations</p>
//         </motion.div>

//         <div className="grid md:grid-cols-3 gap-8">
//           {[
//             { icon: MessageSquare, title: "Multi-Model Chat", desc: "Access GPT-4, Claude, and more in one platform" },
//             { icon: Users, title: "User Management", desc: "Roles, permissions, and analytics included" },
//             { icon: Shield, title: "Admin Dashboard", desc: "Manage users, models, and system settings" },
//           ].map((feature, i) => (
//             <motion.div
//               key={i}
//               variants={fadeUp}
//               initial="hidden"
//               whileInView="visible"
//               viewport={{ once: true }}
//               custom={i + 1}
//               whileHover={{ scale: 1.05, rotate: 1 }}
//               whileTap={{ scale: 0.98 }}
//               transition={{ type: "spring", stiffness: 200, damping: 10 }}
//             >
//               <Card className="shadow-md">
//                 <CardHeader>
//                   <feature.icon className="h-12 w-12 text-primary mb-4" />
//                   <CardTitle>{feature.title}</CardTitle>
//                   <CardDescription>{feature.desc}</CardDescription>
//                 </CardHeader>
//               </Card>
//             </motion.div>

//           ))}
//         </div>
//       </section>
//     </div>
//   )
// }


"use client"

import { Button } from "@/components/ui/button"
import { MessageSquare, Shield, Users, Sparkles, Zap, Globe, Moon, Sun, ArrowRight, Code, Rocket, Star, Brain, Terminal, Cpu, CheckCircle, Play, Mic, Image as ImageIcon, Video, Palette, Check, X, Crown } from "lucide-react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { motion, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion"
import { useState, useEffect, useRef } from "react"
import { ThemeToggle } from "@/components/theme-toggle"
import { LiquidButton } from "@/components/LiquidButton"

const GlobalStyles = () => (
  <style jsx global>{`
    /* Hide scrollbar for Chrome, Safari and Opera */
    ::-webkit-scrollbar {
      display: none;
    }

    /* Hide scrollbar for IE, Edge and Firefox */
    body {
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }
  `}</style>
)

// 3D Background Canvas Component
const Background3D = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let animationFrameId: number
    let particles: Particle[] = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    class Particle {
      x: number
      y: number
      z: number
      vx: number
      vy: number
      vz: number

      constructor() {
        this.x = Math.random() * (canvas?.width ?? 0)
        this.y = Math.random() * (canvas?.height ?? 0)
        this.z = Math.random() * 1000
        this.vx = (Math.random() - 0.5) * 0.5
        this.vy = (Math.random() - 0.5) * 0.5
        this.vz = Math.random() * 0.5 + 0.5
      }

      update() {
        this.x += this.vx
        this.y += this.vy
        this.z -= this.vz

        if (this.z <= 0) {
          this.z = 1000
          this.x = Math.random() * (canvas?.width ?? 0)
          this.y = Math.random() * (canvas?.height ?? 0)
        }

        if (this.x < 0 || this.x > (canvas?.width ?? 0)) this.vx *= -1
        if (this.y < 0 || this.y > (canvas?.height ?? 0)) this.vy *= -1
      }

      draw() {
        if (!canvas || !ctx) return
        const scale = 1000 / (1000 + this.z)
        const x = (this.x - canvas.width / 2) * scale + canvas.width / 2
        const y = (this.y - canvas.height / 2) * scale + canvas.height / 2
        const size = scale * 2
        const opacity = (1000 - this.z) / 1000 * 0.5

        ctx.fillStyle = `rgba(99, 102, 241, ${opacity})`
        ctx.beginPath()
        ctx.arc(x, y, size, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    for (let i = 0; i < 100; i++) {
      particles.push(new Particle())
    }

    const animate = () => {
      if (!canvas || !ctx) return
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      particles.forEach((p, i) => {
        particles.slice(i + 1).forEach(p2 => {
          const dx = p.x - p2.x
          const dy = p.y - p2.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < 150) {
            const scale1 = 1000 / (1000 + p.z)
            const scale2 = 1000 / (1000 + p2.z)
            const x1 = (p.x - canvas.width / 2) * scale1 + canvas.width / 2
            const y1 = (p.y - canvas.height / 2) * scale1 + canvas.height / 2
            const x2 = (p2.x - canvas.width / 2) * scale2 + canvas.width / 2
            const y2 = (p2.y - canvas.height / 2) * scale2 + canvas.height / 2

            ctx.strokeStyle = `rgba(99, 102, 241, ${0.2 * (1 - dist / 150)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
          }
        })
      })

      particles.forEach(p => {
        p.update()
        p.draw()
      })

      animationFrameId = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animationFrameId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 -z-10"
      style={{ background: 'linear-gradient(to bottom, #000000, #0a0a0f)' }}
    />
  )
}

// Feature Row Component for Pricing
interface FeatureRowProps {
  icon: React.ReactNode
  title: string
  desc: string
  included: boolean
}

const FeatureRow = ({ icon, title, desc, included }: FeatureRowProps) => {
  return (
    <div className="flex items-start gap-3">
      <div className={`mt-0.5 ${included ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-600'}`}>
        {included ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className={included ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-600'}>{icon}</span>
          <span className={`font-medium ${included ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-600'}`}>{title}</span>
        </div>
        <div className={`text-xs mt-0.5 ${included ? 'text-gray-600 dark:text-gray-400' : 'text-gray-400 dark:text-gray-700'}`}>{desc}</div>
      </div>
    </div>
  )
}

export default function Home() {
  const { scrollYProgress } = useScroll()
  const heroY = useTransform(scrollYProgress, [0, 0.3], [0, 100])
  const heroOpacity = useTransform(scrollYProgress, [0, 0.3], [1, 0])

  const capabilities = [
    {
      icon: MessageSquare,
      title: "AI Chat",
      description: "GPT-4, Claude 3.5, Gemini Pro, and more",
      gradient: "from-blue-500 to-cyan-500",
      models: ["GPT-4 Turbo", "Claude 3.5 Sonnet", "Gemini Pro", "Llama 3"],
    },
    {
      icon: ImageIcon,
      title: "Image Generation",
      description: "DALL-E 3, Midjourney, Stable Diffusion",
      gradient: "from-purple-500 to-pink-500",
      models: ["DALL-E 3", "Midjourney v6", "Stable Diffusion XL"],
    },
    {
      icon: Mic,
      title: "Voice Synthesis",
      description: "ElevenLabs ultra-realistic voices",
      gradient: "from-green-500 to-emerald-500",
      models: ["ElevenLabs", "Google TTS", "Azure Speech"],
    },
    {
      icon: Video,
      title: "Video Generation",
      description: "Veo 3 and cutting-edge video AI",
      gradient: "from-orange-500 to-red-500",
      models: ["Veo 3", "Runway Gen-3", "Pika Labs"],
    },
  ]

  return (
    <>
      <GlobalStyles />
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-100 dark:from-black dark:to-gray-950 text-gray-900 dark:text-white overflow-x-hidden transition-all duration-500 ease-in-out">
        <div className="dark:block hidden">
          <Background3D />
        </div>

        {/* Header */}
        <header className="fixed top-0 w-full z-50 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl transition-all duration-500 ease-in-out will-change-auto">
          <div className="container mx-auto flex items-center justify-between px-6 py-4 relative">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <img
                src="/sira-gpt.png"
                alt="Sira GPT"
                className="h-10 w-10 dark:brightness-0 dark:invert"
              />
              <span className="text-xl font-bold text-gray-900 dark:text-white">Sira GPT</span>
            </motion.div>

            <motion.div
              className="flex items-center gap-3 relative z-[60]"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="relative">
                <ThemeToggle />
              </div>
              <LiquidButton variant="ghost" href="/auth/login">Login</LiquidButton>
              <LiquidButton href="/auth/register">Sign Up</LiquidButton>
            </motion.div>
          </div>
        </header>

        {/* Hero Section */}
        <motion.section
          style={{ y: heroY, opacity: heroOpacity }}
          className="container mx-auto px-6 pt-40 pb-24 relative"
        >
          <div className="max-w-5xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, duration: 0.8 }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 backdrop-blur-sm text-sm font-medium mb-8"
            >
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                All AI Models in One Platform
              </span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.8 }}
              className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6 leading-tight"
            >
              <span className="bg-gradient-to-r from-gray-900 to-gray-700 dark:from-white dark:via-gray-200 dark:to-gray-400 bg-clip-text text-transparent">
                Chat, Create,
              </span>
              <br />
              <span className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">
                Generate Anything
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.8 }}
              className="text-xl md:text-2xl text-gray-600 dark:text-gray-400 mb-12 max-w-3xl mx-auto leading-relaxed"
            >
              Access GPT-4, Claude, image generation, voice synthesis, and video creation. Choose your plan, use any AI model.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
              className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16"
            >
              <LiquidButton size="lg" href="/auth/register">
                <Rocket className="h-5 w-5" />
                Start Free Trial
              </LiquidButton>
              <LiquidButton variant="outline" size="lg" href="#pricing">
                View Pricing
              </LiquidButton>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              className="flex flex-wrap justify-center gap-8 text-sm text-gray-600 dark:text-gray-400"
            >
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span>No credit card required</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span>Cancel anytime</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span>50K+ active users</span>
              </div>
            </motion.div>
          </div>
        </motion.section>

        {/* Capabilities Section */}
        <section className="container mx-auto px-6 py-24">
          <div className="max-w-7xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="text-center mb-16"
            >
              <h2 className="text-4xl md:text-6xl font-bold mb-4 bg-gradient-to-r from-gray-900 to-gray-700 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">
                One Platform, Infinite Possibilities
              </h2>
              <p className="text-xl text-gray-600 dark:text-gray-400">Choose your AI, create anything</p>
            </motion.div>

            <div className="grid md:grid-cols-2 gap-6">
              {capabilities.map((capability, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                >
                  <div className="relative group h-full">
                    <div className={`absolute inset-0 bg-gradient-to-r ${capability.gradient} opacity-0 group-hover:opacity-20 rounded-3xl blur-xl transition-all duration-500`} />
                    <Card className="relative h-full bg-white/30 dark:bg-white/5 backdrop-blur-xl border border-gray-200/50 dark:border-white/10 hover:border-gray-300/70 dark:hover:border-white/30 hover:bg-white/40 dark:hover:bg-white/8 transition-all duration-300 p-8 shadow-lg hover:shadow-xl">
                      <div className="flex items-start gap-6">
                        <div className={`h-16 w-16 rounded-2xl bg-gradient-to-br ${capability.gradient} flex items-center justify-center flex-shrink-0 shadow-lg`}>
                          <capability.icon className="h-8 w-8 text-white" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-2xl font-bold mb-2 text-gray-900 dark:text-white">{capability.title}</h3>
                          <p className="text-gray-600 dark:text-gray-400 mb-4">{capability.description}</p>
                          <div className="flex flex-wrap gap-2">
                            {capability.models.map((model, idx) => (
                              <span
                                key={idx}
                                className="px-3 py-1 rounded-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-xs text-gray-700 dark:text-gray-300"
                              >
                                {model}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </Card>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <section id="pricing" className="container mx-auto px-6 py-24">
          <div className="max-w-7xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="text-center mb-16"
            >
              <h2 className="text-4xl md:text-6xl font-bold mb-4 bg-gradient-to-r from-gray-900 to-gray-700 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">
                Choose Your Package
              </h2>
              <p className="text-xl text-gray-600 dark:text-gray-400">Flexible pricing for every need</p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* FREE */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0 }}
                className="rounded-2xl p-8 bg-white/40 dark:bg-white/5 backdrop-blur-xl border border-gray-200/50 dark:border-white/10 shadow-lg min-h-[420px] flex flex-col transition-all duration-300 hover:shadow-xl hover:scale-[1.02] hover:bg-white/50 dark:hover:bg-white/8"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">FREE</h3>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">Basic access</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-gray-900 dark:text-white">Free</div>
                    <div className="text-xs text-gray-600 dark:text-gray-400">3 calls / month</div>
                  </div>
                </div>

                <div className="mt-6 space-y-3 text-sm flex-1">
                  <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Conversational assistant" included />
                  <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Basic web search" included />
                  <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Not included" included={false} />
                  <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Not included" included={false} />
                  <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Not included" included={false} />
                </div>

                <div className="mt-8 border-t border-gray-200 dark:border-white/10 pt-6 flex flex-col items-center gap-3">
                  <LiquidButton variant="ghost" disabled className="w-full">
                    Free (default)
                  </LiquidButton>
                  <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
                    Free tier is the default for new users
                  </div>
                </div>
              </motion.div>

              {/* BASIC */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 }}
                className="rounded-2xl p-8 bg-white/40 dark:bg-white/5 backdrop-blur-xl border border-gray-200/50 dark:border-white/10 shadow-lg min-h-[400px] flex flex-col transition-all duration-300 hover:shadow-xl hover:scale-[1.02] hover:bg-white/50 dark:hover:bg-white/8"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">BASIC</h3>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">GPT, Web, Image</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-gray-900 dark:text-white">$5</div>
                    <div className="text-xs text-gray-600 dark:text-gray-400">10,000 / month</div>
                  </div>
                </div>

                <div className="mt-6 space-y-3 text-sm flex-1">
                  <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Conversational assistant" included />
                  <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Integrated web results" included />
                  <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Included" included />
                  <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Not included" included={false} />
                  <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Not included" included={false} />
                </div>

                <div className="mt-8 border-t border-gray-200 dark:border-white/10 pt-6">
                  <LiquidButton className="w-full" href="/auth/register">
                    Subscribe
                  </LiquidButton>
                </div>
              </motion.div>

              {/* STANDARD */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 }}
                className="rounded-2xl p-8 bg-gradient-to-b from-indigo-500/10 to-purple-500/5 dark:from-indigo-500/20 dark:to-purple-500/10 backdrop-blur-xl border-2 border-indigo-400/30 dark:border-indigo-500/50 shadow-xl min-h-[400px] flex flex-col transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-500/30 hover:scale-[1.02] hover:bg-gradient-to-b hover:from-indigo-500/15 hover:to-purple-500/10 relative"
              >
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white px-4 py-1 rounded-full text-xs font-semibold shadow-lg">
                    Most Popular
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">STANDARD</h3>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">All features + ElevenLabs</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-gray-900 dark:text-white">$15</div>
                    <div className="text-xs text-gray-600 dark:text-gray-400">30,000 / month</div>
                  </div>
                </div>

                <div className="mt-6 space-y-3 text-sm flex-1">
                  <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Included" included />
                  <FeatureRow icon={<Globe className="h-5 w-5" />} title="Web search" desc="Included" included />
                  <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Image generation" desc="Included" included />
                  <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Included" included />
                  <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Included" included />
                </div>

                <div className="mt-8 border-t border-gray-200 dark:border-white/10 pt-6">
                  <LiquidButton className="w-full" href="/auth/register">
                    Subscribe
                  </LiquidButton>
                </div>
              </motion.div>

              {/* ENTERPRISE */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 }}
                className="rounded-2xl p-8 bg-gradient-to-b from-amber-500/10 to-yellow-500/5 dark:from-amber-500/15 dark:to-yellow-600/5 backdrop-blur-xl border border-amber-300/40 dark:border-amber-500/30 shadow-lg min-h-[400px] flex flex-col transition-all duration-300 hover:shadow-xl hover:shadow-amber-500/20 hover:scale-[1.02] hover:bg-gradient-to-b hover:from-amber-500/15 hover:to-yellow-500/10"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">ENTERPRISE</h3>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">All features, priority & SLAs</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-gray-900 dark:text-white">$99</div>
                    <div className="text-xs text-gray-600 dark:text-gray-400">100,000 / month</div>
                  </div>
                </div>

                <div className="mt-6 space-y-3 text-sm flex-1">
                  <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Included" included />
                  <FeatureRow icon={<Video className="h-5 w-5" />} title="Video generation" desc="Included" included />
                  <FeatureRow icon={<Mic className="h-5 w-5" />} title="Advanced audio & music" desc="Included" included />
                  <FeatureRow icon={<Globe className="h-5 w-5" />} title="Priority & SLAs" desc="Included" included />
                  <FeatureRow icon={<Crown className="h-5 w-5" />} title="Unlimited calls" desc="Included" included />
                </div>

                <div className="mt-8 border-t border-gray-200 dark:border-white/10 pt-6">
                  <LiquidButton className="w-full" href="/auth/register">
                    Subscribe
                  </LiquidButton>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="container mx-auto px-6 py-32">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="max-w-5xl mx-auto relative"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/30 to-purple-500/30 rounded-3xl blur-3xl" />
            <div className="relative bg-white/80 dark:bg-white/5 backdrop-blur-xl border border-gray-200 dark:border-white/20 rounded-3xl p-12 md:p-16 text-center">
              <h2 className="text-4xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-gray-900 to-gray-700 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
                Ready to Create?
              </h2>
              <p className="text-xl text-gray-600 dark:text-gray-400 mb-10 max-w-2xl mx-auto">
                Start with our free plan. Upgrade anytime to unlock advanced AI models and features.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <LiquidButton size="lg" href="/auth/register">
                  Start Free Now
                  <ArrowRight className="h-5 w-5" />
                </LiquidButton>
                <LiquidButton variant="outline" size="lg" href="#pricing">
                  Compare Plans
                </LiquidButton>
              </div>
            </div>
          </motion.div>
        </section>

        {/* Footer */}
        <footer className="border-t border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl transition-all duration-500 ease-in-out">
          <div className="container mx-auto px-6 py-6">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6">
              <div className="flex items-center gap-3">
                <img
                  src="/sira-gpt.png"
                  alt="Sira GPT"
                  className="h-8 w-8 brightness-0 dark:brightness-0 dark:invert"
                />
                <span className="font-semibold text-gray-700 dark:text-white">
                  Sira GPT
                </span>
                {/* <span className="font-semibold text-gray-300">Sira GPT</span> */}
              </div>
              <div className="font-semibold text-gray-700 dark:text-white">
                © 2025 Sira GPT. All AI models in one place.
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  )
}