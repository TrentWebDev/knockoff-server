const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays } = require('date-fns')

const prisma = new PrismaClient()

// GET /api/dashboard — complete dashboard data
router.get('/', async (req, res) => {
  const businessId = req.businessId
  if (!businessId) return res.status(400).json({ error: 'No business profile found' })

  const today = new Date()
  const todayStart = startOfDay(today)
  const todayEnd = endOfDay(today)
  const weekStart = startOfWeek(today, { weekStartsOn: 1 })
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 })
  const monthStart = startOfMonth(today)
  const monthEnd = endOfMonth(today)

  try {
    const [
      todayJobs,
      weekJobs,
      pendingInvoices,
      overdueInvoices,
      openQuotes,
      recentConversations,
      unreadNotifications,
      recentPayments
    ] = await Promise.all([
      prisma.job.findMany({
        where: { businessId, scheduledAt: { gte: todayStart, lte: todayEnd }, status: { not: 'CANCELLED' } },
        orderBy: { scheduledAt: 'asc' },
        include: { customer: true }
      }),
      prisma.job.findMany({
        where: { businessId, scheduledAt: { gte: weekStart, lte: weekEnd }, status: { not: 'CANCELLED' } }
      }),
      prisma.invoice.findMany({
        where: { businessId, status: { in: ['SENT', 'VIEWED'] } },
        orderBy: { dueDate: 'asc' }
      }),
      prisma.invoice.findMany({
        where: { businessId, status: 'OVERDUE' },
        orderBy: { dueDate: 'asc' }
      }),
      prisma.quote.findMany({
        where: { businessId, status: { in: ['SENT', 'VIEWED'] } },
        orderBy: { sentAt: 'desc' }
      }),
      prisma.conversation.findMany({
        where: { businessId },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
      }),
      prisma.notification.count({
        where: { businessId, readAt: null }
      }),
      prisma.invoice.findMany({
        where: { businessId, status: 'PAID', paidAt: { gte: monthStart, lte: monthEnd } },
        orderBy: { paidAt: 'desc' },
        take: 20
      })
    ])

    const weekRevenue = weekJobs
      .filter(j => j.status === 'COMPLETED')
      .reduce((sum, j) => sum + (j.totalCents || 0), 0)

    const monthRevenue = recentPayments.reduce((sum, inv) => sum + (inv.paidAmountCents || inv.totalCents || 0), 0)

    const pendingTotal = pendingInvoices.reduce((sum, inv) => sum + (inv.balanceDueCents || 0), 0)
    const overdueTotal = overdueInvoices.reduce((sum, inv) => sum + (inv.balanceDueCents || 0), 0)
    const quotePipeline = openQuotes.reduce((sum, q) => sum + (q.totalCents || 0), 0)

    const hour = today.getHours()
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

    res.json({
      greeting,
      today: {
        date: today.toISOString(),
        jobs: todayJobs,
        jobCount: todayJobs.length,
        nextJob: todayJobs.find(j => j.scheduledAt > today) || todayJobs[0] || null
      },
      stats: {
        weekRevenue,
        monthRevenue,
        pendingTotal,
        overdueTotal,
        quotePipeline,
        pendingInvoicesCount: pendingInvoices.length,
        overdueInvoicesCount: overdueInvoices.length,
        openQuotesCount: openQuotes.length
      },
      pendingInvoices: pendingInvoices.slice(0, 5),
      overdueInvoices: overdueInvoices.slice(0, 5),
      openQuotes: openQuotes.slice(0, 5),
      recentConversations: recentConversations.slice(0, 5),
      unreadNotifications
    })
  } catch (err) {
    console.error('Dashboard error:', err)
    res.status(500).json({ error: 'Failed to load dashboard data' })
  }
})

module.exports = router
