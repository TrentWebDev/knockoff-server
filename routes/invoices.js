const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { body, validationResult } = require('express-validator')
const { generateInvoicePDF } = require('../services/invoice.service')
const { sendEmail } = require('../services/email.service')
const { sendSMS } = require('../services/sms.service')
const { createStripePaymentLink } = require('../services/stripe.service')
const { addDays, format } = require('date-fns')
const audit = require('../services/audit.service')
const { v4: uuidv4 } = require('uuid')

const prisma = new PrismaClient()

// GET /api/invoices
router.get('/', async (req, res) => {
  const { status, page = 1, limit = 20, search } = req.query
  const businessId = req.businessId
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { businessId }
  if (status) where.status = status.toUpperCase()
  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: 'insensitive' } },
      { invoiceNumber: { contains: search, mode: 'insensitive' } }
    ]
  }

  try {
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.invoice.count({ where })
    ])
    res.json({ invoices, total, pages: Math.ceil(total / parseInt(limit)) })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoices' })
  }
})

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } }, job: true }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    const business = await prisma.business.findUnique({ where: { id: req.businessId }, select: { paymentTermsDays: true } })
    res.json({ invoice: { ...invoice, paymentTermsDays: business?.paymentTermsDays || 7 } })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice' })
  }
})

// POST /api/invoices/bulk-remind — send payment reminders to all OVERDUE invoices
router.post('/bulk-remind', async (req, res) => {
  const business = req.user.business
  try {
    const overdueInvoices = await prisma.invoice.findMany({
      where: { businessId: req.businessId, status: 'OVERDUE' }
    })

    let sent = 0
    for (const invoice of overdueInvoices) {
      try {
        if (invoice.customerEmail) {
          await sendEmail({
            to: invoice.customerEmail,
            subject: `Payment reminder: Invoice ${invoice.invoiceNumber}`,
            template: 'invoice-reminder',
            data: {
              invoice,
              business,
              daysOverdue: Math.floor((Date.now() - new Date(invoice.dueDate).getTime()) / 86400000)
            }
          })
        }
        if (invoice.customerPhone) {
          await sendSMS({
            to: invoice.customerPhone,
            body: `Hi ${invoice.customerName.split(' ')[0]}, just a reminder that invoice ${invoice.invoiceNumber} for $${(invoice.balanceDueCents / 100).toFixed(2)} from ${business.name} is overdue. Please get in touch.`,
            from: business.twilioPhoneNumber
          })
        }
        await prisma.invoice.update({ where: { id: invoice.id }, data: { reminderSentAt: new Date() } })
        sent++
      } catch (e) {
        console.warn(`Failed to remind invoice ${invoice.id}:`, e.message)
      }
    }

    res.json({ sent, total: overdueInvoices.length })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send bulk reminders' })
  }
})

