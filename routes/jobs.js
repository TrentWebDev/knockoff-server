const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { body, validationResult } = require('express-validator')
const { sendJobConfirmationSMS, sendJobConfirmationEmail } = require('../services/calendar.service')
const { syncJobToGoogleCalendar, deleteGoogleCalendarEvent } = require('../services/calendar.service')
const { v4: uuidv4 } = require('uuid')
const { addDays } = require('date-fns')

const prisma = new PrismaClient()

// GET /api/jobs
router.get('/', async (req, res) => {
  const { status, from, to, search, page = 1, limit = 50 } = req.query
  const businessId = req.businessId
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { businessId }
  if (status) where.status = status.toUpperCase()
  if (search) where.OR = [
    { customerName: { contains: search, mode: 'insensitive' } },
    { address: { contains: search, mode: 'insensitive' } },
    { suburb: { contains: search, mode: 'insensitive' } }
  ]
  if (from || to) {
    where.scheduledAt = {}
    if (from) where.scheduledAt.gte = new Date(from)
    if (to) where.scheduledAt.lte = new Date(to)
  }

  try {
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: { customer: true, invoice: true },
        orderBy: { scheduledAt: 'asc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.job.count({ where })
    ])
    res.json({ jobs, total })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load jobs' })
  }
})

// GET /api/jobs/:id
router.get('/:id', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { customer: true, invoice: { include: { lineItems: true } }, photos: true }
    })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({ job: { ...job, customerConfirmed: job.confirmedByCustomer } })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load job' })
  }
})

// POST /api/jobs
router.post('/', [
  body('customerName').trim().notEmpty(),
  body('customerPhone').trim().notEmpty(),
  body('address').trim().notEmpty(),
  body('suburb').trim().notEmpty(),
  body('jobType').trim().notEmpty()
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const businessId = req.businessId
  const business = req.user.business
  const {
    customerName, customerPhone, customerEmail, address, suburb,
    jobType, description, notes, scheduledAt, durationMinutes,
    priority, customerId, accessNotes, materialsNeeded
  } = req.body

  try {
    const job = await prisma.job.create({
      data: {
        businessId,
        customerId,
        customerName,
        customerPhone,
        customerEmail,
        address,
        suburb,
        jobType,
        description: description || '',
        notes,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        durationMinutes: durationMinutes || 60,
        priority: priority || 'NORMAL',
        accessNotes,
        materialsNeeded
      },
      include: { customer: true }
    })

    // Sync to Google Calendar
    if (scheduledAt && business.googleCalendarId) {
      try {
        const eventId = await syncJobToGoogleCalendar(job, business)
        await prisma.job.update({ where: { id: job.id }, data: { googleEventId: eventId } })
      } catch (e) {
        console.warn('Google Calendar sync failed:', e.message)
      }
    }

    // Send confirmation to customer
    if (scheduledAt && job.status === 'CONFIRMED') {
      try {
        await sendJobConfirmationSMS(job, business)
        if (customerEmail) await sendJobConfirmationEmail(job, business)
      } catch (e) {
        console.warn('Confirmation send failed:', e.message)
      }
    }

    res.status(201).json({ job })
  } catch (err) {
    console.error('Create job error:', err)
    res.status(500).json({ error: 'Failed to create job' })
  }
})

// PUT /api/jobs/:id
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.job.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!existing) return res.status(404).json({ error: 'Job not found' })

    const { scheduledAt, ...data } = req.body
    const updateData = { ...data }
    if (scheduledAt) updateData.scheduledAt = new Date(scheduledAt)

    const job = await prisma.job.update({
      where: { id: existing.id },
      data: updateData,
      include: { customer: true }
    })

    // Re-sync Google Calendar if time changed
    const business = req.user.business
    if (scheduledAt && business.googleCalendarId) {
      try {
        const eventId = await syncJobToGoogleCalendar(job, business)
        if (eventId !== job.googleEventId) {
          await prisma.job.update({ where: { id: job.id }, data: { googleEventId: eventId } })
        }
      } catch (e) {}
    }

    res.json({ job })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job' })
  }
})

// POST /api/jobs/:id/send-confirmation — resend customer confirmation SMS/email
router.post('/:id/send-confirmation', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (!job.scheduledAt) return res.status(400).json({ error: 'Job has no scheduled time' })
    if (!job.customerPhone && !job.customerEmail) return res.status(400).json({ error: 'No customer contact details' })
    const business = req.user.business
    const sent = { sms: false, email: false }
    try { await sendJobConfirmationSMS(job, business); sent.sms = true } catch (e) {}
    try { await sendJobConfirmationEmail(job, business); sent.email = true } catch (e) {}
    if (!sent.sms && !sent.email) return res.status(500).json({ error: 'Failed to send — check SMS/email settings' })
    await prisma.job.update({ where: { id: job.id }, data: { confirmationSentAt: new Date() } })
    res.json({ success: true, sent })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send confirmation' })
  }
})

// POST /api/jobs/:id/start — mark job as in progress
router.post('/:id/start', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (!['PENDING', 'CONFIRMED'].includes(job.status)) return res.status(400).json({ error: `Cannot start a job with status ${job.status}` })
    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'IN_PROGRESS' }
    })
    res.json({ job: updated })
  } catch (err) {
    res.status(500).json({ error: 'Failed to start job' })
  }
})

