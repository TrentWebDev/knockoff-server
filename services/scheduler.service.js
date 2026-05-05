const { PrismaClient } = require('@prisma/client')
const { sendEmail } = require('./email.service')
const { sendSMS } = require('./sms.service')
const { format, addDays, isAfter, isBefore, differenceInDays } = require('date-fns')

const prisma = new PrismaClient()

function scheduleJobs() {
  // Run checks every hour
  setInterval(runScheduledTasks, 60 * 60 * 1000)
  // Run immediately on startup (with delay to let server boot)
  setTimeout(runScheduledTasks, 10000)
  console.log('Background scheduler started')
}

async function runScheduledTasks() {
  try {
    await Promise.all([
      checkOverdueInvoices(),
      expireOldQuotes(),
      sendInvoiceReminders(),
      sendQuoteFollowUps(),
      sendDailySummaries(),
      checkJobReminders()
    ])
  } catch (err) {
    console.error('Scheduler error:', err.message)
  }
}

async function checkOverdueInvoices() {
  const overdue = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'VIEWED'] },
      dueDate: { lt: new Date() }
    }
  })

  for (const inv of overdue) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: 'OVERDUE' }
    })
    await prisma.notification.create({
      data: {
        businessId: inv.businessId,
        type: 'invoice_overdue',
        priority: 'urgent',
        title: 'Invoice Overdue',
        body: `Invoice ${inv.invoiceNumber} for ${inv.customerName} ($${(inv.balanceDueCents / 100).toFixed(2)}) is now overdue`,
        actionUrl: `/invoices/${inv.id}`
      }
    })
  }
}

async function expireOldQuotes() {
  const now = new Date()
  await prisma.quote.updateMany({
    where: {
      status: { in: ['SENT', 'VIEWED', 'DRAFT'] },
      validUntil: { lt: now }
    },
    data: { status: 'EXPIRED' }
  })
}

async function sendInvoiceReminders() {
  const now = new Date()
  const threeDaysFromNow = addDays(now, 3)

  // 3-day-before reminder
  const dueSoon = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'VIEWED'] },
      dueDate: { gte: now, lte: threeDaysFromNow },
      reminderSentAt: null
    },
    include: { business: true }
  })

  for (const inv of dueSoon) {
    if (inv.customerEmail) {
      try {
        const viewUrl3 = inv.publicViewToken ? `${process.env.CLIENT_URL}/invoice/${inv.publicViewToken}` : null
        await sendEmail({
          to: inv.customerEmail,
          subject: `Invoice ${inv.invoiceNumber} due in 3 days`,
          template: 'invoice-reminder',
          data: { invoice: inv, business: inv.business, daysOverdue: 0, viewUrl: viewUrl3 }
        })
        await prisma.invoice.update({ where: { id: inv.id }, data: { reminderSentAt: now } })
      } catch (e) {}
    }
  }

  // Overdue reminder (7 days past due)
  const sevenDaysOverdue = await prisma.invoice.findMany({
    where: {
      status: 'OVERDUE',
      dueDate: { lt: addDays(now, -7) },
      overdueSentAt: null
    },
    include: { business: true }
  })

  for (const inv of sevenDaysOverdue) {
    const daysOverdue = differenceInDays(now, new Date(inv.dueDate))
    if (inv.customerEmail) {
      try {
        const viewUrlOverdue = inv.publicViewToken ? `${process.env.CLIENT_URL}/invoice/${inv.publicViewToken}` : null
        await sendEmail({
          to: inv.customerEmail,
          subject: `Overdue: Invoice ${inv.invoiceNumber} — ${inv.business.name}`,
          template: 'invoice-reminder',
          data: { invoice: inv, business: inv.business, daysOverdue, viewUrl: viewUrlOverdue }
        })
        await prisma.invoice.update({ where: { id: inv.id }, data: { overdueSentAt: now } })
      } catch (e) {}
    }
  }
}

