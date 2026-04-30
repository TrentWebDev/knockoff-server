const express = require('express')
const router = express.Router()
const Stripe = require('stripe')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// GET /api/stripe/connect-url — generate OAuth link for tradie to connect their Stripe account
router.get('/connect-url', async (req, res) => {
  if (!process.env.STRIPE_CLIENT_ID) {
    return res.status(500).json({ error: 'Stripe Connect not configured' })
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: `${process.env.SERVER_URL}/api/stripe/callback`,
    state: req.businessId,
    'stripe_user[business_type]': 'individual',
    'stripe_user[business_name]': req.user.business?.name || '',
    'stripe_user[email]': req.user.email || '',
    'stripe_user[country]': 'AU',
    'stripe_user[currency]': 'aud'
  })
  res.json({ url: `https://connect.stripe.com/oauth/authorize?${params}` })
})

// GET /api/stripe/callback — Stripe redirects here after tradie connects
router.get('/callback', async (req, res) => {
  const { code, state: businessId, error } = req.query

  if (error) {
    return res.redirect(`${process.env.CLIENT_URL}/settings?stripe=error`)
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
    const response = await stripe.oauth.token({ grant_type: 'authorization_code', code })
    const stripeAccountId = response.stripe_user_id

    await prisma.business.update({
      where: { id: businessId },
      data: { stripeConnectId: stripeAccountId }
    })

    res.redirect(`${process.env.CLIENT_URL}/settings?stripe=connected&tab=billing`)
  } catch (err) {
    console.error('Stripe Connect callback error:', err)
    res.redirect(`${process.env.CLIENT_URL}/settings?stripe=error`)
  }
})

// DELETE /api/stripe/disconnect — remove Stripe connection
router.delete('/disconnect', async (req, res) => {
  try {
    const business = req.user.business
    if (business.stripeConnectId) {
      try {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
        await stripe.oauth.deauthorize({
          client_id: process.env.STRIPE_CLIENT_ID,
          stripe_user_id: business.stripeConnectId
        })
      } catch (e) {
        console.warn('Stripe deauthorize failed:', e.message)
      }
    }
    await prisma.business.update({
      where: { id: req.businessId },
      data: { stripeConnectId: null }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Stripe' })
  }
})

// GET /api/stripe/status
router.get('/status', (req, res) => {
  res.json({ connected: !!req.user.business?.stripeConnectId })
})

module.exports = router
