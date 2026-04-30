const express = require('express')
const router = express.Router()
const { createCheckoutSession, createCustomerPortalSession } = require('../services/stripe.service')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

router.post('/checkout', async (req, res) => {
  const { tier, interval } = req.body
  try {
    const session = await createCheckoutSession({
      businessId: req.businessId,
      userId: req.user.id,
      tier: tier.toUpperCase(),
      interval: interval || 'month',
      trialDays: req.user.business?.subscriptionStatus === 'trialing' ? 14 : 0
    })
    res.json({ url: session.url })
  } catch (err) {
    console.error('Checkout error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/portal', async (req, res) => {
  const stripeCustomerId = req.user.business?.stripeCustomerId
  if (!stripeCustomerId) return res.status(400).json({ error: 'No Stripe customer found' })
  try {
    const session = await createCustomerPortalSession(stripeCustomerId)
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/status', async (req, res) => {
  const business = req.user.business
  if (!business) return res.json({ status: null })
  res.json({
    tier: business.subscriptionTier,
    status: business.subscriptionStatus,
    trialEndsAt: business.trialEndsAt,
    subscriptionEndsAt: business.subscriptionEndsAt
  })
})

module.exports = router
