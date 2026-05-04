const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays, addDays } = require('date-fns')

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
    const tomorrowStart = startOfDay(addDays(today, 1))
    const sevenDaysEnd = endOfDay(addDays(today, 7))

    const [
      todayJobs,
      weekJobs,
      upcomingJobs,
      pendingInvoices,
      overdueInvoices,
      openQuotes,
      recentConversations,
      unreadNotifications,
      recentPayments,
      recentActivity
    ] = await Promise.all([
      prisma.job.findMany({
        where: { businessId, scheduledAt: { gte: todayStart, lte: todayEnd }, status: { not: 'CANCELLED' } },
        orderBy: { scheduledAt: 'asc' },
        include: { customer: true }
      }),
      prisma.job.findMany({
        where: { businessId, scheduledAt: { gte: weekStart, lte: weekEnd }, status: { not: 'CANCELLED' } }
      }),
      prisma.job.findMany({
        where: { businessId, scheduledAt: { gte: tomorrowStart, lte: sevenDaysEnd }, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
        orderBy: { scheduledAt: 'asc' },
        take: 8
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
      }),
      // Activity feed: mix recent events across entity types
      Promise.all([
        prisma.invoice.findMany({
          where: { businessId, status: 'PAID', paidAt: { gte: subDays(today, 14) } },
          orderBy: { paidAt: 'desc' }, take: 10,
          select: { id: true, invoiceNumber: true, customerName: true, paidAmountCents: true, totalCents: true, paidAt: true }
        }),
        prisma.job.findMany({
          where: { businessId, status: 'COMPLETED', completedAt: { gte: subDays(today, 14) } },
          orderBy: { completedAt: 'desc' }, take: 10,
          select: { id: true, customerName: true, jobType: true, completedAt: true, totalCents: true }
        }),
        prisma.quote.findMany({
          where: { businessId, status: 'ACCEPTED', acceptedAt: { gte: subDays(today, 14) } },
          orderBy: { acceptedAt: 'desc' }, take: 10,
          select: { id: true, customerName: true, totalCents: true, acceptedAt: true, convertedToInvoiceId: true }
        }),
        prisma.customer.findMany({
          where: { businessId, createdAt: { gte: subDays(today, 14) } },
          orderBy: { createdAt: 'desc' }, take: 5,
          select: { id: true, firstName: true, lastName: true, createdAt: true }
        })
      ]).then(([paidInvs, completedJobs, acceptedQuotes, newCustomers]) => {
        const events = [
          ...paidInvs.map(i => ({ type: 'payment', id: i.id, at: i.paidAt, title: `Payment received from ${i.customerName}`, amount: i.paidAmountCents || i.totalCents, link: `/invoices/${i.id}` })),
          ...completedJobs.map(j => ({ type: 'job_complete', id: j.id, at: j.completedAt, title: `Job completed for ${j.customerName}`, subtitle: j.jobType?.replace(/_/g, ' '), link: `/jobs/${j.id}` })),
          ...acceptedQuotes.map(q => ({ type: 'quote_accepted', id: q.id, at: q.acceptedAt, title: `Quote accepted by ${q.customerName}`, amount: q.totalCents, link: q.convertedToInvoiceId ? `/invoices/${q.convertedToInvoiceId}` : null })),
          ...newCustomers.map(c => ({ type: 'new_customer', id: c.id, at: c.createdAt, title: `New customer: ${c.firstName} ${c.lastName}`.trim(), link: `/customers/${c.id}` }))
        ]
        return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 15)
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
      upcomingJobs,
      recentConversations: recentConversations.slice(0, 5),
      unreadNotifications,
      recentActivity
    })
  } catch (err) {
    console.error('Dashboard error:', err)
    res.status(500).json({ error: 'Failed to load dashboard data' })
  }
})

module.exports = router
