const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { sendEmail } = require('../services/email.service')
const { addDays, format } = require('date-fns')
const { v4: uuidv4 } = require('uuid')

const prisma = new PrismaClient()

router.get('/', async (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query
  const where = { businessId: req.businessId }
  if (status) where.status = status.toUpperCase()
  if (search) where.OR = [
    { customerName: { contains: search, mode: 'insensitive' } },
    { quoteNumber: { contains: search, mode: 'insensitive' } }
  ]
  try {
    const [quotes, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.quote.count({ where })
    ])
    res.json({ quotes: quotes.map(q => ({ ...q, expiresAt: q.validUntil })), total })
  } catch (err) { res.status(500).json({ error: 'Failed to load quotes' }) }
})

router.get('/:id', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    res.json({ quote })
  } catch (err) { res.status(500).json({ error: 'Failed to load quote' }) }
})

router.post('/', async (req, res) => {
  const business = req.user.business
  const { customerName, customerEmail, customerPhone, customerAddress, jobDescription, lineItems, notes, validDays = 30, showLineItems = true, customerId } = req.body

  try {
    const subtotalCents = (lineItems || []).reduce((sum, i) => sum + Math.round(i.quantity * i.unitPriceCents), 0)
    const gstCents = business.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
    const totalCents = subtotalCents + gstCents

    // Get next quote number (reuse invoice counter with Q prefix)
    const quoteNumber = `QUO-${Date.now().toString().slice(-6)}`

    const quote = await prisma.quote.create({
      data: {
        businessId: req.businessId,
        customerId,
        quoteNumber,
        customerName,
        customerEmail,
        customerPhone,
        customerAddress,
        jobDescription,
        validUntil: addDays(new Date(), validDays),
        subtotalCents,
        gstCents,
        totalCents,
        notes,
        showLineItems,
        lineItems: {
          create: (lineItems || []).map((item, idx) => ({
            description: item.description,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            totalCents: Math.round(item.quantity * item.unitPriceCents),
            category: item.category || 'labor',
            sortOrder: idx
          }))
        }
      },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    res.status(201).json({ quote })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create quote' })
  }
})

router.post('/:id/send', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: true }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    const business = req.user.business

    if (quote.customerEmail) {
      const serverUrl = process.env.SERVER_URL || 'https://knockoff-server-production.up.railway.app'
      await sendEmail({
        to: quote.customerEmail,
        subject: `Quote from ${business.name} — $${(quote.totalCents / 100).toFixed(2)}`,
        template: 'quote',
        data: {
          quote,
          business,
          viewUrl: `${serverUrl}/quote/${quote.id}`,
          acceptUrl: `${serverUrl}/quote/${quote.id}/accept`,
          declineUrl: `${serverUrl}/quote/${quote.id}/decline`,
          validUntil: format(new Date(quote.validUntil), 'dd MMMM yyyy')
        }
      })
    }

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'SENT', sentAt: new Date() },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    res.json({ quote: updated })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send quote' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    const { lineItems, ...data } = req.body

    if (lineItems) {
      await prisma.quoteLineItem.deleteMany({ where: { quoteId: quote.id } })
      const subtotalCents = lineItems.reduce((sum, i) => sum + Math.round(i.quantity * i.unitPriceCents), 0)
      const gstCents = req.user.business.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
      const totalCents = subtotalCents + gstCents
      Object.assign(data, { subtotalCents, gstCents, totalCents,
        lineItems: { create: lineItems.map((item, idx) => ({
          description: item.description, quantity: item.quantity, unitPriceCents: item.unitPriceCents,
          totalCents: Math.round(item.quantity * item.unitPriceCents), category: item.category || 'labor', sortOrder: idx
        })) }
      })
    }

    const updated = await prisma.quote.update({ where: { id: quote.id }, data, include: { lineItems: { orderBy: { sortOrder: 'asc' } } } })
    res.json({ quote: updated })
  } catch (err) { res.status(500).json({ error: 'Failed to update quote' }) }
})

// Public: accept/decline quote (no auth)
router.post('/:id/accept', async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id } })
    if (!quote || quote.status === 'EXPIRED') return res.status(400).json({ error: 'Quote not valid' })

    await prisma.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } })
    await prisma.notification.create({
      data: {
        businessId: quote.businessId,
        type: 'quote_accepted',
        priority: 'info',
        title: '🎉 Quote Accepted',
        body: `${quote.customerName} accepted the quote for $${(quote.totalCents / 100).toFixed(2)}`,
        actionUrl: `/quotes/${quote.id}`
      }
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Failed to accept quote' }) }
})