async function sendQuoteFollowUps() {
  const now = new Date()

  // Day 3 follow-up
  const day3 = await prisma.quote.findMany({
    where: {
      status: 'SENT',
      sentAt: { lte: addDays(now, -3), gte: addDays(now, -4) },
      followUp1SentAt: null
    },
    include: { business: true }
  })

  for (const quote of day3) {
    if (quote.customerEmail) {
      try {
        await sendEmail({
          to: quote.customerEmail,
          subject: `Quick question about your quote — ${quote.business.name}`,
          template: 'quote-followup',
          data: {
            quote,
            business: quote.business,
            message: `Hi ${quote.customerName.split(' ')[0]}, just checking if you had any questions about the quote I sent through. Happy to answer anything — no pressure at all.`,
            followUpNumber: 1
          }
        })
        await prisma.quote.update({ where: { id: quote.id }, data: { followUp1SentAt: now } })
      } catch (e) {}
    }
  }

  // Day 7 follow-up
  const day7 = await prisma.quote.findMany({
    where: {
      status: { in: ['SENT', 'VIEWED'] },
      sentAt: { lte: addDays(now, -7), gte: addDays(now, -8) },
      followUp2SentAt: null,
      followUp1SentAt: { not: null }
    },
    include: { business: true }
  })

  for (const quote of day7) {
    if (quote.customerEmail) {
      try {
        await sendEmail({
          to: quote.customerEmail,
          subject: `Still keen to help — ${quote.business.name}`,
          template: 'quote-followup',
          data: {
            quote,
            business: quote.business,
            message: `Hi ${quote.customerName.split(' ')[0]}, still happy to get this sorted for you. The quote is valid for another ${Math.max(0, differenceInDays(new Date(quote.validUntil), now))} days.`,
            followUpNumber: 2
          }
        })
        await prisma.quote.update({ where: { id: quote.id }, data: { followUp2SentAt: now, status: 'VIEWED' } })
      } catch (e) {}
    }
  }
}

async function sendDailySummaries() {
  const now = new Date()
  // Only run at 7am AEST (21:00 UTC previous day)
  if (now.getUTCHours() !== 21 || now.getUTCMinutes() > 5) return

  const businesses = await prisma.business.findMany({
    where: { subscriptionStatus: { in: ['active', 'trialing'] } },
    include: { users: { where: { role: 'OWNER' }, take: 1 } }
  })

  const todayStart = new Date(now.setHours(0, 0, 0, 0))
  const todayEnd = new Date(now.setHours(23, 59, 59, 999))

  for (const business of businesses) {
    const owner = business.users[0]
    if (!owner) continue

    const [jobs, pendingInvoices, openQuotes, overdueInvoices] = await Promise.all([
      prisma.job.findMany({ where: { businessId: business.id, scheduledAt: { gte: todayStart, lte: todayEnd }, status: { not: 'CANCELLED' } }, orderBy: { scheduledAt: 'asc' } }),
      prisma.invoice.findMany({ where: { businessId: business.id, status: { in: ['SENT', 'VIEWED'] } } }),
      prisma.quote.findMany({ where: { businessId: business.id, status: { in: ['SENT', 'VIEWED'] } } }),
      prisma.invoice.findMany({ where: { businessId: business.id, status: 'OVERDUE' } })
    ])

    const pendingRevenue = pendingInvoices.reduce((s, i) => s + i.balanceDueCents, 0)

    try {
      await sendEmail({
        to: owner.email,
        subject: `☀️ ${jobs.length} job${jobs.length !== 1 ? 's' : ''} today — Knock Off Daily Summary`,
        template: 'daily-summary',
        data: { business, jobs, pendingRevenue, overdueCount: overdueInvoices.length, quotesCount: openQuotes.length, firstName: owner.firstName }
      })
    } catch (e) {}
  }
}

async function checkJobReminders() {
  const now = new Date()
  // Use a 25-minute window centred on 2 hours from now so each job is only
  // caught once by the hourly scheduler (100–125 minutes away)
  const windowStart = new Date(now.getTime() + 100 * 60 * 1000)
  const windowEnd   = new Date(now.getTime() + 125 * 60 * 1000)

  const upcoming = await prisma.job.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED'] },
      scheduledAt: { gte: windowStart, lte: windowEnd },
      confirmationSentAt: { not: null }
    },
    include: { business: true }
  })

  for (const job of upcoming) {
    if (job.customerPhone) {
      try {
        await sendSMS({
          to: job.customerPhone,
          body: `Hi ${job.customerName.split(' ')[0]}, reminder: ${job.business.name} is coming for your ${job.jobType.replace(/_/g, ' ')} today at ${format(new Date(job.scheduledAt), 'h:mma')}. See you then!`,
          from: job.business.twilioPhoneNumber
        })
      } catch (e) {}
    }
  }
}

module.exports = { scheduleJobs }
