const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { v4: uuidv4 } = require('uuid')
const { sendEmail } = require('../services/email.service')

const prisma = new PrismaClient()

// POST /api/accountant/invite
router.post('/invite', async (req, res) => {
  const { email, name } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })

  try {
    const token = uuidv4()
    const invite = await prisma.accountantInvite.upsert({
      where: { token: `${req.businessId}-${email}` },
      update: { token, name, revokedAt: null },
      create: { businessId: req.businessId, email, name, token }
    })

    const business = req.user.business
    const acceptUrl = `${process.env.CLIENT_URL}/accountant/accept?token=${token}`

    try {
      await sendEmail({
        to: email,
        subject: `${business.name} has invited you to view their financials on Knock Off`,
        template: 'accountant-invite',
        data: { business, name, acceptUrl }
      })
    } catch (e) {
      console.warn('Invite email failed:', e.message)
    }

    res.json({ success: true, token })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send invite' })
  }
})

// GET /api/accountant/invites
router.get('/invites', async (req, res) => {
  try {
    const invites = await prisma.accountantInvite.findMany({
      where: { businessId: req.businessId, revokedAt: null },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ invites })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invites' })
  }
})

// DELETE /api/accountant/invite/:id
router.delete('/invite/:id', async (req, res) => {
  try {
    await prisma.accountantInvite.update({
      where: { id: req.params.id, businessId: req.businessId },
      data: { revokedAt: new Date() }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke invite' })
  }
})

module.exports = router
