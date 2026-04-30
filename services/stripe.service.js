const Stripe = require('stripe')
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

async function createCheckoutSession({ businessId, userId, tier, interval = 'month', trialDays = 14 }) {
  const priceMap = {
    SOLO: { month: process.env.STRIPE_PRICE_SOLO_MONTHLY, year: process.env.STRIPE_PRICE_SOLO_ANNUAL },
    GROWING: { month: process.env.STRIPE_PRICE_GROWING_MONTHLY, year: process.env.STRIPE_PRICE_GROWING_ANNUAL },
    BUSINESS: { month: process.env.STRIPE_PRICE_BUSINESS_MONTHLY, year: process.env.STRIPE_PRICE_BUSINESS_ANNUAL }
  }

  const priceId = priceMap[tier]?.[interval]
  if (!priceId) throw new Error(`No price configured for ${tier} ${interval}`)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: trialDays,
      metadata: { businessId, userId, tier }
    },
    success_url: `${process.env.CLIENT_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.CLIENT_URL}/billing`,
    metadata: { businessId, userId, tier }
  })

  return session
}

async function createCustomerPortalSession(stripeCustomerId) {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${process.env.CLIENT_URL}/settings/billing`
  })
  return session
}

async function createStripePaymentLink(invoice, business) {
  const connectedAccountId = business.stripeConnectId
  const options = connectedAccountId ? { stripeAccount: connectedAccountId } : {}

  const product = await stripe.products.create({
    name: `Invoice ${invoice.invoiceNumber} — ${invoice.customerName}`,
    metadata: { invoiceId: invoice.id }
  }, options)

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: invoice.balanceDueCents,
    currency: 'aud'
  }, options)

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { invoiceId: invoice.id, businessId: business.id },
    after_completion: {
      type: 'redirect',
      redirect: { url: `${process.env.CLIENT_URL}/invoice-paid?invoice=${invoice.invoiceNumber}` }
    }
  }, options)

  return paymentLink
}

function constructEvent(payload, signature) {
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET)
}

module.exports = { createCheckoutSession, createCustomerPortalSession, createStripePaymentLink, constructEvent }