// POST /api/invoices — create invoice
router.post('/', [
  body('customerName').trim().notEmpty(),
  body('lineItems').isArray({ min: 1 }),
  body('lineItems.*.description').notEmpty(),
  body('lineItems.*.quantity').isNumeric(),
  body('lineItems.*.unitPriceCents').isInt({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const businessId = req.businessId
  const business = req.user.business
  const {
    customerName, customerEmail, customerPhone, customerAddress,
    jobId, customerId, lineItems, notes, depositCents, voiceTranscript
  } = req.body

  try {
    // Get next invoice number
    const updatedBusiness = await prisma.business.update({
      where: { id: businessId },
      data: { nextInvoiceNumber: { increment: 1 } },
      select: { nextInvoiceNumber: true, invoicePrefix: true, paymentTermsDays: true }
    })
    const invoiceNumber = `${updatedBusiness.invoicePrefix}-${String(updatedBusiness.nextInvoiceNumber - 1).padStart(4, '0')}`

    // Calculate totals
    const subtotalCents = lineItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPriceCents), 0)
    const gstCents = business.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
    const totalCents = subtotalCents + gstCents
    const deposit = depositCents || 0
    const balanceDueCents = totalCents - deposit
    const dueDate = addDays(new Date(), updatedBusiness.paymentTermsDays)

    const invoice = await prisma.invoice.create({
      data: {
        businessId,
        customerId,
        jobId,
        invoiceNumber,
        customerName,
        customerEmail,
        customerPhone,
        customerAddress,
        dueDate,
        subtotalCents,
        gstCents,
        totalCents,
        depositCents: deposit,
        balanceDueCents,
        notes,
        voiceTranscript,
        publicViewToken: uuidv4(),
        lineItems: {
          create: lineItems.map((item, idx) => ({
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

    await audit.log({
      businessId, entityType: 'invoice', entityId: invoice.id,
      action: 'created', description: `Invoice ${invoice.invoiceNumber} created`,
      userId: req.user.id, userEmail: req.user.email
    })

    res.status(201).json({ invoice })
  } catch (err) {
    console.error('Create invoice error:', err)
    res.status(500).json({ error: 'Failed to create invoice' })
  }
})

// PUT /api/invoices/:id — update invoice
router.put('/:id', async (req, res) => {
  const { lineItems, ...data } = req.body
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    if (invoice.status === 'PAID') return res.status(400).json({ error: 'Cannot edit a paid invoice' })

    const updateData = { ...data }
    if (lineItems) {
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: invoice.id } })
      const subtotalCents = lineItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPriceCents), 0)
      const gstCents = req.user.business.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
      const totalCents = subtotalCents + gstCents
      const balanceDueCents = totalCents - (data.depositCents || invoice.depositCents || 0)
      Object.assign(updateData, { subtotalCents, gstCents, totalCents, balanceDueCents })
      updateData.lineItems = {
        create: lineItems.map((item, idx) => ({
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalCents: Math.round(item.quantity * item.unitPriceCents),
          category: item.category || 'labor',
          sortOrder: idx
        }))
      }
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: updateData,
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    res.json({ invoice: updated })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice' })
  }
})

// POST /api/invoices/:id/send — send invoice to customer
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const business = req.user.business
    const { sendVia = ['email'] } = req.body

    // Generate Stripe payment link
    let paymentLink = null
    if (business.stripeConnectId || process.env.STRIPE_SECRET_KEY) {
      try {
        paymentLink = await createStripePaymentLink(invoice, business)
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { stripePaymentLinkId: paymentLink.id, stripePaymentLinkUrl: paymentLink.url }
        })
      } catch (e) {
        console.warn('Stripe payment link failed:', e.message)
      }
    }

    // Generate PDF
    const pdfBuffer = await generateInvoicePDF(invoice, business)

    // Send email
    if (sendVia.includes('email') && invoice.customerEmail) {
      const serverUrl = process.env.SERVER_URL || 'https://knockoff-server-production.up.railway.app'
      await sendEmail({
        to: invoice.customerEmail,
        subject: `Tax Invoice ${invoice.invoiceNumber} from ${business.name}`,
        template: 'invoice',
        data: {
          invoice,
          business,
          paymentLink: paymentLink?.url,
          viewUrl: invoice.publicViewToken ? `${serverUrl}/invoice/${invoice.publicViewToken}` : null,
          formattedTotal: `$${(invoice.totalCents / 100).toFixed(2)}`,
          formattedDue: `$${(invoice.balanceDueCents / 100).toFixed(2)}`,
          dueDateFormatted: format(new Date(invoice.dueDate), 'dd MMMM yyyy')
        },
        attachments: [{
          filename: `Invoice-${invoice.invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }]
      })
    }

    // Send SMS
    if (sendVia.includes('sms') && invoice.customerPhone) {
      const msg = paymentLink
        ? `Hi ${invoice.customerName.split(' ')[0]}, your invoice from ${business.name} for $${(invoice.totalCents / 100).toFixed(2)} is ready. Pay online: ${paymentLink.url}`
        : `Hi ${invoice.customerName.split(' ')[0]}, your invoice ${invoice.invoiceNumber} from ${business.name} for $${(invoice.totalCents / 100).toFixed(2)} is due ${format(new Date(invoice.dueDate), 'dd MMM')}.`
      await sendSMS({ to: invoice.customerPhone, body: msg, from: business.twilioPhoneNumber })
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'SENT', sentAt: new Date() },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })

    await audit.log({
      businessId: req.businessId, entityType: 'invoice', entityId: invoice.id,
      action: 'sent', description: `Invoice sent via ${sendVia.join(', ')} to ${invoice.customerEmail || invoice.customerPhone}`,
      userId: req.user.id, userEmail: req.user.email
    })

    res.json({ invoice: updated, paymentLink: paymentLink?.url })
  } catch (err) {
    console.error('Send invoice error:', err)
    res.status(500).json({ error: 'Failed to send invoice: ' + err.message })
  }
})

// POST /api/invoices/:id/payment-link — generate Stripe payment link
router.post('/:id/payment-link', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    if (invoice.status === 'PAID') return res.status(400).json({ error: 'Invoice already paid' })
    if (invoice.stripePaymentLinkUrl) return res.json({ url: invoice.stripePaymentLinkUrl })

    const business = req.user.business
    if (!business.stripeConnectId && !process.env.STRIPE_SECRET_KEY) {
      return res.status(400).json({ error: 'Stripe not connected. Set up Stripe in Settings first.' })
    }

    const link = await createStripePaymentLink(invoice, business)
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { stripePaymentLinkId: link.id, stripePaymentLinkUrl: link.url }
    })
    res.json({ url: link.url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate payment link: ' + err.message })
  }
})

// POST /api/invoices/:id/void — void/cancel an invoice
router.post('/:id/void', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    if (invoice.status === 'PAID') return res.status(400).json({ error: 'Cannot void a paid invoice' })
    const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'CANCELLED' } })
    res.json({ invoice: updated })
  } catch (err) {
    res.status(500).json({ error: 'Failed to void invoice' })
  }
})

// GET /api/invoices/:id/pdf — download PDF
router.get('/:id/pdf', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const pdfBuffer = await generateInvoicePDF(invoice, req.user.business)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoice.invoiceNumber}.pdf"`)
    res.send(pdfBuffer)
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate PDF' })
  }
})

// POST /api/invoices/:id/mark-paid
router.post('/:id/mark-paid', async (req, res) => {
  const { paidAmountCents, paymentMethod, paidAt } = req.body
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'PAID',
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        paidAmountCents: paidAmountCents || invoice.balanceDueCents,
        paymentMethod: paymentMethod || null
      }
    })

    if (invoice.customerId) {
      await prisma.customer.update({
        where: { id: invoice.customerId },
        data: { totalSpend: { increment: updated.paidAmountCents } }
      })
    }

    await audit.log({
      businessId: req.businessId, entityType: 'invoice', entityId: invoice.id,
      action: 'paid', description: `Invoice marked as paid — $${((paidAmountCents || invoice.balanceDueCents) / 100).toFixed(2)}`,
      userId: req.user.id, userEmail: req.user.email,
      metadata: { paidAmountCents: updated.paidAmountCents, paymentMethod: req.body.paymentMethod }
    })

    res.json({ invoice: updated })
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark invoice as paid' })
  }
})

// POST /api/invoices/:id/reminder
router.post('/:id/reminder', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const business = req.user.business
    if (invoice.customerEmail) {
      await sendEmail({
        to: invoice.customerEmail,
        subject: `Payment reminder: Invoice ${invoice.invoiceNumber}`,
        template: 'invoice-reminder',
        data: {
          invoice,
          business,
          daysOverdue: invoice.status === 'OVERDUE' ? Math.floor((Date.now() - new Date(invoice.dueDate).getTime()) / 86400000) : 0
        }
      })
    }
    if (invoice.customerPhone) {
      await sendSMS({
        to: invoice.customerPhone,
        body: `Hi ${invoice.customerName.split(' ')[0]}, just a reminder that invoice ${invoice.invoiceNumber} for $${(invoice.balanceDueCents / 100).toFixed(2)} from ${business.name} is due. Please get in touch if you have any questions.`,
        from: business.twilioPhoneNumber
      })
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { reminderSentAt: new Date() }
    })

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reminder' })
  }
})

module.exports = router
