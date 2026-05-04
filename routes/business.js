const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { body, validationResult } = require('express-validator')

const prisma = new PrismaClient()

// GET /api/business — get business profile
router.get('/', async (req, res) => {
  if (!req.businessId) return res.json({ business: null })
  try {
    const business = await prisma.business.findUnique({ where: { id: req.businessId } })
    res.json({ business })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load business' })
  }
})

// POST /api/business — create business profile (onboarding step 2)
router.post('/', [
  body('name').trim().notEmpty().withMessage('Business name required'),
  body('tradeType').trim().notEmpty(),
  body('phone').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  try {
    if (req.user.businessId) {
      return res.status(409).json({ error: 'Business already exists — use PUT to update' })
    }

    const {
      name, abn, tradeType, phone, address, suburb, state, postcode,
      hourlyRate, emergencyRate, calloutFee, materialMarkup,
      paymentTermsDays, bankBsb, bankAccount, bankName,
      workingDays, workingHoursStart, workingHoursEnd
    } = req.body

    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    const business = await prisma.business.create({
      data: {
        name, abn, tradeType, phone,
        email: req.user.email,
        address, suburb: suburb || '', state: state || 'NSW', postcode,
        hourlyRate: hourlyRate || 0,
        emergencyRate: emergencyRate || 0,
        calloutFee: calloutFee || 0,
        materialMarkup: materialMarkup ? parseFloat(materialMarkup) / 100 : 0.2,
        paymentTermsDays: paymentTermsDays || 7,
        bankBsb, bankAccount, bankName,
        workingDays: workingDays || ['MON','TUE','WED','THU','FRI'],
        workingHoursStart: workingHoursStart || '07:00',
        workingHoursEnd: workingHoursEnd || '17:00',
        subscriptionTier: 'TRIAL',
        subscriptionStatus: 'trialing',
        trialEndsAt
      }
    })

    // Link user to business
    await prisma.user.update({ where: { id: req.user.id }, data: { businessId: business.id } })

    res.status(201).json({ business })
  } catch (err) {
    console.error('Create business error:', err)
    res.status(500).json({ error: 'Failed to create business' })
  }
})

// PUT /api/business — update business profile
router.put('/', async (req, res) => {
  if (!req.businessId) return res.status(400).json({ error: 'No business profile found' })

  const {
    name, abn, tradeType, phone, email, address, suburb, state, postcode,
    serviceRadius, serviceSuburbs, hourlyRate, emergencyRate, calloutFee,
    materialMarkup, invoicePrefix, paymentTermsDays, bankName, bankBsb, bankAccount,
    aiBusinessHours, aiAfterHours, aiGreeting, aiServiceAreas, aiTone, aiServices, invoiceFooter,
    workingHoursStart, workingHoursEnd, workingDays, jobBufferMinutes, maxJobsPerDay,
    gstRegistered
  } = req.body

  try {
    const updateData = {}
    if (name !== undefined) updateData.name = name
    if (abn !== undefined) updateData.abn = abn
    if (tradeType !== undefined) updateData.tradeType = tradeType
    if (phone !== undefined) updateData.phone = phone
    if (email !== undefined) updateData.email = email
    if (address !== undefined) updateData.address = address
    if (suburb !== undefined) updateData.suburb = suburb
    if (state !== undefined) updateData.state = state
    if (postcode !== undefined) updateData.postcode = postcode
    if (serviceRadius !== undefined) updateData.serviceRadius = parseInt(serviceRadius)
    if (serviceSuburbs !== undefined) updateData.serviceSuburbs = serviceSuburbs
    if (hourlyRate !== undefined) updateData.hourlyRate = Math.round(parseFloat(hourlyRate) * 100)
    if (emergencyRate !== undefined) updateData.emergencyRate = Math.round(parseFloat(emergencyRate) * 100)
    if (calloutFee !== undefined) updateData.calloutFee = Math.round(parseFloat(calloutFee) * 100)
    if (materialMarkup !== undefined) updateData.materialMarkup = parseFloat(materialMarkup) / 100
    if (invoicePrefix !== undefined) updateData.invoicePrefix = invoicePrefix
    if (paymentTermsDays !== undefined) updateData.paymentTermsDays = parseInt(paymentTermsDays)
    if (bankName !== undefined) updateData.bankName = bankName
    if (bankBsb !== undefined) updateData.bankBsb = bankBsb
    if (bankAccount !== undefined) updateData.bankAccount = bankAccount
    if (aiBusinessHours !== undefined) updateData.aiBusinessHours = aiBusinessHours
    if (aiAfterHours !== undefined) updateData.aiAfterHours = aiAfterHours
    if (aiGreeting !== undefined) updateData.aiGreeting = aiGreeting
    if (aiServiceAreas !== undefined) updateData.aiServiceAreas = aiServiceAreas
    if (aiTone !== undefined) updateData.aiTone = aiTone
    if (aiServices !== undefined) updateData.aiServices = aiServices
    if (invoiceFooter !== undefined) updateData.invoiceFooter = invoiceFooter
    if (workingHoursStart !== undefined) updateData.workingHoursStart = workingHoursStart
    if (workingHoursEnd !== undefined) updateData.workingHoursEnd = workingHoursEnd
    if (workingDays !== undefined) updateData.workingDays = workingDays
    if (jobBufferMinutes !== undefined) updateData.jobBufferMinutes = parseInt(jobBufferMinutes)
    if (maxJobsPerDay !== undefined) updateData.maxJobsPerDay = parseInt(maxJobsPerDay)
    if (gstRegistered !== undefined) updateData.gstRegistered = Boolean(gstRegistered)

    const business = await prisma.business.update({ where: { id: req.businessId }, data: updateData })
    res.json({ business })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update business' })
  }
})

module.exports = router
