import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { validateSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
                  request.cookies.get('auth-token')?.value

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await validateSession(token)
    if (!user || !user.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Get basic stats
    const [
      totalUsers,
      totalChats,
      totalMessages,
      totalPayments,
      totalApiUsage,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.chat.count(),
      prisma.message.count(),
      prisma.payment.count(),
      prisma.apiUsage.count(),
    ])

    // Get active users (users who have been active in the last 7 days)
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const activeUsers = await prisma.user.count({
      where: {
        updatedAt: {
          gte: lastWeek,
        },
      },
    })

    // Get revenue
    const revenue = await prisma.payment.aggregate({
      where: {
        status: 'COMPLETED',
      },
      _sum: {
        amount: true,
      },
    })

    // Get users by plan
    const usersByPlan = await prisma.user.groupBy({
      by: ['plan'],
      _count: {
        plan: true,
      },
    })

    // Get API usage by model
    const apiUsageByModel = await prisma.apiUsage.groupBy({
      by: ['model'],
      _sum: {
        tokens: true,
      },
      _count: {
        model: true,
      },
    })

    // Get monthly revenue
    const monthlyRevenue = await prisma.payment.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: {
          gte: new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000), // Last 12 months
        },
      },
      select: {
        amount: true,
        createdAt: true,
      },
    })

    // Group revenue by month
    const revenueByMonth = monthlyRevenue.reduce((acc, payment) => {
      const month = payment.createdAt.toISOString().slice(0, 7)
      acc[month] = (acc[month] || 0) + payment.amount
      return acc
    }, {} as Record<string, number>)

    return NextResponse.json({
      totalUsers,
      activeUsers,
      totalChats,
      totalMessages,
      totalPayments,
      totalApiUsage,
      totalRevenue: revenue._sum.amount || 0,
      usersByPlan: usersByPlan.reduce((acc, item) => {
        acc[item.plan] = item._count.plan
        return acc
      }, {} as Record<string, number>),
      apiUsageByModel: apiUsageByModel.map(item => ({
        model: item.model,
        tokens: item._sum.tokens || 0,
        count: item._count.model,
      })),
      revenueByMonth,
    })
  } catch (error) {
    console.error('Get analytics error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}