const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { constructEvent } = require('../services/stripe.service')
const { runCustomerAI } = require('../services/ai.service')
const { sendSMS } = require('../services/sms.service')
const twilio = require('twilio')

const prisma = new PrismaClient()

// POST /api/webhooks/stripe
router.post('/stripe', async (req, res) => {
  let event
  try {
    event = constructEvent(req.body, req.headers['stripe-signature'])
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const { businessId, tier } = session.metadata || {}
        if (businessId) {
          await prisma.business.update({
            where: { id: businessId },
            data: {
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              subscriptionTier: tier || 'SOLO',
              subscriptionStatus: 'active'
            }
          })
        }
        break
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const business = await prisma.business.findFirst({ where: { stripeSubscriptionId: sub.id } })
        if (business) {
          await prisma.business.update({
            where: { id: business.id },
            data: {
              subscriptionStatus: sub.status,
              subscriptionEndsAt: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null
            }
          })
        }
        break
      }

      case 'payment_link.payment_completed':
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.metadata?.invoiceId) {
          const invoice = await prisma.invoice.findUnique({ where: { id: session.metadata.invoiceId } })
          if (invoice) {
            await prisma.invoice.update({
              where: { id: invoice.id },
              data: { status: 'PAID', paidAt: new Date(), paidAmountCents: session.amount_total }
            })
            await prisma.notification.create({
              data: {
                businessId: invoice.businessId,
                type: 'invoice_paid',
                priority: 'info',
                title: '💰 Invoice Paid',
                body: `${invoice.customerName} paid invoice ${invoice.invoiceNumber} — $${(session.amount_total / 100).toFixed(2)}`,
                actionUrl: `/invoices/${invoice.id}`
              }
            })
          }
        }
        break
      }
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err)
  }

  res.json({ received: true })
})

// POST /api/webhooks/twilio/sms — inbound SMS from customers
router.post('/twilio/sms', async (req, res) => {
  const sig = req.headers['x-twilio-signature']
  const url = `${process.env.SERVER_URL}/api/webhooks/twilio/sms`

  try {
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      sig,
      url,
      req.body
    )
    if (!valid && process.env.NODE_ENV === 'production') {
      return res.status(403).send('Invalid signature')
    }
  } catch (e) {}

  const { From: from, To: to, Body: body } = req.body

  try {
    // Find business by Twilio number
    const business = await prisma.business.findFirst({ where: { twilioPhoneNumber: to } })
    if (!business) {
      return res.set('Content-Type', 'text/xml').send('<Response></Response>')
    }

    // Find or create conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        businessId: business.id,
        customerPhone: from,
        status: 'active',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } }
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          businessId: business.id,
          customerPhone: from,
          channel: 'sms',
          messages: { create: [{ role: 'user', content: body }] }
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } }
      })
    } else {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: 'user', content: body }
      })
      conversation.messages.push({ role: 'user', content: body, createdAt: new Date() })
    }

    const history = conversation.messages.map(m => ({ role: m.role, content: m.content }))
    const reply = await runCustomerAI({ business, messages: history, conversationId: conversation.id })

    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: reply }
    })

    // Send reply via Twilio
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</Message></Response>`
    res.set('Content-Type', 'text/xml').send(twiml)
  } catch (err) {
    console.error('Twilio webhook error:', err)
    res.set('Content-Type', 'text/xml').send('<Response><Message>Sorry, we had a technical issue. Please try again or call us directly.</Message></Response>')
  }
})

module.exports = router
