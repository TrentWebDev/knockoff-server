const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { getAuthUrl, exchangeCodeForTokens } = require('../services/calendar.service')
const { verifyToken } = require('../middleware/auth')
const { google } = require('googleapis')

const prisma = new PrismaClient()

// GET /api/calendar/auth-url
router.get('/auth-url', verifyToken, (req, res) => {
  const url = getAuthUrl()
  res.json({ url })
})

// GET /api/calendar/callback — Google OAuth callback
router.get('/callback', async (req, res) => {
  const { code, state } = req.query
  try {
    const tokens = await exchangeCodeForTokens(code)
    // Get calendar list to find primary
    const oauth2 = new (require('google-auth-library').OAuth2Client)(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    )
    oauth2.setCredentials(tokens)
    const calendar = google.calendar({ version: 'v3', auth: oauth2 })
    const calList = await calendar.calendarList.list()
    const primary = calList.data.items.find(c => c.primary)

    // state contains businessId
    if (state) {
      await prisma.business.update({
        where: { id: state },
        data: {
          googleAccessToken: tokens.access_token,
          googleRefreshToken: tokens.refresh_token,
          googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          googleCalendarId: primary?.id || 'primary'
        }
      })
    }

    res.redirect(`${process.env.CLIENT_URL}/settings/calendar?connected=1`)
  } catch (err) {
    console.error('Calendar callback error:', err)
    res.redirect(`${process.env.CLIENT_URL}/settings/calendar?error=1`)
  }
})

// GET /api/calendar/events — get events for range
router.get('/events', verifyToken, async (req, res) => {
  const { from, to } = req.query
  const where = { businessId: req.businessId }
  if (from) where.startAt = { gte: new Date(from) }
  if (to) where.endAt = { lte: new Date(to) }

  try {
    const events = await prisma.calendarEvent.findMany({ where, orderBy: { startAt: 'asc' } })
    const jobs = await prisma.job.findMany({
      where: {
        businessId: req.businessId,
        scheduledAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined },
        status: { not: 'CANCELLED' }
      },
      include: { customer: true }
    })
    res.json({ events, jobs })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load calendar data' })
  }
})

// POST /api/calendar/disconnect
router.post('/disconnect', verifyToken, async (req, res) => {
  try {
    await prisma.business.update({
      where: { id: req.businessId },
      data: { googleCalendarId: null, googleAccessToken: null, googleRefreshToken: null, googleTokenExpiry: null }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect calendar' })
  }
})

module.exports = router