// POST /api/jobs/:id/complete — mark complete, trigger invoice creation
router.post('/:id/complete', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, businessId: req.businessId }
    })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
      include: { customer: true }
    })

    // Update customer's last job date
    if (job.customerId) {
      await prisma.customer.update({
        where: { id: job.customerId },
        data: { lastJobAt: new Date() }
      })
    }

    res.json({ job: updated, message: 'Job marked complete. Ready to create invoice.' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete job' })
  }
})

// POST /api/jobs/:id/complete-and-invoice — mark complete + create draft invoice in one tap
router.post('/:id/complete-and-invoice', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: { invoice: true }
    })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    // If invoice already exists, just complete and return existing invoice
    if (job.invoice) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'COMPLETED', completedAt: new Date() } })
      if (job.customerId) {
        await prisma.customer.update({ where: { id: job.customerId }, data: { lastJobAt: new Date() } }).catch(() => {})
      }
      return res.json({ invoiceId: job.invoice.id, existed: true })
    }

    const updatedBusiness = await prisma.business.update({
      where: { id: req.businessId },
      data: { nextInvoiceNumber: { increment: 1 } },
      select: { nextInvoiceNumber: true, invoicePrefix: true, paymentTermsDays: true, hourlyRate: true, gstRegistered: true }
    })

    const invoiceNumber = `${updatedBusiness.invoicePrefix}-${String(updatedBusiness.nextInvoiceNumber - 1).padStart(4, '0')}`
    const hourlyRate = updatedBusiness.hourlyRate || 12000
    const durationHours = job.durationMinutes ? job.durationMinutes / 60 : 2
    const quantity = Math.round(durationHours * 2) / 2
    const unitPriceCents = hourlyRate
    const subtotalCents = Math.round(quantity * unitPriceCents)
    const gstCents = updatedBusiness.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
    const totalCents = subtotalCents + gstCents
    const jobTypeLabel = job.jobType
      ? job.jobType.charAt(0) + job.jobType.slice(1).toLowerCase().replace(/_/g, ' ') + ' labour'
      : 'Labour'

    const [updatedJob, invoice] = await Promise.all([
      prisma.job.update({ where: { id: job.id }, data: { status: 'COMPLETED', completedAt: new Date() } }),
      prisma.invoice.create({
        data: {
          businessId: req.businessId,
          jobId: job.id,
          customerId: job.customerId || undefined,
          invoiceNumber,
          customerName: job.customerName,
          customerEmail: job.customerEmail || null,
          customerPhone: job.customerPhone,
          customerAddress: [job.address, job.suburb].filter(Boolean).join(', '),
          dueDate: addDays(new Date(), updatedBusiness.paymentTermsDays || 7),
          subtotalCents,
          gstCents,
          totalCents,
          balanceDueCents: totalCents,
          publicViewToken: uuidv4(),
          notes: job.description || null,
          lineItems: {
            create: [{
              description: jobTypeLabel,
              quantity,
              unitPriceCents,
              totalCents: subtotalCents,
              category: 'labor',
              sortOrder: 0
            }]
          }
        }
      })
    ])

    if (job.customerId) {
      await prisma.customer.update({ where: { id: job.customerId }, data: { lastJobAt: new Date() } }).catch(() => {})
    }

    res.json({ invoice, job: updatedJob, invoiceId: invoice.id })
  } catch (err) {
    console.error('Complete-and-invoice error:', err)
    res.status(500).json({ error: 'Failed to complete job and create invoice' })
  }
})

// POST /api/jobs/:id/confirm — customer confirmation endpoint (no auth required for SMS link)
router.post('/:id/confirm', async (req, res) => {
  const { token, action } = req.body // action: 'confirm' or 'reschedule'
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    if (action === 'confirm') {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'CONFIRMED', confirmedByCustomer: true }
      })

      // Notify tradie
      const business = await prisma.business.findUnique({ where: { id: job.businessId } })
      if (business) {
        await prisma.notification.create({
          data: {
            businessId: job.businessId,
            type: 'job_confirmed',
            priority: 'info',
            title: 'Job Confirmed',
            body: `${job.customerName} confirmed their job for ${job.scheduledAt ? new Date(job.scheduledAt).toLocaleString('en-AU') : 'TBD'}`,
            actionUrl: `/jobs/${job.id}`
          }
        })
      }

      res.json({ success: true, message: 'Job confirmed! See you then.' })
    } else {
      res.json({ success: true, message: 'We\'ll be in touch to find a new time.' })
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update job' })
  }
})

// POST /api/jobs/:id/photos — upload job photo (base64 data URL)
router.post('/:id/photos', async (req, res) => {
  const { url, type = 'before', caption } = req.body
  if (!url) return res.status(400).json({ error: 'url required' })
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    const photo = await prisma.jobPhoto.create({
      data: { jobId: job.id, url, type, caption: caption || null }
    })
    res.status(201).json({ photo })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save photo' })
  }
})

// DELETE /api/jobs/:id/photos/:photoId
router.delete('/:id/photos/:photoId', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    await prisma.jobPhoto.deleteMany({ where: { id: req.params.photoId, jobId: job.id } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete photo' })
  }
})

// DELETE /api/jobs/:id
router.delete('/:id', async (req, res) => {
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    // Delete Google Calendar event
    if (job.googleEventId && req.user.business.googleCalendarId) {
      try { await deleteGoogleCalendarEvent(job, req.user.business) } catch (e) {}
    }

    await prisma.job.update({ where: { id: job.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel job' })
  }
})

module.exports = router