router.post('/:id/decline', async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id } })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    await prisma.quote.update({ where: { id: quote.id }, data: { status: 'DECLINED', declinedAt: new Date() } })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Failed to decline quote' }) }
})

// POST /api/quotes/:id/follow-up — send follow-up reminder email
router.post('/:id/follow-up', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: true }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    if (!['SENT', 'VIEWED'].includes(quote.status)) return res.status(400).json({ error: 'Can only follow up on sent or viewed quotes' })

    const business = req.user.business
    const serverUrl = process.env.SERVER_URL || 'https://knockoff-server-production.up.railway.app'

    const followUpNum = !quote.followUp1SentAt ? 1 : !quote.followUp2SentAt ? 2 : 3
    const updateData = followUpNum === 1 ? { followUp1SentAt: new Date() }
      : followUpNum === 2 ? { followUp2SentAt: new Date() }
      : { followUp3SentAt: new Date() }

    if (quote.customerEmail) {
      await sendEmail({
        to: quote.customerEmail,
        subject: `Following up on your quote from ${business.name} — $${(quote.totalCents / 100).toFixed(2)}`,
        template: 'quote',
        data: {
          quote,
          business,
          viewUrl: `${serverUrl}/quote/${quote.id}`,
          acceptUrl: `${serverUrl}/quote/${quote.id}/accept`,
          declineUrl: `${serverUrl}/quote/${quote.id}/decline`,
          validUntil: format(new Date(quote.validUntil), 'dd MMMM yyyy'),
          isFollowUp: true,
          followUpNum
        }
      })
    }

    await prisma.quote.update({ where: { id: quote.id }, data: updateData })
    res.json({ success: true, followUpNum })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to send follow-up' })
  }
})

// POST /api/quotes/:id/convert — convert accepted quote to invoice
router.post('/:id/convert', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: true }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })

    const business = req.user.business

    const updatedBusiness = await prisma.business.update({
      where: { id: req.businessId },
      data: { nextInvoiceNumber: { increment: 1 } },
      select: { nextInvoiceNumber: true, invoicePrefix: true, paymentTermsDays: true }
    })
    const invoiceNumber = `${updatedBusiness.invoicePrefix || 'INV'}-${String(updatedBusiness.nextInvoiceNumber - 1).padStart(4, '0')}`

    const invoice = await prisma.invoice.create({
      data: {
        businessId: req.businessId,
        customerId: quote.customerId || undefined,
        invoiceNumber,
        publicViewToken: uuidv4(),
        customerName: quote.customerName,
        customerEmail: quote.customerEmail,
        customerPhone: quote.customerPhone,
        customerAddress: quote.customerAddress,
        subtotalCents: quote.subtotalCents,
        gstCents: quote.gstCents,
        totalCents: quote.totalCents,
        balanceDueCents: quote.totalCents,
        paymentTermsDays: updatedBusiness.paymentTermsDays || 7,
        dueDate: addDays(new Date(), updatedBusiness.paymentTermsDays || 7),
        notes: quote.notes,
        lineItems: {
          create: quote.lineItems.map((item, idx) => ({
            description: item.description,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            totalCents: item.totalCents,
            category: item.category || 'labor',
            sortOrder: idx
          }))
        }
      },
      include: { lineItems: true }
    })

    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'ACCEPTED', convertedToInvoiceId: invoice.id }
    })

    res.json({ invoice })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to convert quote to invoice' })
  }
})

// POST /api/quotes/:id/schedule-job — create a job from a quote
router.post('/:id/schedule-job', async (req, res) => {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })

    const { scheduledAt, durationMinutes = 120, notes: extraNotes } = req.body
    const business = req.user.business

    const [addressLine, suburb] = (quote.customerAddress || '').split(',').map(s => s.trim())

    const job = await prisma.job.create({
      data: {
        businessId: req.businessId,
        customerId: quote.customerId || undefined,
        customerName: quote.customerName,
        customerPhone: quote.customerPhone || business.phone || '',
        customerEmail: quote.customerEmail,
        address: addressLine || 'TBD',
        suburb: suburb || 'TBD',
        jobType: 'GENERAL',
        description: quote.jobDescription,
        notes: [quote.notes, extraNotes].filter(Boolean).join('\n') || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        durationMinutes: parseInt(durationMinutes) || 120,
        status: scheduledAt ? 'CONFIRMED' : 'PENDING'
      }
    })

    if (quote.status === 'ACCEPTED') {
      await prisma.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } })
    }

    res.json({ job })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to schedule job from quote' })
  }
})

module.exports = router
